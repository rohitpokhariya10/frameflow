import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import type { FalTransport } from './providers/falClient.js';
import type { LayerInfo } from './layerizeArtifacts.js';
import { createRun, executeRun, readRun, resumeRun, type RunnerDeps } from './layerizeExperiment.js';
import { createOpenAIPlanner } from './layerizePlanner.js';
import type { RefinementOptions } from './recursiveDecomposition.js';
import { gridFor, layerShape, rgbOnGrid } from './backgroundContamination.js';
import { backgroundQuality, plainFieldFill } from './backgroundRecovery.js';
import { castShadows } from './shadowResidue.js';
import { isPlate, screenFillers, screenPlates, type ScreenItem } from './layerUsefulness.js';
import { isShadowLayer } from './interactionGrouping.js';
import { grow } from './outerBackground.js';
import { offerComposite, offerPart, ALL_PARTS, rowFillEdit } from './complexOffer.fixture.js';
import { creative, GHOST_PART, ghostEdit, GREY_BASE_PART, GREY_PANEL_PART, HIDDEN_SLAB_PART, part, partPng, RED_PARTS, redAnalysis, STAIN_PART, STUDIO_FILLER_PART, STUDIO_PARTS, studioAnalysis, type Part } from './peopleShadow.fixture.js';
import { creative as holdingCreative, HOLDING_PARTS, holdingAnalysis, partPng as holdingPng, WHITE_FIELD_PART } from './protectedInteraction.fixture.js';

type Edit = 'ghost' | 'rowfill' | 'none';
const R = (key: string) => part(RED_PARTS, key), S = (key: string) => part(STUDIO_PARTS, key), H = (key: string) => part(HOLDING_PARTS, key);
const at = (x: number, y: number) => Math.round(y * 1.024) * 1024 + Math.round(x * 1.024);
const A = gridFor({ width: 1024, height: 1024 }, 640), nA = A.width * A.height;

/** A semantic, refined run with every provider faked; Seedream answers the scripted splits in turn, the edit as asked. */
async function run(original: Buffer, analysis: unknown, passes: { base: Part[]; layers: Part[]; render?: (p: Part) => Promise<Buffer> }[], edit: Edit, refinement: boolean | Partial<RefinementOptions> = true) {
  const files: Record<string, Buffer> = {}, answers = new Map<string, unknown>(), submitted: Record<string, unknown>[] = [];
  const transport = {
    upload: vi.fn(async () => 'https://v3b.fal.media/files/test/upload.png'),
    submit: vi.fn<FalTransport['submit']>(async (_endpoint, input) => {
      const step = passes[submitted.length]; if (!step) throw new Error(`Unexpected Seedream submission #${submitted.length + 1}.`);
      const requestId = `req-${submitted.length}`; submitted.push(input);
      const layers: unknown[] = [];
      const add = async (name: string, png: Buffer) => { const url = `https://v3b.fal.media/files/test/${requestId}-${layers.length}.png`; files[url] = png; layers.push({ image: { url }, z_index: layers.length, name }); };
      const render = step.render ?? partPng;
      await add('Background', await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1000 1000" preserveAspectRatio="none">${step.base.map(p => p.svg).join('')}</svg>`)).png().toBuffer());
      for (const p of step.layers) await add(p.name, await render(p));
      answers.set(requestId, { layers });
      return { requestId };
    }),
    status: vi.fn(async () => 'COMPLETED' as const), result: vi.fn(async (_e: string, id: string) => answers.get(id)), cancel: vi.fn(async () => undefined), download: vi.fn(async (url: string) => files[url]),
  } satisfies FalTransport;
  const create = vi.fn(async () => ({ status: 'completed', output: [], output_text: JSON.stringify(analysis) }));
  const reconstruct = vi.fn(async (request: { image: Buffer; mask: Buffer }) => ({ image: edit === 'ghost' ? await ghostEdit(request.image, request.mask) : await rowFillEdit(request.image, request.mask) }));
  const deps: RunnerDeps = { planner: createOpenAIPlanner({ client: { responses: { create } } as never }), transport: () => transport, sleep: async () => undefined,
    ...(edit === 'none' ? {} : { backgroundReconstructor: { model: 'test-edit', reconstruct } }) };
  const { dir } = await createRun(mkdtempSync(join(tmpdir(), 'people-shadow-')), original, { mode: 'generated' }, { refinement });
  await executeRun(dir, deps);
  return { dir, run: readRun(dir), submitted, reconstruct, deps };
}
const raw = async (file: string | Buffer) => sharp(file).removeAlpha().raw().toBuffer();
const lum = (rgb: Buffer, i: number) => 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
const diff = (a: Buffer, b: Buffer, i: number) => Math.max(Math.abs(a[i * 3] - b[i * 3]), Math.abs(a[i * 3 + 1] - b[i * 3 + 1]), Math.abs(a[i * 3 + 2] - b[i * 3 + 2]));
const maskOf = async (file: string) => { const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true }); return (i: number) => data[i * info.channels]; };
/** Pixels of the background that are a darker ghost of the true background (a shadow or silhouette left behind), in %. */
async function ghostPercent(background: string, truth: Buffer) {
  const [bg, t] = await Promise.all([raw(background), raw(truth)]);
  let dark = 0; for (let i = 0; i < bg.length / 3; i++) if (lum(bg, i) < lum(t, i) - 12) dark++;
  return 100 * dark / (bg.length / 3);
}
const names = (layers: LayerInfo[]) => layers.map(l => l.name);

