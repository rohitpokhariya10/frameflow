import { randomUUID } from 'node:crypto';
import type { DecompositionConfig } from './config.js';
import type { DecompositionRepository } from './repository.js';
import type { ArtifactStore } from './artifactStore.js';
import type { DurableFalClient } from './providers/falClient.js';
import { PipelineContext } from './context.js';
import { attachMockProvider } from './providers/mock.js';
import { runPhase } from './pipeline.js';

export class DecompositionWorker {
  readonly id = randomUUID(); private stopping = false;
  constructor(readonly repository: DecompositionRepository, readonly store: ArtifactStore, readonly config: DecompositionConfig, readonly provider?: DurableFalClient) {}
  stop() { this.stopping = true; }
  async tick() {
    this.repository.workerHeartbeat(this.id);
    const job = this.repository.claimJob(this.id, this.config.leaseMs); if (!job) return false;
    const context = new PipelineContext(job, this.repository, this.store, this.config, this.provider, this.id);
    const heartbeat = setInterval(() => this.repository.heartbeat(job.id, this.id, job.fence, this.config.leaseMs), Math.min(10000, this.config.leaseMs / 3));
    try {
      if (job.cancelRequested) {
        for (const request of this.repository.providerRequests(job.id)) await this.provider?.cancel(request);
        const latest = this.repository.getJob(job.id)!; latest.state = 'cancelled'; latest.progress = 'Cancelled; completed inference may still be charged'; this.repository.updateJob(latest, { workerId: this.id, fence: latest.fence, revision: latest.revision });
      } else {
        if (job.data.verificationMode !== this.config.providerMode) throw new Error('Job provider mode differs from worker configuration.');
        if (this.config.providerMode === 'mock') await attachMockProvider(context);
        await runPhase(context);
      }
    } catch (error) {
      const latest = this.repository.getJob(job.id);
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'PHASE_FAILED';
      if (latest && !latest.tombstonedAt && latest.leaseOwner === this.id && latest.fence === job.fence) {
        if (latest.cancelRequested) { for (const request of this.repository.providerRequests(job.id)) await this.provider?.cancel(request); latest.state = 'cancelled'; latest.progress = 'Cancelled'; }
        else if (code === 'STALE_LEASE') return true;
        else {
          latest.state = code === 'SUBMISSION_UNKNOWN' ? 'needs_review' : 'failed';
          latest.error = { code, message: error instanceof Error && code !== 'PHASE_FAILED' ? error.message : 'This phase could not finish. Existing artifacts are preserved; retry the failed step.', retryable: !['PROVIDER_AUTH', 'PROVIDER_CREDITS', 'PROVIDER_SAFETY', 'SUBMISSION_UNKNOWN'].includes(code) };
          latest.progress = latest.error.message;
          if (code === 'SUBMISSION_UNKNOWN') latest.review = { code, message: latest.error.message, actions: [], artifactIds: [] };
          if (code === 'DEADLINE_EXCEEDED') for (const request of this.repository.providerRequests(job.id)) await this.provider?.cancel(request);
        }
        this.repository.updateJob(latest, { workerId: this.id, fence: latest.fence, revision: latest.revision });
      }
    } finally { clearInterval(heartbeat); this.repository.releaseJob(job.id, this.id, job.fence); }
    return true;
  }
  async run() {
    await this.store.reconcileOrphans();
    while (!this.stopping) { await this.tick(); await new Promise<void>((resolve) => setTimeout(resolve, 500)); }
  }
}
