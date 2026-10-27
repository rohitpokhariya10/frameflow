import { z } from "zod";
import type { ServerEnv } from "../config.js";
import { enqueueJob } from "../jobs/queue.js";
import type { AnalyseTemplateInput } from "../jobs/kinds/analyseTemplate.js";
import { estimateTemplateCreation } from "../costs/profiles.js";
import { newId, now, type StudioStore as Db } from "../store.js";

export class TemplateError extends Error {
  constructor(
    public readonly code: "not_found" | "invalid" | "over_budget" | "busy",
    message: string,
  ) {
    super(message);
    this.name = "TemplateError";
  }
}

export const createTemplateSchema = z.object({
  name: z.string().trim().min(1, "Give the template a name.").max(120),
  guidance: z.string().trim().max(2000).nullable().optional(),
  brandKitId: z.string().nullable().optional(),
  referenceAssetIds: z.array(z.string().min(1)).min(1, "Add at least one reference image.").max(3, "Use at most three reference images."),
});

export function createTemplate(db: Db, input: z.infer<typeof createTemplateSchema>) {
  const assets = input.referenceAssetIds.map((id) => db.assets.get(id));
  if (new Set(input.referenceAssetIds).size !== input.referenceAssetIds.length || assets.some((a) => !a || a.role !== "reference")) {
    throw new TemplateError("invalid", "Reference images must be uploaded as 'Template reference'.");
  }
  if (input.brandKitId && !db.brandKits.get(input.brandKitId)) {
    throw new TemplateError("invalid", "Brand kit not found.");
  }
  const at = now();
  return db.templates.insert({
    id: newId("tpl"),
    name: input.name,
    creatorGuidance: input.guidance || null,
    brandKitId: input.brandKitId || null,
    status: "draft",
    currentProfileVersionId: null,
    thumbnailAssetId: input.referenceAssetIds[0],
    references: input.referenceAssetIds.map((assetId, position) => ({ assetId, position })),
    createdAt: at,
    updatedAt: at,
  });
}

export function startAnalysis(db: Db, env: ServerEnv, templateId: string, idempotencyKey: string) {
  const template = db.templates.get(templateId);
  if (!template) throw new TemplateError("not_found", "Template not found.");
  const estimate = estimateTemplateCreation(env, template.references.length);
  if (!estimate.withinCap) {
    throw new TemplateError("over_budget", "Analysing these references could exceed the template budget (STUDIO_MAX_TEMPLATE_BUDGET_USD).");
  }
  const input: AnalyseTemplateInput = {
    templateId,
    referenceAssetIds: [...template.references].sort((a, b) => a.position - b.position).map((r) => r.assetId),
    guidance: template.creatorGuidance,
    model: env.OPENAI_ANALYSIS_MODEL,
  };
  const { job, created } = enqueueJob(db, { kind: "analyse_template", idempotencyKey: `analyse:${templateId}:${idempotencyKey}`, input });
  if (created) db.templates.update(templateId, { status: "analysing", updatedAt: now() });
  return { job, created, estimateMicroUsd: estimate.totalMicroUsd };
}

const analysisJobs = (db: Db, templateId: string) => db.jobs.filter((j) => j.kind === "analyse_template" && j.idempotencyKey.startsWith(`analyse:${templateId}:`));

/** Status shown in the UI, derived from the latest analysis job when one is running or failed. */
export function templateView(db: Db, templateId: string) {
  const template = db.templates.get(templateId);
  if (!template) return null;
  const jobs = analysisJobs(db, templateId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latestJob = jobs[0] ?? null;
  const profile = db.profiles.get(template.currentProfileVersionId);
  let status = template.status;
  if (latestJob && !["complete", "needs_review"].includes(latestJob.state)) {
    status = ["failed", "cancelled"].includes(latestJob.state) ? (profile ? "ready" : "failed") : "analysing";
  }
  const jobIds = new Set(jobs.map((j) => j.id));
  const usage = db.usage.filter((u) => u.jobId !== null && jobIds.has(u.jobId));
  return { template, profile: profile ?? null, status, latestJob, usage };
}
