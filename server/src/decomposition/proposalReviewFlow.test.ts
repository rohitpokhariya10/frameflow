import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { validDecompositionReview, type DecompositionReview, type ProposalReviewTarget } from '@frameflow/shared';
import { DecompositionRepository } from './repository.js';
import { ArtifactStore } from './artifactStore.js';
import { readDecompositionConfig, normalizeDecompositionOptions } from './config.js';
import { PipelineContext } from './context.js';
import { runPhase } from './pipeline.js';
import { createTransform } from './image/coordinates.js';
import { ProviderError } from './providers/adapters.js';
import type { Infer } from './providers/inference.js';

async function rgba(width: number, height: number, box?: { x: number; y: number; width: number; height: number }) {
  const data = Buffer.alloc(width * height * 4, 0);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4; data[i] = 220; data[i + 1] = 110; data[i + 2] = 30;
    data[i + 3] = !box || (x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height) ? 255 : 0;
  }
  return sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

/** Poster-like discovery: a base plus person, held item, headline text and a panel, as uniformly scaled crops. */
async function setup() {
  const dir = await mkdtemp(resolve(tmpdir(), 'frameflow-proposal-review-'));
  const repo = new DecompositionRepository(dir), store = new ArtifactStore(dir, repo);
  const config = readDecompositionConfig({ DECOMP_DATA_DIR: dir, DECOMP_PROVIDER_MODE: 'live' });
  const master = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#dddddd' } }).png().toBuffer();
  const source = await store.write({ ownerId: 'operator', kind: 'source', mimeType: 'image/png', width: 256, height: 256 }, master);
  repo.addSource({ id: 'source', ownerId: 'operator', originalArtifactId: source.artifactId, masterArtifactId: source.artifactId, originalSha256: source.sha256, workingMasterSha256: source.sha256, width: 256, height: 256, mimeType: 'image/png', hasAlpha: false, orientationNormalized: false, metadata: {}, createdAt: Date.now() });
  const box = (l: number, t: number, r: number, b: number) => [l, t, r, b] as [number, number, number, number];
  const outputs = Object.assign([await rgba(512, 512), await rgba(400, 600, { x: 20, y: 20, width: 360, height: 560 }), await rgba(240, 120, { x: 10, y: 10, width: 220, height: 100 }), await rgba(600, 150, { x: 10, y: 10, width: 580, height: 130 }), await rgba(300, 300, { x: 5, y: 5, width: 290, height: 290 })], {
    requestId: 'seedream-req', layers: [
      { zIndex: 0 },
      { zIndex: 1, name: 'Woman', description: 'Young woman', bboxAbsolute: box(100, 100, 300, 400) },
      { zIndex: 2, name: 'Phone', description: 'Phone held by the woman', bboxAbsolute: box(260, 200, 380, 260) },
      { zIndex: 3, name: 'PRO headline', description: 'Headline text', bboxAbsolute: box(40, 20, 440, 120) },
      { zIndex: 4, name: 'Orange panel', description: 'Rounded panel', bboxAbsolute: box(60, 140, 360, 440) }] });
  const samPrompts: string[] = [];
  const infer = vi.fn<Infer>(async (model, request) => {
    if (model === 'seedream') return outputs;
    samPrompts.push(String(request.prompt));
    throw new ProviderError('TEST_STOP', 'Stop before paid segmentation in this test.');
  });
  repo.createJob('operator', 'source', normalizeDecompositionOptions({}, config), 'proposal-review');
  let job = repo.claimJob('worker')!;
  job.phase = 2; job.data = { verificationMode: 'live', analysisArtifactId: source.artifactId, analysisTransform: createTransform(256, 256, 1024) };
  job = repo.updateJob(job, { workerId: 'worker', fence: job.fence, revision: job.revision });
  const run = async () => { const claimed = repo.claimJob('worker')!; const context = new PipelineContext(claimed, repo, store, config, undefined, 'worker'); context.infer = infer; try { await runPhase(context); } finally { repo.releaseJob(claimed.id, 'worker', repo.getJob(claimed.id)!.fence); } };
  const first = new PipelineContext(job, repo, store, config, undefined, 'worker'); first.infer = infer; await runPhase(first);
  const submit = (review: DecompositionReview) => { expect(validDecompositionReview(review, 256, 256)).toBe(true); repo.reviewJob(job.id, 'operator', review); };
  return { repo, id: job.id, run, submit, infer, samPrompts, cleanup: async () => { repo.close(); await rm(dir, { recursive: true, force: true }); } };
}