describe('a person on a plain red studio field, with a soft drop shadow and a contact shadow', () => {
  const RED_BG = () => creative([R('background')]);

  it('1/4: the cast shadows go with the man, Seedream\'s ghost base is rejected, and the plain red continues with no call', async () => {
    const s = await run(await creative(RED_PARTS), redAnalysis(), [{ base: [R('background'), R('shadow'), GHOST_PART], layers: ['man', 'headline', 'cta'].map(R) }], 'ghost');
    const b = s.run.refinement!.background!;
    // The shadows were found in the original and removed with him (not only his silhouette).
    expect(b.shadow!.percent).toBeGreaterThan(2);
    expect(b.shadow!.components.filter(c => c.accepted).map(c => c.position)).toEqual(expect.arrayContaining(['center', 'lower center']));
    expect(s.run.refinement!.mask).toMatchObject({ shadowFile: 'shadow-mask.png' });
    const mask = await maskOf(join(s.dir, 'foreground-mask.png'));
    for (const [x, y] of [[660, 620], [655, 900], [520, 994]]) expect(mask(at(x, y)), `shadow at ${x},${y}`).toBe(255);
    // Seedream's base holds a ghost of him and his shadows: rejected as residue, not as black or foreign colors.
    const base = b.candidates.find(c => c.method === 'provider-base')!;
    expect(base).toMatchObject({ quality: 'failed', chosen: false });
    expect(base.reasons).toContain('silhouette-residue');
    expect(base.metrics.blackPercent).toBe(0);
    // The plain red field is continued locally and validated: no image edit at all.
    expect(b).toMatchObject({ status: 'continued-clean', method: 'plain-field', quality: 'usable', fallbackUsed: false, aiTried: false, plainField: { plain: true } });
    expect(s.run.calls).toMatchObject({ planner: 1, seedreamInitial: 1, seedreamResidual: 0, backgroundReconstruction: 0 });
    expect(s.reconstruct).not.toHaveBeenCalled();
    // Hiding him reveals the clean red: behind him, in his drop shadow and at his feet, and nowhere a darker ghost.
    const [clean, truth] = await Promise.all([raw(join(s.dir, 'clean-background.png')), raw(await RED_BG())]);
    for (const [x, y] of [[510, 700], [510, 330], [660, 620], [700, 900], [520, 994], [150, 160], [170, 850]]) expect(diff(clean, truth, at(x, y)), `${x},${y}`).toBeLessThanOrEqual(8);
    expect(await ghostPercent(join(s.dir, 'clean-background.png'), await RED_BG())).toBeLessThan(0.3);
    // The editor gets the background, the man, the headline and the button; nothing else.
    expect(names(s.run.outputLayers!)).toEqual(['Background', 'Man in white shirt', 'White SUMMER SALE headline text', 'Yellow SHOP NOW button']);
    expect(s.run.refinement!.layerPlan).toMatchObject({ editableLayers: 4, dropped: [], byCategory: { background: 1, person: 1, text: 1, object: 1 } });
    expect(existsSync(join(s.dir, 'shadow-mask.png'))).toBe(true);
  }, 60_000);

  it('a soft ghost from the image edit is caught as silhouette residue (it is neither black nor a foreign color); the plain field is used and nothing is retried', async () => {
    const s = await run(await creative(RED_PARTS), redAnalysis(), [{ base: [R('background'), R('shadow'), GHOST_PART], layers: ['man', 'headline', 'cta'].map(R) }], 'ghost', { deterministicBackground: false });
    expect(s.reconstruct).toHaveBeenCalledTimes(1);
    const b = s.run.refinement!.background!, ai = b.candidates.find(c => c.method === 'ai-reconstruction')!;
    expect(ai.quality).toBe('failed');
    expect(ai.reasons).toEqual(['silhouette-residue']);
    expect(ai.metrics).toMatchObject({ blackPercent: 0 });
    expect(ai.metrics.residuePercent).toBeGreaterThan(50);
    expect(b).toMatchObject({ status: 'fallback', method: 'plain-field', quality: 'usable', aiTried: true, fallbackUsed: true });
    expect(await ghostPercent(join(s.dir, 'clean-background.png'), await RED_BG())).toBeLessThan(0.3);
    await resumeRun(s.dir, s.deps);
    expect(s.reconstruct).toHaveBeenCalledTimes(1);
    expect(readRun(s.dir).calls!.backgroundReconstruction).toBe(1);
  }, 60_000);

  it('Seedream\'s own shadow layer joins the man (it moves and hides with him); a clean base needs no reconstruction', async () => {
    const s = await run(await creative(RED_PARTS), redAnalysis(), [{ base: [R('background')], layers: ['shadow', 'man', 'headline', 'cta'].map(R) }], 'ghost');
    const layers = s.run.outputLayers!, man = layers.find(l => l.name?.startsWith('Man in white shirt'))!;
    expect(man.grouping!.members.map(m => [m.name, m.role])).toEqual([['Man in white shirt', 'parent'], ['Soft cast shadow of the man', 'cast_shadow']]);
    expect(names(layers)).not.toContain('Soft cast shadow of the man');
    expect(s.run.interactions!.decisions).toEqual(expect.arrayContaining([expect.objectContaining({ decision: 'grouped', role: 'cast_shadow', name: 'Soft cast shadow of the man' })]));
    // The removal mask covers his shadow too; the clean base is kept as returned, with no call.
    const mask = await maskOf(join(s.dir, 'foreground-mask.png'));
    expect(mask(at(660, 620))).toBe(255);
    expect(s.run.refinement!.background).toMatchObject({ status: 'provider-clean', method: 'provider-base' });
    expect(s.run.calls!.backgroundReconstruction).toBe(0);
    expect(layers).toHaveLength(4);
  }, 60_000);

  it('a shadow stain no subject casts is not a layer, and it is removed from the background', async () => {
    const s = await run(await creative([...RED_PARTS, STAIN_PART]), redAnalysis(), [{ base: [R('background'), R('shadow')], layers: [...['man', 'headline', 'cta'].map(R), STAIN_PART] }], 'ghost');
    expect(names(s.run.outputLayers!)).not.toContain('Dark shadow smudge');
    expect(s.run.refinement!.layerPlan!.dropped).toEqual([expect.objectContaining({ name: 'Dark shadow smudge', reason: 'detached-shadow', action: 'remove', category: 'effect' })]);
    const [clean, truth] = await Promise.all([raw(join(s.dir, 'clean-background.png')), raw(await RED_BG())]);
    expect(diff(clean, truth, at(850, 170))).toBeLessThanOrEqual(8);
    expect(s.run.refinement!.background).toMatchObject({ status: 'continued-clean' });
    expect(s.run.warnings.some(w => /^LAYERS_LEFT_OUT: 1 layer\(s\) are not editor layers \(Dark shadow smudge: detached-shadow\)/.test(w))).toBe(true);
  }, 60_000);

  it('3: a grey panel Seedream invented behind the man is not emitted; the red continues behind him', async () => {
    const s = await run(await creative(RED_PARTS), redAnalysis(), [{ base: [R('background')], layers: [GREY_PANEL_PART, ...['man', 'headline', 'cta'].map(R)] }], 'ghost');
    expect(names(s.run.outputLayers!)).not.toContain('Grey background panel');
    const dropped = s.run.refinement!.layerPlan!.dropped;
    expect(dropped).toEqual([expect.objectContaining({ name: 'Grey background panel', reason: 'not-in-original', action: 'fold' })]);
    expect(dropped[0].evidencePercent).toBeLessThan(5);
    // The reconstruction is the creative again (the panel would have painted grey around him).
    expect(s.run.refinement!.fidelity!.after.meanAbsDiff).toBeLessThan(s.run.refinement!.fidelity!.before.meanAbsDiff);
    // Seedream's base is the clean red here: kept as returned.
    expect(s.run.refinement!.background).toMatchObject({ status: 'provider-clean', method: 'provider-base' });
    const [clean, truth] = await Promise.all([raw(join(s.dir, s.run.outputLayers![0].file)), raw(await RED_BG())]);
    for (const [x, y] of [[370, 700], [650, 450], [510, 700]]) expect(diff(clean, truth, at(x, y)), `${x},${y}`).toBeLessThanOrEqual(8);
    expect(s.run.outputLayers!.filter(l => /Man in white shirt/.test(l.name ?? ''))).toHaveLength(1);
  }, 60_000);
});

