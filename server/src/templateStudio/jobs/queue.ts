import { newId, now, type JobErrorInfo, type JobRecord, type StudioStore } from "../store.js";

export type { JobErrorInfo };

export const TERMINAL_STATES = ["complete", "needs_review", "failed", "cancelled"] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

/** States shown for the poster pipeline; other kinds use "running". */
export const ACTIVE_STATES = ["queued", "running", "analysing", "planning", "generating", "composing", "reviewing"] as const;
export type JobState = TerminalState | (typeof ACTIVE_STATES)[number];

export const JOB_KINDS = ["analyse_template", "generate_poster", "review_poster", "make_cutout", "generate_style_variation", "generate_master_creatives"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** A job claimed this many times without finishing is assumed to crash the worker. */
export const MAX_CLAIMS = 5;

export function isTerminal(state: string): state is TerminalState {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * Create a job, or return the existing one when the idempotency key was seen
 * before (double-clicks, client retries). The stored input snapshot is never
 * modified afterwards.
 */
export function enqueueJob(db: StudioStore, args: { kind: JobKind; idempotencyKey: string; input: unknown; campaignId?: string }) {
  const existing = db.jobs.find((j) => j.idempotencyKey === args.idempotencyKey);
  if (existing) return { job: existing, created: false };
  const at = now();
  const job = db.jobs.insert({
    id: newId("job"),
    kind: args.kind,
    idempotencyKey: args.idempotencyKey,
    inputSnapshot: args.input,
    state: "queued",
    currentStage: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    attemptCount: 0,
    cancelRequested: false,
    error: null,
    result: null,
    campaignId: args.campaignId ?? null,
    createdAt: at,
    updatedAt: at,
    finishedAt: null,
  });
  return { job, created: true };
}

const claimable = (j: JobRecord, at: Date) => !isTerminal(j.state) && (j.leaseExpiresAt === null || j.leaseExpiresAt < at.toISOString());

/**
 * Lease the oldest runnable job. A job whose lease expired (the server stopped
 * mid-job) becomes claimable again and resumes from its last completed stage.
 */
export function claimNextJob(db: StudioStore, workerId: string, leaseMs: number, at = new Date()) {
  for (;;) {
    const candidate = db.jobs.filter((j) => claimable(j, at)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!candidate) return null;
    if (candidate.attemptCount >= MAX_CLAIMS) {
      finishJob(db, candidate.id, null, "failed", {
        error: { code: "worker_crash_loop", message: `This job was started ${candidate.attemptCount} times without finishing and has been stopped.`, stage: candidate.currentStage ?? undefined },
      });
      continue;
    }
    return db.jobs.update(candidate.id, (j) => ({
      leaseOwner: workerId,
      leaseExpiresAt: new Date(at.getTime() + leaseMs).toISOString(),
      attemptCount: j.attemptCount + 1,
      updatedAt: now(),
    }));
  }
}

/** Extend the lease; returns false if this worker no longer owns the job. */
export function renewLease(db: StudioStore, jobId: string, workerId: string, leaseMs: number) {
  const job = db.jobs.get(jobId);
  if (!job || job.leaseOwner !== workerId || isTerminal(job.state)) return false;
  db.jobs.update(jobId, { leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString() });
  return true;
}

/**
 * Move a job to a terminal state. When `workerId` is given, only the lease
 * holder may finish it.
 */
export function finishJob(
  db: StudioStore,
  jobId: string,
  workerId: string | null,
  state: TerminalState,
  extra: { error?: JobErrorInfo; result?: unknown } = {},
) {
  const job = db.jobs.get(jobId);
  if (!job || isTerminal(job.state) || (workerId && job.leaseOwner !== workerId)) return false;
  db.jobs.update(jobId, {
    state,
    leaseOwner: null,
    leaseExpiresAt: null,
    finishedAt: now(),
    updatedAt: now(),
    ...(extra.error ? { error: extra.error } : {}),
    ...(extra.result !== undefined ? { result: extra.result } : {}),
  });
  // Holds are created immediately before provider calls. An unsettled hold may have been billed; only a known pre-processing rejection may release it.
  return true;
}

/**
 * Cancel a job. A queued job (not leased) is cancelled immediately; a running
 * job stops before its next stage. An in-flight provider call cannot be
 * cancelled or refunded.
 */
export function requestCancel(db: StudioStore, jobId: string, at = new Date()) {
  const job = db.jobs.get(jobId);
  if (!job) return null;
  if (isTerminal(job.state)) return job;
  const leased = job.leaseExpiresAt !== null && job.leaseExpiresAt > at.toISOString();
  if (!leased) {
    db.jobs.update(jobId, { state: "cancelled", cancelRequested: true, finishedAt: at.toISOString(), leaseOwner: null, leaseExpiresAt: null, updatedAt: now() });
    // Preserve interrupted-call holds, including jobs whose lease expired.
    return db.jobs.get(jobId)!;
  }
  return db.jobs.update(jobId, { cancelRequested: true, updatedAt: now() });
}

/** Explicit recovery only for budget rejection. Completed stages and their paid outputs are never rerun. */
export function resumeBudgetJob(db: StudioStore, jobId: string) {
  const job = db.jobs.require(jobId, 'Job');
  if (job.state !== 'failed' || job.error?.code !== 'budget_exceeded') throw new Error('Only budget-rejected jobs can resume. Unknown provider outcomes must never be retried automatically.');
  if (db.stages.find(s => s.jobId === jobId && s.status === 'outcome_unknown')) throw new Error('This job contains an uncertain paid outcome and cannot resume.');
  return db.jobs.update(jobId, { state: 'queued', error: null, finishedAt: null, leaseOwner: null, leaseExpiresAt: null, cancelRequested: false, attemptCount: 0, updatedAt: now() });
}
