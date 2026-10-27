import { prepareReference, referenceEditInputs, composeReference, validateReferenceEdit, type PreparedReference } from '../../referenceProducts.js';
import { reuseReference } from './reuseReference.js';
import { preflightBudget } from '../../costs/budget.js';
import { estimateReferencePoster } from '../../costs/profiles.js';
import { createHash } from "node:crypto";
import sharp from "sharp";
import { imageCall, structuredCall, type CallContext } from "../../ai/calls.js";
import type { UserContent } from "../../ai/provider.js";
import { ingestAsset } from "../../assets/ingest.js";
import { readAssetImage } from "../../assets/read.js";
import {
  CONCEPT_PLAN_SCHEMA,
  REVIEW_SCHEMA,
  SUBJECT_ANALYSIS_SCHEMA,
  conceptPlanSchema,
  reviewSchema,
  subjectAnalysisSchema,
  type ConceptPlan,
  type Review,
  type StyleProfile,
  type SubjectAnalysis,
} from "../../contracts/ai.js";
import { buildOverlay, presentFields } from "../../compose/build.js";
import { canvasToSource, describeCrop, getFormat, sceneCrop } from "../../compose/formats.js";
import { fitSubjects, framingBrief, framingRules, matchSubjectAspects, planBackdrop, type PlannedBackdrop } from "../../compose/framing.js";
import { renderLayoutGuide } from "../../compose/layoutGuide.js";
import { compileImagePrompt, imagePromptVersion, type ManifestEntry } from "../../compose/imagePrompt.js";
import { overlayDocSchema, type CampaignCopy, type OverlayDoc } from "../../compose/overlay.js";
import { canvasScene } from "../../compose/render.js";
import { CALL_LIMITS } from "../../costs/profiles.js";
import { composeExactProducts } from "../../exactProducts.js";
import { listFonts } from "../../fonts/library.js";
import { renderDoc, snapshotRules } from "../../posters/service.js";
import { SUBJECT_ANALYST, artDirector, visualReviewer } from "../../prompts.js";
import { readStorageFile } from "../../storage.js";
import { newId, now, type AssetRecord as Asset, type PosterRecord, type ReferencePolicy } from "../../store.js";
import { JobStageError, type JobKindDef, type StageContext } from "../runner.js";

export interface GeneratePosterInput {
  referencePolicy?: ReferencePolicy;
  campaignId: string;
  templateId: string;
  profileVersionId: string;
  clusterId: string | null;
  brandKitId: string | null;
  subjects: { subjectId: string; assetId: string; name: string; subjectType: string | null; isSku: boolean; referenceProductId?: string }[];
  copy: CampaignCopy;
  partnerLogoIds: string[];
  formatId: string;
  quality: "low" | "medium" | "high";
  direction: string | null;
  /** Occasion chosen in the form (e.g. "Diwali"). */
  occasion?: string | null;
  /** match (default) | adapt | explore: each sends different instructions to the planner, image model and reviewer. */
  fidelityMode: "match" | "adapt" | "explore";
  /** Place each product's own pixels from its transparent cutout over the generated scene (FrameFlow compositor). */
  preserveProductPixels?: boolean;
  models: { analysis: string; planner: string; image: string; review: string };
}

function deps(ctx: StageContext, input = ctx.job.inputSnapshot as unknown as GeneratePosterInput) {
  const prepared = ctx.outputs.prepare_reference as PreparedReference | null | undefined;
  if (prepared) input = { ...input, subjects: prepared.subjects };
  const { env, provider } = ctx.deps;
  if (!env || !provider) throw new JobStageError("not_configured", "The worker is missing its provider configuration.");
  const call: CallContext = { db: ctx.db, env, provider, job: ctx.job };
  return { env, provider, call, input };
}

function loadContext(ctx: StageContext, input: GeneratePosterInput) {
  const version = ctx.db.profiles.get(input.profileVersionId);
  if (!version) throw new JobStageError("not_found", "The template's style profile no longer exists.");
  const profile = version.profile as unknown as StyleProfile;
  const template = ctx.db.templates.get(input.templateId);
  const refs = [...(template?.references ?? [])].sort((a, b) => a.position - b.position).map((r) => ctx.db.assets.get(r.assetId)).filter((a): a is Asset => Boolean(a));
  const hashes = version.referenceHashes;
  const refAsset = (refId: string) => refs.find((a) => a.sha256 === hashes[refId]);
  const cluster = profile.referenceClusters.find((c) => c.id === input.clusterId) ?? profile.referenceClusters.find((c) => c.id === profile.defaultClusterId) ?? profile.referenceClusters[0];
  const styleRefs = (cluster?.referenceIds ?? Object.keys(hashes)).map((id) => ({ id, asset: refAsset(id) })).filter((r): r is { id: string; asset: Asset } => Boolean(r.asset));
  const campaign = ctx.db.campaigns.require(input.campaignId, "Campaign");
  const rules = snapshotRules(campaign.brandSnapshot);
  const format = getFormat(input.formatId);
  if (!format) throw new JobStageError("invalid_format", `Unknown output format "${input.formatId}".`);
  // Primary composition is stable even when a style cluster excludes ref1.
  const primary = refs.find(a => a.sha256 === hashes.ref1);
  if (primary) { const i = styleRefs.findIndex(r => r.asset.id === primary.id); if (i >= 0) styleRefs.splice(i, 1); styleRefs.unshift({ id: 'ref1', asset: primary }); }
  const aspects = styleRefs.slice(0, 1).map((r) => r.asset.width / r.asset.height).filter((a) => a > 0);
  const refAspect = aspects.length ? aspects.reduce((a, b) => a + b, 0) / aspects.length : 1;
  const framing = framingRules(profile, format, refAspect);
  if (mode(input) !== 'match') Object.assign(framing, { source: 'default', staging: 'Staging follows the requested environment.', heroPlacement: 'Keep product identity and readable hierarchy.', backdrop: null, maxGroupWidth: 0.85, maxGroupHeight: 0.8, minTop: 0.05, minSide: 0.04, maxBottom: 0.95 });
  return { profile, cluster, styleRefs, rules, format, campaign, framing };
}

