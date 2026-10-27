import { beforeEach, describe, expect, it } from "vitest";
import { parseStudioEnv } from "./config.js";
import { BudgetExceededError, releaseReservation, reserveBudget, settleUsage, spentToday } from "./costs/budget.js";
import { CostUnboundedError, costFromUsage, estimateImageCall, estimateTextCall, formatInr, visionTokens } from "./costs/estimate.js";
import { describeMoney, estimatePoster, estimateTemplateCreation } from "./costs/profiles.js";
import { enqueueJob } from "./jobs/queue.js";
import { tempStudio } from "./testing/harness.js";

const env = parseStudioEnv({}, "/tmp/template-studio-unused");

describe("vision token formula (patch-based models)", () => {
  it("matches the published worked examples (1.2× multiplier)", () => {
    expect(visionTokens("gpt-5.6-luna", { width: 1024, height: 1024 }, "high")).toBe(1229);
    expect(visionTokens("gpt-5.6-luna", { width: 2048, height: 2048 }, "high")).toBe(3000);
    // The published 4096×512 example (2458) is for gpt-6-astra, which has no 2048px limit.
    // For luna, "high" first fits within 2048×2048: 2048×256 → 64×8 patches.
    expect(visionTokens("gpt-5.6-luna", { width: 4096, height: 512 }, "high")).toBe(Math.ceil(512 * 1.2));
  });

  it("caps low detail at 512×512", () => {
    expect(visionTokens("gpt-5.6-luna", { width: 1536, height: 1024 }, "low")).toBe(Math.ceil(16 * 11 * 1.2));
  });

  it("uses a conservative multiplier when none is published", () => {
    expect(visionTokens("gpt-6-luna", { width: 1024, height: 1024 }, "high")).toBe(Math.ceil(1024 * 1.5));
  });
});

describe("estimates", () => {
  it("refuses to estimate unknown models or unbounded output", () => {
    expect(() => estimateTextCall({ model: "mystery-model", promptChars: 10, images: [], imageDetail: "low", maxOutputTokens: 100 })).toThrow(
      CostUnboundedError,
    );
    expect(() => estimateTextCall({ model: "gpt-6-luna", promptChars: 10, images: [], imageDetail: "low", maxOutputTokens: 0 })).toThrow(
      /max output/,
    );
  });

  it("prices gpt-image-2 output from the published per-image table", () => {
    const e = estimateImageCall({ model: "gpt-image-2", quality: "high", size: "1024x1536", promptChars: 0, referenceImages: 0 });
    expect(e.breakdown.find((b) => b.label.startsWith("Image output"))?.microUsd).toBe(165_000);
    expect(e.microUsd).toBe(Math.ceil(165_000 * 1.2));
  });

  it("scales unpublished custom sizes up, never down", () => {
    const e = estimateImageCall({ model: "gpt-image-2", quality: "high", size: "2048x2048", promptChars: 0, referenceImages: 0 });
    expect(e.breakdown.at(-1)?.microUsd).toBe(211_000 * 4);
  });

  it("keeps template creation well within the $1 template limit", () => {
    const w = estimateTemplateCreation(env, 3);
    expect(w.withinCap).toBe(true);
    expect(w.totalMicroUsd).toBeLessThan(50_000); // under 5 cents with gpt-6-luna
  });

  it("keeps a 6-product high-quality poster within the $1 job limit", () => {
    const w = estimatePoster(env, { subjects: 6 });
    expect(w.withinCap).toBe(true);
    // The image call dominates; text roles stay small.
    const image = w.calls.find((c) => c.stage.startsWith("Scene image"))!.estimate.microUsd;
    expect(image / w.totalMicroUsd).toBeGreaterThan(0.9);
  });

  it("formats rupees at the configured rate", () => {
    expect(formatInr(350_000, 100)).toBe("₹35");
    expect(formatInr(8_800, 100)).toBe("₹0.88");
    expect(formatInr(0, 100)).toBe("₹0");
  });
});

describe("costFromUsage", () => {
  it("prices Responses usage with cached tokens and includes reasoning once", () => {
    // 10k input (2k cached), 3k output (of which 1k reasoning, already counted in output_tokens)
    const usage = { input_tokens: 10_000, input_tokens_details: { cached_tokens: 2_000 }, output_tokens: 3_000, output_tokens_details: { reasoning_tokens: 1_000 } };
    expect(costFromUsage("gpt-6-luna", usage)).toBe(8_000 * 0.1 + 2_000 * 0.01 + 3_000 * 0.5);
  });

  it("adds the 1.25× surcharge for cache-write tokens (real gpt-6-luna usage shape)", () => {
    const usage = { input_tokens: 3097, input_tokens_details: { cache_write_tokens: 3094, cached_tokens: 0 }, output_tokens: 1680, output_tokens_details: { reasoning_tokens: 94 } };
    expect(costFromUsage("gpt-6-luna", usage)).toBe(Math.ceil(3097 * 0.1 + 3094 * 0.1 * 0.25 + 1680 * 0.5));
  });

  it("prices Images usage by text/image split, or at the image rate when the split is missing", () => {
    const split = { input_tokens: 8_000, input_tokens_details: { text_tokens: 1_000, image_tokens: 7_000 }, output_tokens: 5_000 };
    expect(costFromUsage("gpt-image-2", split)).toBe(1_000 * 5 + 7_000 * 8 + 5_000 * 30);
    expect(costFromUsage("gpt-image-2", { input_tokens: 8_000, output_tokens: 5_000 })).toBe(8_000 * 8 + 5_000 * 30);
  });

  it("returns unknown (null), never zero, when usage is missing", () => {
    expect(costFromUsage("gpt-image-2", undefined)).toBeNull();
    expect(costFromUsage("gpt-image-2", { foo: 1 })).toBeNull();
    expect(costFromUsage("unknown-model", { input_tokens: 1, output_tokens: 1 })).toBeNull();
  });
});

