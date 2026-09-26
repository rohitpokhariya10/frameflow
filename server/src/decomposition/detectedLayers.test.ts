import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it } from 'vitest';
import type { DetectedLayerCutout, ProposalReviewTarget } from '@frameflow/shared';
import { DecompositionRepository } from './repository.js';
import { ArtifactStore } from './artifactStore.js';
import { readDecompositionConfig } from './config.js';
import { createDecompositionRouter } from './router.js';
import { hashOperatorPassword } from './auth.js';
import { detectedLayerCutout } from './detectedLayers.js';
import { encodeMask, emptyMask } from './image/masks.js';
import { createTransform } from './image/coordinates.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

/** A 200×160 source: red left half, blue right half. "Red block" is detected at x 20–79, y 30–89. */
async function fixture() {
  const dir = await mkdtemp(resolve(tmpdir(), 'frameflow-detected-')), repo = new DecompositionRepository(dir), store = new ArtifactStore(dir, repo);
  closers.push(async () => repo.close());
  const pixels = Buffer.alloc(200 * 160 * 3);
  for (let i = 0; i < 200 * 160; i++) pixels.set(i % 200 < 100 ? [220, 30, 30] : [30, 30, 220], i * 3);
  const png = await sharp(pixels, { raw: { width: 200, height: 160, channels: 3 } }).png().toBuffer();
  const master = await store.write({ ownerId: 'operator', kind: 'source', mimeType: 'image/png', width: 200, height: 160 }, png);
  repo.addSource({ id: 'source', ownerId: 'operator', originalArtifactId: master.artifactId, masterArtifactId: master.artifactId, originalSha256: master.sha256, workingMasterSha256: master.sha256, width: 200, height: 160, mimeType: 'image/png', hasAlpha: false, orientationNormalized: false, metadata: {}, createdAt: Date.now() });
  const job = repo.createJob('operator', 'source', { maxObjects: 6, targetLabels: [], qualityProfile: 'refined', completeHiddenObjects: false, reconstructBackground: false, allowEraseFallback: false, maxCalls: 5 }, 'detected-test');
  const region = emptyMask(200, 160);
  for (let y = 30; y < 90; y++) for (let x = 20; x < 80; x++) region.data[y * 200 + x] = 255;
  const mask = await store.write({ ownerId: 'operator', jobId: job.id, kind: 'mask', mimeType: 'image/png', width: 200, height: 160 }, await encodeMask(region));
  const targets: ProposalReviewTarget[] = [
    { id: 'target-1', label: 'Red block', proposalIds: [], approved: false, rejected: false, groupMode: 'single', role: 'object', maskArtifactId: mask.artifactId },
    { id: 'target-2', label: 'Title', description: 'Headline reading "SALE"', proposalIds: [], approved: false, rejected: false, groupMode: 'single', role: 'text', maskArtifactId: mask.artifactId },
    { id: 'target-background', label: 'Background', proposalIds: [], approved: false, rejected: false, groupMode: 'single', role: 'background', baseLayer: true },
  ];
  job.data = { proposals: [], proposalTargets: targets, analysisTransform: createTransform(200, 160, 1024) };
  job.state = 'completed';
  return { dir, repo, store, job: repo.updateJob(job) };
}
const rgba = async (store: ArtifactStore, repo: DecompositionRepository, result: DetectedLayerCutout) => sharp(await store.read(repo.getArtifact(result.artifactId)!)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

it('cuts a detected layer from the original pixels at its original position, without contacting a provider or changing the job', async () => {
  const f = await fixture();
  const before = f.repo.getJob(f.job.id)!;
  const result = await detectedLayerCutout(f.repo, f.store, before, 'target-1');
  expect(result).toMatchObject({ targetId: 'target-1', label: 'Red block', kind: 'image', bbox: { x: 18, y: 28, width: 64, height: 64 } });
  const { data, info } = await rgba(f.store, f.repo, result);
  const at = (x: number, y: number) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)];
  expect(at(10, 10)).toEqual([220, 30, 30, 255]);
  expect(at(0, 0)[3]).toBe(0);
  const after = f.repo.getJob(f.job.id)!;
  expect(after.revision).toBe(before.revision); expect(after.callsUsed).toBe(before.callsUsed); expect(after.data).toEqual(before.data);
  expect(f.repo.db.prepare('SELECT COUNT(*) AS n FROM provider_requests').get()).toEqual({ n: 0 });
});

it('applies brush corrections, carries a text suggestion for text layers, and refuses the background and unknown layers', async () => {
  const f = await fixture();
  const trimmed = await detectedLayerCutout(f.repo, f.store, f.job, 'target-1', [{ mode: 'subtract', radius: 6, points: [{ x: 50, y: 60 }] }]);
  const { data, info } = await rgba(f.store, f.repo, trimmed);
  expect(data[((60 - trimmed.bbox.y) * info.width + (50 - trimmed.bbox.x)) * 4 + 3]).toBe(0);
  expect(await detectedLayerCutout(f.repo, f.store, f.job, 'target-2')).toMatchObject({ kind: 'text', textSuggestion: { text: 'SALE', textConfidence: 'low' } });
  await expect(detectedLayerCutout(f.repo, f.store, f.job, 'target-background')).rejects.toMatchObject({ code: 'LAYER_IS_BACKGROUND' });
  await expect(detectedLayerCutout(f.repo, f.store, f.job, 'nope')).rejects.toMatchObject({ code: 'LAYER_NOT_FOUND' });
  await expect(detectedLayerCutout(f.repo, f.store, f.job, 'target-1', [{ mode: 'subtract', radius: 256, points: [{ x: 50, y: 60 }] }])).rejects.toMatchObject({ code: 'LAYER_EMPTY' });
});

it('route: requires the owner session and CSRF, and validates brush strokes against the image', async () => {
  const f = await fixture();
  const config = readDecompositionConfig({ DECOMPOSITION_ENABLED: 'true', DECOMP_DATA_DIR: f.dir, FAL_KEY: 'offline-test-only', DECOMP_OPERATOR_PASSWORD_HASH: await hashOperatorPassword('a-private-test-password') });
  const app = express(); app.use('/api/decomposition', createDecompositionRouter(config, f.repo, f.store));
  const server: Server = createServer(app); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  closers.unshift(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/decomposition`, headers = { Origin: 'http://localhost:5173', 'X-FrameFlow-CSRF': '1', 'Content-Type': 'application/json' };
  const url = `${base}/jobs/${f.job.id}/detected/target-1/cutout`;
  expect((await fetch(url, { method: 'POST', headers, body: '{}' })).status).toBe(401);
  const login = await fetch(`${base}/session`, { method: 'POST', headers, body: JSON.stringify({ password: 'a-private-test-password' }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  expect((await fetch(url, { method: 'POST', headers: { ...headers, Cookie: cookie, 'X-FrameFlow-CSRF': '' }, body: '{}' })).status).toBe(403);
  const outside = await fetch(url, { method: 'POST', headers: { ...headers, Cookie: cookie }, body: JSON.stringify({ strokes: [{ mode: 'add', radius: 4, points: [{ x: 500, y: 10 }] }] }) });
  expect(outside.status).toBe(400);
  const ok = await fetch(url, { method: 'POST', headers: { ...headers, Cookie: cookie }, body: JSON.stringify({ strokes: [] }) });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toMatchObject({ targetId: 'target-1', kind: 'image', bbox: { x: 18, y: 28 } });
});
