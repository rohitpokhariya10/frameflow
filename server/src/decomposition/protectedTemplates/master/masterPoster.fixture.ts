/**
 * TEST FIXTURE: a 1000×1300 offer creative for master templates, unlike the Easy EMI poster in every count and place: a
 * white frame, a mint panel with a repeating diamond pattern, a brand wordmark in the header, a three-line headline
 * ("Super" / "SALE" / "today."), a pill with "Up to 50% off", a supporting line, six logo cards in a 3×2 grid and a T&C
 * line on the frame. A fake recognizer "reads" its words at known places (source pixels): no OCR runs with it.
 */
import sharp from 'sharp';

export const MASTER_POSTER = { width: 1000, height: 1300 } as const;
/** Where each word is drawn (generous boxes: the scan tightens every box to the word's own ink). */
export const MASTER_WORDS = [
  { text: 'ACME', confidence: 0.94, box: { x: 768, y: 52, width: 170, height: 64 } },
  { text: 'Super', confidence: 0.95, box: { x: 104, y: 222, width: 300, height: 104 } },
  { text: 'SALE', confidence: 0.96, box: { x: 100, y: 342, width: 640, height: 210 } },
  { text: 'today.', confidence: 0.93, box: { x: 104, y: 574, width: 270, height: 92 } },
  { text: 'Up', confidence: 0.92, box: { x: 128, y: 714, width: 70, height: 56 } },
  { text: 'to', confidence: 0.93, box: { x: 204, y: 714, width: 46, height: 56 } },
  { text: '50%', confidence: 0.91, box: { x: 256, y: 714, width: 104, height: 56 } },
  { text: 'off', confidence: 0.9, box: { x: 366, y: 714, width: 76, height: 56 } },
  { text: 'On', confidence: 0.95, box: { x: 104, y: 832, width: 60, height: 50 } },
  { text: 'selected', confidence: 0.6, box: { x: 168, y: 832, width: 170, height: 50 } },
  { text: 'cards.', confidence: 0.95, box: { x: 342, y: 832, width: 130, height: 50 } },
  { text: 'T&Cs', confidence: 0.95, box: { x: 66, y: 1238, width: 80, height: 40 } },
  { text: 'apply', confidence: 0.95, box: { x: 150, y: 1238, width: 90, height: 44 } },
];
export const MASTER_TILES = [[100, 930], [320, 930], [540, 930], [100, 1030], [320, 1030], [540, 1030]].map(([x, y]) => ({ x, y, width: 200, height: 76 }));
const COLOURS = ['#c8102e', '#1d2a6b', '#0a8f3c', '#f59e0b', '#7c3aed', '#0e7490'];
const tile = (i: number) => `<rect width="200" height="76" rx="22" fill="#ffffff" stroke="#0f5132" stroke-width="2"/><rect x="24" y="22" width="56" height="32" rx="6" fill="${COLOURS[i]}"/><rect x="92" y="30" width="86" height="16" fill="#334155"/>`;
const svg = (body: string, w: number = MASTER_POSTER.width, h: number = MASTER_POSTER.height) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`)).png().toBuffer();
const SANS = 'font-family="Helvetica, Arial, sans-serif"';
export const masterPosterPng = () => svg('<defs><pattern id="d" width="120" height="80" patternUnits="userSpaceOnUse"><path d="M0 40 L60 0 L120 40 L60 80 Z" fill="none" stroke="#fdf6d2" stroke-width="5"/></pattern></defs>'
  + '<rect width="1000" height="1300" fill="#ffffff"/><rect x="60" y="160" width="880" height="1040" fill="#bdf0dc"/><rect x="60" y="160" width="880" height="1040" fill="url(#d)"/>'
  + `<text x="772" y="104" ${SANS} font-weight="700" font-size="52" fill="#0b3b3c">ACME</text>`
  + '<text x="108" y="300" font-family="Georgia, serif" font-style="italic" font-weight="700" font-size="92" fill="#03595a">Super</text>'
  + `<text x="104" y="540" ${SANS} font-weight="700" font-size="250" fill="#03595a">SALE</text>`
  + `<text x="108" y="640" ${SANS} font-weight="700" font-size="80" fill="#03595a">today.</text>`
  + `<rect x="100" y="700" width="380" height="84" rx="42" fill="#03595a"/><text x="132" y="758" ${SANS} font-weight="700" font-size="48" fill="#cede59">Up to 50% off</text>`
  + `<text x="108" y="868" ${SANS} font-weight="700" font-size="44" fill="#03595a">On selected cards.</text>`
  + MASTER_TILES.map((t, i) => `<g transform="translate(${t.x} ${t.y})">${tile(i)}</g>`).join('')
  + `<text x="70" y="1268" ${SANS} font-size="30" fill="#03595a">T&amp;Cs apply</text>`);
/** A replacement logo for a card (transparent around it). */
export const newLogoPng = () => svg('<rect x="10" y="8" width="180" height="60" rx="14" fill="#0a8f3c"/><circle cx="50" cy="38" r="18" fill="#ffffff"/>', 200, 76);
