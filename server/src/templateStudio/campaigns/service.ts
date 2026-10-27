import { z } from "zod";
import { DEFAULT_FIDELITY_MODE, studioCreativeDirection } from "@frameflow/shared";
import type { ServerEnv } from "../config.js";
import { parseRules } from "../brand/kits.js";
import { getFormat } from "../compose/formats.js";
import { copySchema } from "../compose/overlay.js";
import { presentFields } from "../compose/build.js";
import { estimateReferencePoster } from "../costs/profiles.js";
import { CostUnboundedError, formatInr, formatUsd } from "../costs/estimate.js";
import { enqueueJob } from "../jobs/queue.js";
import type { GeneratePosterInput } from "../jobs/kinds/generatePoster.js";
import { newId, now, type StudioStore as Db } from "../store.js";
import { resolveReferencePolicy } from '../referencePolicy.js';
import { preflightBudget } from '../costs/budget.js';

export class CampaignError extends Error {
  constructor(
    public readonly code: "not_found" | "invalid" | "over_budget",
    message: string,
  ) {
    super(message);
    this.name = "CampaignError";
  }
}

export const createCampaignSchema = z.object({
  productActions: z.array(z.object({ productId: z.string(), action: z.enum(['keep', 'replace', 'remove']), replacementAssetId: z.string().optional() })).max(20).optional(),
  backgroundOnly: z.boolean().optional(),
  referenceText: z.enum(['keep', 'remove']).optional(),
  idempotencyKey: z.string().min(8).max(128),
  templateId: z.string().min(1),
  /** Defaults to the template's brand kit; null for no brand kit. */
  brandKitId: z.string().nullable().optional(),
  clusterId: z.string().nullable().optional(),
  subjects: z
    .array(
      z.object({
        assetId: z.string().min(1),
        name: z.string().trim().min(1).max(120),
        subjectType: z.string().trim().max(120).nullable().optional(),
        isSku: z.boolean().optional(),
      }),
    )
    .max(6, "Use at most six products."),
  copy: copySchema,
  partnerLogoIds: z.array(z.string()).max(3).default([]),
  formatId: z.string(),
  quality: z.enum(["low", "medium", "high"]).optional(),
  direction: z.string().trim().max(1000).nullable().optional(),
  /** Festival or occasion the poster is themed for (e.g. "Diwali"); stored with the job input. */
  occasion: z.string().trim().max(80).nullable().optional(),
  /** FrameFlow default: Match Reference. */
  fidelityMode: z.enum(["match", "adapt", "explore"]).default(DEFAULT_FIDELITY_MODE),
  /** Explore only: one of FrameFlow's creative directions, added to the art direction. */
  creativeDirectionId: z.string().max(40).nullable().optional(),
  /** Exact product pixels from transparent cutouts (FrameFlow's compositor); every product must have transparency. */
  preserveProductPixels: z.boolean().default(false),
});
export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;

/** The direction text the art director receives: the user's own, plus the chosen FrameFlow direction in Explore. */
export function directionText(input: Pick<CreateCampaignInput, "direction" | "fidelityMode" | "creativeDirectionId">) {
  const preset = input.fidelityMode === "explore" ? studioCreativeDirection(input.creativeDirectionId) : undefined;
  const own = input.direction?.trim() || null;
  if (!preset) return own;
  return [`Creative direction "${preset.title}": ${preset.text}`, own].filter(Boolean).join("\n");
}

