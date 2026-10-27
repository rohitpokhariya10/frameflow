/**
 * TEST FIXTURE: a 1000×1200 Product with Text creative, drawn: a white page with a brand wordmark, a mint panel with a
 * repeating lattice, a two-line headline and an offer line, a mascot at the left, three products (a television, a
 * washing machine, a refrigerator with "LG" printed on it) on a gold podium, three bank-logo cards and a T&C line on the
 * page below the panel. A fake recognizer "reads" its words at known places, and a fake vision analysis answers in the
 * live analysis's own schema (parsed by the same parser): no OCR and no model runs with them.
 */
import sharp from 'sharp';
import { parseSceneDescription, type ProtectedTemplate, type SceneDescription } from '@frameflow/shared';
import type { SceneAnalyzer } from '../../creativeTemplates/smartProviders.js';
import type { Segmenter, SegmentTarget } from '../../creativeTemplates/segmenter.js';
import { fakeRecognizer } from '../../../textRecognition/recognizer.js';
import { decodeRgba } from '../pixels.js';
import { detectProduct } from './detect.js';

export const PRODUCT_POSTER = { width: 1000, height: 1200 } as const;
export const PRODUCT_WORDS = [
  { text: 'ACME', confidence: 0.94, box: { x: 768, y: 52, width: 170, height: 64 } },
  { text: 'Grand', confidence: 0.95, box: { x: 104, y: 196, width: 240, height: 84 } },
  { text: 'Savings', confidence: 0.95, box: { x: 360, y: 196, width: 330, height: 84 } },
  { text: 'Get', confidence: 0.93, box: { x: 104, y: 304, width: 80, height: 50 } },
  { text: '26%', confidence: 0.6, box: { x: 192, y: 304, width: 100, height: 50 } },
  { text: 'cashback', confidence: 0.93, box: { x: 300, y: 304, width: 200, height: 50 } },
  { text: 'LG', confidence: 0.9, box: { x: 696, y: 540, width: 44, height: 30 } },
  { text: 'T&Cs', confidence: 0.95, box: { x: 66, y: 1150, width: 80, height: 40 } },
  { text: 'apply', confidence: 0.95, box: { x: 150, y: 1150, width: 90, height: 44 } },
];
export const PRODUCT_TILES = [[100, 1040], [320, 1040], [540, 1040]].map(([x, y]) => ({ x, y, width: 200, height: 76 }));
/** Where each object is drawn (source pixels). */
export const PRODUCT_OBJECTS = {
  mascot: { x: 96, y: 560, width: 172, height: 350 },
  tv: { x: 300, y: 560, width: 220, height: 262 },
  washer: { x: 520, y: 640, width: 130, height: 182 },
  fridge: { x: 680, y: 520, width: 120, height: 302 },
  podium: { x: 190, y: 800, width: 660, height: 90 },
};
const COLOURS = ['#c8102e', '#1d2a6b', '#0a8f3c'];
const tile = (i: number) => `<rect width="200" height="76" rx="22" fill="#ffffff" stroke="#0f5132" stroke-width="2"/><rect x="24" y="22" width="56" height="32" rx="6" fill="${COLOURS[i]}"/><rect x="92" y="30" width="86" height="16" fill="#334155"/>`;
const SANS = 'font-family="Helvetica, Arial, sans-serif"';
export const productPosterPng = () => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1200">
  <defs><pattern id="d" width="120" height="80" patternUnits="userSpaceOnUse"><path d="M0 40 L60 0 L120 40 L60 80 Z" fill="none" stroke="#fdf6d2" stroke-width="5"/></pattern>
    <linearGradient id="screen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c3aed"/><stop offset="1" stop-color="#ec4899"/></linearGradient></defs>
  <rect width="1000" height="1200" fill="#ffffff"/><rect x="60" y="160" width="880" height="840" fill="#bdf0dc"/><rect x="60" y="160" width="880" height="840" fill="url(#d)"/>
  <text x="772" y="104" ${SANS} font-weight="700" font-size="52" fill="#0b3b3c">ACME</text>
  <text x="108" y="268" ${SANS} font-weight="700" font-size="80" fill="#03595a">Grand Savings</text>
  <text x="108" y="344" ${SANS} font-size="44" fill="#03595a">Get 26% cashback</text>
  <ellipse cx="520" cy="820" rx="330" ry="34" fill="#e0b04f"/><rect x="190" y="820" width="660" height="56" fill="#c9922e"/><ellipse cx="520" cy="876" rx="330" ry="14" fill="#a87420"/>
  <rect x="300" y="560" width="220" height="140" rx="6" fill="#111111"/><rect x="310" y="570" width="200" height="120" fill="url(#screen)"/><rect x="400" y="700" width="20" height="100" fill="#333333"/><rect x="350" y="798" width="120" height="16" rx="6" fill="#333333"/>
  <rect x="520" y="640" width="130" height="180" rx="10" fill="#9ca3af"/><circle cx="585" cy="740" r="46" fill="#1f2937"/><circle cx="585" cy="740" r="32" fill="#60a5fa"/>
  <rect x="680" y="520" width="120" height="300" rx="8" fill="#374151"/><rect x="688" y="600" width="6" height="80" fill="#9ca3af"/><text x="698" y="566" ${SANS} font-weight="700" font-size="26" fill="#ffffff">LG</text>
  <ellipse cx="182" cy="780" rx="74" ry="120" fill="#f97316"/><circle cx="182" cy="620" r="58" fill="#fdba74"/><circle cx="162" cy="610" r="8" fill="#111111"/><circle cx="202" cy="610" r="8" fill="#111111"/><rect x="132" y="880" width="100" height="26" rx="10" fill="#7c2d12"/>
  ${PRODUCT_TILES.map((t, i) => `<g transform="translate(${t.x} ${t.y})">${tile(i)}</g>`).join('')}
  <text x="70" y="1180" ${SANS} font-size="30" fill="#03595a">T&amp;Cs apply</text></svg>`)).png().toBuffer();

const frac = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x / PRODUCT_POSTER.width, y: b.y / PRODUCT_POSTER.height, w: b.width / PRODUCT_POSTER.width, h: b.height / PRODUCT_POSTER.height, certainty: 'tight' });
const thing = (id: string, kind: string, importance: string, category: string, box: { x: number; y: number; width: number; height: number }, confidence: number) => ({
  id, kind, importance, category, description: category, box: frac(box), occluded: false, properties: [], identity: { brand: '', model: '', evidence: '', confidence: 0, markings: 'none' }, confidence });
/** The vision analysis's answer for the fixture, in its schema (snake case, as the model returns it). */
export const PRODUCT_SCENE_ANSWER = {
  summary: 'A festive appliance offer: a mascot beside a television, a washing machine and a refrigerator on a gold podium.',
  objects: [
    thing('character_1', 'character', 'supporting', 'mascot', PRODUCT_OBJECTS.mascot, 0.95),
    thing('product_1', 'product', 'main', 'television', PRODUCT_OBJECTS.tv, 0.62),
    thing('product_2', 'product', 'main', 'washing machine', PRODUCT_OBJECTS.washer, 0.9),
    thing('product_3', 'product', 'main', 'refrigerator', PRODUCT_OBJECTS.fridge, 0.92),
    thing('furniture_1', 'furniture', 'supporting', 'podium', PRODUCT_OBJECTS.podium, 0.9),
    thing('scenery_1', 'scenery', 'background', 'mint panel with a lattice', { x: 60, y: 160, width: 880, height: 840 }, 0.9),
  ],
  relations: [{ source: 'product_3', relation: 'on', target: 'furniture_1', evidence: 'stands on it', confidence: 0.9 }],
  marks: [
    ...PRODUCT_TILES.map((t, i) => ({ id: `mark_${i + 1}`, kind: 'bank_logo', text: `Bank ${i + 1}`, owner_id: '', overlay: true, box: frac(t) })),
    { id: 'mark_4', kind: 'merchant_logo', text: 'ACME', owner_id: '', overlay: true, box: frac({ x: 768, y: 52, width: 170, height: 64 }) },
    { id: 'mark_5', kind: 'product_brand', text: 'LG', owner_id: 'product_3', overlay: false, box: frac({ x: 696, y: 540, width: 44, height: 30 }) },
  ],
  text_overlays: [
    { id: 'text_1', role: 'headline', text: 'Grand Savings', refers_to: [], box: frac({ x: 100, y: 190, width: 600, height: 96 }) },
    { id: 'text_2', role: 'offer', text: 'Get 26% cashback', refers_to: [], box: frac({ x: 100, y: 298, width: 410, height: 62 }) },
    { id: 'text_3', role: 'legal', text: 'T&Cs apply', refers_to: [], box: frac({ x: 60, y: 1144, width: 190, height: 52 }) },
    { id: 'text_4', role: 'cta', text: 'Hurry', refers_to: [], box: frac({ x: 720, y: 190, width: 180, height: 60 }) },
  ],
  lighting: { direction: 'front', quality: 'soft', color: 'warm' },
  main_candidates: ['product_1', 'product_2', 'product_3'], advertised_ids: ['product_1', 'product_2', 'product_3'], uncertainties: [],
};
/** The fake vision analysis: the answer above, through the live analysis's parser; counts its calls. */
export function fakeProductAnalyzer(answer: unknown = PRODUCT_SCENE_ANSWER): SceneAnalyzer & { calls: number } {
  const a = { model: 'offline-test-analyser', calls: 0, async analyze(_image: Buffer, _mime: string, save: (file: string, value: object) => void): Promise<SceneDescription> {
    a.calls++; save('scene.offline-answer.json', answer as object); return parseSceneDescription(answer);
  } };
  return a;
}

/** A fake segmentation provider: each target's mask is what is not the page or panel colours inside its box; records what it was given. */
export function fakeSegmenter(): Segmenter & { calls: { image: Buffer; targets: SegmentTarget[] }[] } {
  const s = { provider: 'sam3', calls: [] as { image: Buffer; targets: SegmentTarget[] }[], async segment(input: { image: Buffer; width: number; height: number; targets: SegmentTarget[] }) {
    s.calls.push({ image: input.image, targets: input.targets });
    const rgb = await sharp(input.image).removeAlpha().raw().toBuffer(), { width: w, height: h } = input;
    const ground = (i: number) => [[255, 255, 255], [0xbd, 0xf0, 0xdc], [0xfd, 0xf6, 0xd2]].some(c => Math.abs(rgb[i * 3] - c[0]) + Math.abs(rgb[i * 3 + 1] - c[1]) + Math.abs(rgb[i * 3 + 2] - c[2]) < 30);
    const masks = await Promise.all(input.targets.map(t => {
      const m = Buffer.alloc(w * h);
      for (let y = t.box.y; y < t.box.y + t.box.height; y++) for (let x = t.box.x; x < t.box.x + t.box.width; x++) if (!ground(y * w + x)) m[y * w + x] = 255;
      return sharp(m, { raw: { width: w, height: h, channels: 1 } }).png().toBuffer();
    }));
    return { mask: masks[0], masks, requestIds: input.targets.map((_, i) => `fake-${i + 1}`) };
  } };
  return s;
}
/** The fixture detected (fake reading and analysis), as the prepare step receives it. */
export async function detectedPoster() {
  const png = await productPosterPng(), source = await decodeRgba(png), files = new Map<string, Buffer>();
  const result = await detectProduct({ template: { id: 'pt-fixture', source: { width: PRODUCT_POSTER.width, height: PRODUCT_POSTER.height } as ProtectedTemplate['source'] }, source, png,
    recognizer: fakeRecognizer(PRODUCT_WORDS), analyzer: fakeProductAnalyzer(), store: (f, b) => files.set(f, b), save: () => undefined, at: new Date().toISOString() });
  return { png, source, analysis: result.analysis, objects: result.objects.map(o => ({ ...o, review: { ...o.review, status: 'accepted' as const } })) };
}

/**
 * The fake image model for new artwork (no network): a soft gradient with a stage, its colours from the prompt's
 * length; with "text drill" in the prompt it also draws the magenta marker the fake word reader reads as text drawn into
 * the artwork. `offline: false` makes it behave like a paid model for the approval tests (it still sends nothing).
 */
export function fakeArtworkGenerator(options: { offline?: boolean } = {}) {
  const g = { model: options.offline === false ? 'gpt-image-2 (test double)' : 'offline-image-model', offline: options.offline !== false, calls: [] as { prompt: string; size: { width: number; height: number } }[],
    async generate(input: { prompt: string; size: { width: number; height: number } }, save: (file: string, value: object) => void) {
      g.calls.push(input); save('artwork.offline-request.json', { prompt: input.prompt, size: input.size });
      // (A new picture on each request, as an image model gives: the same prompt twice is not the same artwork.)
      const { width: W, height: H } = input.size, hue = (input.prompt.length * 37 + g.calls.length * 53) % 360, drill = /text drill/i.test(input.prompt);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,88%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},60%,62%)"/></linearGradient></defs>
        <rect width="${W}" height="${H}" fill="url(#g)"/><circle cx="${W * 0.15}" cy="${H * 0.2}" r="${Math.min(W, H) * 0.12}" fill="hsl(${(hue + 180) % 360},70%,70%)" opacity="0.5"/>
        <ellipse cx="${W * 0.6}" cy="${H * 0.72}" rx="${W * 0.32}" ry="${H * 0.05}" fill="hsl(${hue},40%,40%)" opacity="0.5"/>${drill ? `<rect x="${W * 0.4}" y="${H * 0.05}" width="${W * 0.2}" height="${H * 0.06}" fill="#ff00ff"/>` : ''}</svg>`;
      return { png: await sharp(Buffer.from(svg)).png().toBuffer(), costUsd: g.offline ? 0 : 0.05, requestId: `test-${g.calls.length}` };
    } };
  return g;
}
