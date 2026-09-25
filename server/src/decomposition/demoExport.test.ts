import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DecompositionRepository } from './repository.js';
import { ArtifactStore } from './artifactStore.js';
import { exportDemo } from './demoExport.js';
import { personHoldingBoardFixture } from './image/syntheticFixtures.js';
import { normalizeSource } from './phases/source.js';
import { overlayMasks } from './image/overlay.js';
import { decodeRgba } from './image/decode.js';
import { emptyMask } from './image/masks.js';

const directories: string[] = [], repositories: DecompositionRepository[] = [];
afterEach(async () => { for (const repo of repositories.splice(0)) repo.close(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), 'frameflow-demo-')); directories.push(directory);
  const repository = new DecompositionRepository(resolve(directory, 'data')); repositories.push(repository);
  const store = new ArtifactStore(resolve(directory, 'data'), repository);
  const generated = await personHoldingBoardFixture(), source = await normalizeSource(generated.image);
  const original = await store.write({ ownerId: 'operator', kind: 'original', mimeType: 'image/png', width: source.width, height: source.height }, source.original);
  const master = await store.write({ ownerId: 'operator', kind: 'master', mimeType: 'image/png', width: source.width, height: source.height }, source.master);
  repository.addSource({ id: 'fixture-source', ownerId: 'operator', originalArtifactId: original.artifactId, masterArtifactId: master.artifactId, originalSha256: source.originalSha256,
    workingMasterSha256: source.workingMasterSha256, width: source.width, height: source.height, mimeType: source.mimeType, orientationNormalized: source.orientationNormalized, hasAlpha: source.hadAlpha, metadata: {}, createdAt: Date.now() });
  const job = repository.createJob('operator', 'fixture-source', { maxObjects: 2, targetLabels: ['board'], maxCalls: 4, qualityProfile: 'faithful', completeHiddenObjects: false, reconstructBackground: false, allowEraseFallback: false }, 'fixture-idempotency');
  job.data = { verificationMode: 'mock', inferences: { hash: { providerRequestId: 'mock-request', token: 'DO_NOT_EXPORT', inputUrl: 'https://private.example/image', dimensions: [{ width: 320, height: 400 }] } } };
  job.warnings = ['<img src=x onerror=alert(1)>']; repository.updateJob(job);
  return { directory, repository, store, job, generated, source };
}

describe('phase 01–05 review demo export', () => {
  it('creates an independently viewable folder with exact source hashes, overlays, explicit mock status and no private paths/tokens', async () => {
    const { directory, repository, store, job, generated, source } = await fixture();
    const overlay = await overlayMasks(source.master, [{ mask: generated.board, color: '#ff0000' }]);
    await store.write({ ownerId: 'operator', jobId: job.id, kind: 'board overlay', relativePath: '05-refined/board-overlay.png', mimeType: 'image/png', width: source.width, height: source.height }, overlay);
    const exported = await exportDemo(repository, store, job.id, resolve(directory, 'review'));
    expect(exported.artifactCount).toBe(3);
    expect(await readFile(resolve(exported.directory, '01-original/original.png'))).toEqual(source.original);
    const html = await readFile(exported.indexPath, 'utf8'), metadataText = await readFile(exported.metadataPath, 'utf8');
    expect(html).toContain('MOCK FIXTURE DEMO');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('05-refined/board-overlay.png');
    expect(html).not.toContain('<img src=x');
    const metadata = JSON.parse(metadataText);
    expect(metadata.source.workingMasterSha256).toBe(source.workingMasterSha256);
    expect(metadataText).not.toContain('DO_NOT_EXPORT'); expect(metadataText).not.toContain('private.example'); expect(metadataText).not.toContain(directory);
    await expect(exportDemo(repository, store, job.id, exported.directory)).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it('rejects traversal/out-of-scope paths before creating the review directory', async () => {
    const { directory, repository, store, job } = await fixture();
    await store.write({ ownerId: 'operator', jobId: job.id, kind: 'bad', relativePath: '05-refined/../../escape.txt', mimeType: 'text/plain' }, Buffer.from('unsafe'));
    await expect(exportDemo(repository, store, job.id, resolve(directory, 'review'))).rejects.toMatchObject({ code: 'INVALID_EXPORT_PATH' });
  });

  it('blends only diagnostic mask pixels, retains source dimensions/alpha and rejects accidental stretched masks', async () => {
    const { generated, source } = await fixture();
    const bytes = await overlayMasks(source.master, [{ mask: generated.board, color: [255, 0, 0], opacity: 0.5 }]);
    const before = await decodeRgba(source.master), after = await decodeRgba(bytes);
    expect([after.width, after.height]).toEqual([before.width, before.height]);
    const untouched = (50 * source.width + 150) * 4, board = (200 * source.width + 150) * 4;
    expect(after.data.subarray(untouched, untouched + 4)).toEqual(before.data.subarray(untouched, untouched + 4));
    expect(Array.from(after.data.subarray(board, board + 4))).toEqual([248, 99, 27, 255]);
    await expect(overlayMasks(source.master, [{ mask: emptyMask(8, 8) }])).rejects.toMatchObject({ code: 'IMAGE_ALIGNMENT' });
  });
});
