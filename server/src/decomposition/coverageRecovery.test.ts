import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import type { TemplateStructure, TemplateVersion } from '@frameflow/shared';
import type { FalTransport } from './providers/falClient.js';
import { createRun, executeRun, type RunnerDeps } from './layerizeExperiment.js';
import { compileTemplatePlan, templateEditPrompt, templatePlanPrompt, templatePlanStrategy } from './creativeTemplates/compile.js';
import { agreeing, baseTone, completeHidden, convexHull, matte, ownerOf, smoothReach, uncoveredContent, type OwnerCandidate } from './coverageRecovery.js';

// Small synthetic grids (no provider, no image files): colours as RGB arrays, masks as 0/1.
const grid = (width: number, height: number) => ({ width, height, scale: 1 });
const fill = (w: number, h: number, colour: (x: number, y: number) => number[]) => { const out = new Uint8Array(w * h * 3); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set(colour(x, y), (y * w + x) * 3); return out; };
const mask = (w: number, h: number, inside: (x: number, y: number) => boolean) => { const out = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inside(x, y)) out[y * w + x] = 1; return out; };
const count = (map: Uint8Array) => map.reduce((sum, v) => sum + v, 0);

describe('uncovered content', () => {
  const w = 80, h = 80, YELLOW = [246, 194, 28];
  const reference = fill(w, h, () => YELLOW);
  it('finds what no layer covers and the base lacks; never a shadow of the base, never what a layer covers', () => {
    const original = fill(w, h, (x, y) => x >= 10 && x < 30 && y >= 10 && y < 30 ? [240, 238, 242] // uncovered white part
      : x >= 50 && x < 70 && y >= 10 && y < 30 ? [250, 250, 250] // the same, but a layer covers it
      : x >= 20 && x < 60 && y >= 50 && y < 70 ? YELLOW.map(v => Math.round(v * 0.55)) : YELLOW); // a shadow: the base darker
    const covered = mask(w, h, (x, y) => x >= 50 && x < 70 && y >= 10 && y < 30);
    const { regions } = uncoveredContent(original, reference, covered, grid(w, h));
    expect(regions).toHaveLength(1);
    expect(regions[0].box).toEqual([10, 10, 30, 30]);
  });
});

describe('where a smooth backdrop really is', () => {
  // A backdrop fading from pink to pale down the canvas, a white lid on it (outlined by an edge, its colours close to the
  // pale fade), and a thin line in front of the backdrop crossing it.
  const w = 60, h = 60, BASE = [246, 194, 28];
  const disc = (y: number) => [230 + Math.round(y / 3), 120 + Math.round(y * 1.8), 200 - Math.round(y / 2)];
  const lid = (x: number, y: number) => x >= 20 && x < 40 && y >= 30 && y < 50;
  const original = fill(w, h, (x, y) => lid(x, y) ? [245, 240, 238] : disc(y));
  const reference = fill(w, h, () => BASE);
  const line = mask(w, h, x => x === 10 || x === 11);
  const visible = mask(w, h, (x, y) => !lid(x, y) && x !== 10 && x !== 11);
  it('grows from where its own pixels match, through smooth steps and across a thin layer in front, never into the lid', () => {
    // The provider's backdrop: right in the top half, a wrong grey in the bottom half.
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set([...(y < 30 ? disc(y) : [138, 126, 136]), 255], (y * w + x) * 4);
    const seeds = agreeing(rgba, original, reference, visible);
    expect(seeds[5 * w + 30]).toBe(1);
    expect(seeds[45 * w + 50]).toBe(0);
    const domain = Uint8Array.from(visible, (v, i) => v || (lid(i % w, Math.floor(i / w)) ? 1 : 0));
    const reach = smoothReach(domain, seeds, line, original, grid(w, h), 8, 3);
    expect(reach[45 * w + 50]).toBe(1); // the pale fade the provider drew grey
    expect(reach[45 * w + 5]).toBe(1); // beyond the thin line
    expect(count(Uint8Array.from(reach, (v, i) => v && lid(i % w, Math.floor(i / w)) ? 1 : 0))).toBe(0);
  });
  it('does not jump a layer in front wider than the gap', () => {
    const wide = mask(w, h, x => x >= 8 && x < 16), domain = mask(w, h, x => x < 8 || x >= 16), seeds = mask(w, h, (x, y) => x >= 16 && y < 4);
    const reach = smoothReach(domain, seeds, wide, original, grid(w, h), 8, 3);
    expect(reach[20 * w + 3]).toBe(0);
    expect(reach[20 * w + 40]).toBe(1);
  });
});

