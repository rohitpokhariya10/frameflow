import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import sharp from 'sharp';
import type { DiscoverySummary, ProposalSummary } from '@frameflow/shared';
import { DecompositionRepository } from './repository.js';
import { ArtifactStore } from './artifactStore.js';
import { readDecompositionConfig, normalizeDecompositionOptions } from './config.js';
import { PipelineContext } from './context.js';
import { runPhase } from './pipeline.js';
import { createTransform } from './image/coordinates.js';
import { ProviderError } from './providers/adapters.js';
import type { Infer } from './providers/inference.js';

async function rgbaLayer(width: number, height: number, box?: { x: number; y: number; width: number; height: number }) {
  const data = Buffer.alloc(width * height * 4, 0);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4; data[i] = 30; data[i + 1] = 90; data[i + 2] = 200;
    data[i + 3] = !box || (x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height) ? 255 : 0;
  }
  return sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

async function setup(env: Record<string, string> = {}) {
  const dir = await mkdtemp(resolve(tmpdir(), 'frameflow-discovery-phase-'));
  const repo = new DecompositionRepository(dir), store = new ArtifactStore(dir, repo);
  const config = readDecompositionConfig({ DECOMP_DATA_DIR: dir, DECOMP_PROVIDER_MODE: 'live', ...env });
  const master = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#789abc' } }).png().toBuffer();
  const source = await store.write({ ownerId: 'operator', kind: 'source', mimeType: 'image/png', width: 256, height: 256 }, master);
  repo.addSource({ id: 'source', ownerId: 'operator', originalArtifactId: source.artifactId, masterArtifactId: source.artifactId, originalSha256: source.sha256, workingMasterSha256: source.sha256, width: 256, height: 256, mimeType: 'image/png', hasAlpha: false, orientationNormalized: false, metadata: {}, createdAt: Date.now() });
  const phase3 = async (key: string, infer: Infer) => {
    repo.createJob('operator', 'source', normalizeDecompositionOptions({}, config), key);
    let job = repo.claimJob('worker')!;
    job.phase = 2; job.data = { verificationMode: 'live', analysisArtifactId: source.artifactId, analysisTransform: createTransform(256, 256, 1024) };
    job = repo.updateJob(job, { workerId: 'worker', fence: job.fence, revision: job.revision });
    const context = new PipelineContext(job, repo, store, config, undefined, 'worker');
    context.infer = infer;
    await runPhase(context);
    return repo.getJob(job.id)!;
  };
  return { dir, repo, store, source, phase3, cleanup: async () => { repo.close(); await rm(dir, { recursive: true, force: true }); } };
}

it('persists normalized Seedream proposals, base layer and discovery provenance, then pauses for proposal review', async () => {
  const env = await setup();
  try {
    const outputs = [await rgbaLayer(512, 512), await rgbaLayer(512, 512, { x: 100, y: 60, width: 200, height: 400 }), await rgbaLayer(80, 120)];
    const infer = vi.fn<Infer>(async model => {
      expect(model).toBe('seedream');
      return Object.assign(outputs, { requestId: 'seedream-req', layers: [{ zIndex: 0, description: 'Studio backdrop' }, { zIndex: 1, name: 'Woman', bboxAbsolute: [100, 60, 300, 460] as [number, number, number, number] }, { zIndex: 2, name: 'Phone', bboxAbsolute: [240, 200, 320, 320] as [number, number, number, number] }] });
    });
    const job = await env.phase3('seedream-phase', infer);
    expect(infer).toHaveBeenCalledTimes(1);
    expect(job.state).toBe('needs_review');
    expect(job.review?.gate).toBe('qwen-proposal-review');
    expect(job.data.discoveryPlan).toEqual({ primary: 'seedream', fallback: 'qwen' });
    const discovery = job.data.discovery as DiscoverySummary;
    expect(discovery).toMatchObject({ contractVersion: 'discovery-v1', provider: 'seedream', providerModel: 'bytedance/seedream/v5/pro/layerize', providerRequestId: 'seedream-req', deterministic: false, sourceHash: env.source.sha256,
      attempts: [{ provider: 'seedream', outcome: 'used', proposalCount: 2 }], baseLayer: { zIndex: 0, width: 256, height: 256, description: 'Studio backdrop' } });
    const proposals = job.data.proposals as (ProposalSummary & { rgbAuthority: string })[];
    expect(proposals.map(p => [p.id, p.label, p.labelSource, p.zIndex, p.provider, p.sourceRegistration?.method, p.registered])).toEqual([
      ['proposal-1', 'Woman', 'provider', 1, 'seedream', 'full-canvas', true], ['proposal-2', 'Phone', 'provider', 2, 'seedream', 'bbox-placed', true]]);
    expect(proposals[0]).toMatchObject({ providerBbox: { x: 50, y: 30, width: 100, height: 200 }, bounds: { x: 50, y: 30, width: 100, height: 200 }, sourceHash: env.source.sha256, revision: 1, contractVersion: 'discovery-v1', rgbAuthority: 'discovery-only', providerRequestId: 'seedream-req' });
    // Artifacts are durable, analysis-registered, and live under the discovery folder.
    const artifacts = env.repo.listArtifacts(job.id);
    const paths = artifacts.map(a => a.relativePath);
    expect(paths).toEqual(expect.arrayContaining(['03-discovery/proposal-001.png', '03-discovery/proposal-002-alpha.png', '03-discovery/base.png', '03-discovery/proposals.json']));
    const layer = artifacts.find(a => a.artifactId === proposals[1].artifactId)!;
    expect(await sharp(await env.store.read(layer)).metadata()).toMatchObject({ width: 256, height: 256, hasAlpha: true });
    // The summary exposed to the client carries the new optional fields.
    expect(env.repo.summarize(job).proposals?.[0]).toMatchObject({ label: 'Woman', provider: 'seedream' });
  } finally { await env.cleanup(); }
});

