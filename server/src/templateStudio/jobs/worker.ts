/**
 * The Generator's single-concurrency worker, run inside the FrameFlow server process instead of a separate one (FrameFlow
 * has no worker process for its experiment). One job at a time, so only one image request is ever in flight.
 *
 * Restart safety is the runner's: a job interrupted by a server restart resumes after its last completed stage, and a
 * paid stage that was running when the process stopped is marked outcome_unknown and the job fails, never re-sent.
 */
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ServerEnv } from '../config.js';
import type { Provider } from '../ai/provider.js';
import type { Segmenter } from '../../decomposition/creativeTemplates/segmenter.js';
import type { ProtectedStore } from '../../decomposition/protectedTemplates/store.js';
import type { WordRecognizer } from '../../textRecognition/recognizer.js';
import type { StudioStore } from '../store.js';
import { claimNextJob, finishJob, isTerminal } from './queue.js';
import { runJob, type JobKindDef } from './runner.js';
import { analyseTemplateJob } from './kinds/analyseTemplate.js';
import { generatePosterJob, reviewPosterJob } from './kinds/generatePoster.js';
import { makeCutoutJob } from './kinds/makeCutout.js';
import { generateStyleVariationJob } from './kinds/generateStyleVariation.js';
import { generateMasterCreativesJob } from './kinds/generateMasterCreatives.js';

export const LEASE_MS = 60_000;
const IDLE_POLL_MS = 1_000;

/** Job kinds this worker runs. Generator's decompose_scene is deliberately absent: FrameFlow decomposes. */
export const jobRegistry: Record<string, JobKindDef> = {
  [generateMasterCreativesJob.kind]: generateMasterCreativesJob,
  [analyseTemplateJob.kind]: analyseTemplateJob,
  [generatePosterJob.kind]: generatePosterJob,
  [reviewPosterJob.kind]: reviewPosterJob,
  [makeCutoutJob.kind]: makeCutoutJob,
  [generateStyleVariationJob.kind]: generateStyleVariationJob,
};

export interface WorkerOptions { db: StudioStore; storageDir: string; env?: ServerEnv; provider?: Provider; segmenter?: () => Segmenter | undefined; log?: (msg: string) => void; registry?: Record<string, JobKindDef>;
  protectedStore?: () => ProtectedStore; recognizer?: () => WordRecognizer }
export interface StudioWorker { workerId: string; startedAt: string; lastSeenAt: () => string; current: () => string | null; wake: () => void; stop: () => Promise<void> }

export function startWorker({ db, storageDir, env, provider, segmenter, log = console.log, registry = jobRegistry, protectedStore, recognizer }: WorkerOptions): StudioWorker {
  const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const startedAt = new Date().toISOString();
  let lastSeenAt = startedAt, current: string | null = null, stopping = false;
  let wakeUp: (() => void) | undefined;
  // This process is the store's only worker: leases held by an earlier process (stopped mid-job) end now, so its jobs are
  // claimed at once and the runner decides what is safe (resume a free stage, or outcome_unknown for a paid one).
  db.jobs.updateMany(j => !isTerminal(j.state) && j.leaseOwner !== null, () => ({ leaseOwner: null, leaseExpiresAt: null }));

  const loop = (async () => {
    log(`template studio worker ${workerId} started`);
    while (!stopping) {
      lastSeenAt = new Date().toISOString();
      let job;
      try { job = claimNextJob(db, workerId, LEASE_MS); }
      catch (err) { log(`claim failed: ${(err as Error).message}`); }
      if (!job) {
        await new Promise<void>(resolve => {
          const t = setTimeout(resolve, IDLE_POLL_MS);
          wakeUp = () => { clearTimeout(t); resolve(); };
        });
        continue;
      }
      const def = registry[job.kind];
      if (!def) {
        finishJob(db, job.id, workerId, 'failed', { error: { code: 'unknown_kind', message: `This worker cannot run "${job.kind}" jobs.` } });
        continue;
      }
      current = job.id;
      try {
        const state = await runJob(db, job, def, { workerId, leaseMs: LEASE_MS, storageDir, env, provider, segmenter, protectedStore, recognizer });
        log(`template studio job ${job.id} (${job.kind}) -> ${state}`);
      } catch (err) {
        // Infrastructure error (e.g. disk full). The lease expires and the job resumes from its last completed stage.
        log(`template studio job ${job.id} interrupted: ${(err as Error).message}`);
      } finally { current = null; }
    }
  })();

  return {
    workerId, startedAt, lastSeenAt: () => (current ? new Date().toISOString() : lastSeenAt), current: () => current,
    wake: () => wakeUp?.(),
    async stop() { stopping = true; wakeUp?.(); await loop; log(`template studio worker ${workerId} stopped`); },
  };
}