describe('which object a part belongs to', () => {
  const w = 40, h = 40, n = w * h;
  const rgbaOf = (colour: number[], alpha: Uint8Array) => { const out = new Uint8Array(n * 4); for (let i = 0; i < n; i++) if (alpha[i]) out.set([...colour, 255], i * 4); return out; };
  const part = mask(w, h, (x, y) => x >= 15 && x < 25 && y >= 15 && y < 25);
  const original = fill(w, h, (x, y) => part[y * w + x] ? [238, 236, 240] : [246, 194, 28]);
  const decoration = mask(w, h, (x, y) => x >= 5 && x < 15 && y >= 18 && y < 22), caseBody = mask(w, h, (x, y) => x >= 12 && x < 28 && y >= 25 && y < 35), earbud = mask(w, h, (x, y) => x >= 25 && x < 32 && y >= 12 && y < 28);
  const candidates: OwnerCandidate[] = [
    { id: 'decoration', alpha: decoration, z: 3, kind: 'object', rgba: rgbaOf([120, 60, 190], decoration) },
    { id: 'case', alpha: caseBody, z: 5, kind: 'object', rgba: rgbaOf([242, 240, 243], caseBody) },
    { id: 'earbud', alpha: earbud, z: 7, kind: 'object', rgba: rgbaOf([250, 250, 250], earbud) },
  ];
  it('is the back-most object it resembles: a white lid is the case, not the purple line that ends at it, nor the earbud in front', () => {
    expect(ownerOf(part, candidates, grid(w, h), { original, part })?.id).toBe('case');
  });
  it('without colours, the back-most object it touches', () => {
    expect(ownerOf(part, candidates, grid(w, h))?.id).toBe('decoration');
  });
});

describe('the base re-lit', () => {
  const at = (o: number[], r: number[]) => baseTone(Uint8Array.from(o), Uint8Array.from(r), 0);
  it('a shadow (darker alike) and a glow (alike toward white) are the base; a grey object on a pale base is not', () => {
    expect(at([135, 107, 15], [246, 194, 28])).toBe(true);
    expect(at([250, 225, 125], [246, 194, 28])).toBe(true);
    expect(at([207, 196, 205], [253, 243, 161])).toBe(false);
    expect(at([120, 60, 190], [246, 194, 28])).toBe(false);
  });
});

describe('cut and completion', () => {
  it('a matte is clear where the original is the base and opaque, in its own colours, where it differs by the high step', () => {
    const original = Uint8Array.from([246, 194, 28, 238, 236, 240, 246, 214, 108]), reference = Uint8Array.from([246, 194, 28, 246, 194, 28, 246, 194, 28]);
    const out = matte(original, reference, Uint8Array.from([1, 1, 1]), 16, 64);
    expect(out[3]).toBe(0);
    expect([...out.subarray(4, 8)]).toEqual([238, 236, 240, 255]);
    expect(out[11]).toBe(255);
  });
  it('a smooth layer behind something is continued from its own pixels, replacing the provider\'s grey there, inside its outline only', () => {
    const w = 40, h = 40, n = w * h, rgba = new Uint8Array(n * 4);
    const disc = (x: number, y: number) => (x - 20) ** 2 + (y - 20) ** 2 <= 15 ** 2;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (disc(x, y)) rgba.set(x >= 16 && x < 24 && y >= 16 && y < 30 ? [128, 128, 128, 255] : [220, 120, 200, 255], (y * w + x) * 4);
    const solid = new Uint8Array(n); for (let i = 0; i < n; i++) if (rgba[i * 4 + 3] > 64) solid[i] = 1;
    const hull = convexHull(solid, w, h), hidden = mask(w, h, (x, y) => x >= 16 && x < 24 && y >= 16 && y < 40);
    const done = completeHidden(rgba, hidden, hull, w, h);
    const centre = [...done.subarray((20 * w + 20) * 4, (20 * w + 20) * 4 + 4)];
    expect(near(centre, [220, 120, 200], 2) && centre[3] > 250, `centre ${centre}`).toBe(true);
    expect(done[(38 * w + 20) * 4 + 3]).toBe(0); // below the disc's outline: nothing added
  });
});

