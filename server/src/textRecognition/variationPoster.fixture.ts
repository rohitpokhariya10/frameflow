/**
 * TEST FIXTURE: a 900×1200 offer poster for word analysis and style variations, with the words a fake recognizer "reads"
 * at known places (source pixels): an italic "Easy", a huge "EMI", "available.", a tenure pill, three bank-logo cards, a
 * brand logo and a T&C line. Used by the unit tests and the offline browser fixture; no OCR or provider runs with it.
 */
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { ProtectedElement } from '@frameflow/shared';

export const VARIATION_POSTER = { width: 900, height: 1200 } as const;
export const VARIATION_WORDS = [
  { text: 'Easy', confidence: 0.95, box: { x: 76, y: 92, width: 264, height: 124 }, baselineY: 186 },
  { text: 'EMI', confidence: 0.93, box: { x: 76, y: 226, width: 730, height: 300 }, baselineY: 520 },
  { text: 'available.', confidence: 0.95, box: { x: 76, y: 562, width: 470, height: 84 }, baselineY: 640 },
  { text: '3-6-9-12', confidence: 0.9, box: { x: 106, y: 704, width: 220, height: 46 }, baselineY: 745 },
  { text: 'months', confidence: 0.96, box: { x: 327, y: 704, width: 172, height: 46 }, baselineY: 745 },
  { text: 'T&Cs', confidence: 0.95, box: { x: 78, y: 1122, width: 76, height: 34 }, baselineY: 1150 },
  { text: 'apply', confidence: 0.62, box: { x: 155, y: 1122, width: 76, height: 38 }, baselineY: 1150 },
];
const TILE = '<rect width="200" height="76" rx="18" fill="#ffffff"/><rect x="20" y="20" width="60" height="36" fill="#1d2a6b"/><rect x="95" y="28" width="85" height="20" fill="#c8102e"/>';
export const VARIATION_TILES = [{ x: 80, y: 822 }, { x: 300, y: 822 }, { x: 520, y: 822 }].map(p => ({ ...p, width: 200, height: 76 }));
const svg = (body: string, w: number = VARIATION_POSTER.width, h: number = VARIATION_POSTER.height) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`)).png().toBuffer();
/** The poster; `seed` changes one unprotected corner pixel block, so each test's image is its own. */
export const variationPosterPng = (seed = '') => svg('<rect width="900" height="1200" fill="#bfeedd"/><circle cx="760" cy="640" r="150" fill="#a7e3cf"/><circle cx="820" cy="1020" r="90" fill="#9fdcc6"/>'
  + `<rect x="4" y="1186" width="10" height="10" fill="#${createHash('sha256').update(`vt:${seed}`).digest('hex').slice(0, 6)}"/>`
  + '<g transform="translate(650 60)"><rect width="200" height="80" rx="12" fill="#14325c"/><circle cx="40" cy="40" r="22" fill="#f5b700"/></g>'
  + '<text x="80" y="186" font-family="Georgia, serif" font-style="italic" font-weight="700" font-size="110" fill="#03595a">Easy</text>'
  + '<text x="80" y="520" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="400" fill="#03595a">EMI</text>'
  + '<text x="80" y="640" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="96" fill="#03595a">available.</text>'
  + '<rect x="80" y="690" width="520" height="80" rx="40" fill="#03595a"/><text x="110" y="745" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="48" fill="#cede59">3-6-9-12 months</text>'
  + VARIATION_TILES.map(t => `<g transform="translate(${t.x} ${t.y})">${TILE}</g>`).join('')
  + '<text x="80" y="1150" font-family="Helvetica, Arial, sans-serif" font-size="28" fill="#03595a">T&amp;Cs apply</text>');
/** A replacement logo for a card. */
export const replacementLogoPng = () => svg('<rect width="200" height="76" rx="18" fill="#ffffff"/><rect x="30" y="18" width="140" height="40" rx="8" fill="#0a8f3c"/>', 200, 76);

const el = (n: number, kind: ProtectedElement['kind'], label: string, box: [number, number, number, number]) => ({
  id: `pe-${String(n).padStart(10, '0')}`, kind, label, box: { x: box[0], y: box[1], width: box[2], height: box[3], rotation: 0 }, zIndex: n,
  representation: 'raster', mask: { mode: 'difference', threshold: 24 }, review: { status: 'approved' }, locked: true, replaceable: true, origin: 'admin',
});
/** The poster's protected regions, as the region editor sends them. */
export const VARIATION_ELEMENTS = [
  el(1, 'text', 'Main copy: italic serif “Easy”, huge bold “EMI” and “available.”', [60, 80, 780, 590]),
  el(2, 'text', 'Tenure pill', [70, 680, 540, 100]),
  el(3, 'other', 'Bank cards', [60, 800, 700, 120]),
  el(4, 'legal', 'T&C line', [60, 1110, 300, 60]),
  el(5, 'logo', 'Brand logo', [640, 50, 220, 100]),
];
