import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { constrainMatte, decodeMask, emptyMask, encodeMask } from '../image/masks.js';
import type { Mask } from '../image/types.js';
import { DecompositionRepository } from '../repository.js';
import { ArtifactStore } from '../artifactStore.js';
import { readDecompositionConfig, normalizeDecompositionOptions } from '../config.js';
import { PipelineContext } from '../context.js';
import { createTransform } from '../image/coordinates.js';
import type { Infer } from '../providers/inference.js';
import { saveTrio, semanticReview } from './semanticPipeline.js';
import { semanticTarget } from './semanticOwnership.js';

const W = 120, H = 100;
const rect = (x: number, y: number, w: number, h: number): Mask => { const m = emptyMask(W, H); for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) m.data[j * W + i] = 255; return m; };
const filled = (value: number): Mask => ({ ...emptyMask(W, H), data: new Uint8Array(W * H).fill(value) });

it('protects the deep interior: a matte cannot remove owned pixels inside the eroded mask', () => {
  const support = rect(30, 20, 60, 60);
  const alpha = constrainMatte(support, filled(0), 3);
  expect(alpha.data[50 * W + 60]).toBe(255);
});

it('protects the deep exterior: a matte cannot add pixels outside the dilated mask', () => {
  const support = rect(30, 20, 60, 60);
  const alpha = constrainMatte(support, filled(255), 3);
  expect(alpha.data[5 * W + 5]).toBe(0);
  expect(alpha.data[50 * W + 110]).toBe(0);
});

it('lets the matte soften only the boundary band', () => {
  const support = rect(30, 20, 60, 60);
  const alpha = constrainMatte(support, filled(128), 3);
  expect(alpha.data[50 * W + 30]).toBe(128);
  expect(alpha.data[50 * W + 28]).toBe(128);
  expect(alpha.data[50 * W + 60]).toBe(255);
  expect(alpha.data[50 * W + 20]).toBe(0);
  // Protected neighbours are never re-owned through the band.
  const neighbour = rect(88, 20, 10, 60);
  expect(constrainMatte(support, filled(255), 3, neighbour).data[50 * W + 89]).toBe(0);
});

it('confirming a non-person object runs exactly one constrained BiRefNet call; mask, alpha and overlay share one revision', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'frameflow-alpha-')), repo = new DecompositionRepository(dir), store = new ArtifactStore(dir, repo);
  try {
    const config = readDecompositionConfig({ DECOMP_DATA_DIR: dir, DECOMP_PROVIDER_MODE: 'live' });
    const master = await sharp({ create: { width: W, height: H, channels: 3, background: '#335577' } }).png().toBuffer();
    const source = await store.write({ ownerId: 'operator', kind: 'source', mimeType: 'image/png', width: W, height: H }, master);
    repo.addSource({ id: 'source', ownerId: 'operator', originalArtifactId: source.artifactId, masterArtifactId: source.artifactId, originalSha256: source.sha256, workingMasterSha256: source.sha256, width: W, height: H, mimeType: 'image/png', hasAlpha: false, orientationNormalized: false, metadata: {}, createdAt: Date.now() });
    repo.createJob('operator', 'source', normalizeDecompositionOptions({}, config), 'alpha');
    const job = repo.claimJob('worker')!; job.phase = 4; job.data = { verificationMode: 'live', reviewWorkflow: 2, analysisTransform: createTransform(W, H, 1024) };
    const context = new PipelineContext(job, repo, store, config, undefined, 'worker');
    const phone = rect(30, 20, 60, 60);
    const original = await saveTrio(context, master, phone, phone, 'test/phone');
    context.job.data.candidates = [{ id: 'phone', label: 'phone', ...original, target: semanticTarget('phone', 'phone'), source: 'sam3', selected: true, memberArtifactIds: [], qualityStatus: 'needs-confirmation', qualityTier: 'REVIEW', warnings: [] }];
    // A matte that tries to erase the interior and flood the exterior: only the band may change.
    const infer = vi.fn<Infer>(async (_model, request) => [await encodeMask({ width: request.transform!.modelWidth, height: request.transform!.modelHeight, data: new Uint8Array(request.transform!.modelWidth * request.transform!.modelHeight).fill(128) })]);
    context.infer = infer;
    await semanticReview(context, master, { action: 'accept-masks', expectedRevision: context.job.revision, objects: [{ id: 'phone', candidateId: 'phone', selected: true }] });
    expect(infer.mock.calls.map(c => c[0])).toEqual(['birefnet']);
    expect(context.job.review?.gate).toBe('alpha-review');
    const [refined] = context.job.data.refined as { maskArtifactId: string; alphaArtifactId: string; revisionId: string; maskRevisionId: string; alphaRevisionId: string; overlayRevisionId: string }[];
    expect(new Set([refined.revisionId, refined.maskRevisionId, refined.alphaRevisionId, refined.overlayRevisionId]).size).toBe(1);
    const alpha = await decodeMask(await context.artifact(refined.alphaArtifactId), { encoding: 'luminance' });
    const mask = await decodeMask(await context.artifact(refined.maskArtifactId), { encoding: 'luminance' });
    expect(alpha.data[50 * W + 60]).toBe(255);
    expect(alpha.data[5 * W + 5]).toBe(0);
    expect(alpha.data[50 * W + 30]).toBe(128);
    expect(mask.data[50 * W + 30]).toBe(255);
  } finally { repo.close(); await rm(dir, { recursive: true, force: true }); }
});