describe('a person in a pink studio interior: one clean scene plate, no fake fallback layer', () => {
  const STUDIO_BG = () => creative([S('studio')]);

  it('2/5: the complete studio plate is the clean background; the grey placeholder base and the plate are not extra layers; no call', async () => {
    const s = await run(await creative(STUDIO_PARTS), studioAnalysis(), [{ base: [GREY_BASE_PART], layers: [S('studio'), S('woman'), S('headline')] }], 'ghost');
    const b = s.run.refinement!.background!;
    // Seedream's grey placeholder base is not the creative's background anywhere: rejected even though it is "clean".
    expect(b.candidates[0]).toMatchObject({ method: 'provider-base', quality: 'failed' });
    expect(b.candidates[0].reasons).toContain('background-mismatch');
    expect(b).toMatchObject({ status: 'scene-clean', method: 'scene-composite', quality: 'usable' });
    expect(s.run.calls!.backgroundReconstruction).toBe(0);
    expect(s.reconstruct).not.toHaveBeenCalled();
    // One background layer: the plate is merged into it, never repeated over a grey slab.
    expect(names(s.run.outputLayers!)).toEqual(['Background', 'Woman in navy dress', 'Dark NEW COLLECTION headline text']);
    expect(s.run.refinement!.layerPlan!.dropped).toEqual([expect.objectContaining({ name: 'Pink studio interior backdrop', reason: 'merged-into-background' })]);
    // Behind the woman: the studio, and no grey anywhere in the background.
    const [clean, truth] = await Promise.all([raw(join(s.dir, 'clean-background.png')), raw(await STUDIO_BG())]);
    for (const [x, y] of [[660, 500], [660, 800], [660, 330], [250, 400]]) expect(diff(clean, truth, at(x, y)), `${x},${y}`).toBeLessThanOrEqual(8);
    let grey = 0; for (let i = 0; i < clean.length / 3; i++) if (Math.abs(clean[i * 3] - 0x9c) < 8 && Math.abs(clean[i * 3 + 1] - 0xa3) < 8 && Math.abs(clean[i * 3 + 2] - 0xaf) < 8) grey++;
    expect(grey).toBe(0);
  }, 60_000);

  it('3/5: an invented grey filler panel and a hidden grey block are dropped; the woman stays one editable layer', async () => {
    const s = await run(await creative(STUDIO_PARTS), studioAnalysis(), [{ base: [GREY_BASE_PART], layers: [S('studio'), STUDIO_FILLER_PART, HIDDEN_SLAB_PART, S('woman'), S('headline')] }], 'ghost');
    expect(names(s.run.outputLayers!)).toEqual(['Background', 'Woman in navy dress', 'Dark NEW COLLECTION headline text']);
    const dropped = Object.fromEntries(s.run.refinement!.layerPlan!.dropped.map(d => [d.name, d.reason]));
    expect(dropped).toEqual({ 'Grey filler panel': 'not-in-original', 'Grey background block': 'hidden', 'Pink studio interior backdrop': 'merged-into-background' });
    expect(s.run.refinement!.layerPlan!.editableLayers).toBe(3);
    expect(s.run.refinement!.background).toMatchObject({ status: 'scene-clean' });
    expect(s.run.warnings.some(w => w.startsWith('LAYERS_LEFT_OUT: 3 layer(s)'))).toBe(true);
  }, 60_000);
});

