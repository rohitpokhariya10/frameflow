/**
 * A deterministic complex offer creative for the recursive decomposition's tests and the offline browser fixture: an
 * orange-to-red gradient with a pedestal, a gift box, a speaker and a power bank on it, headphones, earbuds, a watch,
 * confetti and a headline. Every part renders on its own (complete, on transparency) and the creative is the parts
 * painted back to front, so a fake Seedream response can "extract" any subset and a fake base can bake any subset in.
 */
import sharp from 'sharp';

export type OfferPart = 'pedestal' | 'giftBox' | 'speaker' | 'powerBank' | 'headphones' | 'earbuds' | 'watch' | 'confetti' | 'text';
/** Painter's order (back to front) and the names a provider would give each part. */
export const OFFER_PARTS: { key: OfferPart; name: string; svg: string }[] = [
  { key: 'pedestal', name: 'Display pedestal', svg: '<rect x="250" y="700" width="500" height="150" rx="18" fill="#fde68a"/><ellipse cx="500" cy="700" rx="250" ry="40" fill="#fef3c7"/>' },
  { key: 'giftBox', name: 'Gift box', svg: '<rect x="70" y="560" width="150" height="150" fill="#7c3aed"/><rect x="135" y="560" width="22" height="150" fill="#facc15"/>' },
  { key: 'speaker', name: 'Bluetooth speaker', svg: '<rect x="560" y="470" width="150" height="250" rx="40" fill="#0f172a"/><circle cx="635" cy="560" r="45" fill="#64748b"/>' },
  { key: 'powerBank', name: 'Power bank', svg: '<rect x="300" y="560" width="120" height="160" rx="16" fill="#e5e7eb"/><rect x="330" y="600" width="60" height="12" fill="#22c55e"/>' },
  { key: 'headphones', name: 'Wireless headphones', svg: '<path d="M290 360 A170 170 0 0 1 630 360" fill="none" stroke="#1f2937" stroke-width="34"/><rect x="250" y="330" width="80" height="140" rx="30" fill="#1f2937"/><rect x="590" y="330" width="80" height="140" rx="30" fill="#1f2937"/>' },
  { key: 'earbuds', name: 'Earbuds', svg: '<ellipse cx="800" cy="300" rx="40" ry="55" fill="#f8fafc"/><ellipse cx="880" cy="320" rx="40" ry="55" fill="#f8fafc"/>' },
  { key: 'watch', name: 'Smartwatch', svg: '<rect x="790" y="520" width="44" height="260" rx="14" fill="#111827"/><rect x="760" y="590" width="104" height="120" rx="26" fill="#111827"/><rect x="775" y="605" width="74" height="90" rx="18" fill="#38bdf8"/>' },
  { key: 'confetti', name: 'Confetti', svg: [[60, 90], [180, 210], [430, 120], [700, 80], [930, 150], [960, 470], [40, 420], [880, 880], [120, 900], [600, 940]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="7" fill="#fff59d"/>`).join('') },
  { key: 'text', name: 'MEGA SALE headline', svg: '<rect x="300" y="60" width="400" height="34" fill="#ffffff"/><rect x="340" y="112" width="320" height="22" fill="#ffffff"/>' },
];
export const ALL_PARTS = OFFER_PARTS.map(part => part.key);
export const partName = (key: OfferPart) => OFFER_PARTS.find(part => part.key === key)!.name;

const svg = (width: number, height: number, body: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1000 1000" preserveAspectRatio="none">${body}</svg>`);
const GRADIENT = '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff7a18"/><stop offset="1" stop-color="#c81d25"/></linearGradient></defs><rect width="1000" height="1000" fill="url(#g)"/>';
/** The clean scene: the gradient alone. */
export const offerBackground = (width = 1024, height = 1024) => sharp(svg(width, height, GRADIENT)).png().toBuffer();
/** One part, complete, on transparency at the creative's size. */
export const offerPart = (key: OfferPart, width = 1024, height = 1024) => sharp(svg(width, height, OFFER_PARTS.find(part => part.key === key)!.svg)).png().toBuffer();
/** The gradient with these parts painted in the creative's order (all parts: the creative itself). */
export const offerComposite = (parts: readonly OfferPart[] = ALL_PARTS, width = 1024, height = 1024) =>
  sharp(svg(width, height, GRADIENT + OFFER_PARTS.filter(part => parts.includes(part.key)).map(part => part.svg).join(''))).png().toBuffer();

/**
 * A fake background edit: every masked pixel (mask alpha 0) is filled from the nearest unmasked pixels of its own row,
 * interpolated left to right. Exact for a vertical gradient, deterministic, and blind to what was removed.
 */
export async function rowFillEdit(image: Buffer, mask: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const alpha = await sharp(mask).ensureAlpha().extractChannel(3).raw().toBuffer();
  const w = info.width, h = info.height, out = Buffer.from(data);
  for (let y = 0; y < h; y++) {
    let left = -1;
    for (let x = 0; x <= w; x++) {
      const known = x < w && alpha[y * w + x] > 127;
      if (x < w && !known) continue;
      for (let fill = left + 1; fill < x; fill++) {
        const a = left >= 0 ? left : x < w ? x : -1, b = x < w ? x : a;
        if (a < 0) continue;
        const t = b === a ? 0 : (fill - a) / (b - a);
        for (let c = 0; c < 3; c++) out[(y * w + fill) * 3 + c] = Math.round(data[(y * w + a) * 3 + c] * (1 - t) + data[(y * w + b) * 3 + c] * t);
      }
      left = x;
    }
  }
  return sharp(out, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}
