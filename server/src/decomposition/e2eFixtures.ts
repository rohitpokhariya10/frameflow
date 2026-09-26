/**
 * Discovery fixtures for browser tests ONLY: a real cached Seedream discovery replayed from a data directory
 * (DECOMP_E2E_REPLAY_DIR + DECOMP_E2E_REPLAY_JOB), or a synthetic poster that mirrors live layerize geometry.
 */
import { resolve } from 'node:path';
import sharp from 'sharp';
import { DecompositionRepository } from './repository.js';
import { ArtifactStore } from './artifactStore.js';
import type { CachedInference } from './context.js';
import type { ProviderLayerMetadata } from './providers/adapters.js';

export type Replay = { source: Buffer; outputs: Buffer[]; layers: ProviderLayerMetadata[]; requestId: string };

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
  // A coloured footer bar that nothing overlaps, so a vector shape is always reconstructable.
  const footer = await sharp({ create: { width: 692, height: 80, channels: 3, background: '#2f6f5e' } }).png().toBuffer();
  const source = await sharp({ create: { width: 800, height: 1000, channels: 3, background: '#f4efe8' } }).composite([{ input: footer, left: 54, top: 902 }]).png().toBuffer();
  const box = (l: number, t: number, r: number, b: number) => [l, t, r, b] as [number, number, number, number];
  const layers: ProviderLayerMetadata[] = [
    { zIndex: 0 },
    { zIndex: 1, name: 'Orange main panel', description: 'Rounded orange panel behind the person', bboxAbsolute: box(100, 260, 700, 830) },
    { zIndex: 2, name: 'PRO headline', description: 'Large headline text', bboxAbsolute: box(100, 40, 660, 230) },
    { zIndex: 3, name: 'Woman holding phone', description: 'Person holding a phone', bboxAbsolute: box(40, 140, 640, 830) },
    { zIndex: 4, name: 'Phone', description: 'Phone held by the person', bboxAbsolute: box(420, 520, 780, 720) },
    { zIndex: 5, name: 'Footer bar', description: 'Solid green footer bar', bboxAbsolute: box(60, 1010, 835, 1100) },
    { zIndex: 6, name: 'Sticker', description: 'Rounded rectangle text sticker reading NEW', bboxAbsolute: box(680, 60, 820, 200) },
  ];
  const outputs = [await sharp({ create: { width: 896, height: 1120, channels: 3, background: '#f4efe8' } }).png().toBuffer(),
    await crop(720, 684, '#f06a1c'), await crop(980, 333, '#f58a2a'), await crop(660, 759, '#6a3a5c'), await crop(837, 465, '#e0782c'), await crop(1163, 135, '#2f6f5e', 0), await crop(210, 210, '#d9364f')];
  return { source, outputs, layers, requestId: 'synthetic-e2e' };
}

export async function loadDiscoveryFixture(): Promise<Replay> {
  return process.env.DECOMP_E2E_REPLAY_DIR && process.env.DECOMP_E2E_REPLAY_JOB
    ? replayFrom(resolve(process.env.DECOMP_E2E_REPLAY_DIR), process.env.DECOMP_E2E_REPLAY_JOB) : synthetic();
}