// The live failure (run 2026-10-08T08-46-52, a reused plan on a yellow creative), rebuilt as a synthetic creative: an
// open white lid stands behind an earbud, over a gradient disc that fades into a yellow base with a pale glow. Seedream
// left the lid out of every layer and out of its base, cut a lid-shaped hole into the disc, drew the disc's fade grey,
// and kept the lid's rim inside the disc's outline.
const W = 600, H = 750;
const svg = (body: string, background = '') => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>
  <radialGradient id="glow" cx="300" cy="460" r="420" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f9de6a"/><stop offset="1" stop-color="#f4c20d"/></radialGradient>
  <linearGradient id="fade" x1="0" y1="240" x2="0" y2="700" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#7b2fd0"/><stop offset="0.45" stop-color="#e08ad8"/><stop offset="1" stop-color="#e08ad8" stop-opacity="0"/></linearGradient>
  <linearGradient id="grey" x1="0" y1="240" x2="0" y2="700" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#7b2fd0"/><stop offset="0.45" stop-color="#e08ad8"/><stop offset="1" stop-color="#8a7f88"/></linearGradient>
  <mask id="hole"><rect width="${W}" height="${H}" fill="#fff"/><rect x="210" y="442" width="200" height="140" rx="34" fill="#000"/></mask>
  <mask id="notch"><rect width="${W}" height="${H}" fill="#fff"/><rect x="380" y="330" width="100" height="100" fill="#000"/></mask>
</defs>${background}${body}</svg>`);
const png = (body: string, background = '') => sharp(svg(body, background)).png().toBuffer();
const BASE = `<rect width="${W}" height="${H}" fill="url(#glow)"/>`;
const DISC = '<circle cx="300" cy="470" r="230" fill="url(#fade)"/>';
const LID = '<rect x="200" y="430" width="220" height="150" rx="40" fill="#f3eff3"/><rect x="222" y="452" width="176" height="128" rx="28" fill="#d7be96"/>';
const CASE = '<rect x="170" y="560" width="280" height="150" rx="30" fill="#f6f4f6"/><rect x="170" y="590" width="280" height="6" fill="#d9d4d9"/>';
const EARBUD = '<ellipse cx="330" cy="400" rx="46" ry="56" fill="#fbfbfb"/><ellipse cx="318" cy="394" rx="14" ry="20" fill="#2d2d2d"/><rect x="336" y="400" width="26" height="170" rx="12" fill="#f8f8f8"/>';

/** A reused template's run on `original` with a fake Seedream returning `answers` (no planner, no paid call). */
async function decomposeWith(original: Buffer, answers: { name: string; png: Buffer }[], structure: TemplateStructure) {
  const files: Record<string, Buffer> = {};
  const transport = {
    upload: vi.fn(async () => 'https://v3b.fal.media/files/test/upload.png'),
    submit: vi.fn<FalTransport['submit']>(async () => ({ requestId: 'req-1' })),
    status: vi.fn(async () => 'COMPLETED' as const),
    result: vi.fn(async (_e: string, id: string) => ({ layers: answers.map((a, z) => { const url = `https://v3b.fal.media/files/test/${id}-${z}.png`; files[url] = a.png; return { image: { url }, z_index: z, name: a.name }; }) })),
    cancel: vi.fn(async () => undefined), download: vi.fn(async (url: string) => files[url]),
  } satisfies FalTransport;
  const reconstruct = vi.fn(async () => { throw new Error('No background edit is expected here.'); });
  const deps: RunnerDeps = { planner: async () => { throw new Error('A reused plan never calls the planner.'); }, transport: () => transport, sleep: async () => undefined, backgroundReconstructor: { model: 'test-image-edit', reconstruct } };
  const version: TemplateVersion = { templateId: 'tpl-bbbbbbbbbbbb', version: 1, createdAt: new Date().toISOString(), name: 'Products on a disc', description: 'A product and an accessory in front of a disc on a canvas', structure,
    plan: { prompt: templatePlanPrompt(structure), strategy: templatePlanStrategy(structure), recommendedLayers: structure.layers.length }, generationPrompt: { text: templateEditPrompt(structure) },
    decomposition: { refinement: true, expectedEditorLayers: { min: 2, max: 6 } }, source: { runId: 'learned', executionId: 'learned', plannerModel: 'offline' } };
  const { dir } = await createRun(mkdtempSync(join(tmpdir(), 'coverage-')), original, compileTemplatePlan(version), { refinement: true,
    templateExecution: { executionId: 'reuse', mode: 'REUSE_TEMPLATE_ORIGINAL' as const, template: { id: version.templateId, version: 1, name: version.name } } });
  const run = await executeRun(dir, deps);
  const layerOf = (word: string) => run.outputLayers!.find(l => l.name?.toLowerCase().includes(word))!;
  const raw = async (file: string) => sharp(join(dir, file)).resize(W, H, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
  const compose = async (skip: string[] = []) => sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(await Promise.all(run.outputLayers!.filter(l => !skip.includes(l.file)).map(async l => ({ input: await sharp(join(dir, l.file)).resize(l.placement.width, l.placement.height, { fit: 'fill' }).png().toBuffer(), left: l.placement.x, top: l.placement.y }))))
    .raw().toBuffer();
  return { dir, run, layerOf, raw, compose, reconstruct, original: await sharp(original).ensureAlpha().raw().toBuffer(), seedreamBase: await sharp(answers[0].png).ensureAlpha().raw().toBuffer() };
}
const ROLES = (...roles: TemplateStructure['layers'][number]['role'][]): TemplateStructure => ({ relationships: [], layers: roles.map((role, order) =>
  ({ id: roles.indexOf(role) === order ? role : `${role}_${order}`, role, order, independent: true, required: role === 'main_product', ...(role === 'background' ? { zone: 'full-canvas' as const } : {}) })) });
