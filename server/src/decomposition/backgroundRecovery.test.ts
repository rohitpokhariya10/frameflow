import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import type { FalTransport } from './providers/falClient.js';
import { createRun, executeRun, readRun, resumeRun, type RunnerDeps } from './layerizeExperiment.js';
import { createOpenAIPlanner } from './layerizePlanner.js';
import { backgroundDifficulty, backgroundQuality, continuationTrust, graphicFill, plainFieldFill } from './backgroundRecovery.js';
import { objectRetention, recreates } from './backgroundContamination.js';
import { rowFillEdit } from './complexOffer.fixture.js';
import { BANGLE_PARTS, bangleAnalysis, blackSilhouetteEdit, creative, flatEdit, HOLDING_PARTS, holdingAnalysis, part, partPng, WHITE_FIELD_PART } from './protectedInteraction.fixture.js';

type Part = (typeof HOLDING_PARTS)[number];
type Edit = 'black' | 'white' | 'fail' | 'rowfill' | 'none';
const H = (key: string) => part(HOLDING_PARTS, key), B = (key: string) => part(BANGLE_PARTS, key);
const at = (x: number, y: number) => Math.round(y * 1.024) * 1024 + Math.round(x * 1.024);

/** A semantic, refined run with every provider faked; Seedream answers the scripted splits in turn. */
async function run(original: Buffer, analysis: unknown, passes: { base: Part[]; layers: Part[] }[], edit: Edit, refinement: boolean | { deterministicBackground: boolean } = true) {
  const files: Record<string, Buffer> = {}, answers = new Map<string, unknown>(), submitted: Record<string, unknown>[] = [];
  const transport = {
    upload: vi.fn(async () => 'https://v3b.fal.media/files/test/upload.png'),
    submit: vi.fn<FalTransport['submit']>(async (_endpoint, input) => {
      const step = passes[submitted.length]; if (!step) throw new Error(`Unexpected Seedream submission #${submitted.length + 1}.`);
      const requestId = `req-${submitted.length}`; submitted.push(input);
      const layers: unknown[] = [];
      const add = async (name: string, png: Buffer) => { const url = `https://v3b.fal.media/files/test/${requestId}-${layers.length}.png`; files[url] = png; layers.push({ image: { url }, z_index: layers.length, name }); };
      await add('Background', await creative(step.base));
      for (const p of step.layers) await add(p.name, await partPng(p));
      answers.set(requestId, { layers });
      return { requestId };
    }),
    status: vi.fn(async () => 'COMPLETED' as const), result: vi.fn(async (_e: string, id: string) => answers.get(id)), cancel: vi.fn(async () => undefined), download: vi.fn(async (url: string) => files[url]),
  } satisfies FalTransport;
  const create = vi.fn(async () => ({ status: 'completed', output: [], output_text: JSON.stringify(analysis) }));
  const reconstruct = vi.fn(async (request: { image: Buffer; mask: Buffer }) => {
    if (edit === 'fail') throw new Error('OpenAI image edit returned 500');
    return { image: edit === 'black' ? await blackSilhouetteEdit(request.image, request.mask) : edit === 'white' ? await flatEdit(request.image, request.mask, [243, 244, 246]) : await rowFillEdit(request.image, request.mask) };
  });
  const deps: RunnerDeps = { planner: createOpenAIPlanner({ client: { responses: { create } } as never }), transport: () => transport, sleep: async () => undefined,
    ...(edit === 'none' ? {} : { backgroundReconstructor: { model: 'test-edit', reconstruct } }) };
  const { dir } = await createRun(mkdtempSync(join(tmpdir(), 'background-')), original, { mode: 'generated' }, { refinement });
  await executeRun(dir, deps);
  return { dir, run: readRun(dir), submitted, reconstruct, deps };
}
const raw = async (file: string) => sharp(file).removeAlpha().raw().toBuffer();
/** The foreground mask as one value per pixel, whatever channel count the PNG decodes to. */
const maskOf = async (file: string) => { const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true }); return (i: number) => data[i * info.channels]; };
const alphaOf = async (png: Buffer) => sharp(png).ensureAlpha().extractChannel(3).raw().toBuffer();
const diff = (a: Buffer, b: Buffer, i: number) => Math.max(Math.abs(a[i * 3] - b[i * 3]), Math.abs(a[i * 3 + 1] - b[i * 3 + 1]), Math.abs(a[i * 3 + 2] - b[i * 3 + 2]));

