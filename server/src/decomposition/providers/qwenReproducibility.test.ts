import { expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { prepareQwenRequest } from './qwenRequest.js';
import { buildProviderInput, normalizeProviderOutput } from './adapters.js';
import { PipelineContext } from '../context.js';
import type { CachedInference } from '../context.js';
import { DecompositionRepository } from '../repository.js';
import { ArtifactStore } from '../artifactStore.js';
import { readDecompositionConfig, normalizeDecompositionOptions } from '../config.js';
import { DurableFalClient } from './falClient.js';
import type { FalTransport } from './falClient.js';
import { normalizeSource, sha256 } from '../phases/source.js';
import { createAnalysis } from '../phases/analysis.js';

it('hashes the exact normalized Qwen wire settings deterministically, excluding transient URLs', () => {
  const a = prepareQwenRequest('input-sha', 'source-sha', { prompt: '  source caption ', numLayers: 4 });
  const b = prepareQwenRequest('input-sha', 'source-sha', { numLayers: 4, prompt: 'source caption' });
  expect(a).toEqual(b); expect(a.sentSeed).toBeGreaterThanOrEqual(0); expect(a.sentSeed).toBeLessThanOrEqual(2147483647);
  expect(a.effectiveInput).toEqual({ prompt: 'source caption', negative_prompt: '', num_layers: 4, num_inference_steps: 28, guidance_scale: 5, acceleration: 'regular', output_format: 'png', enable_safety_checker: true, sync_mode: false, seed: a.sentSeed });
  const { image_url: url, ...wire } = buildProviderInput('qwen', { imageUrl: 'https://fal.media/different-upload', prompt: 'source caption', seed: a.sentSeed });
  expect(url).toContain('different-upload'); expect(wire).toEqual(a.effectiveInput);
  expect(prepareQwenRequest('input-2', 'source-sha').requestFingerprint).not.toBe(prepareQwenRequest('input-sha', 'source-sha').requestFingerprint);
  expect(prepareQwenRequest('input-sha', 'source-2').requestFingerprint).not.toBe(prepareQwenRequest('input-sha', 'source-sha').requestFingerprint);
});
it.each([{ prompt: 'another caption' }, { negativePrompt: 'text' }, { numLayers: 3 }, { numInferenceSteps: 30 }, { guidanceScale: 6 }, { acceleration: 'none' as const }, { seed: 13 }])('does not reuse material request changes: %j', options => {
  const before = prepareQwenRequest('image', 'source');
  expect(prepareQwenRequest('image', 'source', options).requestFingerprint).not.toBe(before.requestFingerprint);
});
it('deterministically produces identical provider bytes through orientation, sRGB, resize and PNG encoding', async () => {
  const bytes = await sharp({ create: { width: 1200, height: 1500, channels: 3, background: '#6789ab' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const a = await normalizeSource(bytes), b = await normalizeSource(bytes);
  const analysisA = await createAnalysis(a.master), analysisB = await createAnalysis(b.master);
  expect(a.originalSha256).toBe(b.originalSha256); expect(a.workingMasterSha256).toBe(b.workingMasterSha256);
  expect(analysisA.sha256).toBe(analysisB.sha256); expect(analysisA.analysis).toEqual(analysisB.analysis);
  expect([analysisA.width, analysisA.height]).toEqual([1024, 819]);
});
it('persists SENT and RETURNED seeds independently through the real durable queue and restarts', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'frameflow-qwen-seeds-')), repo = new DecompositionRepository(dir);
  try {
    repo.addSource({ id: 'source', ownerId: 'operator', originalArtifactId: 'source', masterArtifactId: 'source', originalSha256: 'sha', workingMasterSha256: 'sha', width: 256, height: 256, hasAlpha: false, mimeType: 'image/png', orientationNormalized: false, metadata: {}, createdAt: Date.now() });
    const config = readDecompositionConfig({ DECOMP_DATA_DIR: dir });
    repo.createJob('operator', 'source', normalizeDecompositionOptions({}, config), 'seed-test');
    const job = repo.claimJob('worker')!;
    const step = repo.createStep(job, 3, 'fingerprint');
    let now = Date.now();
    const transport = { submit: vi.fn(async () => ({ requestId: 'qwen-request' })), status: vi.fn(async () => 'COMPLETED'), result: vi.fn(async () => ({ images: [{ url: 'https://fal.media/result' }], seed: 42, prompt: 'returned caption' })) } as unknown as FalTransport;
    const options = { maxGlobalCalls: 10, now: () => now, random: () => 0.5 };
    const input = { jobId: job.id, stepId: step.id, model: 'qwen' as const, inputHash: 'fingerprint', input: { image_url: 'https://fal.media/input', seed: 41 } };
    await new DurableFalClient(repo, transport, options).advance(input); now += 3000;
    await new DurableFalClient(repo, transport, options).advance(input);
    const record = repo.getProviderRequest(step.id, 'fingerprint')!;
    expect(record.sentSeed).toBe(41); expect(record.returnedSeed).toBe(42);
    expect(normalizeProviderOutput('qwen', { images: [{ url: 'https://fal.media/test' }], seed: 42, prompt: 'returned caption' })).toMatchObject({ seed: 42, prompt: 'returned caption' });
    expect(transport.submit).toHaveBeenCalledTimes(1);
  } finally { repo.close(); await rm(dir, { recursive: true, force: true }); }
});
it('reuses only verified same-owner completed Qwen output across jobs, copies files, and misses on changed seed', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'frameflow-qwen-cache-')), repo = new DecompositionRepository(dir), store = new ArtifactStore(dir, repo);
  try {
    const config = readDecompositionConfig({ DECOMP_DATA_DIR: dir, DECOMP_PROVIDER_MODE: 'live' });
    const image = await sharp({ create: { width: 256, height: 320, channels: 4, background: '#12345680' } }).png().toBuffer();
    const source = await store.write({ ownerId: 'operator', kind: 'source', mimeType: 'image/png', width: 256, height: 320 }, image);
    repo.addSource({ id: 'source', ownerId: 'operator', originalArtifactId: source.artifactId, masterArtifactId: source.artifactId, originalSha256: sha256(image), workingMasterSha256: sha256(image), width: 256, height: 320, hasAlpha: true, mimeType: 'image/png', orientationNormalized: false, metadata: {}, createdAt: Date.now() });
    const advance = vi.fn(async ({ input }: { input: Record<string, unknown> }) => ({ state: 'completed', request: { providerRequestId: 'paid-1', sentSeed: input.seed, seed: input.seed }, output: { images: [{ url: 'https://fal.media/output' }], seed: input.seed } }));
    const provider = { advance, transport: { upload: vi.fn(async () => 'https://fal.media/upload'), download: vi.fn(async () => image) } } as unknown as DurableFalClient;
    const makeContext = (key: string) => { repo.createJob('operator', 'source', normalizeDecompositionOptions({}, config), key); const job = repo.claimJob('worker')!; job.data.verificationMode = 'live'; return new PipelineContext(job, repo, store, config, provider, 'worker'); };
    const first = makeContext('first'); await first.infer('qwen', { image });
    const saved = first.job.data.qwenInference as CachedInference;
    expect(saved.sentSeed).toBe(saved.returnedSeed); expect(saved.qwen?.inputSha256).toBe(sha256(image));
    await first.infer('qwen', { image, key: 'same-request-new-step' }); expect(advance).toHaveBeenCalledTimes(1);
    first.review('TEST', 'Pause', []); first.save();
    expect(repo.findReusableQwen('other-owner', saved.inputHash, 'new-job')).toBeUndefined();
    const second = makeContext('second'); const reused = await second.infer('qwen', { image });
    expect(advance).toHaveBeenCalledTimes(1); expect(reused[0]).toEqual(image);
    const copied = second.job.data.qwenInference as CachedInference;
    expect(copied.qwen?.cachedFromJobId).toBe(first.job.id); expect(copied.artifactIds).not.toEqual(saved.artifactIds);
    await store.remove(repo.getArtifact(saved.artifactIds[0])!); expect(await second.artifact(copied.artifactIds[0])).toEqual(image);
    await second.infer('qwen', { image, seed: (saved.sentSeed! + 1) % 2147483647 }); expect(advance).toHaveBeenCalledTimes(2);
    await second.infer('qwen', { image }); expect(advance).toHaveBeenCalledTimes(2);
    expect((second.job.data.qwenInference as CachedInference).sentSeed).toBe(saved.sentSeed);
    // Expired and deleted donors cannot be selected, regardless of fingerprint.
    repo.db.prepare("UPDATE decomposition_jobs SET tombstoned_at=1 WHERE id=?").run(first.job.id);
    repo.db.prepare("UPDATE decomposition_jobs SET json=json_set(json,'$.expiresAt',0) WHERE id=?").run(second.job.id);
    expect(repo.findReusableQwen('operator', (second.job.data.qwenInference as CachedInference).inputHash, 'future-job')).toBeUndefined();
  } finally { repo.close(); await rm(dir, { recursive: true, force: true }); }
});