const decomposeOpenLid = async () => decomposeWith(await png(`${DISC}${LID}${CASE}${EARBUD}`, BASE), [
  { name: 'Background', png: await png('', BASE) },
  { name: 'Purple gradient circular backdrop panel', png: await png('<circle cx="300" cy="470" r="230" fill="url(#grey)" mask="url(#hole)"/>') },
  { name: 'Main wireless earbud charging case', png: await png(CASE) },
  { name: 'Standing earbud', png: await png(EARBUD) },
], ROLES('background', 'backdrop', 'main_product', 'supporting_product'));
const at = (rgba: Buffer, x: number, y: number) => [0, 1, 2, 3].map(c => rgba[(y * W + x) * 4 + c]);
const near = (pixel: number[], rgb: number[], tolerance = 14) => rgb.every((v, c) => Math.abs(pixel[c] - v) <= tolerance);
const meanDiff = (a: Buffer, b: Buffer) => { let sum = 0, n = 0; for (let i = 0; i < a.length; i += 4) { for (let c = 0; c < 3; c++) sum += Math.abs(a[i + c] - b[i + c]); n += 3; } return sum / n; };
/** Points of the lid no layer in front covers: its rim, and its shaded inside (closer to the glow than the cut, and not the glow re-lit). */
const RIM: [number, number] = [250, 436], INSIDE: [number, number][] = [[260, 500], [300, 520], [390, 500]];