/** The recharge offer with everything baked into Seedream's base (the worst case), the woman's parts as Seedream split them live. */
const PAYTM_LAYERS = ['field', 'woman', 'phone', 'badge', 'fingers', 'headline', 'pill', 'get', 'chevron'];
const paytm = async (edit: Edit, layers = PAYTM_LAYERS.map(H)) => run(await creative(HOLDING_PARTS), holdingAnalysis('high'), [{ base: HOLDING_PARTS, layers }], edit);
/** The same, with the image edit tried before the local continuation: how a bad edit is caught. */
const paytmEditFirst = async (edit: Edit) => run(await creative(HOLDING_PARTS), holdingAnalysis('high'), [{ base: HOLDING_PARTS, layers: PAYTM_LAYERS.map(H) }], edit, { deterministicBackground: false });

describe('clean background behind a large person on a geometric offer background (Paytm-like)', () => {
  it('A/E: the removal mask is the grouped person\'s real silhouette (fingers and phone included), not its box', async () => {
    const s = await paytm('black');
    const mask = await maskOf(join(s.dir, 'foreground-mask.png'));
    const value = (x: number, y: number) => mask(at(x, y));
    // Inside the torso, the phone and the fingers that cross it: removed.
    expect([value(700, 700), value(425, 470), value(485, 549)]).toEqual([255, 255, 255]);
    // Inside the group's box but outside her silhouette (beside her head, above her arm): kept, and left exactly as it was.
    for (const [x, y] of [[850, 270], [560, 420]]) expect(value(x, y), `${x},${y}`).toBe(0);
    const [clean, original] = await Promise.all([raw(join(s.dir, 'clean-background.png')), sharp(await creative(HOLDING_PARTS)).removeAlpha().raw().toBuffer()]);
    for (const [x, y] of [[850, 270], [560, 420]]) expect(diff(clean, original, at(x, y)), `${x},${y}`).toBeLessThanOrEqual(2);
    // The grouping is intact: one protected person-with-phone layer.
    expect(s.run.outputLayers!.filter(l => l.grouping?.protectedInteraction === 'hand_holding_object')).toHaveLength(1);
    expect(s.run.refinement!.background).toMatchObject({ difficulty: { level: 'hard-large-occlusion', simpleGraphic: true } });
    expect(s.run.refinement!.background!.largestConnectedMaskCoverage).toBeGreaterThanOrEqual(10);
  }, 60_000);

  it('B/C: by default the white field and yellow curve continue locally behind her, with no image edit at all', async () => {
    const s = await paytm('black');
    expect(s.reconstruct).not.toHaveBeenCalled();
    expect(s.run.calls).toMatchObject({ planner: 1, seedreamInitial: 1, seedreamResidual: 0, backgroundReconstruction: 0 });
    expect(s.run.refinement!.background).toMatchObject({ status: 'continued-clean', method: 'graphic-fill', quality: 'usable', fallbackUsed: false, aiTried: false });
    expect(s.run.outputLayers![0]).toMatchObject({ file: 'clean-background.png', cleanBackground: { status: 'continued-clean', method: 'graphic-fill' } });
    const [clean, expected, woman] = await Promise.all([raw(join(s.dir, 'clean-background.png')), sharp(await creative([H('background'), H('field')])).removeAlpha().raw().toBuffer(), alphaOf(await partPng(H('woman')))]);
    let area = 0, right = 0, black = 0;
    for (let i = 0; i < woman.length; i++) if (woman[i] > 200) { area++; if (diff(clean, expected, i) <= 30) right++; if (Math.max(clean[i * 3], clean[i * 3 + 1], clean[i * 3 + 2]) < 60) black++; }
    expect(black).toBe(0);
    expect(right / area).toBeGreaterThanOrEqual(0.9);
  }, 60_000);

  it('B/C: an edit tried first that comes back as a black silhouette is rejected; the white field and the yellow curve continue behind her; headline and CTA are not baked in', async () => {
    const s = await paytmEditFirst('black');
    const b = s.run.refinement!.background!;
    expect(b.candidates.map(c => [c.method, c.quality, c.chosen])).toEqual([['provider-base', 'failed', false], ['scene-composite', 'failed', false], ['ai-reconstruction', 'failed', false], ['graphic-fill', 'usable', true]]);
    expect(b.candidates[2].reasons).toEqual(expect.arrayContaining(['black-region']));
    expect(b.candidates[2].metrics.blackPercent).toBeGreaterThan(50);
    expect(b).toMatchObject({ status: 'fallback', method: 'graphic-fill', quality: 'usable', fallbackUsed: true, aiTried: true });
    expect(s.run.outputLayers![0]).toMatchObject({ file: 'clean-background.png', cleanBackground: { status: 'fallback', method: 'graphic-fill' } });
    expect(s.run.calls).toMatchObject({ planner: 1, seedreamInitial: 1, seedreamResidual: 0, backgroundReconstruction: 1 });
    expect(s.reconstruct).toHaveBeenCalledTimes(1);
    // Behind the woman: no black, and at least 90% of her area is the true background (white field or yellow curve).
    const [clean, expected, woman] = await Promise.all([raw(join(s.dir, 'clean-background.png')), sharp(await creative([H('background'), H('field')])).removeAlpha().raw().toBuffer(), alphaOf(await partPng(H('woman')))]);
    let area = 0, right = 0, black = 0;
    for (let i = 0; i < woman.length; i++) if (woman[i] > 200) { area++; if (diff(clean, expected, i) <= 30) right++; if (Math.max(clean[i * 3], clean[i * 3 + 1], clean[i * 3 + 2]) < 60) black++; }
    expect(black).toBe(0);
    expect(right / area).toBeGreaterThanOrEqual(0.9);
    // Headline and CTA exist as layers, so the background holds only the field where they were.
    for (const [x0, y0, x1, y1] of [[70, 115, 350, 190], [70, 770, 330, 820]]) {
      let sum = 0, count = 0;
      for (let y = y0; y < y1; y += 5) for (let x = x0; x < x1; x += 5) { sum += diff(clean, expected, at(x, y)); count++; }
      expect(sum / count, `${x0},${y0}`).toBeLessThan(6);
    }
    // The raw AI output is kept for debugging; the reconstruction with every layer still matches the original.
    expect(existsSync(join(s.dir, 'clean-background-ai.png'))).toBe(true);
    expect(s.run.refinement!.fidelity!.after.meanAbsDiff).toBeLessThan(1.5);
  }, 60_000);

  it('a flat placeholder fill that cuts across the curve is caught as a seam, and the continuation is used instead', async () => {
    const s = await paytmEditFirst('white');
    const ai = s.run.refinement!.background!.candidates.find(c => c.method === 'ai-reconstruction')!;
    expect(ai.quality).not.toBe('usable');
    expect(ai.reasons).toEqual(expect.arrayContaining(['boundary-discontinuity']));
    expect(s.run.refinement!.background).toMatchObject({ method: 'graphic-fill', status: 'fallback', quality: 'usable' });
  }, 60_000);

  it('D: when Seedream\'s own scene layers already hold the background, it is used: no AI call', async () => {
    const s = await paytm('black', [WHITE_FIELD_PART, ...PAYTM_LAYERS.map(H)]);
    expect(s.run.refinement!.background).toMatchObject({ status: 'scene-clean', method: 'scene-composite', quality: 'usable', fallbackUsed: false, aiTried: false });
    expect(s.run.calls!.backgroundReconstruction).toBe(0);
    expect(s.reconstruct).not.toHaveBeenCalled();
    const [clean, expected] = await Promise.all([raw(join(s.dir, 'clean-background.png')), sharp(await creative([H('background'), H('field')])).removeAlpha().raw().toBuffer()]);
    let sum = 0; for (let i = 0; i < expected.length; i += 3) sum += Math.abs(clean[i] - expected[i]);
    expect(sum / (expected.length / 3)).toBeLessThan(2);
  }, 60_000);

  it('D/H: a clean provider base needs no reconstruction, even with a large glow layer in the run', async () => {
    const glow = { key: 'glow', name: 'Warm central glow background', svg: '<ellipse cx="500" cy="520" rx="470" ry="440" fill="#fde68a" fill-opacity="0.55"/>' };
    const parts = [H('background'), glow, H('field'), ...HOLDING_PARTS.slice(2)];
    const s = await run(await creative(parts), holdingAnalysis('high'), [{ base: [H('background'), glow, H('field')], layers: [glow, ...PAYTM_LAYERS.map(H)] }], 'black');
    expect(s.run.outputLayers!.find(l => l.name === 'Warm central glow background')!.provenance!.role).toBe('background');
    expect(s.run.refinement!.background).toMatchObject({ status: 'provider-clean', method: 'provider-base', quality: 'usable' });
    expect(s.run.calls!.backgroundReconstruction).toBe(0);
    expect(s.reconstruct).not.toHaveBeenCalled();
  }, 60_000);

  it('G: a failed edit keeps every extracted layer, reports the fallback and is never retried', async () => {
    const s = await paytmEditFirst('fail');
    expect(s.run.stage).toBe('done');
    expect(s.run.outputLayers).toHaveLength(6);
    expect(s.run.refinement!.background).toMatchObject({ status: 'fallback', method: 'graphic-fill', fallbackUsed: true, aiTried: false });
    expect(s.run.refinement!.background!.reasons.join(' ')).toMatch(/because the OpenAI image edit failed: OpenAI image edit returned 500/);
    expect(s.run.calls!.backgroundReconstruction).toBe(1);
    await resumeRun(s.dir, s.deps);
    expect(s.reconstruct).toHaveBeenCalledTimes(1);
    expect(readRun(s.dir).calls!.backgroundReconstruction).toBe(1);
  }, 60_000);
});