const shortId = (i: number) => `s${i + 1}`;
const mode = (input: GeneratePosterInput) => input.fidelityMode ?? "match";

/** Width/height of the product itself, ignoring transparent or plain padding around it. */
async function productAspect(storageDir: string, asset: Asset): Promise<number | null> {
  try {
    const data = await readStorageFile(storageDir, asset.normalisedPath);
    const { info } = await sharp(data).trim({ threshold: 12 }).toBuffer({ resolveWithObject: true });
    return info.width / info.height;
  } catch {
    return asset.width > 0 && asset.height > 0 ? asset.width / asset.height : null;
  }
}

export function planProblems(plan: ConceptPlan, subjectIds: string[], fields: string[]): string[] {
  const problems: string[] = [];
  if (!plan.concepts.some((c) => c.id === plan.chosenConceptId)) problems.push(`chosenConceptId "${plan.chosenConceptId}" is not one of the concept ids.`);
  for (const id of subjectIds) {
    const n = plan.subjects.filter((s) => s.subjectId === id).length;
    if (n !== 1) problems.push(`Subject ${id} must appear exactly once in subjects (found ${n}).`);
  }
  if (plan.subjects.some(s => !subjectIds.includes(s.subjectId))) problems.push('Unrequested subject in plan.');
  if (plan.texts.some(t => !fields.includes(t.field))) problems.push('Unrequested copy field in plan.');
  for (const f of fields) {
    const n = plan.texts.filter((t) => t.field === f).length;
    if (n !== 1) problems.push(`Copy field "${f}" must have exactly one text region (found ${n}).`);
  }
  const boxes = [...plan.texts.map((t) => ({ name: `text ${t.field}`, b: t })), ...plan.subjects.map((s) => ({ name: `subject ${s.subjectId}`, b: s.region }))];
  for (const { name, b } of boxes) {
    if (b.x + b.width > 1.001 || b.y + b.height > 1.001) problems.push(`${name} region extends past the canvas (x+width and y+height must be ≤ 1).`);
    if (b.width < 0.02 || b.height < 0.02) problems.push(`${name} region is too small.`);
  }
  return problems;
}

/** The template rules a style complaint may cite: always-keep invariants and excluded directions. */
export function citableStyleRules(profile: StyleProfile): string[] {
  return [...new Set([...profile.sharedInvariants, ...profile.excludedDirections].map((r) => r.trim()).filter(Boolean))];
}

/**
 * Style complaints that don't cite a real template rule ("doesn't match the
 * reference's sunset") are kept as low-severity notes and never block a poster.
 */
export function triageIssues(issues: Review["issues"], rules: string[], opts: { hasCopy: boolean } = { hasCopy: true }): (Review["issues"][number] & { advisory: boolean })[] {
  return issues.map((i) => {
    // With no copy, style complaints fixable only in the text/logo layer are about text the user chose not to add.
    const unsupported = i.category === "style_rule" && (!i.brokenRule || !rules.includes(i.brokenRule) || (!opts.hasCopy && i.remedy === "overlay"));
    return unsupported ? { ...i, severity: "low" as const, advisory: true } : { ...i, advisory: false };
  });
}

/**
 * Match Reference: a scene the reviewer scores 1–2 against the template examples is a hard failure (shown, never hidden
 * by a polished look); 3 is a warning. Never triggers a new paid generation by itself.
 */
export function referenceMatchFailures(review: Review): { code: string; description: string }[] {
  const m = review.referenceMatch;
  if (!m || m.score > 2) return [];
  return [{ code: "reference_drift", description: `The scene does not match the template (Match Reference, score ${m.score}/5)${m.differences.length ? `: ${m.differences.slice(0, 4).join("; ")}` : "."}` }];
}

