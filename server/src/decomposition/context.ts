import sharp from 'sharp';
import type { DecompositionConfig } from './config.js';
import type { ArtifactRecord, DecompositionRepository, JobRecord, StepRecord } from './repository.js';
import type { ArtifactStore } from './artifactStore.js';
import { DecompositionError } from './errors.js';
import { buildProviderInput, ProviderError, endpointRegistry } from './providers/adapters.js';
import { DurableFalClient, providerInputHash, validateProviderImage } from './providers/falClient.js';
import type { Infer } from './providers/inference.js';
import { sha256 } from './phases/source.js';

export class PipelineContext {
  step: StepRecord;
  constructor(public job: JobRecord, readonly repository: DecompositionRepository, readonly store: ArtifactStore, readonly config: DecompositionConfig, readonly provider: DurableFalClient | undefined, readonly workerId: string) {
    this.step = repository.createStep(job, job.phase + 1, sha256(Buffer.from(JSON.stringify({ source: job.sourceId, options: job.options, review: job.data.reviewRevision, phase: job.phase + 1, attempt: job.data.attempt ?? 1 }))), '', Number(job.data.attempt ?? 1));
  }
  get lease() { return { workerId: this.workerId, fence: this.job.fence, revision: this.job.revision }; }
  check() {
    const latest = this.repository.getJob(this.job.id);
    if (!latest || latest.cancelRequested || latest.tombstonedAt) throw new DecompositionError('JOB_CANCELLED', 'Job was cancelled.', 409);
    if (latest.fence !== this.job.fence || latest.leaseOwner !== this.workerId || latest.revision !== this.job.revision || latest.leaseUntil <= Date.now()) throw new DecompositionError('STALE_LEASE', 'Worker no longer owns this job.', 409);
    if (latest.deadlineAt <= Date.now()) throw new DecompositionError('DEADLINE_EXCEEDED', 'The active job deadline was reached. Download available layers or explicitly retry.', 408);
  }
  save() { this.check(); this.job = this.repository.updateJob(this.job, this.lease); }
  async artifact(id: string): Promise<Buffer> {
    const record = this.repository.getArtifact(id, this.job.ownerId);
    if (!record) throw new DecompositionError('ARTIFACT_UNAVAILABLE', 'An expected artifact is missing. Retry or use the available partial layers.', 409);
    return this.store.read(record);
  }
  async put(kind: string, bytes: Buffer, relativePath?: string, mimeType = 'image/png'): Promise<ArtifactRecord> {
    this.check(); const meta = mimeType.startsWith('image/') ? await sharp(bytes, { limitInputPixels: this.config.maxPixels }).metadata() : undefined;
    const record = await this.store.write({ ownerId: this.job.ownerId, jobId: this.job.id, kind, mimeType, width: meta?.width, height: meta?.height, relativePath }, bytes);
    this.step.outputArtifactIds.push(record.artifactId); return record;
  }
  warn(message: string) { if (!this.job.warnings.includes(message)) this.job.warnings.push(message); }
  review(code: string, message: string, actions: string[], artifactIds: string[] = []) {
    this.job.state = 'needs_review'; this.job.review = { code, message, actions, artifactIds }; this.job.progress = message;
  }
  finish(phase: number, progress: string) {
    this.check(); this.step.status = 'completed'; this.repository.updateStep(this.step, this.lease);
    this.job.phase = phase; this.job.progress = progress; this.save();
  }
  /** Buffer-in, durable provider queue, validated immutable local artifacts out. */
  infer: Infer = async (model, request) => {
    this.check(); if (!this.provider) throw new ProviderError('PROVIDER_NOT_CONFIGURED', 'Set the server FAL_KEY to run decomposition.');
    const { image, mask, ...settings } = request;
    const inputHash = providerInputHash(model, { image: sha256(image), mask: mask && sha256(mask), settings });
    const cache = (this.job.data.inferences ??= {}) as Record<string, { artifactIds: string[]; requestId: string; dimensions: { width: number; height: number }[]; model: string; inputHash: string; settings: unknown; endpoint: string; seed?: number; inputImageSha256: string; outputSha256: string[] }>;
    const cached = cache[inputHash];
    if (cached) { const results: Buffer[] = []; for (const id of cached.artifactIds) results.push(await this.artifact(id)); return results; }
    const callStep = this.repository.createStep(this.job, this.step.phase, inputHash, request.key ?? model, Number(this.job.data.attempt ?? 1));
    const existing = this.repository.getProviderRequest(callStep.id, inputHash);
    const dimensions = await sharp(image).metadata(); const maskDimensions = mask ? await sharp(mask).metadata() : undefined;
    // Upload only when a new request needs submission; known queue requests resume without re-upload.
    const imageUrl = existing ? 'https://fal.media/resumed-input' : await this.provider.transport.upload(image);
    const maskUrl = mask ? existing ? 'https://fal.media/resumed-mask' : await this.provider.transport.upload(mask) : undefined;
    this.check();
    const input = buildProviderInput(model, { ...settings, imageUrl, maskUrl, width: dimensions.width, height: dimensions.height, maskWidth: maskDimensions?.width, maskHeight: maskDimensions?.height });
    for (;;) {
      this.check();
      const advanced = await this.provider.advance({ jobId: this.job.id, stepId: callStep.id, model, input, inputHash });
      if (advanced.state === 'pending') {
        this.repository.event(this.job, 'provider_progress', `${model}: ${advanced.request.status.toLowerCase()}`);
        await new Promise<void>((resolve) => setTimeout(resolve, Math.max(100, Math.min(15000, advanced.nextPollAt - Date.now())))); continue;
      }
      const buffers: Buffer[] = [], ids: string[] = [], hashes: string[] = [], sizes: { width: number; height: number }[] = [];
      for (const output of advanced.output.images) {
        this.check(); let bytes: Buffer | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          try { bytes = await this.provider.transport.download(output.url); break; }
          catch (error) { if (!(error instanceof ProviderError) || !error.retryable || attempt === 2) throw error; await new Promise<void>((resolve) => setTimeout(resolve, 1000 * (attempt + 1))); }
        }
        if (!bytes) throw new ProviderError('PROVIDER_OUTPUT_UNAVAILABLE', 'Provider media could not be downloaded.');
        const size = await validateProviderImage(bytes, model, this.config.maxPixels);
        const normalized = await sharp(bytes).ensureAlpha().png().toBuffer();
        const artifact = await this.put('provider-output', normalized);
        ids.push(artifact.artifactId); hashes.push(artifact.sha256); sizes.push({ width: size.width, height: size.height }); buffers.push(normalized);
      }
      cache[inputHash] = { artifactIds: ids, requestId: advanced.request.providerRequestId!, dimensions: sizes, model, inputHash, settings, endpoint: endpointRegistry[model].endpoint, seed: advanced.request.seed, inputImageSha256: sha256(image), outputSha256: hashes };
      this.job.data.inferences = cache; this.save(); callStep.status = 'completed'; callStep.outputArtifactIds = ids; this.repository.updateStep(callStep, this.lease);
      return buffers;
    }
  };
}