it('falls back to Qwen on a safe Seedream failure and keeps historical Qwen artifact paths', async () => {
  const env = await setup();
  try {
    const qwen = await rgbaLayer(256, 256, { x: 40, y: 40, width: 80, height: 120 });
    const infer = vi.fn<Infer>(async model => { if (model === 'seedream') throw new ProviderError('PROVIDER_UNAVAILABLE', 'down'); return Object.assign([qwen], { seed: 9, requestId: 'qwen-req' }); });
    const job = await env.phase3('fallback-phase', infer);
    expect(infer.mock.calls.map(c => c[0])).toEqual(['seedream', 'qwen']);
    expect(job.state).toBe('needs_review');
    expect(job.data.discovery).toMatchObject({ provider: 'qwen', fallbackFrom: 'seedream', deterministic: true, attempts: [{ provider: 'seedream', outcome: 'failed', code: 'PROVIDER_UNAVAILABLE' }, { provider: 'qwen', outcome: 'used' }] });
    expect(job.warnings).toContain('DISCOVERY_FALLBACK_USED');
    expect((job.data.proposals as ProposalSummary[])[0]).toMatchObject({ provider: 'qwen', labelSource: 'generic', label: 'Object 1', registered: true });
    expect(env.repo.listArtifacts(job.id).map(a => a.relativePath)).toEqual(expect.arrayContaining(['03-qwen/proposal-001.png', '03-qwen/proposals.json']));
  } finally { await env.cleanup(); }
});

it('fails the phase without a second paid call when the Seedream submission is ambiguous', async () => {
  const env = await setup();
  try {
    const infer = vi.fn<Infer>(async () => { throw new ProviderError('SUBMISSION_UNKNOWN', 'ambiguous'); });
    await expect(env.phase3('ambiguous-phase', infer)).rejects.toMatchObject({ code: 'SUBMISSION_UNKNOWN' });
    expect(infer).toHaveBeenCalledTimes(1);
  } finally { await env.cleanup(); }
});

it('uses Qwen only when configured, and summarizes historical proposals that predate the discovery contract', async () => {
  const env = await setup({ DECOMP_DISCOVERY_PROVIDER: 'qwen' });
  try {
    const qwen = await rgbaLayer(256, 256, { x: 40, y: 40, width: 80, height: 120 });
    const infer = vi.fn<Infer>(async model => { expect(model).toBe('qwen'); return Object.assign([qwen], { seed: 9 }); });
    const job = await env.phase3('qwen-phase', infer);
    expect(job.data.discoveryPlan).toEqual({ primary: 'qwen' });
    expect(job.data.discovery).toMatchObject({ provider: 'qwen', attempts: [{ provider: 'qwen', outcome: 'used' }] });
    // A historical job record: old proposal shape without provider fields, no discovery summary.
    const legacy = { ...job, data: { ...job.data, discovery: undefined, proposals: [{ id: 'proposal-1', label: 'Object 1', artifactId: (job.data.proposals as ProposalSummary[])[0].artifactId, width: 256, height: 256, registered: true, warnings: [] }] } };
    expect(env.repo.summarize(legacy).proposals?.[0]).toMatchObject({ id: 'proposal-1', label: 'Object 1' });
  } finally { await env.cleanup(); }
});