describe('protected people stay intact while useless layers go', () => {
  it('6/7 (Paytm-like): the hand-held phone group and the yellow brand curve stay; the white plate and an invented grey block do not', async () => {
    const grey: Part = { key: 'grey', name: 'Grey filler block', svg: '<rect x="520" y="400" width="400" height="600" fill="#9ca3af"/>' };
    const layers = [WHITE_FIELD_PART, H('field'), grey, ...['woman', 'phone', 'badge', 'fingers', 'headline', 'pill', 'get', 'chevron'].map(H)];
    const s = await run(await holdingCreative(HOLDING_PARTS), holdingAnalysis('high'), [{ base: HOLDING_PARTS, layers, render: holdingPng }], 'ghost');
    const out = s.run.outputLayers!;
    expect(out.filter(l => l.grouping?.protectedInteraction === 'hand_holding_object')).toHaveLength(1);
    const group = out.find(l => l.grouping?.protectedInteraction)!;
    expect(group.grouping!.members.map(m => m.name)).toEqual(expect.arrayContaining(['Woman base', 'Smartphone with white screen', 'Foreground gripping finger fragments']));
    expect(names(out)).toContain('Bright yellow curved decorative field');
    expect(names(out)).not.toContain('Full-canvas off-white background');
    expect(names(out)).not.toContain('Grey filler block');
    expect(Object.fromEntries(s.run.refinement!.layerPlan!.dropped.map(d => [d.name, d.reason]))).toEqual({ 'Grey filler block': 'not-in-original', 'Full-canvas off-white background': 'merged-into-background' });
    expect(s.run.refinement!.background).toMatchObject({ status: 'scene-clean', method: 'scene-composite' });
    expect(s.run.calls!.backgroundReconstruction).toBe(0);
  }, 60_000);
});

