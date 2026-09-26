import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { DecompositionRepository } from './repository.js';
import { ArtifactStore } from './artifactStore.js';
import { readDecompositionConfig, normalizeDecompositionOptions } from './config.js';
import { PipelineContext } from './context.js';
import { runPhase } from './pipeline.js';
import { createTransform } from './image/coordinates.js';
import { decodeMask, emptyMask, encodeMask, measureMask } from './image/masks.js';
import type { Infer } from './providers/inference.js';

it('persists full-person candidate identity and both point labels through review and phase 5; rejects a patch mismatch before inference', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'frameflow-review-'));
  const repo = new DecompositionRepository(dir);
  try {
    const store = new ArtifactStore(dir, repo);
    const config = readDecompositionConfig({ DECOMP_DATA_DIR: dir });
    const master = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#789abc' } }).png().toBuffer();
    const source = await store.write({ ownerId: 'operator', kind: 'source', mimeType: 'image/png', width: 256, height: 256 }, master);
    repo.addSource({ id: 'source', ownerId: 'operator', originalArtifactId: source.artifactId, masterArtifactId: source.artifactId, originalSha256: source.sha256, workingMasterSha256: source.sha256, width: 256, height: 256, mimeType: 'image/png', hasAlpha: false, orientationNormalized: false, metadata: {}, createdAt: Date.now() });
    const person = emptyMask(256, 256), patch = emptyMask(256, 256);
    for (let y = 24; y < 232; y++) for (let x = 64; x < 192; x++) person.data[y * 256 + x] = 255;
    for (let y = 150; y < 160; y++) for (let x = 100; x < 120; x++) patch.data[y * 256 + x] = 255;
    const personPng = await encodeMask(person);
    const candidates = [];
    // Deliberately different list positions, generic labels, and stable candidate numbers.
    for (const [id, label, mask] of [['candidate-5', 'Object 5', patch], ['candidate-8', 'Object 8', person]] as const) {
      const artifact = await store.write({ ownerId: 'operator', kind: 'mask', mimeType: 'image/png', width: 256, height: 256 }, await encodeMask(mask));
      candidates.push({ id, label, maskArtifactId: artifact.artifactId, overlayArtifactId: artifact.artifactId, warnings: [], statistics: measureMask(mask), selected: false });
    }
    const options = normalizeDecompositionOptions({ targetLabels: ['person', 'background'] }, config);
    for (const candidateId of ['candidate-8', 'candidate-5']) {
      repo.createJob('operator', 'source', options, candidateId);
      let job = repo.claimJob('worker')!;
      job.phase = 4; job.state = 'needs_review';
      job.review = { code: 'OWNERSHIP', message: 'Select person', actions: ['accept-masks'], artifactIds: [] };
      job.data = { candidates, analysisArtifactId: source.artifactId, analysisTransform: createTransform(256, 256, 1024) };
      job = repo.updateJob(job, { workerId: 'worker', fence: job.fence, revision: job.revision });
      const points = [{ x: 128, y: 80, label: 1 as const }, { x: 10, y: 128, label: 0 as const }];
      repo.reviewJob(job.id, 'operator', { expectedRevision: job.revision, action: 'accept-masks', objects: candidates.map(c => ({ id: c.id, candidateId: c.id, selected: c.id === candidateId, label: 'person', points: c.id === candidateId ? points : [] })) });
      job = repo.claimJob('worker')!;
      expect(repo.summarize(job).reviewSubmission?.objects?.find(c => c.selected)?.points).toEqual(points);
      const context = new PipelineContext(job, repo, store, config, undefined, 'worker');
      const infer = vi.fn<Infer>(async (model, request) => {
        expect(['sam3', 'birefnet']).toContain(model);
        const transform = request.transform!;
        if (model === 'sam3') {
          expect(request.key).toContain('candidate-8');
          expect(request.prompt).toBe('person');
          expect(request.points).toEqual(points.map(p => ({ ...p, x: p.x - transform.crop.x, y: p.y - transform.crop.y })));
        }
        return [await sharp(personPng).extract({ left: transform.crop.x, top: transform.crop.y, width: transform.crop.width, height: transform.crop.height }).png().toBuffer()];
      });
      context.infer = infer;
      await runPhase(context);
      if (candidateId === 'candidate-5') {
        expect(infer).not.toHaveBeenCalled();
        expect(context.job.review?.code).toBe('GUIDANCE_MASK_CONFLICT');
        expect(context.job.review?.message).toContain('POSITIVE_POINT_OUTSIDE_MASK');
      } else {
        const refined = context.job.data.refined as { id: string; maskArtifactId: string; input: { candidateId: string; positivePointCount: number; negativePointCount: number }; warnings: string[] }[];
        expect(refined).toHaveLength(1);
        expect(refined[0]).toMatchObject({ id: 'candidate-8', input: { candidateId: 'candidate-8', positivePointCount: 1, negativePointCount: 1 } });
        expect(measureMask(await decodeMask(await context.artifact(refined[0].maskArtifactId), { encoding: 'luminance' })).area).toBe(measureMask(person).area);
        expect(refined[0].warnings).not.toContain('POSITIVE_GUIDANCE_MISSING');
        expect(infer).toHaveBeenCalledTimes(2);
      }
    }
  } finally { repo.close(); await rm(dir, { recursive: true, force: true }); }
});
