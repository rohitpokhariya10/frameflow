import type { ServerEnv } from "../config.js";
import { newId, now, type BudgetReservationRecord, type StudioStore } from "../store.js";
import { costFromUsage, formatInr, formatUsd } from "./estimate.js";
import { RATE_CARD_VERSION } from "./rateCard.js";

/**
 * Best-effort spending limits enforced by the application (not provider
 * billing caps). Before every paid call the worker reserves the call's
 * upper-bound estimate; the call is refused if it would exceed the job's cap
 * or the daily cap. After the call the reservation is settled with the
 * usage-derived cost, or kept at the reserved amount when usage is unknown.
 *
 * Only the in-process worker makes paid calls, and the store applies a
 * read-check-write without awaiting, so reservations never race.
 */

const toMicro = (usd: number) => Math.round(usd * 1_000_000);

export class BudgetExceededError extends Error {
  readonly code = "budget_exceeded";
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export function jobCapMicroUsd(kind: string, env: ServerEnv): number {
  return toMicro(kind === "analyse_template" ? env.MAX_TEMPLATE_BUDGET_USD : env.MAX_JOB_BUDGET_USD);
}

/** Start of the current day in the server's local time zone. */
export function startOfToday(at = new Date()) {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Amount a reservation counts against limits: actual when settled with usage, otherwise the hold. */
function charged(r: Pick<BudgetReservationRecord, "status" | "microUsd" | "actualMicroUsd">) {
  if (r.status === "released") return 0;
  return r.actualMicroUsd ?? r.microUsd;
}

export function spentToday(db: StudioStore, at = new Date()) {
  const since = startOfToday(at).toISOString();
  return db.reservations.filter((r) => (r.createdAt >= since || r.status === 'held') && r.status !== "released").reduce((s, r) => s + charged(r), 0);
}

export function budgetStatus(db: StudioStore, env: ServerEnv) {
  const cap = toMicro(env.DAILY_BUDGET_USD), used = spentToday(db);
  const held = db.reservations.filter(r => r.status === 'held').reduce((s, r) => s + r.microUsd, 0);
  const reset = startOfToday(); reset.setDate(reset.getDate() + 1);
  return { cap, used, held, remaining: Math.max(0, cap - used), resets: reset.toISOString() };
}

/** Whole-operation check before any paid preparation. Per-call reservations remain authoritative. */
export function preflightBudget(db: StudioStore, env: ServerEnv, estimateMicroUsd: number, kind = 'generate_poster') {
  if (!Number.isSafeInteger(estimateMicroUsd) || estimateMicroUsd < 0) throw new BudgetExceededError('Invalid operation estimate.');
  if (estimateMicroUsd === 0) return;
  const cap = jobCapMicroUsd(kind, env), daily = budgetStatus(db, env);
  if (estimateMicroUsd > cap) throw new BudgetExceededError(`Operation estimate ${formatUsd(estimateMicroUsd)} exceeds the per-job limit ${formatUsd(cap)}. No paid preparation started.`);
  if (estimateMicroUsd > daily.remaining) throw new BudgetExceededError(`Operation estimate ${formatUsd(estimateMicroUsd)} exceeds the remaining Studio daily budget ${formatUsd(daily.remaining)} (cap ${formatUsd(daily.cap)}, used/reserved ${formatUsd(daily.used)}). No paid preparation started.`);
}

export function reserveBudget(
  db: StudioStore,
  env: ServerEnv,
  args: { jobId: string; jobKind: string; stage: string; estimateMicroUsd: number; now?: Date },
) {
  if (!Number.isSafeInteger(args.estimateMicroUsd) || args.estimateMicroUsd < 0) throw new BudgetExceededError('Invalid call estimate.');
  const jobCap = jobCapMicroUsd(args.jobKind, env);
  const dailyCap = toMicro(env.DAILY_BUDGET_USD);
  const money = (m: number) => `${formatUsd(m)} (≈ ${formatInr(m, env.USD_INR_RATE)})`;

  const existing = db.reservations.find((r) => r.jobId === args.jobId && r.stage === args.stage);
  if (existing && existing.status !== "released") return existing;

  const jobSpent = db.reservations.filter((r) => r.jobId === args.jobId).reduce((s, r) => s + charged(r), 0);
  if (jobSpent + args.estimateMicroUsd > jobCap) {
    throw new BudgetExceededError(
      `This step could cost up to ${money(args.estimateMicroUsd)}, which would take this job past its ${money(jobCap)} limit (already used ${money(jobSpent)}).`,
    );
  }
  const daySpent = spentToday(db, args.now);
  if (daySpent + args.estimateMicroUsd > dailyCap) {
    throw new BudgetExceededError(
      `Today's spending limit of ${money(dailyCap)} would be exceeded (used ${money(daySpent)}, this step up to ${money(args.estimateMicroUsd)}). Raise STUDIO_DAILY_BUDGET_USD or try tomorrow.`,
    );
  }

  return existing
    ? db.reservations.update(existing.id, { status: "held", microUsd: args.estimateMicroUsd, actualMicroUsd: null, updatedAt: now() })
    : db.reservations.insert({ id: newId("bud"), jobId: args.jobId, stage: args.stage, microUsd: args.estimateMicroUsd, actualMicroUsd: null, status: "held", createdAt: now(), updatedAt: now() });
}

/**
 * Record what a call actually cost and settle its reservation. Missing or
 * unreadable usage is stored as unknown; the reservation then stays charged at
 * the estimate rather than being treated as free.
 */
export function settleUsage(
  db: StudioStore,
  args: {
    jobId: string;
    stage: string;
    model: string;
    usage: unknown;
    providerRequestId?: string | null;
    estimateMicroUsd: number;
  },
) {
  const previous = db.usage.find(r => r.jobId === args.jobId && r.stage === args.stage);
  if (previous) {
    db.reservations.updateMany(r => r.jobId === args.jobId && r.stage === args.stage && r.status === 'held', () => ({ status: 'settled', actualMicroUsd: previous.usageDerivedMicroUsd, updatedAt: now() }));
    return previous.usageDerivedMicroUsd;
  }
  const derived = costFromUsage(args.model, args.usage);
  db.usage.insert({
    id: newId("use"),
    jobId: args.jobId,
    stage: args.stage,
    model: args.model,
    providerRequestId: args.providerRequestId ?? null,
    rawUsage: args.usage ?? null,
    rateCardVersion: RATE_CARD_VERSION,
    estimatedMicroUsd: args.estimateMicroUsd,
    usageDerivedMicroUsd: derived,
    costUnknown: derived === null,
    createdAt: now(),
  });
  db.reservations.updateMany((r) => r.jobId === args.jobId && r.stage === args.stage && r.status === "held", () => ({ status: "settled", actualMicroUsd: derived, updatedAt: now() }));
  return derived;
}

/** Return a hold when a call was rejected before the provider did any work. */
export function releaseReservation(db: StudioStore, jobId: string, stage: string) {
  db.reservations.updateMany((r) => r.jobId === jobId && r.stage === stage && r.status === "held", () => ({ status: "released", updatedAt: now() }));
}