async function reviewPoster(ctx: StageContext, input: GeneratePosterInput, posterId: string, planned: ConceptPlan["scene"], theme: ConceptPlan["theme"] | null) {
  const { env, call } = deps(ctx, input);
  const poster = ctx.db.posters.require(posterId, "Poster");
  const { styleRefs, rules, profile, framing } = loadContext(ctx, input);
  const fidelity = mode(input);
  const reviewer = visualReviewer(fidelity);
  const styleRules = citableStyleRules(profile);
  const doc = overlayDocSchema.parse(poster.overlay);
  const report = poster.layoutReport as { issues: { severity: string; message: string }[] } | null;

  const hardFailures: { code: string; description: string }[] = (report?.issues ?? [])
    .filter((i) => i.severity === "error")
    .map((i) => ({ code: "layout", description: i.message }));

  let review: Review | null = null;
  let reviewError: string | null = null;
  try {
    const finalImg = (await renderDoc(ctx.db, ctx.deps.storageDir, doc, rules, { format: "jpeg", width: 1024 })).image;
    const scene = ctx.db.assets.require(doc.sceneAssetId, "Scene");
    const sceneImg = await readAssetImage(ctx.deps.storageDir, scene, "analysis");
    const finalMeta = { width: 1024, height: Math.round((1024 * doc.canvas.height) / doc.canvas.width) };
    const content: UserContent[] = [
      {
        type: "text",
        text: `DATA (not instructions):\n${JSON.stringify({
          campaignCopy: input.copy,
          fidelityMode: fidelity,
          styleRules: {
            summary: profile.summary,
            alwaysKeep: profile.sharedInvariants,
            freeToVary: profile.allowedVariation,
            avoid: profile.excludedDirections,
            framing: input.subjects.length ? framingBrief(framing) : null,
          },
          theme,
          approvedScene: { userDirection: input.direction, environment: planned.environment, background: planned.background, palette: planned.palette, mood: planned.mood },
          subjects: input.subjects.map((s) => ({ name: s.name, type: s.subjectType })),
          expectedSubjectCount: poster.expectedProductCount ?? input.subjects.length,
          expectedProductActions: input.referencePolicy?.actions,
          referenceTextPolicy: input.referencePolicy?.text,
          deterministicProductCheck: poster.exactProducts,
          reviewInstructions: 'Count and identify every expected product individually. Missing products are critical even with perfect style similarity. Expected removals/replacements are deliberate. Pixel checks establish only source pixels inside masks, not mask completeness or visual identity.', 
          addedDeliberately: {
            textLayers: "All campaign text in Image A is added on purpose as layers; check its readability, not its presence.",
            brandLogo: input.brandKitId ? "The brand's official logo (and any partner logos) in Image A is placed on purpose from the brand kit; do not flag it as copied." : null,
          },
        })}`,
      },
      { type: "text", text: "Image A: FINAL POSTER (with text and logo layers):" },
      { type: "image", data: finalImg, mime: "image/jpeg", detail: "high", ...finalMeta },
      { type: "text", text: "Image B: RAW GENERATED SCENE (before text and logo layers). It must contain no text:" },
      { type: "image", data: sceneImg.data, mime: sceneImg.mime, detail: "high", width: sceneImg.width, height: sceneImg.height },
    ];
    for (const ref of styleRefs.slice(0, 3)) {
      const img = await readAssetImage(ctx.deps.storageDir, ref.asset, "analysis");
      content.push({
        type: "text",
        text: fidelity === "match"
          ? `Template example ${ref.id} (primary composition to match; KEEP products must remain, only explicit removals/replacements change; follow reference text policy):`
          : `Template example ${ref.id} (one example of the design language; its setting is not a requirement):`,
      });
      content.push({ type: "image", data: img.data, mime: img.mime, detail: "low", width: img.width, height: img.height });
    }
    for (const s of input.subjects) {
      const asset = ctx.db.assets.require(s.assetId, "Product image");
      const img = await readAssetImage(ctx.deps.storageDir, asset, "analysis");
      content.push({ type: "text", text: `Original subject "${s.name}":` });
      content.push({ type: "image", data: img.data, mime: img.mime, detail: "low", width: img.width, height: img.height });
    }
    const ask = (key: string) =>
      structuredCall(call, {
        key,
        request: {
          model: input.models.review,
          system: reviewer.system,
          content,
          schema: reviewSchema(styleRules, { matchReference: fidelity === "match" }),
          schemaName: "poster_review",
          maxOutputTokens: CALL_LIMITS.review.maxOutputTokens,
          reasoningEffort: env.OPENAI_TEXT_REASONING_EFFORT,
        },
      });
    try {
      review = (await ask("review")).data as Review;
    } catch (err) {
      // Structured output occasionally gets stuck repeating itself until the limit; one fresh attempt usually succeeds.
      if (!(err instanceof JobStageError) || err.code !== "incomplete") throw err;
      if (err.opts.detail) console.warn(`[template studio review] retrying after a cut-off answer for poster ${posterId}: ${err.opts.detail}`);
      review = (await ask("review:retry")).data as Review;
    }
  } catch (err) {
    if (!(err instanceof JobStageError) || err.opts.outcomeUnknown) throw err;
    // The poster is still shown; it is just marked as not automatically reviewed.
    reviewError = err.message;
  }

  if (review) {
    const integrity = review.productIntegrity;
    const expected = poster.expectedProductCount ?? input.subjects.length;
    if (integrity && (integrity.observedCount !== null && integrity.observedCount !== expected || integrity.missing.length || integrity.unexpected.length)) hardFailures.push({ code: 'subject_count', description: `Expected ${expected} products; reviewer observed ${integrity.observedCount ?? 'an uncertain count'}. Missing: ${integrity.missing.join(', ') || 'none named'}. Unexpected: ${integrity.unexpected.join(', ') || 'none named'}.` });
    if (integrity?.identityProblems.length) hardFailures.push({ code: 'product_identity', description: integrity.identityProblems.join('; ') });
    if (integrity?.uncertainties.length) hardFailures.push({ code: 'product_uncertain', description: integrity.uncertainties.join('; ') });
    for (const t of (input.referencePolicy?.text === "keep" ? [] : review.unwantedSceneText)) hardFailures.push({ code: "scene_text", description: `The generated image contains text: ${t}` });
    for (const c of review.copiedReferenceContent) hardFailures.push({ code: "copied_reference", description: `Copied from the reference: ${c}` });
    if (review.scores.subjectCount <= 2 && (poster.expectedProductCount ?? input.subjects.length) > 0) hardFailures.push({ code: "subject_count", description: "The reviewer thinks a product is missing or duplicated." });
    if (review.scores.subjectIdentity <= 2 && (poster.expectedProductCount ?? input.subjects.length) > 0) hardFailures.push({ code: 'product_identity', description: 'The reviewer reports a critical product identity mismatch.' });
    hardFailures.push(...referenceMatchFailures(review));
  }
  const items = review ? triageIssues(review.issues, styleRules, { hasCopy: presentFields(input.copy).length > 0 }) : [];
  if (poster.exactProducts?.requested && !poster.exactProducts.ok) hardFailures.push({ code: 'preservation_failed', description: poster.exactProducts.detail });
  const needsReview = !review || hardFailures.length > 0 || items.some((i) => i.severity === "high");
  ctx.db.reviews.insert({
    id: newId("rev"),
    posterId,
    jobId: ctx.job.id,
    model: input.models.review,
    promptVersion: reviewer.version,
    fidelityMode: fidelity,
    hardFailures,
    scores: review?.scores ?? null,
    issues: { summary: review?.summary ?? null, items, reviewError, schema: REVIEW_SCHEMA },
    referenceMatch: review?.referenceMatch ?? null,
    createdAt: now(),
  });
  ctx.db.posters.update(posterId, { reviewStatus: needsReview ? "needs_review" : "ok", updatedAt: now() });
  return { posterId, reviewStatus: needsReview ? "needs_review" : "ok", reviewError };
}