it('starts proposal review from provider names and keeps the discovered base as a background element', async () => {
  const env = await setup();
  try {
    const job = env.repo.getJob(env.id)!;
    expect(job.state).toBe('needs_review'); expect(job.review?.gate).toBe('qwen-proposal-review');
    const targets = env.repo.summarize(job).proposalTargets!;
    expect(targets.map(t => [t.label, t.role, t.baseLayer ?? false])).toEqual([['Woman', 'unknown', false], ['Phone', 'unknown', false], ['PRO headline', 'unknown', false], ['Orange panel', 'unknown', false], ['Background', 'background', true]]);
    expect(targets[0]).toMatchObject({ description: 'Young woman', proposalIds: ['proposal-1'], provenance: { operation: 'discovered', originalLabel: 'Woman', proposalIds: ['proposal-1'] } });
    expect(targets[4]).toMatchObject({ id: 'target-background', proposalIds: [], provenance: { operation: 'discovered-base' } });
    // Provisional source-space guidance comes from the registered proposal alpha.
    expect(targets.every(t => t.maskArtifactId && t.overlayArtifactId && t.provisionalMaskRevision)).toBe(true);
    expect(env.repo.summarize(job).discovery?.baseLayer?.artifactId).toBeTruthy();
  } finally { await env.cleanup(); }
});