describe('worn jewelry: bangles go with their hands and leave no ghost', () => {
  it('F: the mask holds the bangles with the hands; the rebuilt background shows the red field where they were', async () => {
    const s = await run(await creative(BANGLE_PARTS), bangleAnalysis(), [
      { base: BANGLE_PARTS, layers: ['leftHands', 'leftBangles', 'centerHands', 'centerBangles', 'rightHands', 'rightBangles', 'standalone', 'headline', 'flower1', 'flower2', 'flower3'].map(B) }], 'rowfill');
    const layers = s.run.outputLayers!;
    expect(layers.filter(l => l.grouping?.members.some(m => m.role === 'worn_ornament'))).toHaveLength(3);
    expect(layers.map(l => l.name)).toEqual(expect.arrayContaining(['Standalone gold bangle product']));
    const mask = await maskOf(join(s.dir, 'foreground-mask.png'));
    // A bangle where it sticks out beyond the wrist (x 95–150 of the left stack): in the mask, and red in the background.
    expect(mask(at(120, 560))).toBe(255);
    const clean = await raw(join(s.dir, 'clean-background.png'));
    const red = [0x7f, 0x1d, 0x1d];
    for (const [x, y] of [[120, 560], [250, 600], [430, 580]]) expect(Math.max(...red.map((v, c) => Math.abs(clean[at(x, y) * 3 + c] - v))), `${x},${y}`).toBeLessThanOrEqual(12);
    // The red field around the hands is plain: it continues locally, with no image edit.
    expect(s.run.refinement!.background).toMatchObject({ quality: 'usable', status: 'continued-clean', method: 'plain-field' });
    expect(s.run.calls!.backgroundReconstruction).toBe(0);
  }, 60_000);
});