const generationStages: JobKindDef = {
  kind: "generate_poster",
  stages: [
    {
      name: "analyse_subjects",
      state: "analysing",
      paid: true,
      async run(ctx) {
        const { env, call, input } = deps(ctx);
        let analysed = 0;
        for (const s of input.subjects) {
          if (s.referenceProductId) continue;
          const asset = ctx.db.assets.require(s.assetId, "Product image");
          const cacheKey = createHash("sha256")
            .update(JSON.stringify({ sha: asset.sha256, name: s.name, type: s.subjectType, sku: s.isSku, model: input.models.analysis, prompt: SUBJECT_ANALYST.version, schema: SUBJECT_ANALYSIS_SCHEMA }))
            .digest("hex");
          const subject = ctx.db.subjects.require(s.subjectId, "Product");
          if (subject.analysisCacheKey === cacheKey && subject.analysis) continue;
          const img = await readAssetImage(ctx.deps.storageDir, asset, "analysis");
          const { data } = await structuredCall(call, {
            key: `subject:${s.subjectId}`,
            request: {
              model: input.models.analysis,
              system: SUBJECT_ANALYST.system,
              content: [
                { type: "text", text: `DATA (user metadata, authoritative):\n${JSON.stringify({ name: s.name, type: s.subjectType, isRealSku: s.isSku })}` },
                { type: "image", data: img.data, mime: img.mime, detail: CALL_LIMITS.subjectAnalysis.imageDetail, width: img.width, height: img.height },
              ],
              schema: subjectAnalysisSchema,
              schemaName: "subject_analysis",
              maxOutputTokens: CALL_LIMITS.subjectAnalysis.maxOutputTokens,
              reasoningEffort: env.OPENAI_TEXT_REASONING_EFFORT,
            },
          });
          ctx.db.subjects.update(s.subjectId, { analysis: data, analysisModel: input.models.analysis, analysisCacheKey: cacheKey, analysisConfidence: data.confidence, updatedAt: now() });
          analysed++;
        }
        return { analysed, cached: input.subjects.length - analysed };
      },
    },
    {
      name: "plan",
      state: "planning",
      paid: true,
      async run(ctx) {
        const { env, call, input } = deps(ctx);
        const { profile, cluster, styleRefs, rules, format, framing } = loadContext(ctx, input);
        const director = artDirector(mode(input));
        const { families } = await listFonts(ctx.db, input.brandKitId);
        const fields = presentFields(input.copy);
        const short = await Promise.all(
          input.subjects.map(async (s, i) => ({
            ...s,
            short: shortId(i),
            analysis: (ctx.db.subjects.get(s.subjectId)?.analysis ?? null) as SubjectAnalysis | null,
            aspect: await productAspect(ctx.deps.storageDir, ctx.db.assets.require(s.assetId, "Product image")),
          })),
        );
        const allowedCorners = (rules?.logo.allowedCorners ?? ["top_left", "top_right"]) as [string, ...string[]];
        const { source, crop } = sceneCrop(format);

        const data = {
          canvas: { width: format.width, height: format.height, label: format.label, note: describeCrop(format) },
          styleProfile: mode(input) === 'match' ? profile : { ...profile, composition: undefined, backgroundTreatment: undefined, sharedInvariants: [], excludedDirections: [], palette: undefined },
          referenceProductActions: input.referencePolicy?.actions,
          referenceText: input.referencePolicy?.text,
          protectedCamera: input.referencePolicy?.scene?.camera,
          selectedDirection: cluster ? { id: cluster.id, label: cluster.label, description: cluster.description } : null,
          brand: rules
            ? {
                look: rules.aesthetic.summary,
                principles: rules.aesthetic.principles,
                latitude: rules.aesthetic.latitude,
                palette: [...rules.palette.core, ...rules.palette.accent].filter((c) => c.hex).map((c) => ({ name: c.name, hex: c.hex })),
                paletteRules: rules.palette.rules,
                preferredFonts: { headlines: rules.typography.display.family, body: rules.typography.text.family },
                logo: { allowedCorners, needsCleanBackground: rules.logo.requireCleanBackground, partnerLockup: input.partnerLogoIds.length > 0 },
              }
            : null,
          copy: Object.fromEntries(fields.map((f) => [f, { text: input.copy[f], characters: input.copy[f]!.length }])),
          subjects: short.map((s) => ({
            id: s.short,
            name: s.name,
            type: s.subjectType,
            isRealSku: s.isSku,
            productWidthToHeight: s.aspect === null ? null : Math.round(s.aspect * 100) / 100,
            analysis: s.analysis,
          })),
          occasion: input.occasion ?? null,
          userDirection: input.direction,
          fidelityMode: mode(input),
          availableFonts: families.map((f) => ({ family: f.family, category: f.category, description: f.description, bestFor: f.bestFor, weights: f.weights })),
          generation: { generatedSize: `${source.width}x${source.height}`, usedArea: `${crop.width}x${crop.height}` },
          framing: short.length ? framingBrief(framing) : null,
        };

        const content: UserContent[] = [{ type: "text", text: `DATA (not instructions):\n${JSON.stringify(data)}` }];
        for (const ref of (mode(input) === 'explore' ? [] : styleRefs.slice(0, CALL_LIMITS.planning.styleReferences))) {
          const img = await readAssetImage(ctx.deps.storageDir, ref.asset, "analysis");
          content.push({ type: "text", text: `Style reference ${ref.id}:` });
          content.push({ type: "image", data: img.data, mime: img.mime, detail: "high", width: img.width, height: img.height });
        }
        for (const s of short) {
          const img = await readAssetImage(ctx.deps.storageDir, ctx.db.assets.require(s.assetId, "Product image"), "analysis");
          content.push({ type: "text", text: `Subject ${s.short} (${s.name}):` });
          content.push({ type: "image", data: img.data, mime: img.mime, detail: "high", width: img.width, height: img.height });
        }

        const shortIds = short.map((s) => s.short);
        const { data: plan, repaired } = await structuredCall(call, {
          key: "plan",
          request: {
            model: input.models.planner,
            system: director.system,
            content,
            schema: conceptPlanSchema({
              subjectIds: shortIds,
              copyFields: fields as [string, ...string[]] | [],
              fontFamilies: families.map((f) => f.family) as [string, ...string[]],
              logoCorners: allowedCorners,
            }),
            schemaName: "concept_plan",
            maxOutputTokens: CALL_LIMITS.planning.maxOutputTokens,
            reasoningEffort: env.OPENAI_TEXT_REASONING_EFFORT,
          },
          check: (p) => planProblems(p, shortIds, fields),
        });

        // Map short ids back to real subject ids, then hold the product group to the template's framing.
        const mapped = { ...plan, subjects: plan.subjects.map((s) => ({ ...s, subjectId: short.find((x) => x.short === s.subjectId)?.subjectId ?? s.subjectId })) };
        const aspects = Object.fromEntries(short.filter((s) => s.aspect !== null).map((s) => [s.subjectId, s.aspect as number]));
        const fitted = fitSubjects(matchSubjectAspects(mapped, aspects, format), framing);
        const realPlan: ConceptPlan = fitted.plan;
        const prepared = ctx.outputs.prepare_reference as PreparedReference | null;
        if (prepared) for (const s of realPlan.subjects) {
          const productId = input.subjects.find(x => x.subjectId === s.subjectId)?.referenceProductId;
          const product = prepared.products.find(p => p.id === productId);
          if (product) { s.region = product.region; s.placement = 'Original primary-reference product position'; s.scaleBasis = 'Protected source geometry'; }
        }
        const framingNotes = fitted.notes;
        const backdrop = planBackdrop(realPlan, framing, format);
        const existing = ctx.db.conceptPlans.find((p) => p.jobId === ctx.job.id);
        const saved = existing ?? ctx.db.conceptPlans.insert({
          id: newId("cpl"),
          jobId: ctx.job.id,
          schemaVersion: CONCEPT_PLAN_SCHEMA,
          model: input.models.planner,
          promptVersion: director.version,
          concepts: realPlan.concepts,
          chosenConceptId: realPlan.chosenConceptId,
          selectionRationale: realPlan.selectionRationale,
          scenePlan: {
            theme: realPlan.theme,
            scene: realPlan.scene,
            subjects: realPlan.subjects,
            plannedSubjects: plan.subjects,
            framing,
            framingNotes,
            backdrop,
            avoid: realPlan.avoid,
            designRationale: realPlan.designRationale,
          },
          overlayPlan: { texts: realPlan.texts, logo: realPlan.logo },
          createdAt: now(),
        });
        return { conceptPlanId: saved.id, plan: realPlan, repaired, framingNotes, backdrop };
      },
    },
    {
      name: "generate_scene",
      state: "generating",
      paid: true,
      async run(ctx) {
        const { call, input } = deps(ctx);
        const { profile, cluster, styleRefs, rules, format, framing } = loadContext(ctx, input);
        const plan = (ctx.outputs.plan as { plan: ConceptPlan }).plan;
        const plannedBackdrop = (ctx.outputs.plan as { backdrop?: PlannedBackdrop | null }).backdrop ?? null;
        const backdrop = plannedBackdrop ? { ...plannedBackdrop, region: canvasToSource(format, plannedBackdrop.region) } : null;

        const prepared = ctx.outputs.prepare_reference as PreparedReference | null;
        const editInputs = prepared ? await referenceEditInputs(ctx, input, prepared, sceneCrop(format).source) : null;
        const manifest: ManifestEntry[] = [];
        const images: { data: Buffer; mime: string; name: string }[] = [];
        const textFields = presentFields(input.copy);
        if (editInputs) { images.push({ data: editInputs.image, mime: 'image/png', name: 'primary-protected.png' }); manifest.push({ index: 1, assetId: prepared!.sourceAssetId, role: 'primary_reference', label: 'Protected primary products', subjectId: null }); }
        let layoutGuideAssetId: string;
        {
          // Layout guide first, at the generation size: the image model treats the first image as the canvas it builds on.
          const { source } = sceneCrop(format);
          const guide = await renderLayoutGuide({
            plan: { ...plan, texts: plan.texts.map((t) => ({ ...t, ...canvasToSource(format, t) })), subjects: plan.subjects.map((s) => ({ ...s, region: canvasToSource(format, s.region) })) },
            rules: framing,
            textFields,
            logoWidthPct: plan.logo.widthPct,
            backdrop,
            width: source.width,
            height: source.height,
          });
          const { asset } = await ingestAsset({ buffer: guide, role: "layout_guide", filename: `layout-${ctx.job.id}.png`, label: `Layout guide for job ${ctx.job.id}` }, { db: ctx.db, storageDir: ctx.deps.storageDir });
          layoutGuideAssetId = asset.id;
          images.push({ data: guide, mime: "image/png", name: "layout-guide.png" });
          manifest.push({ index: images.length, assetId: asset.id, role: "layout_guide", label: "Layout guide", subjectId: null });
        }

        for (const ref of (mode(input) === 'explore' ? [] : styleRefs.slice(0, CALL_LIMITS.imagePrompt.styleReferences))) {
          const img = await readAssetImage(ctx.deps.storageDir, ref.asset, "analysis");
          images.push({ data: img.data, mime: img.mime, name: `style-${ref.id}.${img.mime === "image/png" ? "png" : "jpg"}` });
          manifest.push({ index: images.length, assetId: ref.asset.id, role: "style_reference", label: ref.id, subjectId: null });
        }
        for (const s of input.subjects) {
          const asset = ctx.db.assets.require(s.assetId, "Product image");
          const img = await readAssetImage(ctx.deps.storageDir, asset, "analysis");
          images.push({ data: img.data, mime: img.mime, name: `subject-${images.length + 1}.${img.mime === "image/png" ? "png" : "jpg"}` });
          manifest.push({ index: images.length, assetId: asset.id, role: "subject_identity", label: s.name, subjectId: s.subjectId });
        }
        const prompt = compileImagePrompt({
          plan,
          profile,
          clusterId: cluster?.id ?? null,
          format,
          manifest,
          subjects: input.subjects.map((s) => ({ subjectId: s.subjectId, name: s.name, analysis: (ctx.db.subjects.get(s.subjectId)?.analysis ?? null) as SubjectAnalysis | null })),
          brand: rules,
          textFields,
          fidelityMode: mode(input),
          direction: input.direction,
          referencePolicy: input.referencePolicy,
          framing,
          backdrop,
        });

        const attempt = ctx.db.attempts.insert({
          id: newId("att"),
          jobId: ctx.job.id,
          model: input.models.image,
          quality: input.quality,
          requestedSize: `${format.width}x${format.height}`,
          providerSize: format.providerSize,
          promptVersion: imagePromptVersion(mode(input)),
          prompt,
          referenceManifest: manifest,
          providerRequestId: null,
          sceneAssetId: null,
          layoutGuideAssetId,
          latencyMs: null,
          usage: null,
          costStatus: "unknown",
          outcome: "pending",
          error: null,
          createdAt: now(),
        });
        let res;
        try {
          res = await imageCall(call, "generate_scene", { model: input.models.image, prompt, images, ...(editInputs ? { mask: editInputs.mask } : {}), size: format.providerSize, quality: input.quality });
        } catch (err) {
          const e = err as JobStageError;
          ctx.db.attempts.update(attempt.id, { outcome: e.opts?.outcomeUnknown ? "outcome_unknown" : "failed", error: { code: e.code, message: e.message } });
          throw err;
        }
        const { asset } = await ingestAsset({ buffer: res.image, role: "generated_scene", filename: `scene-${ctx.job.id}.png`, label: `Scene for job ${ctx.job.id}` }, { db: ctx.db, storageDir: ctx.deps.storageDir });
        ctx.db.attempts.update(attempt.id, {
          outcome: "succeeded",
          sceneAssetId: asset.id,
          providerRequestId: res.requestId,
          latencyMs: res.latencyMs,
          usage: res.usage ?? null,
          costStatus: res.costMicroUsd === null ? "unknown" : "usage_derived",
        });
        return { sceneAssetId: asset.id, attemptId: attempt.id, placement: editInputs?.placement };
      },
    },
    {
      name: "compose",
      state: "composing",
      paid: false,
      async run(ctx) {
        const { input } = deps(ctx);
        const { rules, format, framing } = loadContext(ctx, input);
        const plan = (ctx.outputs.plan as { plan: ConceptPlan }).plan;
        const generated = ctx.db.assets.require((ctx.outputs.generate_scene as { sceneAssetId: string }).sceneAssetId, "Scene");
        const generatedData = await readStorageFile(ctx.deps.storageDir, generated.normalisedPath);
        const { source, crop } = sceneCrop(format);
        // Scale the crop if the provider returned a different size than requested.
        const sx = generated.width / source.width;
        const sy = generated.height / source.height;
        let docCrop = { x: Math.round(crop.x * sx), y: Math.round(crop.y * sy), width: Math.round(crop.width * sx), height: Math.round(crop.height * sy) };
        let scene = generated;
        let exactProducts: PosterRecord["exactProducts"] = null;
        let productLayers: PosterRecord['productLayers'];
        let decompositionAssetId: string | undefined;
        const prepared = ctx.outputs.prepare_reference as PreparedReference | null;
        if (prepared) {
          const generatedStage = ctx.outputs.generate_scene as { placement: { x: number; y: number; width: number; height: number } };
          const exact = await composeReference(ctx, input, prepared, generatedData, generatedStage.placement, format.providerSize);
          scene = (await ingestAsset({ buffer: exact.composite, role: 'generated_scene', filename: `preserved-${ctx.job.id}.png` }, { db: ctx.db, storageDir: ctx.deps.storageDir })).asset;
          docCrop = { x: 0, y: 0, width: scene.width, height: scene.height };
          exactProducts = { requested: true, applied: true, ok: true, detail: exact.detail };
          productLayers = exact.layers;
          decompositionAssetId = (await ingestAsset({ buffer: exact.plate, role: 'generated_scene', filename: `protected-background-${ctx.job.id}.png` }, { db: ctx.db, storageDir: ctx.deps.storageDir })).asset.id;
        }
        if (!prepared && input.preserveProductPixels && input.subjects.length) {
          // FrameFlow's compositor places each product's own pixels where it was planned; on any failure the model's scene stays and says so.
          try {
            const products = await Promise.all(
              plan.subjects.map(async (s) => {
                const subject = input.subjects.find((x) => x.subjectId === s.subjectId)!;
                const cutout = ctx.db.assets.require(subject.assetId, "Product image");
                return { id: subject.subjectId, label: subject.name, cutout: await readStorageFile(ctx.deps.storageDir, cutout.normalisedPath), region: s.region };
              }),
            );
            const exact = await composeExactProducts(generatedData, docCrop, products, framing.supports);
            const { asset } = await ingestAsset({ buffer: exact.composite, role: "generated_scene", filename: `scene-exact-${ctx.job.id}.png`, label: `Scene with exact product pixels for job ${ctx.job.id}` }, { db: ctx.db, storageDir: ctx.deps.storageDir });
            scene = asset;
            docCrop = { x: 0, y: 0, width: asset.width, height: asset.height };
            exactProducts = { requested: true, applied: true, ok: exact.ok, detail: exact.detail };
          } catch (err) {
            throw new JobStageError('preservation_failed', `Exact product pixels could not be applied: ${(err as Error).message}. No redraw was accepted.`);
          }
        }
        const sceneData = scene === generated ? generatedData : await readStorageFile(ctx.deps.storageDir, scene.normalisedPath);
        // Keep the full primary canvas: source products are never cropped or stretched to fit an export preset.
        const composeFormat = prepared ? { ...format, width: scene.width, height: scene.height } : format;
        const tmpDoc = { crop: docCrop, canvas: { width: composeFormat.width, height: composeFormat.height } };
        const { raw } = await canvasScene(tmpDoc, sceneData);
        const { families } = await listFonts(ctx.db, input.brandKitId);

        const doc: OverlayDoc = buildOverlay({
          plan,
          copy: input.copy,
          format: composeFormat,
          crop: docCrop,
          sceneAssetId: scene.id,
          sceneRaw: raw,
          fontFamilies: families.map((f) => f.family),
          rules,
          brandKitId: input.brandKitId,
          partnerLogoIds: input.partnerLogoIds,
        });
        if (prepared) doc.notes.push(...prepared.warnings, 'Reference product composition retains the original canvas proportions; export dimensions follow this canvas.');
        overlayDocSchema.parse(doc);
        const { report } = await renderDoc(ctx.db, ctx.deps.storageDir, doc, rules, { format: "png", width: 64 });
        const existing = ctx.db.posters.find((p) => p.jobId === ctx.job.id);
        const poster = existing ?? ctx.db.posters.insert({
          id: newId("pst"),
          campaignId: input.campaignId,
          jobId: ctx.job.id,
          sceneAssetId: scene.id,
          rawSceneAssetId: scene === generated ? null : generated.id,
          exactProducts, productLayers, decompositionAssetId, provenance: 'ai_generated', expectedProductCount: input.subjects.length,
          overlay: doc,
          layoutReport: report,
          reviewStatus: "pending",
          approvedAt: null,
          createdAt: now(),
          updatedAt: now(),
        });
        return { posterId: poster.id, layoutErrors: report.issues.filter((i) => i.severity === "error").length };
      },
    },
    {
      name: "review",
      state: "reviewing",
      paid: true,
      async run(ctx) {
        const { posterId } = ctx.outputs.compose as { posterId: string };
        const plan = (ctx.outputs.plan as { plan: ConceptPlan }).plan;
        return reviewPoster(ctx, deps(ctx).input, posterId, plan.scene, plan.theme ?? null);
      },
    },
  ],
  finish(outputs) {
    const review = outputs.review as { posterId: string; reviewStatus: string };
    return { state: review.reviewStatus === "ok" ? "complete" : "needs_review", result: { posterId: review.posterId } };
  },
};

