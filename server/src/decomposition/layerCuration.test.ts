import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { createRun, executeRun, resumeRun } from './layerizeExperiment.js';
import { curationFixture } from './curation.fixture.js';
import { plannedAnalysis } from './simpleBackground.fixture.js';
import { gridFor, layerShape, rgbOnGrid } from './backgroundContamination.js';
import { groupInteractions } from './interactionGrouping.js';
import { screenFillers } from './layerUsefulness.js';
import { BUDGETS, consolidateDecorations } from './layerCuration.js';
import * as curationModule from './layerCuration.js';
import type { LayerInfo } from './layerizeArtifacts.js';
import type { FalTransport } from './providers/falClient.js';

const canvas = { width: 128, height: 128 }, grid = gridFor(canvas, 128);
async function item(file: string, name: string, svg: string, role = 'unknown', semantic?: LayerInfo['semantic']) {
  const png = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128">${svg}</svg>`)).png().toBuffer();
  const layer: LayerInfo = { file, name, index: 1, zIndex: 1, pixelWidth: 128, pixelHeight: 128, opaquePercent: 50,
    placement: { kind: 'full-canvas', x: 0, y: 0, ...canvas }, ...(semantic ? { semantic } : {}) };
  return { layer, png, shape: await layerShape(png, layer, grid), kind: 'foreground' as const, role };
}
const rect = '<rect x="25" y="25" width="40" height="60" fill="#d5452c"/>';
const original = async (items: { png: Buffer }[]) => rgbOnGrid(await sharp({ create: { ...canvas, channels: 4, background: '#edf8f3' } }).composite(items.map(i => ({ input: i.png }))).png().toBuffer(), grid);