it('persists approve, reject, rename, shape/text roles, grouping and split provenance across reload; ignores forged fields', async () => {
  const env = await setup();
  try {
    let job = env.repo.getJob(env.id)!;
    const [woman, phone, headline, panel, background] = env.repo.summarize(job).proposalTargets!;
    // Client-side edits: group woman+phone, rename, mark text and shape, reject, and try to forge base/provenance.
    const group: ProposalReviewTarget = { id: 'target-group-1', label: 'woman_with_phone', proposalIds: ['proposal-1', 'proposal-2'], memberTargetIds: [woman.id, phone.id], groupMode: 'group', role: 'object', approved: true, rejected: false };
    const forged = { ...headline, label: 'PRO', role: 'text' as const, approved: true, baseLayer: true, provenance: { operation: 'user-group' as const, sourceRevision: 99, createdAt: 'forged' } };
    env.submit({ expectedRevision: job.revision, action: 'save-proposals', targets: [group, forged, { ...panel, label: 'Orange rounded panel', role: 'shape', approved: false, rejected: true }, { ...background, approved: true }] });
    await env.run();
    job = env.repo.getJob(env.id)!;
    expect(job.state).toBe('needs_review'); expect(env.infer.mock.calls.filter(c => c[0] !== 'seedream')).toHaveLength(0);
    // Reload through a fresh repository summary: everything survives.
    const saved = env.repo.summarize(env.repo.getJob(env.id)!).proposalTargets!;
    const byId = Object.fromEntries(saved.map(t => [t.id, t]));
    expect(saved.map(t => t.id)).toEqual(['target-group-1', headline.id, panel.id, 'target-background']);
    expect(byId['target-group-1']).toMatchObject({ label: 'woman_with_phone', groupMode: 'group', approved: true, proposalIds: ['proposal-1', 'proposal-2'],
      provenance: { operation: 'user-group', memberTargetIds: [woman.id, phone.id], memberLabels: ['Woman', 'Phone'], proposalIds: ['proposal-1', 'proposal-2'], sourceRevision: job.data.reviewRevision } });
    expect(byId[headline.id]).toMatchObject({ label: 'PRO', role: 'text', approved: true, provenance: { operation: 'discovered', originalLabel: 'PRO headline' } });
    expect(byId[headline.id].baseLayer).toBeUndefined();
    expect(byId[panel.id]).toMatchObject({ label: 'Orange rounded panel', role: 'shape', rejected: true, approved: false });
    expect(byId['target-background']).toMatchObject({ baseLayer: true, approved: true, role: 'background' });
    // The grouped provisional mask is the union of both members' source-space guidance.
    expect(byId['target-group-1'].maskArtifactId).not.toBe(woman.maskArtifactId);

    // Split the group back out: the server records which target it came from.
    job = env.repo.getJob(env.id)!;
    const current = env.repo.summarize(job).proposalTargets!;
    const splitWoman: ProposalReviewTarget = { id: 'target-split-a', label: 'Woman', proposalIds: ['proposal-1'], groupMode: 'single', role: 'object', approved: true, rejected: false, splitFromTargetId: 'target-group-1' };
    const invented: ProposalReviewTarget = { id: 'target-new', label: 'Logo', proposalIds: [], groupMode: 'single', role: 'object', approved: false, rejected: false, splitFromTargetId: 'target-group-1', userBox: { x: 10, y: 10, width: 30, height: 30 } };
    env.submit({ expectedRevision: job.revision, action: 'save-proposals', targets: [...current.filter(t => t.id !== 'target-group-1'), splitWoman, invented] });
    await env.run();
    const after = Object.fromEntries(env.repo.summarize(env.repo.getJob(env.id)!).proposalTargets!.map(t => [t.id, t]));
    expect(after['target-split-a'].provenance).toMatchObject({ operation: 'user-split', parentTargetId: 'target-group-1', parentLabel: 'woman_with_phone', proposalIds: ['proposal-1'] });
    // A target with no proposals cannot be a split of that group; it is recorded as user-created.
    expect(after['target-new'].provenance).toMatchObject({ operation: 'user-created' });
    expect(after['target-new'].userBox).toEqual({ x: 10, y: 10, width: 30, height: 30 });
  } finally { await env.cleanup(); }
});

it('approving continues to source segmentation with object targets only; the background layer is never segmented', async () => {
  const env = await setup();
  try {
    let job = env.repo.getJob(env.id)!;
    const [woman, phone, headline, panel, background] = env.repo.summarize(job).proposalTargets!;
    // Background alone is not enough to continue.
    env.submit({ expectedRevision: job.revision, action: 'approve-proposals', targets: [woman, phone, headline, panel, { ...background, approved: true }] });
    await env.run();
    job = env.repo.getJob(env.id)!;
    expect(job.state).toBe('needs_review'); expect(job.review?.message).toMatch(/object target/);
    expect(job.data.proposalReviewApproved).toBeUndefined();
    const group: ProposalReviewTarget = { id: 'target-group-1', label: 'woman holding phone', proposalIds: ['proposal-1', 'proposal-2'], memberTargetIds: [woman.id, phone.id], groupMode: 'group', role: 'object', approved: true, rejected: false };
    const refreshed = env.repo.summarize(job).proposalTargets!;
    env.submit({ expectedRevision: job.revision, action: 'approve-proposals', targets: [group, ...refreshed.filter(t => ![woman.id, phone.id].includes(t.id)).map(t => ({ ...t, approved: t.baseLayer === true }))] });
    // Source segmentation starts; the stubbed provider stops it, which the pipeline turns into a review pause or failure.
    await env.run().catch(() => undefined);
    job = env.repo.getJob(env.id)!;
    expect(job.data.proposalReviewApproved).toBe(true);
    expect(env.samPrompts.length).toBeGreaterThan(0);
    expect(env.samPrompts.some(p => /background/i.test(p))).toBe(false);
  } finally { await env.cleanup(); }
});