/** New jobs use an explicit reference policy. Earlier completed jobs remain readable. */
export const generatePosterJob: JobKindDef = {
  ...generationStages,
  stages: [
    { name: 'preflight', state: 'planning', paid: false, async run(ctx) {
      const { input, env } = deps(ctx);
      if (input.referencePolicy?.localReuse) return { local: true };
      if (!input.referencePolicy) throw new JobStageError('legacy_request', 'This older generation request lacks explicit reference-product choices. Start a new generation from the template; no paid work was repeated.');
      validateReferenceEdit(input.referencePolicy);
      const format = getFormat(input.formatId)!;
      const estimate = estimateReferencePoster(env, input.referencePolicy, { subjects: input.subjects.length, quality: input.quality, size: format.providerSize });
      try { preflightBudget(ctx.db, env, estimate.totalMicroUsd); }
      catch (err) { throw new JobStageError('budget_exceeded', (err as Error).message); }
      return { estimateMicroUsd: estimate.totalMicroUsd };
    } },
    { name: 'reuse_reference', state: 'composing', paid: false, async run(ctx) {
      const { input } = deps(ctx); return input.referencePolicy?.localReuse ? reuseReference(ctx, input) : null;
    } },
    { name: 'prepare_reference', state: 'analysing', paid: true, async run(ctx) { return ctx.outputs.reuse_reference ? null : prepareReference(ctx, deps(ctx).input); } },
    ...generationStages.stages.map(stage => ({ ...stage, async run(ctx: StageContext) {
      if (ctx.outputs.reuse_reference) return stage.name === 'review' ? ctx.outputs.reuse_reference : { skipped: 'local reference reuse' };
      return stage.run(ctx);
    } })),
  ],
};