describe('deterministic editor curation', () => {
  it('keeps meaningful badly-named content; suppresses low-alpha fragments and empty helpers', async () => {
    const meaningful = await item('object.png', 'Layer 0', rect);
    const faint = await item('fragment.png', 'Layer 1', '<rect x="90" y="90" width="2" height="2" opacity=".02"/>');
    const helper = await item('helper.png', 'Fallback helper', '');
    const decisions = screenFillers([meaningful, faint, helper], await original([meaningful]), grid);
    expect(decisions.map(d => d.kept)).toEqual([true, false, false]);
  });
  it('preserves semantically essential person, product, CTA, logo and badge despite generic names', async () => {
    for (const type of ['person', 'product', 'cta', 'logo', 'badge']) {
      const essential = await item(`${type}.png`, 'Layer 0', rect, 'unknown', { id: type, type, editableIndependently: true });
      expect(screenFillers([essential], await original([]), grid)[0].kept, type).toBe(true);
    }
  });
  it('removes a translucent product shadow without hiding an intentional graphic shadow', async () => {
    const soft = await item('soft.png', 'Translucent phone shadow', '<ellipse cx="60" cy="105" rx="35" ry="7" opacity=".15"/>', 'product');
    const graphic = await item('graphic.png', 'Graphic shadow', rect.replace('#d5452c', '#202020'), 'decor', { id: 'graphic_shadow', type: 'graphic', editableIndependently: true });
    expect(screenFillers([soft], await original([soft]), grid)[0].kept).toBe(false);
    expect(screenFillers([graphic], await original([graphic]), grid)[0].kept).toBe(true);
  });
  it('suppresses duplicate visual products but retains one complete copy', async () => {
    const a = await item('a.png', 'Product', rect, 'product'), b = await item('b.png', 'Product copy', rect, 'product');
    b.layer.zIndex = 2;
    const decisions = screenFillers([a, b], await original([a, b]), grid);
    expect(decisions.filter(d => d.kept)).toHaveLength(1);
    expect(decisions.find(d => !d.kept)?.reason).toBe('duplicate');
  });
  it('a dark product named Shadow stays a product; its name cannot make it a cast shadow', async () => {
    for (const id of ['shadow_phone', 'phone']) {
      const person = await item('person.png', 'Person', rect, 'person');
      const product = await item('product.png', 'Shadow edition phone', '<rect x="60" y="45" width="20" height="35" fill="#222"/>', 'product');
      const semantic = plannedAnalysis('A person beside a Shadow edition phone.', [['person', 'person'], [id, 'product']]);
      const grouped = await groupInteractions({ dir: mkdtempSync(join(tmpdir(), 'curation-shadow-name-')), canvas, grid, entries: [person, product], semantic, options: { heldObjects: true } });
      expect(product.layer.semantic).toMatchObject({ id, type: 'product' });
      expect(grouped.entries).toHaveLength(2);
      expect(grouped.record.decisions.some(d => d.role === 'cast_shadow')).toBe(false);
      expect(screenFillers([product], await original([product]), grid)[0]).toMatchObject({ kept: true, category: 'product' });
    }
  });
  it('merges headline effects but preserves a real headline whose semantic id contains glow', async () => {
    const title = await item('text.png', 'Headline glow', rect, 'text', { id: 'headline_glow', type: 'text', editableIndependently: true });
    const outline = await item('outline.png', 'Headline outline', rect.replace('#d5452c', '#252525'), 'text', { id: 'headline_outline', type: 'text effect', editableIndependently: false });
    outline.layer.zIndex = 0;
    const grouped = await groupInteractions({ dir: mkdtempSync(join(tmpdir(), 'curation-text-')), canvas, grid, entries: [outline, title], options: { heldObjects: true } });
    expect(grouped.entries).toHaveLength(1);
    expect(grouped.entries[0].layer.grouping?.parent).toBe(title.layer.file);
    expect(grouped.entries[0].layer.grouping?.members.find(m => m.file === outline.layer.file)?.role).toBe('text_effect');
  });
  it('groups tiny related decorations without budget pressure', async () => {
    const entries = await Promise.all([10, 50, 90].map(x => item(`star-${x}.png`, 'Star decoration', `<rect x="${x}" y="5" width="4" height="4" fill="#efbd24"/>`, 'decor')));
    entries.forEach((e, i) => { e.layer.zIndex = i; });
    const grouped = await groupInteractions({ dir: mkdtempSync(join(tmpdir(), 'curation-decor-')), canvas, grid, entries, options: { heldObjects: true } });
    expect(grouped.entries).toHaveLength(1);
    expect(grouped.entries[0].layer.grouping?.members).toHaveLength(3);
  });
  it('budget pressure consolidates decorations, never the essential person/product/text', async () => {
    const essential = await Promise.all(['person', 'product', ...Array.from({ length: 15 }, () => 'text')].map((type, i) => item(`essential-${i}.png`, type, rect, type, { id: `e-${i}`, type, editableIndependently: true })));
    const decor = await Promise.all([5, 100].map(x => item(`decor-${x}.png`, 'Decoration', `<rect x="${x}" y="5" width="15" height="15" fill="#ed45bb"/>`, 'decor')));
    const items = [...essential, ...decor]; items.forEach((e, i) => { e.layer.zIndex = i; });
    const consolidated = await consolidateDecorations(items, items.length + 1, BUDGETS.complex, { dir: mkdtempSync(join(tmpdir(), 'curation-budget-')), canvas, grid });
    expect(consolidated?.members).toEqual(decor);
    expect(items.filter(i => !consolidated?.members.includes(i))).toEqual(essential);
    expect(essential.length + 2).toBeGreaterThan(BUDGETS.complex.max);
  });
});