describe("budget reservations", () => {
  let ctx: ReturnType<typeof tempStudio>;
  beforeEach(() => {
    ctx = tempStudio();
  });

  const job = async (kind: "generate_poster" | "analyse_template", key: string) =>
    (await enqueueJob(ctx.db, { kind, idempotencyKey: key, input: {} })).job;

  it("refuses a step that would push a template job past its $1 limit", async () => {
    const j = await job("analyse_template", "t1");
    const tight = parseStudioEnv({ STUDIO_MAX_TEMPLATE_BUDGET_USD: "0.01" }, "/tmp/template-studio-unused");
    await reserveBudget(ctx.db, tight, { jobId: j.id, jobKind: j.kind, stage: "analyse", estimateMicroUsd: 8_000 });
    expect(() =>
      reserveBudget(ctx.db, tight, { jobId: j.id, jobKind: j.kind, stage: "repair", estimateMicroUsd: 6_000 }),
    ).toThrow(BudgetExceededError);
  });

  it("enforces the daily limit across jobs", async () => {
    const daily = parseStudioEnv({ STUDIO_DAILY_BUDGET_USD: "0.50" }, "/tmp/template-studio-unused");
    const a = await job("generate_poster", "p1");
    const b = await job("generate_poster", "p2");
    await reserveBudget(ctx.db, daily, { jobId: a.id, jobKind: a.kind, stage: "generate", estimateMicroUsd: 400_000 });
    expect(() =>
      reserveBudget(ctx.db, daily, { jobId: b.id, jobKind: b.kind, stage: "generate", estimateMicroUsd: 200_000 }),
    ).toThrow(/Today's spending limit/);
  });

  it("is idempotent per job stage (a resumed stage doesn't double-reserve)", async () => {
    const j = await job("generate_poster", "p3");
    const first = await reserveBudget(ctx.db, env, { jobId: j.id, jobKind: j.kind, stage: "generate", estimateMicroUsd: 300_000 });
    const again = await reserveBudget(ctx.db, env, { jobId: j.id, jobKind: j.kind, stage: "generate", estimateMicroUsd: 300_000 });
    expect(again.id).toBe(first.id);
    expect(await spentToday(ctx.db)).toBe(300_000);
  });

  it("settles to the usage-derived cost, and keeps the hold when usage is unknown", async () => {
    const j = await job("generate_poster", "p4");
    await reserveBudget(ctx.db, env, { jobId: j.id, jobKind: j.kind, stage: "plan", estimateMicroUsd: 10_000 });
    await reserveBudget(ctx.db, env, { jobId: j.id, jobKind: j.kind, stage: "generate", estimateMicroUsd: 400_000 });

    const derived = await settleUsage(ctx.db, {
      jobId: j.id, stage: "plan", model: "gpt-6-luna", estimateMicroUsd: 10_000,
      usage: { input_tokens: 5_000, output_tokens: 1_000 },
    });
    expect(derived).toBe(5_000 * 0.1 + 1_000 * 0.5);
    const unknown = await settleUsage(ctx.db, { jobId: j.id, stage: "generate", model: "gpt-image-2", estimateMicroUsd: 400_000, usage: null });
    expect(unknown).toBeNull();

    expect(await spentToday(ctx.db)).toBe(1_000 + 400_000);
    const ledger = ctx.db.usage.filter((u) => u.jobId === j.id);
    expect(ledger.map((l) => l.costUnknown)).toEqual([false, true]);
  });

  it("returns released holds to the budget", async () => {
    const j = await job("generate_poster", "p5");
    await reserveBudget(ctx.db, env, { jobId: j.id, jobKind: j.kind, stage: "generate", estimateMicroUsd: 400_000 });
    await releaseReservation(ctx.db, j.id, "generate");
    expect(await spentToday(ctx.db)).toBe(0);
  });
});

// FrameFlow: rupees use the one configured rate (AI_BUDGET_USD_INR), never a live exchange rate.
describe("configured USD→INR rate", () => {
  it("uses FrameFlow's planning rate by default and states its source", () => {
    const e = parseStudioEnv({}, "/tmp/template-studio-unused");
    expect(e.fx).toMatchObject({ rate: 90, source: "configured", variable: "AI_BUDGET_USD_INR" });
    expect(describeMoney(1_000_000, e).inr).toBe("₹90");
  });

  it("follows AI_BUDGET_USD_INR when it is set", () => {
    const e = parseStudioEnv({ AI_BUDGET_USD_INR: "100" }, "/tmp/template-studio-unused");
    expect(e.fx.rate).toBe(100);
    expect(e.fx.note).toContain("AI_BUDGET_USD_INR");
    expect(describeMoney(1_000_000, e).inr).toBe("₹100");
  });
});
