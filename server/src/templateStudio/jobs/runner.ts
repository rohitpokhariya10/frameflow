import type { ServerEnv } from "../config.js";
import type { Provider } from "../ai/provider.js";
import type { Segmenter } from "../../decomposition/creativeTemplates/segmenter.js";
import type { ProtectedStore } from "../../decomposition/protectedTemplates/store.js";
import type { WordRecognizer } from "../../textRecognition/recognizer.js";
import { newId, now, type JobRecord as Job, type StudioStore as Db } from "../store.js";
import { finishJob, renewLease, type JobErrorInfo, type JobState, type TerminalState } from "./queue.js";

/**
 * Executes a job as an ordered list of stages. Each completed stage's output
 * is persisted, so a restarted worker resumes after the last completed stage
 * without repeating paid work.
 *
 * A paid stage found in "running" state on resume means the worker died while
 * a provider call may have been in flight. That call may have been billed, so
 * the stage is marked outcome_unknown and the job fails instead of retrying.
 */

export class JobStageError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly opts: { outcomeUnknown?: boolean; detail?: string; requestId?: string | null } = {},
  ) {
    super(message);
    this.name = "JobStageError";
  }
}

export interface StageContext {
  db: Db;
  job: Job;
  /** Outputs of earlier stages in this job, keyed by stage name. */
  outputs: Record<string, unknown>;
  /** Aborted if the worker loses its lease or is shutting down hard. */
  signal: AbortSignal;
  deps: RunnerDeps;
}

export interface StageDef {
  name: string;
  /** Job state shown to the user while this stage runs. */
  state: Exclude<JobState, TerminalState | "queued">;
  /** True if the stage makes a billable provider call. */
  paid: boolean;
  run(ctx: StageContext): Promise<unknown>;
}

export interface JobKindDef {
  kind: string;
  stages: StageDef[];
  /** Decide the terminal state and stored result from stage outputs. */
  finish?(outputs: Record<string, unknown>): { state: "complete" | "needs_review"; result?: unknown };
}

export interface RunnerDeps {
  workerId: string;
  leaseMs: number;
  storageDir: string;
  /** Present in the worker; job kinds that call providers require them. */
  env?: ServerEnv;
  provider?: Provider;
  /** FrameFlow's mask provider for exact product cutouts; undefined when it is not configured. */
  segmenter?: () => Segmenter | undefined;
  /** Style variations: the protected templates (read only) and the local recognizer that checks generated artwork for text. */
  protectedStore?: () => ProtectedStore;
  recognizer?: () => WordRecognizer;
}

export async function runJob(db: Db, job: Job, def: JobKindDef, deps: RunnerDeps): Promise<JobState> {
  const controller = new AbortController();
  let leaseLost = false;
  const renew = setInterval(() => {
    if (!renewLease(db, job.id, deps.workerId, deps.leaseMs)) {
      leaseLost = true;
      controller.abort(new Error("lease lost"));
    }
  }, Math.max(1000, Math.floor(deps.leaseMs / 3)));

  const fail = (error: JobErrorInfo) => {
    finishJob(db, job.id, deps.workerId, "failed", { error });
    return "failed" as const;
  };
  const stageRecord = (name: string) => db.stages.find((s) => s.jobId === job.id && s.stage === name);

  try {
    const outputs: Record<string, unknown> = {};

    for (const stage of def.stages) {
      if (leaseLost) return "running";

      const fresh = db.jobs.require(job.id, "Job");
      if (fresh.cancelRequested) {
        finishJob(db, job.id, deps.workerId, "cancelled", {
          error: { code: "cancelled", message: "Cancelled by user.", stage: stage.name },
        });
        return "cancelled";
      }

      const prior = stageRecord(stage.name);
      if (prior?.status === "done") {
        outputs[stage.name] = prior.output;
        continue;
      }
      if (prior && stage.paid && (prior.status === "running" || prior.status === "outcome_unknown")) {
        db.stages.update(prior.id, { status: "outcome_unknown" });
        return fail({
          code: "outcome_unknown",
          stage: stage.name,
          message:
            "The server stopped while a paid request was in progress. It may have been billed, so it was not repeated automatically. Start the step again explicitly if you want to retry.",
        });
      }

      const startedAt = new Date();
      const record = prior
        ? db.stages.update(prior.id, { status: "running", paid: stage.paid, startedAt: startedAt.toISOString(), completedAt: null, output: null })
        : db.stages.insert({ id: newId("stg"), jobId: job.id, stage: stage.name, status: "running", paid: stage.paid, output: null, startedAt: startedAt.toISOString(), completedAt: null, durationMs: null });
      if (db.jobs.get(job.id)?.leaseOwner === deps.workerId) db.jobs.update(job.id, { state: stage.state, currentStage: stage.name, updatedAt: now() });

      let output: unknown;
      try {
        output = await stage.run({ db, job: fresh, outputs, signal: controller.signal, deps });
      } catch (err) {
        const e =
          err instanceof JobStageError
            ? err
            : new JobStageError("stage_error", "An internal error stopped this step.", {
                detail: err instanceof Error ? err.message : String(err),
                outcomeUnknown: stage.paid,
              });
        db.stages.update(record.id, {
          status: e.opts.outcomeUnknown ? "outcome_unknown" : "failed",
          completedAt: now(),
          durationMs: Date.now() - startedAt.getTime(),
        });
        if (leaseLost) return "running";
        return fail({ code: e.code, message: e.message, stage: stage.name, detail: e.opts.detail, requestId: e.opts.requestId });
      }

      db.stages.update(record.id, { status: "done", output: output ?? null, completedAt: now(), durationMs: Date.now() - startedAt.getTime() });
      outputs[stage.name] = output;
    }

    const { state, result } = def.finish?.(outputs) ?? { state: "complete" as const };
    finishJob(db, job.id, deps.workerId, state, { result });
    return state;
  } finally {
    clearInterval(renew);
  }
}
