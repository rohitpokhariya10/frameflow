import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { buildProviderInput, normalizeProviderOutput, SEEDREAM_MAX_LAYERS } from './adapters.js';
import { prepareSeedreamRequest } from './seedreamRequest.js';
import { DurableFalClient } from './falClient.js';
import type { FalTransport } from './falClient.js';
import { PipelineContext } from '../context.js';
import type { CachedInference } from '../context.js';
import { DecompositionRepository } from '../repository.js';
import { ArtifactStore } from '../artifactStore.js';
import { readDecompositionConfig, normalizeDecompositionOptions } from '../config.js';
import { sha256 } from '../phases/source.js';

const fixtures = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/decomposition/provider-contracts.json', import.meta.url), 'utf8')) as Record<string, Record<string, unknown>>;
const imageUrl = 'https://v3b.fal.media/files/test/source.png';
const layer = (z: number, extra: Record<string, unknown> = {}) => ({ image: { url: `https://v3b.fal.media/files/test/layer-${z}.png`, width: 1024, height: 1024 }, z_index: z, ...extra });

describe('seedream layerize contract', () => {
  it('builds the documented wire input without a seed or local dimensions', () => {
    expect(buildProviderInput('seedream', { imageUrl, width: 1024, height: 768, seed: 5 })).toEqual({ image_url: imageUrl, image_size: 'auto', enhance_prompt_mode: 'standard', enable_safety_checker: true, sync_mode: false });
    expect(buildProviderInput('seedream', { imageUrl, prompt: '  separate the text  ' })).toMatchObject({ prompt: 'separate the text' });
    expect(() => buildProviderInput('seedream', { imageUrl, width: 400, height: 800 })).toThrow(/width/);
    expect(() => buildProviderInput('seedream', { imageUrl, width: 512, height: 5999 * 2 })).toThrow();
    expect(() => buildProviderInput('seedream', { imageUrl, imageSize: 'auto_4K' as never })).toThrow(/size/);
  });

  it('normalizes layers with z-index, names, descriptions and boxes; ignores the gallery images list', () => {
    const output = normalizeProviderOutput('seedream', fixtures.seedream);
    expect(output.images.map(image => image.url)).toEqual(['https://v3b.fal.media/files/test/seedream-base.png', 'https://v3b.fal.media/files/test/seedream-layer.png']);
    expect(output.layers).toEqual([{ zIndex: 0 }, { zIndex: 1, name: 'Woman', description: 'A woman holding a phone', bboxAbsolute: [100, 120, 600, 900], bboxNormalized: [97.6, 117.2, 585.9, 878.9] }]);
    expect(normalizeProviderOutput('seedream', { layers: [layer(0), layer(1, { name: 'PRO\u0000\n text ' + 'x'.repeat(200) })] }).layers![1].name).toMatch(/^PRO text x+$/);
    expect(normalizeProviderOutput('seedream', { layers: [layer(0), layer(1, { name: 'PRO\u0000\n text ' + 'x'.repeat(200) })] }).layers![1].name!.length).toBe(100);
  });

  it('rejects malformed, excessive, duplicate-order and unsafe layer responses', () => {
    expect(() => normalizeProviderOutput('seedream', { images: [{ url: imageUrl }] })).toThrow(/no usable layers/);
    expect(() => normalizeProviderOutput('seedream', { layers: [layer(0), layer(0)] })).toThrow(/z-index/);
    expect(() => normalizeProviderOutput('seedream', { layers: [layer(0), layer(1, { bounding_box: { absolute: [600, 120, 100, 900] } })] })).toThrow(/bounding box/);
    expect(() => normalizeProviderOutput('seedream', { layers: [layer(0), layer(1, { bounding_box: { normalized: [0, 0, 1200, 10] } })] })).toThrow(/bounding box/);
    expect(() => normalizeProviderOutput('seedream', { layers: [layer(-1)] })).toThrow(/z-index/);
    expect(() => normalizeProviderOutput('seedream', { layers: [{ image: { url: 'http://insecure.example/x.png' }, z_index: 0 }] })).toThrow(/URL/);
    expect(() => normalizeProviderOutput('seedream', { layers: Array.from({ length: SEEDREAM_MAX_LAYERS + 1 }, (_, i) => layer(i)) })).toThrow(/too many/);
    expect(() => normalizeProviderOutput('seedream', { layers: [layer(0)], has_nsfw_concepts: [true] })).toThrow(/safety/);
  });

  it('fingerprints exact settings deterministically and marks the provider as unseeded', () => {
    const a = prepareSeedreamRequest('input', 'source', { width: 1024, height: 768 });
    expect(a).toEqual(prepareSeedreamRequest('input', 'source', { width: 1024, height: 768 }));
    expect(a.deterministic).toBe(false);
    expect(a.effectiveInput).not.toHaveProperty('image_url');
    expect(a.effectiveInput).not.toHaveProperty('seed');
    for (const changed of [prepareSeedreamRequest('input-2', 'source'), prepareSeedreamRequest('input', 'source-2'), prepareSeedreamRequest('input', 'source', { prompt: 'text only' }), prepareSeedreamRequest('input', 'source', { imageSize: 'auto_2K' }), prepareSeedreamRequest('input', 'source', { enhancePromptMode: 'fast' })])
      expect(changed.requestFingerprint).not.toBe(a.requestFingerprint);
  });

  it('persists normalized layer metadata in the durable provider record across worker restarts', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'frameflow-seedream-durable-')), repo = new DecompositionRepository(dir);
    try {
      repo.addSource({ id: 'source', ownerId: 'operator', originalArtifactId: 'source', masterArtifactId: 'source', originalSha256: 'sha', workingMasterSha256: 'sha', width: 512, height: 512, hasAlpha: false, mimeType: 'image/png', orientationNormalized: false, metadata: {}, createdAt: Date.now() });
      const config = readDecompositionConfig({ DECOMP_DATA_DIR: dir });
      repo.createJob('operator', 'source', normalizeDecompositionOptions({}, config), 'durable');
      const job = repo.claimJob('worker')!, step = repo.createStep(job, 3, 'fingerprint');
      let now = Date.now();
      const transport = { submit: vi.fn(async () => ({ requestId: 'seedream-request' })), status: vi.fn(async () => 'COMPLETED'), result: vi.fn(async () => fixtures.seedream) } as unknown as FalTransport;
      const options = { maxGlobalCalls: 10, now: () => now, random: () => 0.5 };
      const input = { jobId: job.id, stepId: step.id, model: 'seedream' as const, inputHash: 'fingerprint', input: { image_url: imageUrl } };
      await new DurableFalClient(repo, transport, options).advance(input); now += 3000;
      await new DurableFalClient(repo, transport, options).advance(input);
      // A fresh client (new worker) replays the saved output instead of paying again.
      const replay = await new DurableFalClient(repo, transport, options).advance(input);
      expect(replay.state).toBe('completed');
      expect(replay.state === 'completed' && replay.output.layers?.[1]).toMatchObject({ name: 'Woman', zIndex: 1, bboxAbsolute: [100, 120, 600, 900] });
      expect(transport.submit).toHaveBeenCalledTimes(1);
      expect(repo.getProviderRequest(step.id, 'fingerprint')!.sentSeed).toBeUndefined();
    } finally { repo.close(); await rm(dir, { recursive: true, force: true }); }
  });
});

