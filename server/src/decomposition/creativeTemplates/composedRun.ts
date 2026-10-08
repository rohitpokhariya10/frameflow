/**
 * Editor-ready runs from a creative variant's own layers. A variant already has its layers (the new scenery as a clean
 * plate, a contact shadow, and the subject as exact source pixels), so it need not be flattened and decomposed again:
 *
 *   createComposedRun   a finished run built locally from those layers: no planner, no Seedream, no cost
 *   addVariantLayers    the shadow and the exact subject placed above a finished decomposition of the scenery plate,
 *                       so only the new scenery is split by the provider and the subject is never re-rendered
 *
 * Both write an ordinary run (run.json and layer files), so the dashboard, layer preview and editor import read it
 * like any other.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import type { RunTemplateExecution } from '@frameflow/shared';
import { readRun, saveRunRecord, SEEDREAM_ENDPOINT, type RunRecord } from '../layerizeExperiment.js';
import type { LayerInfo } from '../layerizeArtifacts.js';
import { normalizeLayerCount } from '../layerCount.js';

export type VariantRunLayer = { file: string; name: string; description: string; png: Buffer; placement: { x: number; y: number; width: number; height: number }; kind: 'full-canvas' | 'bbox-crop'; semantic: { id: string; type: string } };
async function layerInfo(layer: VariantRunLayer, index: number, zIndex: number): Promise<LayerInfo> {
  const { data, info } = await sharp(layer.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let opaque = 0; for (let i = 3; i < data.length; i += 4) if (data[i] > 8) opaque++;
  return { index, file: layer.file, zIndex, name: layer.name, description: layer.description, pixelWidth: info.width, pixelHeight: info.height,
    opaquePercent: Math.round(1000 * opaque / Math.max(1, info.width * info.height)) / 10, placement: { kind: layer.kind, ...layer.placement }, semantic: { id: layer.semantic.id, type: layer.semantic.type, editableIndependently: true } };
}
/** A finished run made of these layers, back to front, over this composite (its original image). */
export async function createComposedRun(runsDir: string, input: { composite: Buffer; layers: VariantRunLayer[]; origin: NonNullable<RunRecord['origin']>; templateExecution: RunTemplateExecution; variant: { setId: string; variantId: string } }) {
  const meta = await sharp(input.composite).metadata(), now = new Date().toISOString();
  const id = `${now.replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`, dir = join(runsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'original.png'), input.composite);
  const layers: LayerInfo[] = [];
  for (const [i, layer] of input.layers.entries()) { writeFileSync(join(dir, layer.file), layer.png); layers.push(await layerInfo(layer, i, i)); }
  const { outputLayers, layerCount } = normalizeLayerCount(layers);
  const run: RunRecord = { id, createdAt: now, updatedAt: now, stage: 'done', templateExecution: input.templateExecution, origin: input.origin,
    original: { file: 'original.png', mime: 'image/png', width: meta.width!, height: meta.height!, bytes: input.composite.length },
    input: { file: 'original.png', mime: 'image/png', width: meta.width!, height: meta.height!, orientationNormalized: false },
    // Never submitted: no request id, no provider call.
    seedream: { endpoint: SEEDREAM_ENDPOINT }, timings: {}, warnings: [], canvas: { width: meta.width!, height: meta.height! }, layers, outputLayers, layerCount,
    editorLayerFiles: layers.map(l => l.file), composed: { source: 'creative-variant', ...input.variant, layers: layers.map(l => l.file), extraction: 'none' } };
  saveRunRecord(dir, run);
  return { dir, run };
}
/**
 * The variant's exact layers above a finished decomposition of its scenery plate (only the scenery was sent). The
 * provider may return its layers at another size than the plate it was given: the exact layers are placed in the run's
 * own canvas, scaled from the source canvas they were cut on. Adding them twice (a resumed run) is a no-op.
 */
export async function addVariantLayers(dir: string, layers: VariantRunLayer[], variant: { setId: string; variantId: string }, source: { width: number; height: number }): Promise<RunRecord> {
  const run = readRun(dir);
  if (run.stage !== 'done' || run.composed) return run;
  const canvas = run.canvas ?? source, sx = canvas.width / source.width, sy = canvas.height / source.height;
  const existing = run.outputLayers ?? run.layers ?? [], top = Math.max(0, ...existing.map(l => l.zIndex)) + 1, added: LayerInfo[] = [];
  for (const [i, layer] of layers.entries()) {
    const x = Math.round(layer.placement.x * sx), y = Math.round(layer.placement.y * sy);
    const width = Math.max(1, Math.min(canvas.width - x, Math.round(layer.placement.width * sx))), height = Math.max(1, Math.min(canvas.height - y, Math.round(layer.placement.height * sy)));
    const scaled = sx === 1 && sy === 1 ? layer : { ...layer, placement: { x, y, width, height }, png: await sharp(layer.png).resize(width, height, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer() };
    writeFileSync(join(dir, scaled.file), scaled.png); added.push(await layerInfo(scaled, existing.length + i, top + i));
  }
  run.layers = [...(run.layers ?? []), ...added];
  run.outputLayers = [...(run.outputLayers ?? []), ...added.map(l => ({ ...l, sources: [l.file] }))];
  run.editorLayerFiles = [...(run.editorLayerFiles ?? existing.map(l => l.file)), ...added.map(l => l.file)];
  run.composed = { source: 'creative-variant', ...variant, layers: added.map(l => l.file), extraction: 'scenery' };
  saveRunRecord(dir, run);
  return run;
}
