import { z } from "zod";
import type { ServerEnv } from "../config.js";
import type { JobRecord as Job, StudioStore as Db } from "../store.js";
import { BudgetExceededError, releaseReservation, reserveBudget, settleUsage } from "../costs/budget.js";
import { CostUnboundedError, estimateImageCall, estimateTextCall } from "../costs/estimate.js";
import { JobStageError } from "../jobs/runner.js";
import { ProviderCallError, type ImageEditRequest, type Provider, type StructuredRequest, type UserContent } from "./provider.js";

/**
 * Every paid call goes through here: estimate → reserve budget → call →
 * record usage → validate. Structured outputs get at most one bounded repair
 * request when they fail validation.
 */

export interface CallContext {
  db: Db;
  env: ServerEnv;
  provider: Provider;
  job: Job;
}

function toStageError(err: unknown): never {
  if (err instanceof BudgetExceededError) throw new JobStageError("budget_exceeded", err.message);
  if (err instanceof CostUnboundedError) throw new JobStageError("cost_unbounded", err.message);
  throw err;
}

async function reserve(ctx: CallContext, key: string, microUsd: number) {
  try {
    reserveBudget(ctx.db, ctx.env, { jobId: ctx.job.id, jobKind: ctx.job.kind, stage: key, estimateMicroUsd: microUsd });
  } catch (err) {
    toStageError(err);
  }
}

async function failProvider(ctx: CallContext, key: string, err: unknown): Promise<never> {
  if (err instanceof ProviderCallError) {
    if (!err.info.outcomeUnknown) releaseReservation(ctx.db, ctx.job.id, key);
    throw new JobStageError(err.info.code, err.info.message, {
      outcomeUnknown: err.info.outcomeUnknown,
      detail: err.info.detail,
      requestId: err.info.requestId,
    });
  }
  throw err;
}

function promptChars(req: Pick<StructuredRequest, "system" | "content" | "schema">) {
  const text = req.content.filter((c): c is Extract<UserContent, { type: "text" }> => c.type === "text").reduce((n, c) => n + c.text.length, 0);
  return req.system.length + text + JSON.stringify(z.toJSONSchema(req.schema)).length;
}

export interface StructuredCallOptions<T> {
  /** Unique within the job, e.g. "plan" or "subject:abc". Used for budget holds and the usage ledger. */
  key: string;
  request: StructuredRequest & { schema: z.ZodType<T> };
  /** Extra semantic checks after schema validation; return problems to trigger one repair. */
  check?: (data: T) => string[];
}

