import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { readDecompositionConfig } from './config.js';
import { DecompositionRepository } from './repository.js';
import { ArtifactStore } from './artifactStore.js';
import { PipelineContext } from './context.js';
import { runPhase } from './pipeline.js';
import { normalizeSource } from './phases/source.js';
import { personHoldingBoardFixture } from './image/syntheticFixtures.js';
import { cropMask, resizeMask, encodeMask } from './image/masks.js';
import { normalizeProviderOutput, endpointRegistry } from './providers/adapters.js';
import { exportDemo } from './demoExport.js';

if (!process.argv.includes('--mock') || process.argv.includes('--live')) throw new Error('This offline demo requires --mock. It never contacts fal.');
const root = fileURLToPath(new URL('../../..', import.meta.url));
const outIndex = process.argv.indexOf('--out');
const destination = outIndex >= 0 ? resolve(process.argv[outIndex + 1]) : resolve(root, 'artifacts/decomposition/offline-demo');
const config = readDecompositionConfig({ ...process.env, DECOMPOSITION_ENABLED: 'false', DECOMP_DATA_DIR: resolve(root, 'server/data/decomposition-offline') });
const repo = new DecompositionRepository(config.dataDir), store = new ArtifactStore(config.dataDir, repo);
const fixture = await personHoldingBoardFixture();
const normalized = await normalizeSource(fixture.image);
const original = await store.write({ ownerId: 'operator', kind: 'source-original', mimeType: normalized.mimeType, width: normalized.width, height: normalized.height }, normalized.original);
const master = await store.write({ ownerId: 'operator', kind: 'source-master', mimeType: 'image/png', width: normalized.width, height: normalized.height }, normalized.master);
const source = repo.addSource({ id: randomUUID(), ownerId: 'operator', originalArtifactId: original.artifactId, masterArtifactId: master.artifactId, originalSha256: normalized.originalSha256, workingMasterSha256: normalized.workingMasterSha256, width: normalized.width, height: normalized.height, mimeType: normalized.mimeType, orientationNormalized: normalized.orientationNormalized, hasAlpha: normalized.hadAlpha, metadata: { providerMode: 'mock' }, createdAt: Date.now() });
let job = repo.createJob('operator', source.id, { maxObjects: 2, targetLabels: ['person', 'board'], qualityProfile: 'refined', completeHiddenObjects: false, reconstructBackground: false, allowEraseFallback: false, maxCalls: 5 }, randomUUID());
job.data.verificationMode = 'mock'; job = repo.updateJob(job);
let calls = 0;
try {
  for (let phase = 1; phase <= 5; phase++) {
    const claimed = repo.claimJob('offline-demo'); if (!claimed || claimed.id !== job.id) throw new Error('Offline job could not be claimed.');
    const context = new PipelineContext(claimed, repo, store, config, undefined, 'offline-demo');
    context.infer = async (model, request) => {
      if (++calls > 5) throw new Error('Offline model-call bound exceeded.');
      const buffers: Buffer[] = [];
      if (model === 'qwen') {
        for (const mask of [fixture.person, fixture.board]) buffers.push(await sharp(fixture.image).removeAlpha().joinChannel(Buffer.from(mask.data), { raw: { width: mask.width, height: mask.height, channels: 1 } }).png().toBuffer());
      } else if (model === 'sam2') {
        for (const mask of [fixture.person, fixture.board]) buffers.push(await encodeMask(mask));
      } else if (model === 'sam3' || model === 'birefnet') {
        const transform = request.transform; if (!transform) throw new Error('Missing refinement transform');
        const target = request.prompt === 'board' ? fixture.board : fixture.person;
        const cropped = resizeMask(cropMask(target, transform.crop), transform.modelWidth, transform.modelHeight);
        let buffer = await encodeMask(cropped);
        if (model === 'birefnet') buffer = await sharp(buffer).blur(0.8).png().toBuffer();
        buffers.push(buffer);
      } else throw new Error('Out-of-scope model');
      const images = buffers.map((_, index) => ({ url: `https://mock.invalid/${calls}/${index}.png` }));
      const response = model === 'qwen' ? { images } : model === 'sam2' ? { individual_masks: images } : model === 'sam3' ? { masks: images } : { image: images[0] };
      const decoded = normalizeProviderOutput(model, response);
      if (decoded.images.length !== buffers.length) throw new Error('Mock contract mismatch');
      const provenance = (context.job.data.inferences ??= {}) as Record<string, unknown>;
      provenance[`mock-${calls}`] = { provider: 'mock', liveVerified: false, endpoint: endpointRegistry[model].endpoint, requestId: `mock-${calls}`, transform: request.transform, dimensions: await Promise.all(buffers.map(async (b) => { const m = await sharp(b).metadata(); return { width: m.width, height: m.height }; })) };
      context.save(); return buffers;
    };
    await runPhase(context); repo.releaseJob(job.id, 'offline-demo', claimed.fence); job = repo.getJob(job.id)!;
    if (phase === 4) job = repo.reviewJob(job.id, 'operator', { expectedRevision: job.revision, action: 'accept-masks', objects: [
      { id: 'candidate-1', label: 'person', selected: true, points: [{ x: 150, y: 120, label: 1 }, { x: 160, y: 200, label: 0 }] },
      { id: 'candidate-2', label: 'board', selected: true, points: [{ x: 160, y: 200, label: 1 }, { x: 150, y: 60, label: 0 }, { x: 70, y: 205, label: 0 }, { x: 247, y: 205, label: 0 }, { x: 150, y: 120, label: 0 }] },
    ] });
    if (job.state === 'failed') throw new Error(job.error?.message);
  }
  const refined = job.data.refined as { label: string; maskArtifactId: string }[];
  if (job.phase !== 5 || refined?.length !== 2) throw new Error('Phase 5 did not produce both target masks.');
  const { decodeMask, overlapMasks } = await import('./image/masks.js');
  const board = await decodeMask(await store.read(repo.getArtifact(refined.find((o) => o.label === 'board')!.maskArtifactId)!), { encoding: 'luminance', binary: true });
  if (overlapMasks(board, fixture.person).intersection) throw new Error('Board owns person/face/finger pixels.');
  const exported = await exportDemo(repo, store, job.id, destination);
  console.info(JSON.stringify({ providerMode: 'mock', liveVerified: false, phase: job.phase, calls, boardPersonOverlap: 0, ...exported }, null, 2));
} finally { repo.close(); }