it('13 raw phone-creative layers become 6 editor layers, with complete provenance and zero extra calls, including resume', async () => {
  const fixture = await curationFixture(), files = new Map(fixture.layers.map((l, i) => [`https://v3b.fal.media/files/test/${i}.png`, l.png]));
  const transport = { upload: vi.fn(async () => 'https://v3b.fal.media/files/test/input.png'), submit: vi.fn(async () => ({ requestId: 'fake-only' })), status: vi.fn(async () => 'COMPLETED' as const),
    result: vi.fn(async () => ({ layers: fixture.layers.map((l, i) => ({ image: { url: [...files.keys()][i] }, z_index: i, name: l.name })) })),
    download: vi.fn(async (url: string) => files.get(url)!), cancel: vi.fn(async () => undefined) } satisfies FalTransport;
  const reconstruct = vi.fn(async () => { throw new Error('Unexpected background edit'); });
  const deps = { transport: () => transport, planner: vi.fn(async () => ({ plan: { prompt: fixture.semantic.downstream_decomposition_prompt, planned_layers: [], warnings: [], semantic_analysis: fixture.semantic }, model: 'fake-only', request: {}, raw: {} })),
    backgroundReconstructor: { model: 'fake-only', reconstruct }, sleep: async () => undefined };
  const { dir } = await createRun(mkdtempSync(join(tmpdir(), 'curation-run-')), fixture.source, { mode: 'generated' }, { semanticPlanning: true, templateKey: 'template-b', refinement: true });
  const run = await executeRun(dir, deps);
  expect(run.stage).toBe('done');
  expect(run.refinement?.curation?.counts).toMatchObject({ rawLayers: 13, editorLayers: 6 });
  expect(run.outputLayers).toHaveLength(6);
  expect(run.outputLayers!.filter(l => l.placement.kind === 'base')).toHaveLength(1);
  expect(run.outputLayers!.some(l => /Layer 0|Fallback helper|Layer 12|Duplicate phone/.test(l.name ?? ''))).toBe(false);
  expect(run.outputLayers!.some(l => l.name === 'Translucent oversized-phone shadow')).toBe(false);
  expect(run.outputLayers!.some(l => l.grouping?.protectedInteraction === 'hand_holding_object')).toBe(true);
  const record = run.refinement!.curation!, debug = JSON.parse(readFileSync(join(dir, 'decomposition-debug.json'), 'utf8'));
  expect(record.entries.find(e => e.file === 'layer-00.png')).toMatchObject({ disposition: 'internal', editorVisible: false });
  expect(record.entries.find(e => e.file === 'layer-04.png')).toMatchObject({ disposition: 'merge', editorVisible: false });
  expect(record.entries.find(e => e.file === 'layer-06.png')).toMatchObject({ disposition: 'merge', editorVisible: false });
  expect(debug.rawLayers).toHaveLength(13);
  expect(debug.curation).toEqual(record);
  expect(run.editorLayerFiles).toEqual(run.outputLayers!.map(l => l.file));
  const artifact = JSON.parse(readFileSync(join(dir, 'layers.json'), 'utf8'));
  expect(artifact.rawLayers).toHaveLength(13);
  expect(artifact.editorLayerFiles).toEqual(run.editorLayerFiles);
  for (const entry of record.entries) { expect(entry.reasons.length).toBeGreaterThan(0); expect(entry.qualityScore).toBeGreaterThanOrEqual(0); expect(entry.usefulnessScore).toBeLessThanOrEqual(1); }
  for (const [i, layer] of fixture.layers.entries()) expect(readFileSync(join(dir, `layer-${String(i).padStart(2, '0')}.png`))).toEqual(layer.png);
  expect(run.calls).toMatchObject({ seedreamInitial: 1, seedreamResidual: 0, backgroundReconstruction: 0 });
  expect(reconstruct).not.toHaveBeenCalled();
  const again = await resumeRun(dir, deps);
  expect(again.editorLayerFiles).toEqual(run.editorLayerFiles);
  expect(again.refinement?.curation).toEqual(record);
  expect(transport.submit).toHaveBeenCalledTimes(1);
  // A local curation failure must never fall back to importing raw layers. The same saved run can be resumed locally.
  const curate = vi.spyOn(curationModule, 'curateLayers').mockRejectedValueOnce(new Error('Synthetic local curation failure'));
  try {
    const failed = await resumeRun(dir, deps);
    expect(failed.stage).toBe('failed');
    expect(failed.editorLayerFiles).toEqual([]);
    expect(failed.outputLayers).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, 'raw-layers.json'), 'utf8')).layers).toHaveLength(13);
  } finally { curate.mockRestore(); }
  const recovered = await resumeRun(dir, deps);
  expect(recovered.stage).toBe('done');
  expect(recovered.editorLayerFiles).toEqual(run.editorLayerFiles);
  expect(transport.submit).toHaveBeenCalledTimes(1);
  expect(reconstruct).not.toHaveBeenCalled();
}, 60_000);