describe('an object part the provider left out of every layer (synthetic rebuild of the live open-lid failure)', () => {
  it('the lid joins the case whole; the disc is whole and lid-free behind it; the base stays clean; the creative is unchanged', async () => {
    const s = await decomposeOpenLid();
    expect(s.run.stage).toBe('done');
    expect(s.reconstruct).not.toHaveBeenCalled();
    expect(s.run.refinement!.background).toMatchObject({ method: 'provider-base', quality: 'usable' });
    const caseLayer = s.layerOf('case'), disc = s.layerOf('backdrop'), earbud = s.layerOf('earbud');
    // The lid is part of the case, opaque, rim and inside, in the original's colours.
    const caseRgba = await s.raw(caseLayer.file);
    for (const [x, y] of [RIM, ...INSIDE]) {
      expect(at(caseRgba, x, y)[3], `case alpha at ${x},${y}`).toBeGreaterThan(230);
      expect(near(at(caseRgba, x, y), at(s.original, x, y), 12), `case colour at ${x},${y}`).toBe(true);
    }
    expect(s.run.refinement!.coverage!.regions.filter(r => r.owner).every(r => r.owner === caseLayer.name)).toBe(true);
    // Without the products, the disc shows its own fade where the lid was (continued from what the creative shows of it),
    // never the lid's white or grey, and never the provider's grey; the base under it is the clean base.
    const productsHidden = await s.compose([caseLayer.file, earbud.file]);
    for (const [x, y] of [RIM, ...INSIDE]) {
      const shown = at(productsHidden, x, y);
      expect(near(shown, at(s.original, x, y), 30), `lid left behind at ${x},${y}: ${shown}`).toBe(false);
      expect(near(shown, [138, 127, 136], 30), `provider grey at ${x},${y}: ${shown}`).toBe(false);
    }
    expect(near(at(productsHidden, 300, 520), at(s.original, 180, 520), 40), 'the disc continues its fade across').toBe(true);
    const base = await s.raw(s.run.outputLayers![0].file);
    for (const [x, y] of [RIM, ...INSIDE]) expect(near(at(base, x, y), at(s.seedreamBase, x, y), 6), `base at ${x},${y}`).toBe(true);
    // Where the disc is visible, it is what the creative shows (the fade), not the provider's grey.
    const discOverBase = await s.compose(s.run.outputLayers!.filter(l => l.file !== disc.file && l !== s.run.outputLayers![0]).map(l => l.file));
    expect(near(at(discOverBase, 150, 540), at(s.original, 150, 540), 12)).toBe(true);
    expect(meanDiff(await s.compose(), s.original)).toBeLessThan(2.5);
    expect(s.run.warnings.some(w => w.startsWith('COVERAGE_COMPLETED') && w.includes(caseLayer.name!))).toBe(true);
    expect(s.run.warnings.filter(w => w.startsWith('PLANNED_LAYER_') || w.startsWith('COVERAGE_GAPS') || w.startsWith('BACKGROUND_RETAINS'))).toEqual([]);
  }, 90_000);
});

// The base keeps a smooth disc but with a notch cut out of it; no layer holds the disc; a purple product touches the
// notch. The notch continues the base's disc, not the product: no object may take it, whatever its colour.
describe('content that continues the base is never an object\'s part', () => {
  it('a notch missing from the base\'s own disc is reported as the base\'s gap and never joins the product beside it', async () => {
    const DISC_ON_BASE = '<circle cx="300" cy="320" r="220" fill="url(#fade)"/>', PRODUCT = '<rect x="400" y="420" width="160" height="200" rx="24" fill="#8a46c8"/><rect x="420" y="450" width="120" height="8" fill="#5b2a8a"/>';
    const plain = `<rect width="${W}" height="${H}" fill="#f3eff8"/>`;
    const s = await decomposeWith(await png(`${DISC_ON_BASE}${PRODUCT}`, plain), [
      { name: 'Background', png: await png(`<g mask="url(#notch)">${DISC_ON_BASE}</g>`, plain) },
      { name: 'Main purple product', png: await png(PRODUCT) },
    ], ROLES('background', 'main_product'));
    expect(s.run.stage).toBe('done');
    const product = s.layerOf('product'), productRgba = await s.raw(product.file);
    // The notch, where the base shows no disc but the creative does: not in the product layer.
    for (const [x, y] of [[440, 380], [470, 400], [420, 360]] as [number, number][]) expect(at(productRgba, x, y)[3], `product alpha at ${x},${y}`).toBe(0);
    expect(s.run.refinement!.coverage!.regions.filter(r => r.owner)).toEqual([]);
    expect(s.run.refinement!.coverage!.regions.some(r => r.ofBase)).toBe(true);
    expect(s.run.warnings.some(w => w.startsWith('COVERAGE_GAPS') && w.includes('continues the base, which lacks it'))).toBe(true);
    expect(s.run.warnings.some(w => w.startsWith('COVERAGE_COMPLETED'))).toBe(false);
  }, 90_000);
});