export async function structuredCall<T>(ctx: CallContext, opts: StructuredCallOptions<T>): Promise<{ data: T; repaired: boolean }> {
  const { request } = opts;
  const images = request.content.filter((c): c is Extract<UserContent, { type: "image" }> => c.type === "image");
  let estimate;
  try {
    estimate = estimateTextCall({
      model: request.model,
      promptChars: promptChars(request),
      images: images.map((i) => ({ width: i.width, height: i.height })),
      imageDetail: images.some((i) => i.detail === "high") ? "high" : "low",
      maxOutputTokens: request.maxOutputTokens,
    });
  } catch (err) {
    toStageError(err);
  }
  await reserve(ctx, opts.key, estimate.microUsd);

  const cached = ctx.db.usage.find(u => u.jobId === ctx.job.id && u.stage === opts.key);
  let res;
  try {
    if (cached && !cached.response) throw new JobStageError('outcome_unknown', 'This paid response was not saved. It will not be sent again.', { outcomeUnknown: true });
    res = cached ? { ...cached.response!, usage: cached.rawUsage, requestId: cached.providerRequestId } : await ctx.provider.structured(request);
  } catch (err) {
    return failProvider(ctx, opts.key, err);
  }
  settleUsage(ctx.db, {
    jobId: ctx.job.id,
    stage: opts.key,
    model: request.model,
    usage: res.usage,
    providerRequestId: res.requestId,
    estimateMicroUsd: estimate.microUsd,
  });

  const recorded = ctx.db.usage.find(u => u.jobId === ctx.job.id && u.stage === opts.key)!;
  ctx.db.usage.update(recorded.id, { response: { text: res.text, refusal: res.refusal, incompleteReason: res.incompleteReason } });

  if (res.refusal) {
    throw new JobStageError("refusal", "The model declined this request. Check the images and text for anything it may not process.", {
      detail: res.refusal,
      requestId: res.requestId,
    });
  }
  if (res.incompleteReason) {
    throw new JobStageError(
      "incomplete",
      res.incompleteReason === "max_output_tokens"
        ? "The model ran out of output space before finishing. Try fewer inputs or shorter guidance."
        : `The response stopped early (${res.incompleteReason}).`,
      // Start and end of the cut-off answer, to tell a too-small limit from a model stuck repeating itself.
      { requestId: res.requestId, detail: res.text ? `${res.text.slice(0, 300)} … ${res.text.slice(-300)}` : undefined },
    );
  }

  const first = validate(res.text, request.schema, opts.check);
  if (first.ok) return { data: first.data, repaired: false };

  // One bounded repair request: text only, with the problems listed.
  const repairKey = `${opts.key}:repair`;
  const repairRequest: StructuredRequest = {
    ...request,
    content: [
      {
        type: "text",
        text: `Your previous response did not pass validation. Return the complete corrected JSON object.\n\nProblems:\n- ${first.problems.join("\n- ")}\n\nPrevious response:\n${(res.text ?? "").slice(0, 60_000)}`,
      },
    ],
    maxOutputTokens: Math.min(request.maxOutputTokens, 8_000),
  };
  let repairEstimate;
  try {
    repairEstimate = estimateTextCall({
      model: request.model,
      promptChars: promptChars(repairRequest),
      images: [],
      imageDetail: "low",
      maxOutputTokens: repairRequest.maxOutputTokens,
    });
  } catch (err) {
    toStageError(err);
  }
  await reserve(ctx, repairKey, repairEstimate.microUsd);
  let repaired;
  const cachedRepair = ctx.db.usage.find(u => u.jobId === ctx.job.id && u.stage === repairKey);
  try {
    if (cachedRepair && !cachedRepair.response) throw new JobStageError('outcome_unknown', 'The paid repair response was not saved and will not be repeated.', { outcomeUnknown: true });
    repaired = cachedRepair ? { ...cachedRepair.response!, usage: cachedRepair.rawUsage, requestId: cachedRepair.providerRequestId } : await ctx.provider.structured(repairRequest);
  } catch (err) {
    return failProvider(ctx, repairKey, err);
  }
  settleUsage(ctx.db, {
    jobId: ctx.job.id,
    stage: repairKey,
    model: request.model,
    usage: repaired.usage,
    providerRequestId: repaired.requestId,
    estimateMicroUsd: repairEstimate.microUsd,
  });
  const repairRecord = ctx.db.usage.find(u => u.jobId === ctx.job.id && u.stage === repairKey)!;
  ctx.db.usage.update(repairRecord.id, { response: { text: repaired.text, refusal: repaired.refusal, incompleteReason: repaired.incompleteReason } });
  const second = validate(repaired.text, request.schema, opts.check);
  if (second.ok) return { data: second.data, repaired: true };
  throw new JobStageError("invalid_output", "The model's answer didn't match the required structure, even after one correction attempt.", {
    detail: second.problems.slice(0, 10).join("; "),
    requestId: repaired.requestId,
  });
}

function validate<T>(text: string | null, schema: z.ZodType<T>, check?: (d: T) => string[]): { ok: true; data: T } | { ok: false; problems: string[] } {
  if (!text) return { ok: false, problems: ["The response was empty."] };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, problems: ["The response was not valid JSON."] };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  const problems = check?.(parsed.data) ?? [];
  return problems.length ? { ok: false, problems } : { ok: true, data: parsed.data };
}

export async function imageCall(ctx: CallContext, key: string, request: ImageEditRequest) {
  if (ctx.db.usage.find(u => u.jobId === ctx.job.id && u.stage === key)) throw new JobStageError('outcome_unknown', 'An image call with this key was already billed. It will not be repeated.', { outcomeUnknown: true });
  let estimate;
  try {
    estimate = estimateImageCall({
      model: request.model,
      quality: request.quality,
      size: request.size,
      promptChars: request.prompt.length,
      referenceImages: request.images.length,
    });
  } catch (err) {
    toStageError(err);
  }
  await reserve(ctx, key, estimate.microUsd);
  let res;
  const started = Date.now();
  try {
    res = await ctx.provider.editImage(request);
  } catch (err) {
    return failProvider(ctx, key, err);
  }
  const costMicroUsd = settleUsage(ctx.db, {
    jobId: ctx.job.id,
    stage: key,
    model: request.model,
    usage: res.usage,
    providerRequestId: res.requestId,
    estimateMicroUsd: estimate.microUsd,
  });
  return { ...res, latencyMs: Date.now() - started, estimateMicroUsd: estimate.microUsd, costMicroUsd };
}
