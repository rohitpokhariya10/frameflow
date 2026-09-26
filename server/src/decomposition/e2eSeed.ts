/**
 * Seeds an isolated decomposition data directory for browser tests. No provider is ever contacted:
 * discovery outputs are replayed through the real phase 1–3 pipeline.
 *
 *   DECOMP_E2E_DATA=<empty dir>            target data directory (required)
 *   DECOMP_E2E_REPLAY_DIR=<data dir>       optional: replay a real cached Seedream discovery from this data directory
 *   DECOMP_E2E_REPLAY_JOB=<job id>         optional: the job whose cached Seedream result and source are replayed
 *
 * Without a replay source, a synthetic poster-like discovery (person, held phone, headline, panel, base) is used.
 */
import { resolve } from 'node:path';
import sharp from 'sharp';
import { readDecompositionConfig, normalizeDecompositionOptions } from './config.js';
import { DecompositionRepository } from './repository.js';
import { ArtifactStore } from './artifactStore.js';
import { PipelineContext, type CachedInference } from './context.js';
import { runPhase } from './pipeline.js';
import type { ProviderLayerMetadata } from './providers/adapters.js';
import type { InferenceOutput } from './providers/inference.js';

type Replay = { source: Buffer; outputs: Buffer[]; layers: ProviderLayerMetadata[]; requestId: string };

async function replayFrom(dir: string, jobId: string): Promise<Replay> {
  const repo = new DecompositionRepository(dir), store = new ArtifactStore(dir, repo);
  try {
    const job = repo.getJob(jobId);
    const cached = job?.data.seedreamInference as CachedInference | undefined;
    if (!job || !cached?.layers) throw new Error(`Job ${jobId} has no cached Seedream discovery to replay.`);
    const source = repo.getSource(job.sourceId)!;
    const outputs: Buffer[] = [];
    for (const id of cached.artifactIds) outputs.push(await store.read(repo.getArtifact(id)!));
    return { source: await store.read(repo.getArtifact(source.masterArtifactId)!), outputs, layers: cached.layers, requestId: cached.requestId };
  } finally { repo.close(); }
}

async function crop(width: number, height: number, fill: string, inset = 0.06) {
  const mask = Buffer.alloc(width * height * 4);
  const [r, g, b] = [1, 3, 5].map(i => parseInt(fill.slice(i, i + 2), 16));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, inside = x >= width * inset && x < width * (1 - inset) && y >= height * inset && y < height * (1 - inset);
    mask[i] = r; mask[i + 1] = g; mask[i + 2] = b; mask[i + 3] = inside ? 255 : 0;
  }
  return sharp(mask, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

/** Mirrors observed live geometry: full-canvas base, bbox crops uniformly upscaled per layer. */
async function synthetic(): Promise<Replay> {
  const source = await sharp({ create: { width: 800, height: 1000, channels: 3, background: '#f4efe8' } }).png().toBuffer();
  const box = (l: number, t: number, r: number, b: number) => [l, t, r, b] as [number, number, number, number];
  const layers: ProviderLayerMetadata[] = [
    { zIndex: 0 },
    { zIndex: 1, name: 'Orange main panel', description: 'Rounded orange panel behind the person', bboxAbsolute: box(100, 260, 700, 830) },
    { zIndex: 2, name: 'PRO headline', description: 'Large headline text', bboxAbsolute: box(100, 40, 660, 230) },
    { zIndex: 3, name: 'Woman holding phone', description: 'Person holding a phone', bboxAbsolute: box(40, 140, 640, 830) },
    { zIndex: 4, name: 'Phone', description: 'Phone held by the person', bboxAbsolute: box(420, 520, 780, 720) },
  ];
  const outputs = [await sharp({ create: { width: 896, height: 1120, channels: 3, background: '#f4efe8' } }).png().toBuffer(),
    await crop(720, 684, '#f06a1c'), await crop(980, 333, '#f58a2a'), await crop(660, 759, '#6a3a5c'), await crop(837, 465, '#e0782c')];
  return { source, outputs, layers, requestId: 'synthetic-e2e' };
}

const target = process.env.DECOMP_E2E_DATA;
if (!target) throw new Error('Set DECOMP_E2E_DATA to an empty directory.');
const replay = process.env.DECOMP_E2E_REPLAY_DIR && process.env.DECOMP_E2E_REPLAY_JOB
  ? await replayFrom(resolve(process.env.DECOMP_E2E_REPLAY_DIR), process.env.DECOMP_E2E_REPLAY_JOB) : await synthetic();
const config = { ...readDecompositionConfig({ DECOMP_DATA_DIR: target, DECOMP_PROVIDER_MODE: 'live' }), discoveryFallback: 'none' as const };
const repo = new DecompositionRepository(config.dataDir), store = new ArtifactStore(config.dataDir, repo, config.maxJobBytes);
const meta = await sharp(replay.source).metadata();
const artifact = await store.write({ ownerId: 'operator', kind: 'source', mimeType: 'image/png', width: meta.width, height: meta.height }, replay.source);
repo.addSource({ id: 'e2e-source', ownerId: 'operator', originalArtifactId: artifact.artifactId, masterArtifactId: artifact.artifactId, originalSha256: artifact.sha256, workingMasterSha256: artifact.sha256, width: meta.width!, height: meta.height!, hasAlpha: Boolean(meta.hasAlpha), mimeType: 'image/png', orientationNormalized: false, metadata: {}, createdAt: Date.now() });
repo.createJob('operator', 'e2e-source', normalizeDecompositionOptions({}, config), 'e2e-proposal-review');
let job = repo.claimJob('e2e-seed', config.leaseMs, 'live')!;
job.data.verificationMode = 'live';
job = repo.updateJob(job, { workerId: 'e2e-seed', fence: job.fence, revision: job.revision });
const infer = async (model: string): Promise<InferenceOutput> => {
  if (model !== 'seedream') throw new Error(`E2E seed does not call ${model}.`);
  return Object.assign([...replay.outputs], { layers: replay.layers, requestId: replay.requestId });
};
for (let phase = 1; phase <= 3; phase++) {
  const context = new PipelineContext(repo.getJob(job.id)!, repo, store, config, undefined, 'e2e-seed');
  context.infer = infer as PipelineContext['infer'];
  await runPhase(context);
}
repo.releaseJob(job.id, 'e2e-seed', repo.getJob(job.id)!.fence);
const seeded = repo.getJob(job.id)!;
console.info(JSON.stringify({ event: 'e2e_seeded', jobId: seeded.id, state: seeded.state, gate: seeded.review?.gate, targets: (seeded.data.proposalTargets as { label: string }[]).map(t => t.label), replay: replay.requestId }));
repo.close();