/** Re-run only the review for an existing poster (an explicit, paid user action). No image call. */
export const reviewPosterJob: JobKindDef = {
  kind: "review_poster",
  stages: [
    {
      name: "review",
      state: "reviewing",
      paid: true,
      async run(ctx) {
        const { posterId } = ctx.job.inputSnapshot as unknown as { posterId: string };
        const poster = ctx.db.posters.get(posterId);
        if (!poster?.jobId) throw new JobStageError("not_found", "The poster no longer exists.");
        const original = ctx.db.jobs.require(poster.jobId, "Job");
        const plan = ctx.db.conceptPlans.find((p) => p.jobId === poster.jobId);
        if (!plan) throw new JobStageError("not_found", "The poster's art direction is missing.");
        const saved = plan.scenePlan as unknown as { scene: ConceptPlan["scene"]; theme?: ConceptPlan["theme"] };
        const savedInput = original.inputSnapshot as unknown as GeneratePosterInput;
        const prepared = ctx.db.stages.find(s => s.jobId === original.id && s.stage === 'prepare_reference' && s.status === 'done')?.output as PreparedReference | null;
        return reviewPoster(ctx, prepared ? { ...savedInput, subjects: prepared.subjects } : savedInput, posterId, saved.scene, saved.theme ?? null);
      },
    },
  ],
  finish(outputs) {
    const review = outputs.review as { posterId: string; reviewStatus: string };
    return { state: "complete", result: { posterId: review.posterId, reviewStatus: review.reviewStatus } };
  },
};