describe('recovery decisions: trust, recreated layers and darkening', () => {
  const W = 200, N = W * W, PURPLE = [124, 92, 196], WHITE = [250, 250, 252];
  const fill = (color: (x: number, y: number) => number[]) => { const out = new Uint8Array(N * 3); for (let i = 0; i < N; i++) out.set(color(i % W, Math.floor(i / W)), i * 3); return out; };
  const inRect = (x: number, y: number) => x >= 60 && x < 140 && y >= 60 && y < 140;

  it('a layer is recreated only when its outline returns: a kept panel is, a soft glow of the same color is not', () => {
    const original = fill((x, y) => inRect(x, y) ? WHITE : PURPLE), model = Float32Array.from(fill(() => PURPLE)), alpha = Uint8Array.from({ length: N }, (_, i) => inRect(i % W, Math.floor(i / W)) ? 1 : 0);
    const glow = fill((x, y) => { const t = Math.max(0, 1 - Math.hypot(x - 100, y - 100) / 75) ** 0.35; return PURPLE.map((c, k) => Math.round(c + t * (WHITE[k] - c))); });
    const [kept] = objectRetention(original, original, model, [{ file: 'panel.png', alpha }], W);
    const [glowing] = objectRetention(glow, original, model, [{ file: 'panel.png', alpha }], W);
    expect(kept).toMatchObject({ retainedPercent: 100, edgeRetainedPercent: 100 });
    expect(recreates(kept, 25)).toBe(true);
    // The glow matches the panel's color over much of it, but none of its outline: a coincidence of color, not the panel.
    expect(glowing.retainedPercent).toBeGreaterThanOrEqual(25);
    expect(glowing.edgeRetainedPercent).toBeLessThan(20);
    expect(recreates(glowing, 25)).toBe(false);
    // Without the grid width (or outline to judge) the color alone decides, as before.
    expect(recreates(objectRetention(glow, original, model, [{ file: 'panel.png', alpha }])[0], 25)).toBe(true);
  });

  it('darkening counts against a known clean continuation only; a large hole on a textured surround is not trusted to a local fill', () => {
    const core = Uint8Array.from({ length: N }, (_, i) => inRect(i % W, Math.floor(i / W)) ? 1 : 0);
    const darker = fill((x, y) => inRect(x, y) ? [120, 120, 120] : [200, 200, 200]), plain = fill(() => [200, 200, 200]);
    expect(backgroundQuality({ rgb: darker, core, w: W, h: W, expected: plain, plain: true }).reasons).toContain('darkened-region');
    expect(backgroundQuality({ rgb: darker, core, w: W, h: W }).reasons).not.toContain('darkened-region');
    // A 16% hole: trusted on a plain field or flat colors, not on a mottled texture.
    const mottled = fill((x, y) => { const v = Math.round(18 * Math.sin(x * 0.7) * Math.cos(y * 0.9) + 9 * Math.sin((x + 2 * y) * 0.31)); return [150 + v, 120 + v, 200 + v]; });
    const flat = fill((x) => x < 100 ? WHITE : [250, 204, 21]);
    expect(continuationTrust(backgroundDifficulty(flat, core, W, W), false)).toMatchObject({ trusted: true });
    expect(backgroundDifficulty(flat, core, W, W)).toMatchObject({ level: 'hard-large-occlusion', flatGraphic: true });
    expect(continuationTrust(backgroundDifficulty(mottled, core, W, W), false)).toMatchObject({ trusted: false });
    expect(continuationTrust(backgroundDifficulty(mottled, core, W, W), true)).toMatchObject({ trusted: true });
  });
});