it('reuses identical Seedream discovery within a job and across same-owner jobs without another paid call', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'frameflow-seedream-cache-')), repo = new DecompositionRepository(dir), store = new ArtifactStore(dir, repo);
  try {
    const config = readDecompositionConfig({ DECOMP_DATA_DIR: dir, DECOMP_PROVIDER_MODE: 'live' });
    const image = await sharp({ create: { width: 512, height: 640, channels: 4, background: '#12345680' } }).png().toBuffer();
    const source = await store.write({ ownerId: 'operator', kind: 'source', mimeType: 'image/png', width: 512, height: 640 }, image);
    repo.addSource({ id: 'source', ownerId: 'operator', originalArtifactId: source.artifactId, masterArtifactId: source.artifactId, originalSha256: sha256(image), workingMasterSha256: sha256(image), width: 512, height: 640, hasAlpha: true, mimeType: 'image/png', orientationNormalized: false, metadata: {}, createdAt: Date.now() });
    const layers = normalizeProviderOutput('seedream', fixtures.seedream).layers;
    const advance = vi.fn(async ({ input }: { input: Record<string, unknown> }) => {
      expect(input).not.toHaveProperty('seed'); expect(input).toMatchObject({ enable_safety_checker: true, sync_mode: false });
      return { state: 'completed', request: { providerRequestId: 'paid-seedream' }, output: { images: [{ url: 'https://fal.media/base' }, { url: 'https://fal.media/layer' }], layers } };
    });
    const provider = { advance, transport: { upload: vi.fn(async () => 'https://fal.media/upload'), download: vi.fn(async () => image) } } as unknown as DurableFalClient;
    const makeContext = (key: string, owner = 'operator') => { repo.createJob(owner, 'source', normalizeDecompositionOptions({}, config), key); const job = repo.claimJob('worker')!; job.data.verificationMode = 'live'; return new PipelineContext(job, repo, store, config, provider, 'worker'); };

    const first = makeContext('first');
    const fresh = await first.infer('seedream', { image, key: 'phase03-discovery' });
    expect(fresh.layers?.[1].name).toBe('Woman'); expect(fresh.requestId).toBe('paid-seedream');
    const saved = first.job.data.seedreamInference as CachedInference;
    expect(saved.seedream).toMatchObject({ deterministic: false, providerRequestId: 'paid-seedream', inputSha256: sha256(image) });
    expect(saved.layers).toEqual(layers);
    const again = await first.infer('seedream', { image, key: 'phase03-discovery-retry' });
    expect(advance).toHaveBeenCalledTimes(1); expect(again.layers).toEqual(layers);
    first.review('TEST', 'Pause', []); first.save();

    // Reload from the database: metadata survives persistence.
    expect((repo.getJob(first.job.id)!.data.seedreamInference as CachedInference).layers).toEqual(layers);
    expect(repo.findReusableSeedream('other-owner', saved.inputHash, 'new-job')).toBeUndefined();

    const second = makeContext('second');
    const reused = await second.infer('seedream', { image });
    expect(advance).toHaveBeenCalledTimes(1);
    expect(reused.layers).toEqual(layers); expect(reused[0]).toEqual(image);
    const copied = second.job.data.seedreamInference as CachedInference;
    expect(copied.seedream?.cachedFromJobId).toBe(first.job.id); expect(copied.artifactIds).not.toEqual(saved.artifactIds);

    // Material setting changes miss the cache.
    await second.infer('seedream', { image, imageSize: 'auto_2K' });
    expect(advance).toHaveBeenCalledTimes(2);
    repo.db.prepare('UPDATE decomposition_jobs SET tombstoned_at=1 WHERE id IN (?,?)').run(first.job.id, second.job.id);
    expect(repo.findReusableSeedream('operator', saved.inputHash, 'future-job')).toBeUndefined();
  } finally { repo.close(); await rm(dir, { recursive: true, force: true }); }
});