export function createCampaign(db: Db, env: ServerEnv, given: CreateCampaignInput) {
  // Match Reference unless asked otherwise, whoever the caller is.
  const input = { ...given, fidelityMode: given.fidelityMode ?? DEFAULT_FIDELITY_MODE, preserveProductPixels: given.preserveProductPixels ?? false };
  const jobKey = `poster:${input.idempotencyKey}`;
  const existing = db.jobs.find((j) => j.idempotencyKey === jobKey);
  if (existing) return { job: existing, campaignId: existing.campaignId, created: false };

  const template = db.templates.get(input.templateId);
  if (!template?.currentProfileVersionId) throw new CampaignError("invalid", "This template hasn't been analysed yet.");
  const format = getFormat(input.formatId);
  if (!format) throw new CampaignError("invalid", "Unknown output format.");
  const fields = presentFields(input.copy);
  let referencePolicy;
  try { referencePolicy = resolveReferencePolicy(db, input); }
  catch (err) { throw new CampaignError('invalid', (err as Error).message); }
  if (new Set(input.subjects.map((s) => s.assetId)).size !== input.subjects.length) throw new CampaignError("invalid", "Each product image can be used once.");
  if (input.creativeDirectionId && input.fidelityMode !== "explore") throw new CampaignError("invalid", "A creative direction applies to Explore Creatives only.");
  if (input.creativeDirectionId && !studioCreativeDirection(input.creativeDirectionId)) throw new CampaignError("invalid", "Unknown creative direction.");

  const brandKitId = input.brandKitId === undefined ? template.brandKitId : input.brandKitId;
  let brandSnapshot: unknown = null;
  if (brandKitId) {
    const kit = db.brandKits.get(brandKitId);
    if (!kit) throw new CampaignError("invalid", "Brand kit not found.");
    brandSnapshot = { kitId: kit.id, revision: kit.revision, rules: parseRules(kit.rules) };
    for (const id of input.partnerLogoIds) {
      const logo = db.brandKitLogos.get(id);
      if (!logo || logo.brandKitId !== brandKitId || logo.kind !== "partner") throw new CampaignError("invalid", "Partner logos must belong to the brand kit.");
    }
  } else if (input.partnerLogoIds.length) {
    throw new CampaignError("invalid", "Partner logos need a brand kit.");
  }

  const assets = input.subjects.map((s) => db.assets.get(s.assetId));
  if (assets.some((a) => !a || (a.role !== "subject" && a.role !== "cutout"))) {
    throw new CampaignError("invalid", "Products must be uploaded as 'Product / subject' images.");
  }
  if (input.preserveProductPixels) {
    const opaque = input.subjects.filter((_, i) => !assets[i]!.hasAlpha).map((s) => s.name);
    if (opaque.length) throw new CampaignError("invalid", `Exact product pixels needs a transparent cutout (PNG with a transparent background) for every product. Not transparent: ${opaque.join(", ")}.`);
  }

  const quality = input.quality ?? env.IMAGE_QUALITY;
  if (referencePolicy.actions.some(a => a.action === 'replace')) {
    const opaque = assets.filter(a => !a!.hasAlpha);
    if (opaque.length) throw new CampaignError('invalid', 'Selective replacement needs a transparent cutout. Use Make cutout or upload a transparent PNG.');
  }
  try {
    const estimate = estimateReferencePoster(env, referencePolicy, { subjects: input.subjects.length, size: format.providerSize, quality });
    const total = estimate.totalMicroUsd;
    preflightBudget(db, env, total);
    if (!referencePolicy.localReuse && !estimate.withinCap) {
      throw new CampaignError(
        "over_budget",
        `This poster could cost up to ${formatUsd(estimate.totalMicroUsd)} (≈ ${formatInr(estimate.totalMicroUsd, env.USD_INR_RATE)}), above the ${formatUsd(estimate.capMicroUsd)} limit. Use fewer products, a lower quality, or raise STUDIO_MAX_JOB_BUDGET_USD.`,
      );
    }
  } catch (err) {
    if (err instanceof CostUnboundedError) throw new CampaignError("invalid", err.message);
    throw err;
  }

  // One subject per product image; user metadata updates it (and invalidates cached analysis via the cache key).
  const subjects = input.subjects.map((s) => {
    const prior = db.subjects.find((x) => x.primaryAssetId === s.assetId);
    const meta = { name: s.name, subjectType: s.subjectType ?? null, isSku: s.isSku ?? false, updatedAt: now() };
    const subject = prior
      ? db.subjects.update(prior.id, meta)
      : db.subjects.insert({ id: newId("sub"), primaryAssetId: s.assetId, ...meta, analysis: null, analysisModel: null, analysisCacheKey: null, analysisConfidence: null, createdAt: now() });
    return { subjectId: subject.id, assetId: s.assetId, name: s.name, subjectType: s.subjectType ?? null, isSku: s.isSku ?? false };
  });

  const copy = Object.fromEntries(fields.map((f) => [f, input.copy[f]!.trim()]));
  const direction = directionText(input);
  const campaign = db.campaigns.insert({
    referencePolicy,
    id: newId("cmp"),
    templateId: template.id,
    profileVersionId: template.currentProfileVersionId,
    copy,
    partnerLogoIds: input.partnerLogoIds,
    subjectIds: subjects.map((s) => s.subjectId),
    formatId: format.id,
    imageQuality: quality,
    outputWidth: format.width,
    outputHeight: format.height,
    direction,
    occasion: input.occasion || null,
    creativeDirectionId: input.fidelityMode === "explore" ? input.creativeDirectionId ?? null : null,
    fidelityMode: input.fidelityMode,
    preserveProductPixels: input.preserveProductPixels,
    brandKitId: brandKitId ?? null,
    brandSnapshot,
    createdAt: now(),
  });

  const jobInput: GeneratePosterInput = {
    referencePolicy,
    campaignId: campaign.id,
    templateId: template.id,
    profileVersionId: template.currentProfileVersionId,
    clusterId: input.clusterId ?? db.profiles.get(template.currentProfileVersionId)?.selectedClusterId ?? null,
    brandKitId: brandKitId ?? null,
    subjects,
    copy,
    partnerLogoIds: input.partnerLogoIds,
    formatId: format.id,
    quality,
    direction,
    occasion: input.occasion || null,
    fidelityMode: input.fidelityMode,
    preserveProductPixels: input.preserveProductPixels,
    models: { analysis: env.OPENAI_ANALYSIS_MODEL, planner: env.OPENAI_PLANNER_MODEL, image: env.OPENAI_IMAGE_MODEL, review: env.OPENAI_REVIEW_MODEL },
  };
  const { job, created } = enqueueJob(db, { kind: "generate_poster", idempotencyKey: jobKey, input: jobInput, campaignId: campaign.id });
  return { job, campaignId: campaign.id, created };
}

/** Start a new generation for an existing campaign (new scene, same inputs): an explicit, paid user action. */
export function regenerate(db: Db, campaignId: string, idempotencyKey: string) {
  const previous = db.jobs.filter((j) => j.campaignId === campaignId && j.kind === "generate_poster").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!previous) throw new CampaignError("not_found", "Campaign not found.");
  return enqueueJob(db, { kind: "generate_poster", idempotencyKey: `poster:${idempotencyKey}`, input: previous.inputSnapshot, campaignId });
}