describe('background recovery units', () => {
  const grid = { width: 200, height: 200 };
  const scene = (paint: (x: number, y: number) => [number, number, number]) => { const out = new Uint8Array(200 * 200 * 3); for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) out.set(paint(x, y), (y * 200 + x) * 3); return out; };
  // White field with a yellow region below the curve y = 0.004·(x−20)² + 60; a person-sized hole across the curve.
  const yellow = (x: number, y: number) => y > 0.004 * (x - 20) ** 2 + 60;
  const truthScene = scene((x, y) => (yellow(x, y) ? [250, 204, 21] : [243, 244, 246]));
  const hole = new Uint8Array(200 * 200); for (let y = 70; y < 190; y++) for (let x = 90; x < 150; x++) hole[y * 200 + x] = 1;
  const filled = (fill: (i: number) => [number, number, number]) => { const out = Uint8Array.from(truthScene); for (let i = 0; i < hole.length; i++) if (hole[i]) out.set(fill(i), i * 3); return out; };
  it('judges a black silhouette failed, a flat seam across the curve not usable, and the true continuation usable', () => {
    const q = (rgb: Uint8Array) => backgroundQuality({ rgb, core: hole, w: grid.width, h: grid.height });
    expect(q(filled(() => [5, 5, 5]))).toMatchObject({ quality: 'failed', reasons: expect.arrayContaining(['black-region']) });
    expect(q(filled(() => [243, 244, 246])).reasons).toContain('boundary-discontinuity');
    expect(q(filled(() => [243, 244, 246])).quality).not.toBe('usable');
    expect(q(truthScene)).toMatchObject({ quality: 'usable', reasons: [] });
    // An AI result that re-rendered the scene outside the mask is degraded even when the hole looks fine.
    const rerendered = scene(() => [200, 150, 40]);
    expect(backgroundQuality({ rgb: truthScene, core: hole, w: 200, h: 200, outside: { ai: rerendered, source: truthScene } }).reasons).toContain('large-unexpected-change');
  });
  it('continues straight edges through a hole, corners included (a panel under a removed headline), and a gradient as one region (no ghost of what stood on a platform)', () => {
    // A light panel (x ≥ 40, y ≥ 60, x < 140) on a darker wall; the hole covers the panel's top-right corner.
    const panel = (x: number, y: number) => x >= 40 && x < 140 && y >= 60;
    const truth = scene((x, y) => (panel(x, y) ? [129, 140, 248] : [79, 70, 229]));
    const corner = new Uint8Array(200 * 200); for (let y = 30; y < 90; y++) for (let x = 100; x < 180; x++) corner[y * 200 + x] = 1;
    const filledCorner = graphicFill(Uint8Array.from(truth, (v, i) => (corner[Math.floor(i / 3)] ? 0 : v)), corner, 200, 200)!;
    let right = 0, total = 0;
    for (let i = 0; i < corner.length; i++) if (corner[i]) { total++; if (Math.max(...[0, 1, 2].map(c => Math.abs(filledCorner[i * 3 + c] - truth[i * 3 + c]))) <= 12) right++; }
    expect(right / total).toBeGreaterThanOrEqual(0.97);
    // A vertical lavender gradient with a white platform at the bottom; the hole (a product) stands on the platform.
    const lavender = (y: number): [number, number, number] => [241 - Math.round(15 * y / 200), 233 - Math.round(19 * y / 200), 250 - Math.round(8 * y / 200)];
    const platform = (x: number, y: number) => y >= 160 && ((x - 100) / 70) ** 2 + ((y - 175) / 15) ** 2 <= 1;
    const stage = scene((x, y) => (platform(x, y) ? [250, 247, 255] : lavender(y)));
    const product = new Uint8Array(200 * 200); for (let y = 40; y < 168; y++) for (let x = 75; x < 125; x++) product[y * 200 + x] = 1;
    const filled = graphicFill(Uint8Array.from(stage, (v, i) => (product[Math.floor(i / 3)] ? 80 : v)), product, 200, 200)!;
    let lighter = 0, above = 0;
    for (let y = 40; y < 150; y++) for (let x = 75; x < 125; x++) { const i = y * 200 + x; above++; if (filled[i * 3 + 1] > lavender(y)[1] + 8) lighter++; }
    expect(lighter / above).toBeLessThan(0.05);
    // The same ring is not a plain field: the platform does not bend a smooth surface toward itself.
    expect(plainFieldFill(stage, product, 200, 200).plain).toBe(false);
    expect(plainFieldFill(scene((_x, y) => lavender(y)), product, 200, 200).plain).toBe(true);
  });
  it('continues a two-color design crisply across the hole and refuses noisy photographic surroundings', () => {
    const out = graphicFill(filled(() => [0, 0, 0]), hole, 200, 200)!;
    let right = 0, total = 0;
    for (let i = 0; i < hole.length; i++) if (hole[i]) { total++; if (Math.max(...[0, 1, 2].map(c => Math.abs(out[i * 3 + c] - truthScene[i * 3 + c]))) <= 30) right++; }
    expect(right / total).toBeGreaterThanOrEqual(0.93);
    expect(backgroundQuality({ rgb: out, core: hole, w: 200, h: 200 }).quality).toBe('usable');
    let seed = 7; const noise = () => (seed = (seed * 1103515245 + 12345) % 2147483648) % 256;
    const photo = scene(() => [noise(), noise(), noise()]);
    expect(graphicFill(photo, hole, 200, 200)).toBeUndefined();
    expect(backgroundDifficulty(photo, hole, 200, 200).simpleGraphic).toBe(false);
    expect(backgroundDifficulty(truthScene, hole, 200, 200)).toMatchObject({ simpleGraphic: true, level: 'hard-large-occlusion', zones: 2, largestComponentPercent: 18 });
  });
});
