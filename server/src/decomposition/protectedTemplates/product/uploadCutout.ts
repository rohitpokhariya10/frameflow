/**
 * A replacement picture for a slot (a product or a character), cut out locally:
 *
 *   transparent   the picture has its own transparency (a PNG cut-out): used as it is, trimmed to what it shows
 *   removed       its backdrop is one plain colour (a studio packshot on white): that colour, reached from the picture's
 *                 edges, taken out, with soft edges where the object's colour meets it
 *   kept          the backdrop is a scene or a gradient: it cannot be told from the object here, so the picture is kept
 *                 whole and the person is told (a cut-out PNG, or the cut-out service, is needed for those)
 *
 * Nothing is sent anywhere.
 */
import sharp from 'sharp';

export interface UploadCutout { png: Buffer; width: number; height: number; background: 'transparent' | 'removed' | 'kept'; note?: string }
const MAX_SIDE = 2048;

export async function cutOutUpload(bytes: Buffer): Promise<UploadCutout> {
  let img = sharp(bytes).rotate();
  const meta = await img.metadata(), side = Math.max(meta.width ?? 1, meta.height ?? 1);
  if (side > MAX_SIDE) img = img.resize({ width: Math.round((meta.width ?? 1) * MAX_SIDE / side), height: Math.round((meta.height ?? 1) * MAX_SIDE / side), fit: 'fill' });
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true }), w = info.width, h = info.height, n = w * h, px = Buffer.from(data);
  const edge: number[] = [];
  for (let x = 0; x < w; x++) edge.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) edge.push(y * w, y * w + w - 1);
  // Its own transparency: most of its edge clear.
  const clearEdge = edge.filter(i => px[i * 4 + 3] < 16).length / edge.length;
  if (clearEdge >= 0.6) return trimmed(px, w, h, 'transparent');
  // A plain backdrop: one colour on most of its edge.
  const counts = new Map<number, number[]>();
  for (const i of edge) { const k = (px[i * 4] >> 3 << 10) | (px[i * 4 + 1] >> 3 << 5) | (px[i * 4 + 2] >> 3), e = counts.get(k) ?? counts.set(k, [0, 0, 0, 0]).get(k)!; e[0] += px[i * 4]; e[1] += px[i * 4 + 1]; e[2] += px[i * 4 + 2]; e[3]++; }
  const top = [...counts.values()].sort((a, b) => b[3] - a[3])[0], near = [...counts.values()].filter(e => Math.abs(e[0] / e[3] - top[0] / top[3]) + Math.abs(e[1] / e[3] - top[1] / top[3]) + Math.abs(e[2] / e[3] - top[2] / top[3]) < 36).reduce((s, e) => s + e[3], 0);
  if (near < edge.length * 0.7) return { ...(await trimmed(px, w, h, 'kept')), note: 'Its background is a scene, not one plain colour, so it was kept. Upload a cut-out PNG (with transparency) for a clean result.' };
  const bg = [top[0] / top[3], top[1] / top[3], top[2] / top[3]], diff = (i: number) => Math.max(Math.abs(px[i * 4] - bg[0]), Math.abs(px[i * 4 + 1] - bg[1]), Math.abs(px[i * 4 + 2] - bg[2]));
  // The backdrop: its colour reached from the edges (a white face inside the object, enclosed by it, stays).
  const out = new Uint8Array(n), queue: number[] = [];
  for (const i of edge) if (!out[i] && diff(i) <= 30) { out[i] = 1; queue.push(i); }
  while (queue.length) { const i = queue.pop()!, x = i % w; for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) if (j >= 0 && j < n && !out[j] && diff(j) <= 30) { out[j] = 1; queue.push(j); } }
  const removed = out.reduce((s, v) => s + v, 0) / n;
  if (removed < 0.03 || removed > 0.97) return { ...(await trimmed(px, w, h, 'kept')), note: removed > 0.97 ? 'Nothing but the backdrop was found: check the picture.' : 'No backdrop was found around the object, so it was kept as it is.' };
  for (let i = 0; i < n; i++) {
    if (out[i]) { px[i * 4 + 3] = 0; continue; }
    // A soft edge: next to the backdrop, partly its colour.
    const x = i % w, nextTo = (x > 0 && out[i - 1]) || (x < w - 1 && out[i + 1]) || (i >= w && out[i - w]) || (i + w < n && out[i + w]);
    if (!nextTo) continue;
    const a = Math.min(1, Math.max(0.15, (diff(i) - 10) / 70));
    for (let c = 0; c < 3; c++) px[i * 4 + c] = Math.round(Math.min(255, Math.max(0, (px[i * 4 + c] - (1 - a) * bg[c]) / a)));
    px[i * 4 + 3] = Math.round(a * px[i * 4 + 3]);
  }
  return trimmed(px, w, h, 'removed');
}

async function trimmed(px: Buffer, w: number, h: number, background: UploadCutout['background']): Promise<UploadCutout> {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) { x0 = 0; y0 = 0; x1 = w - 1; y1 = h - 1; }
  const width = x1 - x0 + 1, height = y1 - y0 + 1;
  const png = await sharp(px, { raw: { width: w, height: h, channels: 4 } }).extract({ left: x0, top: y0, width, height }).png().toBuffer();
  return { png, width, height, background };
}
