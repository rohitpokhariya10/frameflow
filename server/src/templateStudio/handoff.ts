/**
 * The one connection between Template Studio and FrameFlow's decomposition: a narrow adapter, outside the decomposition
 * code, which it only reads.
 *
 *   1. decompositionScene: the poster's text-free scene (exact product pixels included when they were applied), cropped to
 *      the poster's aspect ratio at the image model's own resolution. No upscaling, no text, no logo: those return as native
 *      editor elements after import. The PNG is stored once, so every download is byte-identical.
 *   2. The browser sends that PNG to FrameFlow's existing decomposition entry point (POST /api/layerize-experiment/runs),
 *      exactly as Decompose/Test does, after the user confirms the paid run.
 *   3. linkDecomposition records which run came from which poster, after checking that the run's saved original is
 *      byte-for-byte this poster's scene: a stale or unrelated run can never be attached.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { readRun, validRunId } from '../decomposition/layerizeExperiment.js';
import { ingestAsset } from './assets/ingest.js';
import { overlayDocSchema } from './compose/overlay.js';
import { readStorageFile } from './storage.js';
import { newId, now, type DecompositionLinkRecord, type PosterRecord, type StudioStore } from './store.js';

export class HandoffError extends Error {
  constructor(readonly code: 'not_found' | 'invalid' | 'mismatch', message: string) { super(message); this.name = 'HandoffError'; }
}

/** The PNG sent to decomposition for this poster, and how it was prepared from the generated image. */
export async function decompositionScene(db: StudioStore, storageDir: string, poster: PosterRecord) {
  const doc = overlayDocSchema.parse(poster.overlay);
  const scene = db.assets.require(poster.decompositionAssetId ?? doc.sceneAssetId, 'Scene');
  const full = doc.crop.x === 0 && doc.crop.y === 0 && doc.crop.width === scene.width && doc.crop.height === scene.height;
  const bytes = full
    ? await readStorageFile(storageDir, scene.normalisedPath)
    : await sharp(await readStorageFile(storageDir, scene.normalisedPath)).extract({ left: doc.crop.x, top: doc.crop.y, width: doc.crop.width, height: doc.crop.height }).png().toBuffer();
  const { asset } = await ingestAsset({ buffer: bytes, role: 'export', filename: `decompose-${poster.id}.png`, label: `Decomposition input for poster ${poster.id}` }, { db, storageDir });
  const note = poster.decompositionAssetId
    ? `Background only (${asset.width}×${asset.height}): protected source-product layers are restored directly in the editor, without re-extracting their pixels.`
    : poster.provenance === 'reference_reuse'
      ? `Reused original reference (${asset.width}×${asset.height}), including original raster text and logos.`
      : full
    ? `The generated scene as is (${asset.width}×${asset.height}), without text or logo.`
    : `The generated scene cropped to the poster's ${doc.canvas.width}:${doc.canvas.height} area (${asset.width}×${asset.height} of ${scene.width}×${scene.height}), without text or logo.`;
  return { asset, bytes: await readStorageFile(storageDir, asset.originalPath), note, canvas: doc.canvas, crop: doc.crop };
}

/** Record that `runId` decomposes this poster's scene; idempotent for the same pair. */
export async function linkDecomposition(db: StudioStore, storageDir: string, runsDir: string, poster: PosterRecord, runId: string): Promise<DecompositionLinkRecord> {
  if (typeof runId !== 'string' || !validRunId(runId)) throw new HandoffError('invalid', 'Unknown decomposition run.');
  const existing = db.decompositions.find(d => d.posterId === poster.id && d.runId === runId);
  if (existing) return existing;
  const dir = join(runsDir, runId);
  if (!existsSync(join(dir, 'run.json'))) throw new HandoffError('not_found', 'Decomposition run not found.');
  const run = readRun(dir);
  const sent = await decompositionScene(db, storageDir, poster);
  const original = readFileSync(join(dir, run.original.file));
  if (createHash('sha256').update(original).digest('hex') !== sent.asset.sha256) throw new HandoffError('mismatch', 'That decomposition run was not made from this poster\'s scene.');
  return db.decompositions.insert({
    id: newId('dec'), posterId: poster.id, runId, sceneAssetId: sent.asset.id, sentWidth: sent.asset.width, sentHeight: sent.asset.height,
    canvasWidth: sent.canvas.width, canvasHeight: sent.canvas.height, crop: sent.crop, createdAt: now(),
  });
}