describe('units: shadows, plain fields, residue and layer usefulness', () => {
  const coreOf = async (parts: Part[], render: (p: Part) => Promise<Buffer> = partPng) => {
    const core = new Uint8Array(nA);
    for (const p of parts) { const a = await sharp(await render(p)).resize(A.width, A.height, { fit: 'fill' }).extractChannel(3).raw().toBuffer(); for (let i = 0; i < nA; i++) if (a[i] > 16) core[i] = 1; }
    return grow(core, A.width, A.height, 5);
  };
  const atA = (x: number, y: number) => Math.round(y * A.height / 1000) * A.width + Math.round(x * A.width / 1000);

  it('finds soft same-hue shadows touching the subject; ignores gradients, crisp grey shapes and dark design elements', async () => {
    const red = await rgbOnGrid(await creative(RED_PARTS), A), core = await coreOf(['man', 'headline', 'cta'].map(R));
    const found = castShadows(red, core, A.width, A.height);
    expect(found).toMatchObject({ assessed: true, model: 'plain' });
    expect(found.mask[atA(660, 620)]).toBe(1);
    expect(found.mask[atA(150, 500)]).toBe(0);
    // A plain gradient offer has no shadow anywhere.
    const offerCore = new Uint8Array(nA);
    for (const p of ALL_PARTS) { const a = await sharp(await offerPart(p)).resize(A.width, A.height, { fit: 'fill' }).extractChannel(3).raw().toBuffer(); for (let i = 0; i < nA; i++) if (a[i] > 16) offerCore[i] = 1; }
    expect(castShadows(await rgbOnGrid(await offerComposite(), A), grow(offerCore, A.width, A.height, 5), A.width, A.height).percent).toBe(0);
    // A crisp grey design block touching him (no shadow in the creative): hard-edged, kept.
    const block: Part = { key: 'block', name: 'block', svg: '<rect x="620" y="600" width="160" height="200" fill="#7f1d1d"/>' };
    const crisp = castShadows(await rgbOnGrid(await creative([R('background'), block, R('man')]), A), await coreOf([R('man')]), A.width, A.height);
    expect(crisp.mask[atA(700, 700)]).toBe(0);
    expect(crisp.components.filter(c => c.accepted)).toEqual([]);
  });

  it('continues a plain field exactly and refuses one that crosses a design boundary', async () => {
    const offer = await rgbOnGrid(await offerComposite([]), A), hole = new Uint8Array(nA);
    for (let y = 150; y < 450; y++) for (let x = 200; x < 400; x++) hole[y * A.width + x] = 1;
    const smeared = Buffer.from(offer); for (let i = 0; i < nA; i++) if (hole[i]) smeared.fill(0, i * 3, i * 3 + 3);
    const plain = plainFieldFill(smeared, hole, A.width, A.height);
    expect(plain.plain).toBe(true);
    let worst = 0; for (let i = 0; i < nA; i++) if (hole[i]) worst = Math.max(worst, diff(plain.out, offer, i));
    expect(worst).toBeLessThanOrEqual(3);
    const studio = await rgbOnGrid(await creative([S('studio')]), A), across = new Uint8Array(nA);
    for (let y = 300; y < 560; y++) for (let x = 340; x < 480; x++) across[y * A.width + x] = 1;
    expect(plainFieldFill(studio, across, A.width, A.height)).toMatchObject({ plain: false });
  });

  it('judges a soft ghost failed as residue, the true continuation usable, and a grey placeholder base as a background mismatch', async () => {
    const truth = await rgbOnGrid(await creative([R('background')]), A), core = await coreOf([R('man')]);
    const ghost = Buffer.from(truth); for (let i = 0; i < nA; i++) if (core[i]) for (let c = 0; c < 3; c++) ghost[i * 3 + c] = Math.round(truth[i * 3 + c] * 0.75);
    const expected = plainFieldFill(truth, core, A.width, A.height);
    const q = (rgb: Buffer, original?: Buffer) => backgroundQuality({ rgb, core, w: A.width, h: A.height, expected: expected.out, plain: expected.plain, ...(original ? { original } : {}) });
    // Without the expected continuation the ghost passes every older check (not black, not foreign, no seam).
    expect(backgroundQuality({ rgb: ghost, core, w: A.width, h: A.height })).toMatchObject({ quality: 'usable' });
    expect(q(ghost)).toMatchObject({ quality: 'failed', reasons: ['silhouette-residue'] });
    expect(q(truth)).toMatchObject({ quality: 'usable', reasons: [] });
    const grey = Buffer.alloc(nA * 3); for (let i = 0; i < nA; i++) grey.set([0x9c, 0xa3, 0xaf], i * 3);
    expect(q(grey, truth).reasons).toContain('background-mismatch');
  });

  it('a shadow is named and looks like one: "Woman with shadow" or an opaque bright layer is never a shadow', async () => {
    const shape = async (png: Buffer) => (await layerShape(png, { placement: { kind: 'full-canvas', x: 0, y: 0, width: 1024, height: 1024 } }, A)).rgba;
    const shadow = await shape(await partPng(R('shadow'))), man = await shape(await partPng(R('man')));
    expect(isShadowLayer({ name: 'Soft cast shadow of the man' }, shadow, nA)).toBe(true);
    expect(isShadowLayer({ name: 'Dark shadow smudge' }, await shape(await partPng(STAIN_PART)), nA)).toBe(true);
    expect(isShadowLayer({ name: 'Woman with shadow' }, man, nA)).toBe(false);
    expect(isShadowLayer({ name: 'Shadow' }, man, nA)).toBe(false);
    expect(isShadowLayer({ name: 'Man in white shirt' }, shadow, nA)).toBe(false);
  });

  it('never drops people, products or text, even hidden or unlike the original; drops a hidden plain object and a faint remnant, never an opaque object colored like its background', async () => {
    const original = await rgbOnGrid(await creative(RED_PARTS), A);
    const item = async (name: string, png: Buffer, z: number, kind: ScreenItem['kind'] = 'foreground', role = 'unknown'): Promise<ScreenItem> => {
      const layer: LayerInfo = { index: z, file: `l${z}.png`, zIndex: z, name, pixelWidth: 1024, pixelHeight: 1024, opaquePercent: 10, placement: { kind: 'full-canvas', x: 0, y: 0, width: 1024, height: 1024 } };
      return { layer, shape: await layerShape(png, layer, A), kind, role };
    };
    const svg = (body: string) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1000 1000" preserveAspectRatio="none">${body}</svg>`)).png().toBuffer();
    const items = [
      await item('Hidden product box', await svg('<rect x="450" y="600" width="100" height="100" fill="#22c55e"/>'), 1, 'foreground', 'product'),
      await item('Hidden block', await svg('<rect x="440" y="500" width="120" height="120" fill="#0ea5e9"/>'), 2),
      await item('Faint smear', await svg('<ellipse cx="850" cy="500" rx="60" ry="40" fill="#b31f1f" fill-opacity="0.5"/>'), 3),
      await item('Magenta panel', await svg('<rect x="700" y="300" width="250" height="200" fill="#d946ef"/>'), 4),
      await item('Man in white shirt', await partPng(R('man')), 5),
      await item('Ghost headline text', await svg('<rect x="600" y="50" width="300" height="40" fill="#0f172a"/>'), 6, 'foreground', 'text'),
      // A real object nearly the color of the field around it (a white product on white): opaque, so never a remnant.
      await item('Red earbuds case', await svg('<rect x="820" y="700" width="60" height="60" rx="12" fill="#b52121"/>'), 7),
    ];
    const decisions = Object.fromEntries(screenFillers(items, original, A).map(d => [d.name, d.kept ? 'kept' : d.reason]));
    expect(decisions).toEqual({ 'Hidden product box': 'kept', 'Hidden block': 'hidden', 'Faint smear': 'faint-remnant', 'Magenta panel': 'not-in-original', 'Man in white shirt': 'kept', 'Ghost headline text': 'kept', 'Red earbuds case': 'kept' });
    // Plates: merged into a scene composite, dropped when the clean background already holds them, kept over a different provider base.
    const plate = await item('Red plate', await creative([R('background')]), 0, 'background', 'background');
    expect(isPlate(plate, A)).toBe(true);
    expect(screenPlates([plate], original, 'scene-composite', A)[0]).toMatchObject({ kept: false, reason: 'merged-into-background' });
    expect(screenPlates([plate], await rgbOnGrid(await creative([R('background')]), A), 'plain-field', A)[0]).toMatchObject({ kept: false, reason: 'duplicates-background' });
    const greyBase = Buffer.alloc(nA * 3, 0x9c);
    expect(screenPlates([plate], greyBase, 'provider-base', A)[0]).toMatchObject({ kept: true });
    expect(screenPlates([plate], greyBase, 'ai-reconstruction', A)[0]).toMatchObject({ kept: false, reason: 'replaced-by-clean-background' });
  });
});
