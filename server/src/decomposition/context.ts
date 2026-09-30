import sharp from 'sharp';
import type { DecompositionConfig } from './config.js';
import type { ArtifactRecord, DecompositionRepository, JobRecord, StepRecord } from './repository.js';
import type { ArtifactStore } from './artifactStore.js';
import { DecompositionError } from './errors.js';
import { buildProviderInput, ProviderError, endpointRegistry } from './providers/adapters.js';
import { DurableFalClient, providerInputHash, validateProviderImage } from './providers/falClient.js';
import { prepareQwenRequest } from './providers/qwenRequest.js';
import type { QwenReproducibility } from './providers/qwenRequest.js';
import { prepareSeedreamRequest } from './providers/seedreamRequest.js';
import type { SeedreamReproducibility } from './providers/seedreamRequest.js';
import type { ProviderLayerMetadata } from './providers/adapters.js';
import type { Infer } from './providers/inference.js';
import { sha256 } from './phases/source.js';

export type CachedInference = {
  scores?: number[]; boxes?: [number, number, number, number][]; artifactIds: string[]; requestId: string;
  dimensions: { width: number; height: number }[]; model: string; inputHash: string; settings: unknown; endpoint: string;
  adapterVersion: string; immutableModelRevision: 'unknown'; seed?: number; sentSeed?: number; returnedSeed?: number;
  inputImageSha256: string; outputSha256: string[]; qwen?: QwenReproducibility;
  seedream?: SeedreamReproducibility; layers?: ProviderLayerMetadata[];
};
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
  /** Copy a verified donor job's outputs into this job, so deleting/expiring the donor cannot break the new result. */
  private async copyDonorOutputs(donor: JobRecord, entry: CachedInference, warning: string): Promise<{ outputs: Buffer[]; ids: string[] } | undefined> {
    if (!entry.artifactIds.length || entry.artifactIds.length > 17 || entry.outputSha256.length !== entry.artifactIds.length) return undefined;
    const outputs: Buffer[] = [];
    try {
      for (const [i, id] of entry.artifactIds.entries()) {
        const record = this.repository.getArtifact(id, this.job.ownerId);
        if (!record || record.jobId !== donor.id || record.sha256 !== entry.outputSha256[i]) throw new Error('Unavailable cache');
        outputs.push(await this.store.read(record));
      }
    } catch { this.warn(warning); return undefined; }
    const ids: string[] = [];
    for (const bytes of outputs) ids.push((await this.put('provider-output', bytes)).artifactId);
    return { outputs, ids };
  }
  /** Buffer-in, durable provider queue, validated immutable local artifacts out. */
  infer: Infer = async (model, request) => {
    this.check(); if (!this.provider) throw new ProviderError('PROVIDER_NOT_CONFIGURED', 'Set the server FAL_KEY to run decomposition.');
    const { image, mask, key, ...settings } = request;
    const source = this.repository.getSource(this.job.sourceId, this.job.ownerId)!;
    const qwen = model === 'qwen' ? prepareQwenRequest(sha256(image), source.originalSha256, settings) : undefined;
    const dimensions = await sharp(image).metadata(); const maskDimensions = mask ? await sharp(mask).metadata() : undefined;
    const seedream = model === 'seedream' ? prepareSeedreamRequest(sha256(image), source.originalSha256, { prompt: settings.prompt, imageSize: settings.imageSize, enhancePromptMode: settings.enhancePromptMode, width: dimensions.width, height: dimensions.height }) : undefined;
    const inputHash = qwen?.requestFingerprint ?? seedream?.requestFingerprint ?? providerInputHash(model, { image: sha256(image), mask: mask && sha256(mask), settings, endpoint: endpointRegistry[model].endpoint });
    const cache = (this.job.data.inferences ??= {}) as Record<string, CachedInference>;
    const logQwenResult = (entry: CachedInference, cacheHit: false | 'job' | 'owner') => {
      if (!qwen) return;
      console.info(JSON.stringify({ event: 'qwen_layered_result', jobId: this.job.id, requestFingerprint: inputHash,
        sentSeed: entry.sentSeed, returnedSeed: entry.returnedSeed, proposalCount: entry.artifactIds.length, providerRequestId: entry.requestId, cacheHit }));
    };
    const logSeedreamResult = (entry: CachedInference, cacheHit: false | 'job' | 'owner') => {
      if (!seedream) return;
      console.info(JSON.stringify({ event: 'seedream_layerize_result', jobId: this.job.id, provider: 'seedream', providerModel: seedream.model, requestFingerprint: inputHash,
        layerCount: entry.artifactIds.length, providerRequestId: entry.requestId, deterministic: false, cacheHit }));
    };
    if (seedream) console.info(JSON.stringify({ event: 'seedream_layerize_request', jobId: this.job.id, provider: 'seedream', providerModel: seedream.model, inputSha256: seedream.inputSha256, requestFingerprint: inputHash, imageSize: seedream.effectiveInput.image_size }));
    if (qwen) {
      console.info(JSON.stringify({ event: 'qwen_layered_request', jobId: this.job.id, inputSha256: qwen.inputSha256,
        requestFingerprint: inputHash, model: qwen.model, seed: qwen.sentSeed, numLayers: qwen.effectiveInput.num_layers,
        steps: qwen.effectiveInput.num_inference_steps, guidance: qwen.effectiveInput.guidance_scale }));
    }
    const cached = cache[inputHash];
    if (cached) {
      const results: Buffer[] = []; for (const id of cached.artifactIds) results.push(await this.artifact(id));
      if (qwen) { this.job.data.qwenInference = cached; this.job.data.qwenRequest = cached.qwen; this.job.data.qwenSeed = cached.sentSeed; this.save(); }
      if (seedream) { this.job.data.seedreamInference = cached; this.save(); }
      logQwenResult(cached, 'job'); logSeedreamResult(cached, 'job');
      return Object.assign(results, { scores: cached.scores, boxes: cached.boxes, requestId: cached.requestId, seed: cached.returnedSeed, layers: cached.layers });
    }
    if (qwen && this.job.data.verificationMode === 'live') {
      const donor = this.repository.findReusableQwen(this.job.ownerId, inputHash, this.job.id);
      const entry = donor?.data.qwenInference as CachedInference | undefined;
      if (entry?.qwen?.requestFingerprint === inputHash && entry.artifactIds.length > 0 && entry.artifactIds.length <= 6) {
        const donorCopy = await this.copyDonorOutputs(donor!, entry, 'QWEN_CACHE_UNAVAILABLE');
        if (donorCopy) {
          const copied: CachedInference = { ...entry, artifactIds: donorCopy.ids, qwen: { ...entry.qwen, cachedFromJobId: donor!.id } };
          cache[inputHash] = copied; this.job.data.qwenInference = copied; this.job.data.qwenRequest = copied.qwen; this.job.data.qwenSeed = copied.sentSeed; this.save();
          logQwenResult(copied, 'owner'); return Object.assign(donorCopy.outputs, { requestId: copied.requestId, seed: copied.returnedSeed });
        }
      }
    }
    if (seedream && this.job.data.verificationMode === 'live') {
      // No provider seed exists, so a same-owner completed response for the identical fingerprint is the only reproducible answer.
      const donor = this.repository.findReusableSeedream(this.job.ownerId, inputHash, this.job.id);
      const entry = donor?.data.seedreamInference as CachedInference | undefined;
      const copied = entry?.seedream?.requestFingerprint === inputHash ? await this.copyDonorOutputs(donor!, entry, 'SEEDREAM_CACHE_UNAVAILABLE') : undefined;
      if (copied) {
        const reused: CachedInference = { ...entry!, artifactIds: copied.ids, seedream: { ...entry!.seedream!, cachedFromJobId: donor!.id } };
        cache[inputHash] = reused; this.job.data.seedreamInference = reused; this.save();
        logSeedreamResult(reused, 'owner'); return Object.assign(copied.outputs, { requestId: reused.requestId, layers: reused.layers });
      }
    }
    if (qwen) {
      const unfinished = this.repository.providerRequests(this.job.id).find(record => record.endpoint === qwen.model && ['SUBMITTING', 'SUBMISSION_UNKNOWN', 'QUEUED', 'IN_PROGRESS'].includes(record.status));
      if (unfinished && unfinished.inputHash !== inputHash) throw new ProviderError('QWEN_REQUEST_CHANGED', 'A Qwen request is already pending with different settings. Preserve/reconcile its saved request ID before starting another paid attempt.');
      this.job.data.qwenRequest = qwen; this.job.data.qwenSeed = qwen.sentSeed; this.save();
    }
    // Discovery requests resume (or recover) their original step across retries, so a retry never pays twice.
    const discoveryModel = qwen?.model ?? seedream?.model;
    const savedRequest = discoveryModel && this.repository.providerRequests(this.job.id).find(record => record.inputHash === inputHash && record.endpoint === discoveryModel);
    const savedStep = savedRequest && this.repository.steps(this.job.id).find(step => step.id === savedRequest.stepId);
    const callStep = this.repository.createStep(this.job, savedStep ? savedStep.phase : this.step.phase, inputHash, savedStep ? savedStep.objectId : key ?? model, savedStep ? savedStep.attempt : Number(this.job.data.attempt ?? 1));
    const existing = this.repository.getProviderRequest(callStep.id, inputHash);
    // Upload only when a new request needs submission; known queue requests resume without re-upload.
    const imageUrl = existing ? 'https://fal.media/resumed-input' : await this.provider.transport.upload(image);
    const maskUrl = mask ? existing ? 'https://fal.media/resumed-mask' : await this.provider.transport.upload(mask) : undefined;
    this.check();
    const input = qwen ? { ...qwen.effectiveInput, image_url: imageUrl } : seedream ? { ...seedream.effectiveInput, image_url: imageUrl } : buildProviderInput(model, { ...settings, imageUrl, maskUrl, width: dimensions.width, height: dimensions.height, maskWidth: maskDimensions?.width, maskHeight: maskDimensions?.height });
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
      cache[inputHash] = { scores: advanced.output.scores, boxes: advanced.output.boxes, artifactIds: ids, requestId: advanced.request.providerRequestId!, dimensions: sizes, model, inputHash, settings, endpoint: endpointRegistry[model].endpoint, adapterVersion: endpointRegistry[model].adapterVersion, immutableModelRevision: 'unknown', seed: advanced.request.seed, sentSeed: qwen?.sentSeed ?? advanced.request.sentSeed, returnedSeed: advanced.output.seed, qwen: qwen && { ...qwen, returnedSeed: advanced.output.seed, returnedPrompt: advanced.output.prompt, providerRequestId: advanced.request.providerRequestId }, seedream: seedream && { ...seedream, providerRequestId: advanced.request.providerRequestId }, layers: advanced.output.layers, inputImageSha256: sha256(image), outputSha256: hashes };
      if (seedream) this.job.data.seedreamInference = cache[inputHash];
      if (qwen) { this.job.data.qwenInference = cache[inputHash]; if (advanced.output.seed !== qwen.sentSeed) this.warn('QWEN_SEED_UNVERIFIED'); }
      this.job.data.inferences = cache; this.save(); callStep.status = 'completed'; callStep.outputArtifactIds = ids; this.repository.updateStep(callStep, this.lease);
      logQwenResult(cache[inputHash], false); logSeedreamResult(cache[inputHash], false);
      return Object.assign(buffers, { seed: advanced.output.seed, scores: advanced.output.scores, boxes: advanced.output.boxes, requestId: advanced.request.providerRequestId, layers: advanced.output.layers });
    }
  };
}
