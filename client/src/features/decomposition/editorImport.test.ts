import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { CANVAS_LIMITS, type DesignVariant } from '@frameflow/shared';
import { readRun } from '../../../../server/src/decomposition/layerizeExperiment';
import { createComposedRun, type VariantRunLayer } from '../../../../server/src/decomposition/creativeTemplates/composedRun';
import { qwenEditorLayers } from '../../../../server/src/decomposition/creativeTemplates/qwenLayers';
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

describe('Seedream-free recovery runs in the editor (a creative Seedream refused)', () => {
  const W = 900, H = 1600, solid = (w: number, h: number, rgba: [number, number, number, number]) => sharp({ create: { width: w, height: h, channels: 4, background: { r: rgba[0], g: rgba[1], b: rgba[2], alpha: rgba[3] / 255 } } }).png().toBuffer();
  const make = async (layers: VariantRunLayer[], composite: Buffer, source: 'single-layer' | 'product-cutouts') => {
    const runs = mkdtempSync(join(tmpdir(), 'editor-recovery-'));
    return (await createComposedRun(runs, { composite, layers, origin: { kind: 'template-execution', generationId: 'e1' } as never, templateExecution: { executionId: 'e1', mode: 'REUSE_TEMPLATE_WITH_EDIT', plan: source === 'single-layer' ? 'flat' : 'cutouts' } as never, source })).dir;
  };
  it('a flat preview imports as exactly one full-canvas layer that redraws the creative, named as a flat preview', async () => {
    const creative = await sharp(await solid(W, H, [210, 60, 70, 255])).composite([{ input: await solid(300, 500, [20, 30, 160, 255]), left: 300, top: 600 }]).png().toBuffer();
    const dir = await make([{ file: 'layer-1-creative.png', name: 'Flat preview (not split into layers)', description: 'flat', png: creative, kind: 'full-canvas', placement: { x: 0, y: 0, width: W, height: H }, semantic: { id: 'creative', type: 'background' } }], creative, 'single-layer');
    const { run, variant, assets } = await imported(dir);
    expectFaithful(run, variant);
    expect(variant.layers!.map(l => l.name)).toEqual(['Flat preview (not split into layers) (z0)']);
    const drawn = await sharp(await render(variant, assets)).removeAlpha().raw().toBuffer(), truth = await sharp(creative).removeAlpha().raw().toBuffer();
    expect(drawn.equals(truth)).toBe(true);
  });
  it('products cut out over a background import back to front at their places, and redraw the creative where the products are', async () => {
    const background = await solid(W, H, [210, 60, 70, 255]), product = await solid(300, 500, [20, 30, 160, 255]), at = { x: 300, y: 600, width: 300, height: 500 };
    const composite = await sharp(background).composite([{ input: product, left: at.x, top: at.y }]).png().toBuffer();
    const dir = await make([{ file: 'layer-1-background.png', name: 'Background (filled locally behind the products)', description: 'bg', png: background, kind: 'full-canvas', placement: { x: 0, y: 0, width: W, height: H }, semantic: { id: 'background', type: 'background' } },
      { file: 'layer-2-product-1.png', name: 'Smartphone (cut out)', description: 'p', png: product, kind: 'bbox-crop', placement: at, semantic: { id: 'product_1', type: 'product' } }], composite, 'product-cutouts');
    const { run, variant, assets } = await imported(dir);
    expectFaithful(run, variant);
    expect(variant.layers!.map(l => l.name)).toEqual(['Background (filled locally behind the products) (z0)', 'Smartphone (cut out) (z1)']);
    const drawn = await sharp(await render(variant, assets)).removeAlpha().raw().toBuffer(), truth = await sharp(composite).removeAlpha().raw().toBuffer();
    expect(drawn.equals(truth)).toBe(true);
  });
});

describe('Qwen layers (the alternative provider for a creative Seedream refused) in the editor', () => {
  it('import back to front at their places, redraw the creative, and a moved product leaves the background behind it, not a copy of itself', async () => {
    const W = 900, H = 1600, product = { x: 300, y: 600, width: 300, height: 520 };
    const sceneAt = (x: number, y: number) => [40 + Math.round(150 * x / W), 60 + Math.round(120 * y / H), 170];
    const draw = (pixel: (x: number, y: number) => number[], channels: 3 | 4) => {
      const data = Buffer.alloc(W * H * channels);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.set(pixel(x, y), (y * W + x) * channels);
      return sharp(data, { raw: { width: W, height: H, channels } }).png().toBuffer();
    };
    const inProduct = (x: number, y: number) => x >= product.x && x < product.x + product.width && y >= product.y && y < product.y + product.height;
    const creative = await draw((x, y) => inProduct(x, y) ? [30, 70, 210] : sceneAt(x, y), 3);
    // As Qwen answers for a 900×1600 creative: 480×864 layers, the creative stretched to that size.
    const qwen = async (png: Buffer) => sharp(png).resize(480, 864, { fit: 'fill' }).png().toBuffer();
    const outputs = [await qwen(await draw(sceneAt, 3)), await qwen(await draw((x, y) => inProduct(x, y) ? [30, 70, 210, 255] : [0, 0, 0, 0], 4))];
    const { layers } = await qwenEditorLayers(creative, outputs, { labels: [{ label: 'Smartphone', box: product }] });
    const runs = mkdtempSync(join(tmpdir(), 'editor-qwen-'));
    const { dir } = await createComposedRun(runs, { composite: creative, layers, origin: { kind: 'template-execution', generationId: 'e1' } as never, templateExecution: { executionId: 'e1', mode: 'REUSE_TEMPLATE_WITH_EDIT', plan: 'qwen' } as never, source: 'qwen-layers' });
    const { run, variant, assets } = await imported(dir);
    expectFaithful(run, variant);
    expect(variant.layers!.map(l => l.name)).toEqual([expect.stringMatching(/^Background \(Qwen; [\d.]+% hidden behind objects is AI-generated\) \(z0\)$/), 'Smartphone (z1)']);
    const drawn = await sharp(await render(variant, assets)).removeAlpha().raw().toBuffer(), truth = await sharp(creative).removeAlpha().raw().toBuffer();
    let sum = 0; for (let i = 0; i < truth.length; i++) sum += Math.abs(drawn[i] - truth[i]);
    expect(sum / truth.length).toBeLessThan(1); // the editor shows the creative (soft product edges only)
    // The product moved 200 px right: where it was, the scene continues.
    const moved = { ...variant, layers: variant.layers!.map((l, i) => i === 1 ? { ...l, x: l.x + 200 } : l) };
    const after = await sharp(await render(moved, assets)).removeAlpha().raw().toBuffer(), cx = product.x + 60, cy = product.y + 260, k = (cy * W + cx) * 3;
    expect(Math.max(...[0, 1, 2].map(c => Math.abs(after[k + c] - sceneAt(cx, cy)[c])))).toBeLessThan(12);
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
