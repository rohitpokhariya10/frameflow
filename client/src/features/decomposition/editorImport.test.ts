import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { CANVAS_LIMITS, type DesignVariant } from '@frameflow/shared';
import { readRun } from '../../../../server/src/decomposition/layerizeExperiment';
import { createComposedRun, type VariantRunLayer } from '../../../../server/src/decomposition/creativeTemplates/composedRun';
import { editorLayersOf, experimentToVariant, type ExperimentRun } from './layerizeExperiment';

// The editor import of both features' runs, through the editor's own import (experimentToVariant): what reaches Konva is
// each kept layer, back to front, at its run placement, on the run's canvas. A creative variant's composed run must
// rebuild its creative exactly; a decomposition run (a smart edit or a template reuse) must keep its layers' names,
// positions, sizes and stacking order.
async function imported(dir: string): Promise<{ run: ExperimentRun; variant: DesignVariant; assets: Map<string, Blob> }> {
  const run = readRun(dir) as unknown as ExperimentRun, assets = new Map<string, Blob>();
  let n = 0;
  const variant = await experimentToVariant(run, async file => new Blob([new Uint8Array(readFileSync(join(dir, file)))], { type: 'image/png' }),
    { putAsset: async (id: string, blob: Blob) => { assets.set(id, blob); }, deleteAsset: async (id: string) => { assets.delete(id); } } as never, () => `id${++n}`);
  return { run, variant, assets };
}
/** The design as Konva draws it: each visible image layer, back to front, at its own position and size. */
async function render(variant: DesignVariant, assets: Map<string, Blob>): Promise<Buffer> {
  const layers = [];
  for (const layer of variant.layers ?? []) {
    if (layer.type !== 'image' || !layer.visible) continue;
    const png = await sharp(Buffer.from(await assets.get(layer.assetId!)!.arrayBuffer())).resize(Math.round(layer.width), Math.round(layer.height), { fit: 'fill' }).png().toBuffer();
    layers.push({ input: png, left: Math.round(layer.x), top: Math.round(layer.y) });
  }
  return sharp({ create: { width: variant.canvas.width, height: variant.canvas.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(layers).png().toBuffer();
}
/** What the import must keep of each run layer: its name with its stacking position, and its placement on the canvas. */
function expectFaithful(run: ExperimentRun, variant: DesignVariant) {
  const kept = [...editorLayersOf(run)!].sort((a, b) => a.zIndex - b.zIndex);
  const scale = Math.min(1, CANVAS_LIMITS.maxSide / run.canvas!.width, CANVAS_LIMITS.maxSide / run.canvas!.height, Math.sqrt(CANVAS_LIMITS.maxArea / (run.canvas!.width * run.canvas!.height)));
  expect(variant.canvas, run.id).toMatchObject({ width: Math.floor(run.canvas!.width * scale), height: Math.floor(run.canvas!.height * scale), transparent: true });
  expect(variant.layers!.map(l => l.name.match(/\(z(\d+)\)$/)?.[1]), `${run.id}: back to front`).toEqual(kept.map(l => String(l.zIndex)));
  for (const [i, layer] of kept.entries()) {
    const shown = variant.layers![i], p = layer.placement;
    if (p.kind !== 'base') expect(shown.name, run.id).toContain((layer.name ?? '').slice(0, 40));
    if (p.kind === 'unresolved') { expect(shown.visible, run.id).toBe(false); continue; }
    expect([shown.x, shown.y, shown.width, shown.height, shown.visible], `${run.id} ${layer.file}`).toEqual([p.x * scale, p.y * scale, Math.max(1, p.width * scale), Math.max(1, p.height * scale), true]);
  }
}

describe('Feature 1: a creative variant\'s own layers in the editor', () => {
  it('rebuild the creative exactly: the scenery, each product\'s shadow and each product, back to front, at their places', async () => {
    const W = 1216, H = 1520, png = (w: number, h: number, draw: (x: number, y: number) => [number, number, number, number]) => {
      const data = Buffer.alloc(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(draw(x, y), (y * w + x) * 4);
      return sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
    };
    const scenery = await png(W, H, (x, y) => [200 + (x % 40), 170 + (y % 50), 140, 255]);
    // Two products of a group, each with its soft contact shadow under it (as the 4:5 composition places them).
    const product = (r: number, g: number, b: number) => png(220, 380, (x, y) => (((x - 110) / 110) ** 2 + ((y - 190) / 190) ** 2 <= 1 ? [r, g, b, 255] : [0, 0, 0, 0]));
    const shadow = () => png(260, 60, (x, y) => [0, 0, 0, Math.max(0, Math.round(110 * (1 - (((x - 130) / 130) ** 2 + ((y - 30) / 30) ** 2))))]);
    const at = { a: { x: 360, y: 640, width: 220, height: 380 }, b: { x: 640, y: 700, width: 220, height: 380 }, sa: { x: 340, y: 990, width: 260, height: 60 }, sb: { x: 620, y: 1050, width: 260, height: 60 } };
    const layer = (file: string, name: string, bytes: Buffer, placement: VariantRunLayer['placement'], kind: VariantRunLayer['kind'], id: string): VariantRunLayer => ({ file, name, description: name, png: bytes, placement, kind, semantic: { id, type: 'object' } });
    const layers = [layer('layer-1-new-scenery.png', 'Generated scene (flattened)', scenery, { x: 0, y: 0, width: W, height: H }, 'full-canvas', 'scenery'),
      layer('layer-2-shadow-a.png', 'Contact shadow · Kettle', await shadow(), at.sa, 'bbox-crop', 'shadow_a'), layer('layer-3-shadow-b.png', 'Contact shadow · Toaster', await shadow(), at.sb, 'bbox-crop', 'shadow_b'),
      layer('layer-4-subject-a.png', 'Kettle (exact source pixels)', await product(30, 90, 200), at.a, 'bbox-crop', 'kettle'), layer('layer-5-subject-b.png', 'Toaster (exact source pixels)', await product(200, 40, 40), at.b, 'bbox-crop', 'toaster')];
    const composite = await sharp(scenery).composite(layers.slice(1).map(l => ({ input: l.png, left: l.placement.x, top: l.placement.y }))).png().toBuffer();
    const runs = mkdtempSync(join(tmpdir(), 'editor-import-'));
    const { dir } = await createComposedRun(runs, { composite, layers, origin: { kind: 'creative-variant' } as never, templateExecution: { executionId: 'e1', templateId: 't1', templateVersion: 1, plan: 'composed' } as never, variant: { setId: 's1', variantId: 'v1' } });
    const { run, variant, assets } = await imported(dir);
    expectFaithful(run, variant);
    expect(variant.layers!.map(l => l.name)).toEqual(['Generated scene (flattened) (z0)', 'Contact shadow · Kettle (z1)', 'Contact shadow · Toaster (z2)', 'Kettle (exact source pixels) (z3)', 'Toaster (exact source pixels) (z4)']);
    const drawn = await sharp(await render(variant, assets)).removeAlpha().raw().toBuffer(), truth = await sharp(composite).removeAlpha().raw().toBuffer();
    let worst = 0; for (let i = 0; i < truth.length; i++) worst = Math.max(worst, Math.abs(drawn[i] - truth[i]));
    expect(worst).toBeLessThanOrEqual(1); // the editor shows the creative as composed (rounding of soft shadow edges only)
  });
});

const replay = process.env.FRAMEFLOW_REPLAY_ARTIFACTS;
describe.skipIf(!replay)('your saved decomposition runs in the editor (read only)', () => {
  it('every finished run your sessions and templates used imports with its layers\' names, positions, sizes and stacking order, on its canvas', async () => {
    const executions = join(replay!, 'template-executions'), runs = join(replay!, 'layerize-experiment');
    const ids = [...new Set(readdirSync(executions).map(d => join(executions, d, 'execution.json')).filter(existsSync).map(f => JSON.parse(readFileSync(f, 'utf8')).runId as string | undefined))]
      .filter((id): id is string => !!id && existsSync(join(runs, id, 'run.json')) && readRun(join(runs, id)).stage === 'done');
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) { const { run, variant } = await imported(join(runs, id)); expectFaithful(run, variant); }
  }, 120_000);
});