it('rejects a background-layer target that tries to take discovered proposals', async () => {
  const env = await setup();
  try {
    const job = env.repo.getJob(env.id)!;
    const targets = env.repo.summarize(job).proposalTargets!;
    env.submit({ expectedRevision: job.revision, action: 'save-proposals', targets: targets.map(t => t.baseLayer ? { ...t, proposalIds: ['proposal-1'] } : t) });
    await expect(env.run()).rejects.toMatchObject({ code: 'INVALID_TARGET' });
  } finally { await env.cleanup(); }
});

it('classification: ambiguous approved elements wait for a type; nothing is segmented', async () => {
  const env = await setup();
  try {
    let job = env.repo.getJob(env.id)!;
    const targets = env.repo.summarize(job).proposalTargets!;
    expect(targets.map(t => t.classification?.kind)).toEqual(['IMAGE_OBJECT', 'IMAGE_OBJECT', 'TEXT', 'SHAPE', 'BACKGROUND']);
    const badge: ProposalReviewTarget = { id: 'target-badge', label: 'Text badge', proposalIds: [], groupMode: 'single', role: 'unknown', approved: true, rejected: false, userBox: { x: 5, y: 5, width: 20, height: 20 } };
    env.submit({ expectedRevision: job.revision, action: 'approve-proposals', targets: [{ ...targets[0], approved: true }, ...targets.slice(1), badge] });
    await env.run();
    job = env.repo.getJob(env.id)!;
    expect(job.state).toBe('needs_review'); expect(job.review?.message).toMatch(/Choose an element type .*Text badge/);
    expect(job.data.proposalReviewApproved).toBeUndefined(); expect(env.samPrompts).toEqual([]);
    expect(env.repo.summarize(job).proposalTargets!.find(t => t.id === 'target-badge')?.classification).toMatchObject({ kind: 'UNKNOWN', reasons: expect.arrayContaining(['CONFLICTING_NAME_EVIDENCE']) });
  } finally { await env.cleanup(); }
});

it('classification: only image objects reach SAM; text, shape and background are recorded for their own routes', async () => {
  const env = await setup();
  try {
    const job = env.repo.getJob(env.id)!;
    const [woman, phone, headline, panel, background] = env.repo.summarize(job).proposalTargets!;
    env.submit({ expectedRevision: job.revision, action: 'approve-proposals', targets: [{ ...woman, approved: true }, phone, { ...headline, approved: true }, { ...panel, approved: true }, { ...background, approved: true }] });
    await env.run().catch(() => undefined);
    const after = env.repo.getJob(env.id)!;
    expect(env.samPrompts.length).toBeGreaterThan(0);
    expect(env.samPrompts.every(p => /woman/i.test(p))).toBe(true);
    expect(after.data.imageObjectTargetIds).toEqual([woman.id]);
    expect((after.data.sceneElements as { label: string; kind: string; baseLayer: boolean }[]).map(e => [e.label, e.kind, e.baseLayer])).toEqual([['PRO headline', 'TEXT', false], ['Orange panel', 'SHAPE', false], ['Background', 'BACKGROUND', true]]);
  } finally { await env.cleanup(); }
});

it('classification: with no image objects approved, segmentation is skipped entirely and the job completes without provider calls', async () => {
  const env = await setup();
  try {
    const job = env.repo.getJob(env.id)!;
    const targets = env.repo.summarize(job).proposalTargets!;
    env.submit({ expectedRevision: job.revision, action: 'approve-proposals', targets: targets.map(t => ({ ...t, approved: /PRO|panel|Background/.test(t.label) })) });
    await env.run();
    expect(env.repo.getJob(env.id)!.data.noImageObjects).toBe(true);
    await env.run();
    const done = env.repo.getJob(env.id)!;
    expect(done.state).toBe('completed'); expect(done.phase).toBe(6);
    expect(env.samPrompts).toEqual([]);
    expect(env.infer.mock.calls.map(c => c[0])).toEqual(['seedream']);
  } finally { await env.cleanup(); }
});
