/**
 * The footprints of a template's products that are not shown (replaced, left out, or their place taken by another
 * product) cleaned from the background they stood on. The template's base is where its products were taken out: outside
 * them it is the original picture, pixel for pixel; where they were it is an estimate (the AI's background or a local
 * fill), and the estimate can keep their shape — a lighter patch where a card reader's stand stood on the podium, a
 * tint over its body with a faint outline. Around them the original keeps their own shadow on the surface. A product put
 * in that place is narrower or shaped otherwise, and the rest of the old shape showed beside it.
 *
 * Only what can be told apart from the artwork is cleaned, never a guess painted over it:
 *   - The estimate: where the background differs from the original picture (`original`) at the old product's place.
 *     Every other pixel is the original artwork and stays as it is, except the old shadow where it stood (below).
 *   - Its outline, where the estimate meets the original: the colour step across it. A ghost of the old product steps
 *     along the outline (most of a stretch the same way, on a surface of one colour); artwork crossing it (rays, a border
 *     the estimate drew again) steps here and there, either way, and is no evidence.
 *   - Over its body (above where it stood) the estimate is kept, shifted by the step measured at its outline (from one
 *     end of each row to the other, then smoothed down the rows): a tint or halo goes, what the estimate drew there (rays,
 *     a border, a picture behind it) stays, and nothing is smeared along the rows.
 *   - Where it stood (from its surface's back rim, else its lowest fifth), on rows where its outline shows a ghost, the
 *     estimate is filled again from beside it (below) — only where that fill can be trusted (on a surface measured
 *     beside it, or one surface on both sides of the row), the estimate along the row is not busy (rays, a pattern), and
 *     it is a shade of what the fill finds or a shadow on it (not a riser's top the estimate drew there). So is its old
 *     shadow beside it: darker than the clean surface by about the same share in each channel (not a pattern of another
 *     colour).
 * Without the original (or one that does not match the background around the footprints) the old product's pixels grown
 * a little are taken as the estimate.
 *
 * The fill: each footprint — the old product's own pixels (its cut-out), a little around them, a band along its contact
 * line for its shadow, and the shadow's tint on the surface beside it — is filled again from what is beside it on the
 * same rows (the colours just left and right of it, a few rows taken together), then smoothed down the rows. The surface
 * it stood on keeps its shape: its back and front rims (a podium's round edges) are measured beside the footprint and
 * continued through it as one smooth curve, and each side of a rim is filled only from that side (the podium's top from
 * the top, the wall from the wall); a background's round bands beside it are followed through it the same way.
 * Local and free; the template's own files never change (a cached background of its own).
 */
import sharp from 'sharp';

type Box = { x: number; y: number; width: number; height: number };
/** Bumped when what cleanFootprints draws changes (a new cached file). */
export const FOOTPRINT_VERSION = 2;
export interface Footprint {
  /** The old product's pixels: its cut-out (alpha) at its place in the picture; else its box is the footprint. */
  cutout?: { png: Buffer; placement: Box };
  box: Box;
  /** Its lowest opaque row (where it stood): the band of its contact shadow. */
  contactY?: number;
}
/** What was found and cleaned at each footprint (in order). */
export interface FootprintReport {
  /** The original picture was the reference (only the estimate and the old shadow could change), or there was none. */
  reference: 'original' | 'none';
  footprints: {
    /** Share of its outline where the estimate steps from the original along it (its old shape showing). */
    ghost: number;
    /** Pixels filled again where it stood, of its old shadow, and of its body shifted (tint, halo). */
    replaced: number; shadow: number; corrected: number;
    /** No ghost of the old product was told apart from the artwork: nothing filled again, no shadow cleaned (at most
     *  a seam with the original evened out). */
    kept: boolean;
  }[];
}

/** How far a footprint reaches beyond its pixels: 3.5 % of its width, 6 px at least (an estimate's soft edge, a halo). */
const growOf = (f: Footprint) => Math.max(6, Math.round(f.box.width * 0.035));
/** A mask grown by r px (a square neighbourhood, in two passes). */
function dilate(mask: Uint8Array, width: number, height: number, r: number) {
  const across = new Uint8Array(width * height), out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) { let last = -1e9; for (let x = 0; x < width; x++) { if (mask[y * width + x]) last = x; if (x - last <= r) across[y * width + x] = 1; } last = 1e9; for (let x = width - 1; x >= 0; x--) { if (mask[y * width + x]) last = x; if (last - x <= r) across[y * width + x] = 1; } }
  for (let x = 0; x < width; x++) { let last = -1e9; for (let y = 0; y < height; y++) { if (across[y * width + x]) last = y; if (y - last <= r) out[y * width + x] = 1; } last = 1e9; for (let y = height - 1; y >= 0; y--) { if (across[y * width + x]) last = y; if (last - y <= r) out[y * width + x] = 1; } }
  return out;
}
/** Each old product's own pixels: its cut-out at its place (alpha over 24), else its box. */
async function silhouettes(width: number, height: number, footprints: Footprint[]) {
  return Promise.all(footprints.map(async f => {
    const own = new Uint8Array(width * height);
    if (f.cutout) {
      const p = f.cutout.placement, w = Math.max(1, Math.round(p.width)), h = Math.max(1, Math.round(p.height));
      const { data, info } = await sharp(f.cutout.png).ensureAlpha().resize(w, h, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const X = Math.round(p.x) + x, Y = Math.round(p.y) + y;
        if (X >= 0 && Y >= 0 && X < width && Y < height && data[(y * w + x) * info.channels + 3] > 24) own[Y * width + X] = 1;
      }
    } else for (let y = Math.max(0, Math.floor(f.box.y)); y < Math.min(height, Math.ceil(f.box.y + f.box.height)); y++) for (let x = Math.max(0, Math.floor(f.box.x)); x < Math.min(width, Math.ceil(f.box.x + f.box.width)); x++) own[y * width + x] = 1;
    return own;
  }));
}
/** The footprints' area (what the fill is made for): their own pixels grown (growOf), and contact bands. */
function holeOf(width: number, height: number, footprints: Footprint[], grown: Uint8Array[]) {
  const hole = new Uint8Array(width * height);
  for (const [n, f] of footprints.entries()) {
    for (let i = 0; i < hole.length; i++) if (grown[n][i]) hole[i] = 1;
    // Its contact shadow: an ellipse along the line it stood on, a little wider than it.
    const cy = f.contactY ?? f.box.y + f.box.height, cx = f.box.x + f.box.width / 2, rx = f.box.width * 0.58, ry = Math.max(6, f.box.height * 0.035);
    for (let y = Math.max(0, Math.floor(cy - ry)); y <= Math.min(height - 1, Math.ceil(cy + ry)); y++) for (let x = Math.max(0, Math.floor(cx - rx)); x <= Math.min(width - 1, Math.ceil(cx + rx)); x++)
      if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) hole[y * width + x] = 1;
  }
  return hole;
}
export async function footprintMask(width: number, height: number, footprints: Footprint[]): Promise<Uint8Array> {
  const own = await silhouettes(width, height, footprints);
  return holeOf(width, height, footprints, footprints.map((f, n) => dilate(own[n], width, height, growOf(f))));
}

/**
 * Where the background is an estimate at each footprint: within its grown pixels, those that differ from the original
 * picture (by more than 2 a channel), and its own pixels. Only when the original matches the background around them
 * (at least half of a band beyond them within 2 a channel: the base is the original outside what was taken out); else
 * (none, another size, a background drawn anew) the grown pixels.
 */
function estimatedArea(width: number, height: number, ground: Uint8Array, original: Uint8Array | undefined, own: Uint8Array[], grown: Uint8Array[]) {
  const est = new Uint8Array(width * height), any = new Uint8Array(width * height);
  for (const g of grown) for (let i = 0; i < any.length; i++) if (g[i]) any[i] = 1;
  const same = (i: number) => !!original && Math.max(Math.abs(ground[i * 3] - original[i * 3]), Math.abs(ground[i * 3 + 1] - original[i * 3 + 1]), Math.abs(ground[i * 3 + 2] - original[i * 3 + 2])) <= 2;
  let matches = false;
  if (original) {
    const band = dilate(any, width, height, 8); let n = 0, k = 0;
    for (let i = 0; i < band.length; i++) if (band[i] && !any[i]) { n++; if (same(i)) k++; }
    matches = n > 0 && k >= n * 0.5;
  }
  for (let i = 0; i < est.length; i++) if (any[i] && (!matches || !same(i) || own.some(o => o[i]))) est[i] = 1;
  return { est, reference: matches };
}

/** A rim of the surface a product stood on: the row of the line between the surface and what is beyond it, at a column. */
type Rim = (x: number) => number;
/** The surface a footprint stood on, over its columns: its back rim (top) and front rim (bottom), each where one was found. */
interface Surface { x0: number; x1: number; y0: number; y1: number; top?: Rim; bottom?: Rim }

/** y = p0 + p1·u + p2·u² (u = (x − xc) / scale) through the points, a second time without those 3 px off; undefined when
 *  they are not one smooth curve (more than 30 % left out, or still more than 1.5 px off on average). Beyond lo–hi, flat. */
function fitRim(points: [number, number][], xc: number, scale: number, lo: number, hi: number): Rim | undefined {
  let pts = points;
  for (let pass = 0; pass < 2; pass++) {
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], T = [0, 0, 0];
    for (const [x, y] of pts) { const u = (x - xc) / scale, v = [1, u, u * u]; for (let i = 0; i < 3; i++) { T[i] += v[i] * y; for (let j = 0; j < 3; j++) M[i][j] += v[i] * v[j]; } }
    const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const d = det(M); if (Math.abs(d) < 1e-9) return undefined;
    const p = [0, 1, 2].map(k => det(M.map((row, i) => row.map((v, j) => j === k ? T[i] : v))) / d);
    const rim: Rim = x => { const u = (Math.min(hi, Math.max(lo, x)) - xc) / scale; return p[0] + p[1] * u + p[2] * u * u; };
    const off = pts.map(([x, y]) => Math.abs(rim(x) - y));
    if (pass === 1) return pts.length >= points.length * 0.7 && Math.sqrt(off.reduce((s, r) => s + r * r, 0) / off.length) <= 1.5 ? rim : undefined;
    pts = pts.filter((_, i) => off[i] <= 3);
    if (pts.length < 12) return undefined;
  }
}

/**
 * The background (PNG) with the footprints cleaned (see above). `keep`: what is painted into the background beside them
 * (a badge): never part of a footprint. `original`: the template's original picture (the reference for what is an
 * estimate). Returns the new PNG, how many pixels changed, and what was found at each footprint.
 */
export async function cleanFootprints(groundPng: Buffer, footprints: Footprint[], keep: Box[] = [], original?: Buffer): Promise<{ png: Buffer; filled: number; report: FootprintReport }> {
  const { data, info } = await sharp(groundPng).removeAlpha().raw().toBuffer({ resolveWithObject: true }), W = info.width, H = info.height;
  const own = await silhouettes(W, H, footprints), grown = footprints.map((f, n) => dilate(own[n], W, H, growOf(f)));
  const picture = original ? await sharp(original).removeAlpha().raw().toBuffer({ resolveWithObject: true }) : undefined;
  const { est, reference } = estimatedArea(W, H, data, picture && picture.info.width === W && picture.info.height === H ? picture.data : undefined, own, grown);
  const hole = holeOf(W, H, footprints, grown), out = Uint8Array.from(data);
  const SIDE = 6, ROWS = 3, median = (v: number[]) => { v.sort((p, q) => p - q); return v[v.length >> 1]; };
  const at = (x: number, y: number) => { const i = (y * W + x) * 3; return [data[i], data[i + 1], data[i + 2]]; };
  const apart = (p: number[], q: number[]) => Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]), Math.abs(p[2] - q[2]));

  // The surface each stood on: from just above its contact line, each column beside the footprint (a third of its width
  // on each side) is followed up and down while it stays the same surface (no step over 20 a channel, within 80 of its
  // colour beside the footprint); where it stops is a rim. A rim found on both sides that is one smooth curve is kept.
  const surfaces: Surface[] = [], lowest = footprints.map(f => Math.round((f.contactY ?? f.box.y + f.box.height) + Math.max(6, f.box.height * 0.035)));
  // Where each stood, from this row down: from just above its surface's back rim (above it is the wall, a poster, its
  // body's place), else its lowest fifth.
  const stood = footprints.map(f => (f.contactY ?? f.box.y + f.box.height) - f.box.height * 0.2);
  for (const [n, f] of footprints.entries()) {
    const cy = Math.round(f.contactY ?? f.box.y + f.box.height), ys = cy - 2, band = Math.max(24, Math.round(f.box.width * 0.33));
    if (ys < 1 || ys >= H - 1) continue;
    let a = W, b = -1, x0 = W, x1 = -1, y0 = H, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (hole[y * W + x]) {
      const near = Math.abs(x - (f.box.x + f.box.width / 2)) <= f.box.width && y >= f.box.y - f.box.height * 0.1 && y <= cy + f.box.height * 0.2;
      if (!near) continue;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      if (Math.abs(y - ys) <= 2) { a = Math.min(a, x); b = Math.max(b, x); }
    }
    if (b < 0) continue;
    const ref: number[][] = [];
    for (let y = ys - 4; y <= ys; y++) for (const x of [a - 3, a - 6, a - 9, b + 3, b + 6, b + 9]) if (x >= 0 && x < W && !hole[y * W + x]) ref.push(at(x, y));
    if (ref.length < 6) continue;
    const S = [0, 1, 2].map(c => median(ref.map(p => p[c])));
    const walk = (x: number, dir: -1 | 1, limit: number): number | undefined => {
      if (hole[ys * W + x] || apart(at(x, ys), S) > 60) return undefined;
      for (let y = ys; ; y += dir) {
        const n = y + dir;
        if (n < 0 || n >= H || (dir < 0 ? n < limit : n > limit) || hole[n * W + x]) return undefined;
        if (apart(at(x, n), at(x, y)) > 20 || apart(at(x, n), S) > 80) return y + dir * 0.5;
      }
    };
    const columns = [...Array.from({ length: band }, (_, k) => a - 1 - k), ...Array.from({ length: band }, (_, k) => b + 1 + k)].filter(x => x >= 0 && x < W);
    const rimOf = (dir: -1 | 1, limit: number) => {
      const pts = columns.flatMap(x => { const y = walk(x, dir, limit); return y === undefined ? [] : [[x, y] as [number, number]]; });
      if (pts.filter(p => p[0] < a).length < 6 || pts.filter(p => p[0] > b).length < 6) return undefined;
      const rim = fitRim(pts, (a + b) / 2, (b - a) / 2 + band, a - band, b + band);
      // Above the line it stood on (a back rim), below it (a front rim), across the whole footprint.
      if (!rim) return undefined;
      for (let x = a; x <= b; x += 4) if (dir < 0 ? rim(x) > ys - 1 : rim(x) < ys + 1) return undefined;
      return rim;
    };
    const top = rimOf(-1, Math.max(0, Math.round(cy - f.box.height * 0.6))), bottom = rimOf(1, Math.min(H - 1, Math.round(cy + f.box.height * 0.35)));
    if (top || bottom) surfaces.push({ x0: Math.max(0, x0 - band), x1: Math.min(W - 1, x1 + band), y0, y1, top, bottom });
    if (top) { let rim = Infinity; for (let x = a; x <= b; x++) rim = Math.min(rim, top(x)); stood[n] = rim - 6; }
    // Stood near the front rim (as far as an eighth of its height): its contact shadow reached the rim, and the band
    // between them is part of its footprint too.
    if (bottom) for (let x = a; x <= b; x++) {
      const end = Math.min(H - 1, Math.ceil(bottom(x) + 1));
      if (!hole[cy * W + x] || end - cy > f.box.height * 0.12) continue;
      for (let y = cy; y <= end; y++) hole[y * W + x] = 1;
      lowest[n] = Math.max(lowest[n], end);
    }
  }

  // The old shadow's tint: near where a product stood, the surface just beside its footprint is darker (or, where the
  // estimate kept a halo, lighter) than the same surface farther along the row — filled from that band, the whole place
  // came out as shadow. Where the colour beside it and the colour a quarter of its width farther (else an eighth) are the
  // same surface (within 40 a channel, or darker by about the same share in each channel: a deep shadow, not under half
  // as bright), the footprint grows over the band until the surface is clean (within 4). Where they are two surfaces (a
  // podium's curved edge, its dark front), it does not grow: the curve stays where it is.
  const shadowOf = (p: ArrayLike<number>, q: ArrayLike<number>) => {
    const r = [0, 1, 2].map(c => (p[c] + 8) / (q[c] + 8));
    return r.every(v => v <= 1.03) && Math.min(...r) >= 0.45 && Math.max(...r) - Math.min(...r) <= 0.12;
  };
  const sameSurface = (p: number[], q: number[]) => apart(p, q) <= 40 || shadowOf(p, q);
  // Below its contact band first, down each column under it: the shadow falls toward the front too. The surface a tenth of
  // its height farther down (12 px at least) is the clean colour; the footprint grows down over the darker band of the
  // same surface until the surface is clean (within 4), never onto another surface (the podium's dark front).
  for (const [n, f] of footprints.entries()) {
    const span = Math.max(12, Math.round(f.box.height * 0.1)), y0 = lowest[n];
    if (y0 + span + 3 >= H) continue;
    for (let x = Math.max(0, Math.floor(f.box.x - f.box.width * 0.1)); x < Math.min(W, Math.ceil(f.box.x + f.box.width * 1.1)); x++) {
      if (!hole[y0 * W + x]) continue;
      const clean = [0, 1, 2].map(c => median([-3, -2, -1, 0, 1, 2, 3].map(d => at(x, y0 + span + d)[c])));
      let last = -1;
      for (let y = y0 + 1; y < y0 + span; y++) { const p = at(x, y); if (!sameSurface(p, clean)) { last = -1; break; } if (apart(p, clean) > 4) last = y; else break; }
      for (let y = y0 + 1; y <= last; y++) hole[y * W + x] = 1;
      if (last > lowest[n]) lowest[n] = Math.max(lowest[n], last);
    }
  }
  for (const [n, f] of footprints.entries()) {
    const cy = f.contactY ?? f.box.y + f.box.height, reach = Math.max(12, Math.round(f.box.width * 0.25));
    for (let y = Math.max(ROWS, Math.round(cy - f.box.height * 0.2)); y <= Math.min(H - 1 - ROWS, lowest[n]); y++) {
      let a = -1, b = -1;
      for (let x = Math.max(0, Math.floor(f.box.x - reach)); x < Math.min(W, Math.ceil(f.box.x + f.box.width + reach)); x++) if (hole[y * W + x]) { if (a < 0) a = x; b = x; }
      if (a < 0) continue;
      for (const [edge, step] of [[a, -1], [b, 1]] as const) for (const span of [reach, Math.round(reach / 2)]) {
        const far = edge + step * span; if (edge + step < 0 || edge + step >= W) break; if (far - 3 < 0 || far + 3 >= W) continue;
        const clean = [0, 1, 2].map(c => median([-3, -2, -1, 0, 1, 2, 3].map(d => at(far + d, y)[c])));
        if (!sameSurface(at(edge + step, y), clean)) continue;
        let last = -1;
        for (let x = edge + step, k = 1; k < span; k++, x += step) { const p = at(x, y); if (!sameSurface(p, clean)) { last = -1; break; } if (apart(p, clean) > 4) last = x; else break; }
        if (last >= 0) for (let x = edge; x !== last + step; x += step) hole[y * W + x] = 1;
        break;
      }
    }
  }
  // What is painted beside them is left as it is (one reaching over a product's own box, a frame around the whole
  // picture, is not beside it).
  const over = (k: Box, b: Box) => k.x < b.x + b.width && k.x + k.width > b.x && k.y < b.y + b.height && k.y + k.height > b.y;
  for (const k of keep.filter(k => !footprints.some(f => over(k, f.box))))
    for (let y = Math.max(0, Math.floor(k.y)); y < Math.min(H, Math.ceil(k.y + k.height)); y++) for (let x = Math.max(0, Math.floor(k.x)); x < Math.min(W, Math.ceil(k.x + k.width)); x++) hole[y * W + x] = 0;

  // Which side of a surface's rims a pixel is on: 0 beyond its back rim, 1 on it, 2 beyond its front rim; -1 within 1 px
  // of a rim (never taken as a colour beside the footprint). Without a surface there, every pixel is on it.
  const surfaceAt = (x: number) => surfaces.find(s => x >= s.x0 && x <= s.x1);
  const sideOf = (x: number, y: number) => {
    const s = surfaceAt(x); if (!s) return 1;
    const c = s.top?.(x) ?? -Infinity, d = s.bottom?.(x) ?? Infinity;
    return y <= c - 1.5 ? 0 : y >= d + 1.5 ? 2 : y >= c + 1.5 && y <= d - 1.5 ? 1 : -1;
  };
  // How much of a pixel is on each side (a rim through it: shared, so the curve is smooth, never stepped).
  const coverOf = (s: Surface, x: number, y: number) => {
    const above = s.top ? Math.min(1, Math.max(0, s.top(x) - (y - 0.5))) : 0, below = s.bottom ? Math.min(1, Math.max(0, y + 0.5 - s.bottom(x))) : 0;
    return [above, Math.max(0, 1 - above - below), below];
  };
  // A row's colour just outside a run of the hole, from SIDE columns beside it over ±ROWS rows (pixels of the hole left
  // out, and, for one side of a rim, the other side's).
  const beside = (y: number, from: number, step: number, side = -2) => {
    const r: number[] = [], g: number[] = [], b: number[] = [];
    for (let dy = -ROWS; dy <= ROWS; dy++) { const yy = y + dy; if (yy < 0 || yy >= H) continue; for (let k = 1, x = from; k <= SIDE + 2 && x >= 0 && x < W; k++, x += step) { if (hole[yy * W + x] || (side > -2 && sideOf(x, yy) !== side)) continue; const i = (yy * W + x) * 3; r.push(data[i]); g.push(data[i + 1]); b.push(data[i + 2]); } }
    return r.length >= 3 ? [median(r), median(g), median(b)] : undefined;
  };
  const runs = (y: number, x0: number, x1: number, each: (from: number, end: number) => void) => {
    for (let x = x0; x <= x1; x++) { if (!hole[y * W + x]) continue; let end = x; while (end + 1 <= x1 && hole[y * W + end + 1]) end++; each(x, end); x = end; }
  };
  // The lines of what is beside a run (a background's round bands crossing where a product stood): their slope on each
  // side (the structure tensor of the pixels beside it; none where it is flat, mixed, or steeper than about 40°). Through
  // the run they are one curve whose slope turns evenly from the left side's to the right side's, and each pixel is
  // filled from where its curve meets each side: a round band stays round instead of flattened to the row. (Lines on
  // one side only are not followed: where the bands end on that side, the curve would reach into them.)
  const lum = (x: number, y: number) => { const i = (y * W + x) * 3; return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; };
  const slopeBeside = (y: number, from: number, step: number) => {
    let xx = 0, yy = 0, xy = 0, n = 0;
    for (let dy = -10; dy <= 10; dy++) for (let k = 0, x = from; k < 16; k++, x += step) {
      const Y = y + dy, i = Y * W + x;
      if (x < 1 || x >= W - 1 || Y < 1 || Y >= H - 1 || hole[i] || hole[i - 1] || hole[i + 1] || hole[i - W] || hole[i + W]) continue;
      const gx = (lum(x + 1, Y) - lum(x - 1, Y)) / 2, gy = (lum(x, Y + 1) - lum(x, Y - 1)) / 2;
      xx += gx * gx; yy += gy * gy; xy += gx * gy; n++;
    }
    if (n < 60 || xx + yy < n || Math.hypot(xx - yy, 2 * xy) / (xx + yy) < 0.6) return 0;
    const phi = 0.5 * Math.atan2(2 * xy, xx - yy);
    return Math.abs(Math.sin(phi)) < 0.75 ? 0 : -Math.cos(phi) / Math.sin(phi);
  };
  const structured = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) runs(y, 0, W - 1, (x, end) => {
    const L = x - 1, R = end + 1, w = R - L, l = L >= 0 ? slopeBeside(y, L, -1) : 0, r = R < W ? slopeBeside(y, R, 1) : 0, [sL, sR] = l && r ? [l, r] : [0, 0];
    const cache = new Map<string, number[] | undefined>(), side = (yy: number, from: number, step: number) => {
      const key = `${yy},${from}`; if (!cache.has(key)) cache.set(key, beside(yy, from, step)); return cache.get(key);
    };
    // The curve's rise from L (its slope sL left of the run, sR right of it), and where it leaves the hole: a row above
    // or below may be wider than this one (a rounded top), so it is followed out of the hole, not stopped at L or R.
    const rise = (p: number) => p <= L ? sL * (p - L) : p <= R ? sL * (p - L) + (sR - sL) * (p - L) ** 2 / (2 * w) : sL * w + (sR - sL) * w / 2 + sR * (p - R);
    const limit = Math.min(60, w * 0.25);
    const exit = (k: number, step: number): [number, number] | undefined => {
      if (!sL && !sR) return [step < 0 ? L : R, y];
      for (let p = k + step; p >= 0 && p < W; p += step) {
        const yy = Math.round(y + Math.max(-limit, Math.min(limit, rise(p) - rise(k))));
        if (yy < 0 || yy >= H) return undefined;
        if (!hole[yy * W + p]) return [p, yy];
      }
    };
    for (let k = x; k <= end; k++) {
      const el = exit(k, -1), er = exit(k, 1);
      const left = (el && side(el[1], el[0], -1)) ?? (L >= 0 ? side(y, L, -1) : undefined), right = (er && side(er[1], er[0], 1)) ?? (R < W ? side(y, R, 1) : undefined);
      if (!left && !right) continue;
      const pl = el?.[0] ?? L, pr = er?.[0] ?? R, t = left && right ? (k - pl) / (pr - pl) : 0, a = left ?? right!, z = right ?? left!, i = (y * W + k) * 3;
      for (let c = 0; c < 3; c++) out[i + c] = Math.round(a[c] + (z[c] - a[c]) * t);
      if (sL || sR) structured[y * W + k] = 1;
    }
  });
  // Around a surface's rims: each side filled from its own side along the row; where a row has none of it beside the
  // footprint (the top of a podium's round back edge), from the nearest row in the column that has; the sides then
  // shared out by how much of each pixel each covers.
  for (const s of surfaces) {
    const ys = [s.top, s.bottom].flatMap(r => r ? Array.from({ length: Math.floor((s.x1 - s.x0) / 4) + 1 }, (_, k) => r(s.x0 + k * 4)) : []);
    const ry0 = Math.max(0, Math.floor(Math.min(...ys)) - 6), ry1 = Math.min(H - 1, Math.ceil(Math.max(...ys)) + 6), w = s.x1 - s.x0 + 1, h = ry1 - ry0 + 1;
    if (h <= 0) continue;
    const fills = [0, 1, 2].map(() => new Float32Array(w * h * 3).fill(NaN));
    for (let y = ry0; y <= ry1; y++) runs(y, s.x0, s.x1, (x, end) => {
      for (let side = 0; side < 3; side++) {
        const left = beside(y, x - 1, -1, side), right = beside(y, end + 1, 1, side);
        if (!left && !right) continue;
        for (let k = x; k <= end; k++) {
          if (coverOf(s, k, y)[side] === 0) continue;
          const t = left && right ? (k - x + 1) / (end - x + 2) : 0, a = left ?? right!, z = right ?? left!, i = ((y - ry0) * w + k - s.x0) * 3;
          for (let c = 0; c < 3; c++) fills[side][i + c] = a[c] + (z[c] - a[c]) * t;
        }
      }
    });
    for (let x = s.x0; x <= s.x1; x++) for (let side = 0; side < 3; side++) {
      const f = fills[side], need: number[] = [];
      for (let y = ry0; y <= ry1; y++) if (hole[y * W + x] && coverOf(s, x, y)[side] > 0 && Number.isNaN(f[((y - ry0) * w + x - s.x0) * 3])) need.push(y);
      for (const y of need) for (let d = 1; d <= h; d++) {
        const src = [y + d, y - d].find(yy => yy >= ry0 && yy <= ry1 && (hole[yy * W + x] ? !Number.isNaN(f[((yy - ry0) * w + x - s.x0) * 3]) : sideOf(x, yy) === side));
        if (src === undefined) continue;
        const i = ((y - ry0) * w + x - s.x0) * 3, j = ((src - ry0) * w + x - s.x0) * 3, p = hole[src * W + x] ? [f[j], f[j + 1], f[j + 2]] : at(x, src);
        for (let c = 0; c < 3; c++) f[i + c] = p[c];
        break;
      }
    }
    for (let y = ry0; y <= ry1; y++) for (let x = s.x0; x <= s.x1; x++) {
      if (!hole[y * W + x]) continue;
      const cover = coverOf(s, x, y), i = ((y - ry0) * w + x - s.x0) * 3, o = (y * W + x) * 3;
      if (cover.some((v, side) => v > 0 && Number.isNaN(fills[side][i]))) continue;
      for (let c = 0; c < 3; c++) out[o + c] = Math.round(cover.reduce((sum, v, side) => sum + (v > 0 ? v * fills[side][i + c] : 0), 0));
    }
  }
  // Down the rows: neighbouring rows' fills of a similar colour taken together (9 rows), so no row-to-row banding shows
  // and two surfaces (a podium's top and its dark front) are never blended into each other. (Not where lines were
  // followed: those are the background's own bands.)
  const smooth = Uint8Array.from(out);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!hole[y * W + x] || structured[y * W + x]) continue;
    const i = (y * W + x) * 3, sum = [0, 0, 0]; let n = 0;
    for (let dy = -4; dy <= 4; dy++) {
      const yy = y + dy; if (yy < 0 || yy >= H || !hole[yy * W + x]) continue;
      const j = (yy * W + x) * 3; if (Math.max(Math.abs(out[j] - out[i]), Math.abs(out[j + 1] - out[i + 1]), Math.abs(out[j + 2] - out[i + 2])) > 40) continue;
      sum[0] += out[j]; sum[1] += out[j + 1]; sum[2] += out[j + 2]; n++;
    }
    for (let c = 0; c < 3; c++) smooth[i + c] = Math.round(sum[c] / n);
  }
  // Where each stood (`stood` and down, faded in over 12 rows above), by footprint; 0 elsewhere.
  const clamp = (v: number) => Math.min(1, Math.max(0, v)), lumOf = (b: Uint8Array, i: number) => 0.299 * b[i] + 0.587 * b[i + 1] + 0.114 * b[i + 2];
  const near = (f: Footprint, x: number, y: number) => x >= f.box.x - f.box.width * 0.6 && x <= f.box.x + f.box.width * 1.6 && y >= f.box.y - f.box.height * 0.1 && y <= f.box.y + f.box.height * 1.3;
  const zone = (n: number, y: number) => clamp((y - stood[n] + 12) / 12);
  const owner = (p: number) => { const n = grown.findIndex(g => g[p]); return n >= 0 ? n : footprints.findIndex(f => near(f, p % W, Math.floor(p / W))); };
  const found = footprints.map(() => ({ ghost: 0, replaced: 0, shadow: 0, corrected: 0, kept: false }));

  // Where the fill can be trusted: on a surface measured beside the footprint (between its rims: the fill follows them),
  // and on rows whose colours beside the footprint, left and right, are one surface (within 30 a channel; none from 45).
  // Between two things (a stand and a badge's ribbon, a riser and another product's place) a fill along the row would
  // invent what is there.
  const trust = new Float32Array(W * H);
  for (let y = 0; y < H; y++) runs(y, 0, W - 1, (x, end) => {
    const l = x > 0 ? beside(y, x - 1, -1) : undefined, r = end < W - 1 ? beside(y, end + 1, 1) : undefined, k = l && r ? clamp((45 - apart(l, r)) / 15) : 0;
    for (let i = x; i <= end; i++) {
      const s = surfaceAt(i), on = !!s && (!s.top || y >= s.top(i) - 2) && (!s.bottom || y <= s.bottom(i) + 2) && y <= s.y1 + 2;
      trust[y * W + i] = on ? 1 : k;
    }
  });
  // Beside its own pixels only its old shadow, where it stood: darker than the clean surface (the fill, where it can be
  // trusted), each channel by about the same share (a pattern beside it, another colour, is never taken for one).
  const base = Uint8Array.from(data);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x; if (!hole[p] || est[p]) continue;
    let z = 0, by = -1;
    for (const [n, f] of footprints.entries()) if (near(f, x, y) && zone(n, y) > z) { z = zone(n, y); by = n; }
    if (by < 0) continue;
    const i = p * 3, dark = clamp((lumOf(smooth, i) - lumOf(data, i) - 2) / 4);
    if (!dark) continue;
    const r = [0, 1, 2].map(c => (data[i + c] + 8) / (smooth[i + c] + 8)), k = z * dark * trust[p] * clamp((0.3 - (Math.max(...r) - Math.min(...r))) / 0.15);
    if (k <= 0) continue;
    for (let c = 0; c < 3; c++) base[i + c] = Math.round(data[i + c] + (smooth[i + c] - data[i + c]) * k);
    found[by].shadow++;
  }

  // The old product's soft edge in the original: 2 px around the estimate (its anti-aliased outline, a colour of its
  // own, not the artwork's). Taken with the estimate (`area`), and set again from what is on each side of it.
  const ring = new Uint8Array(W * H), area = Uint8Array.from(est);
  if (reference) { const edge = dilate(est, W, H, 2); for (let p = 0; p < W * H; p++) if (edge[p] && !est[p] && hole[p]) { ring[p] = 1; area[p] = 1; } }
  // Its outline (where it meets the original), each point with the step across it — the mean colour within 6 px on the
  // original's side (its old shadow cleaned) less the estimate's, over 3 rows (left and right sides) or 3 columns (top
  // and bottom), so a band of the artwork along them is measured on its own rows — and which way the original lies
  // (0 left, 1 right, 2 above, 3 below). Steady where the original's side is of one colour there (no edge of the
  // artwork through it, so the step is the estimate's own).
  type Edge = { x: number; y: number; n: number; d: number[]; steady: boolean; dir: number };
  const edges: Edge[] = [];
  for (let y = 6; y < H - 6; y++) for (let x = 6; x < W - 6; x++) {
    const p = y * W + x; if (!area[p]) continue;
    const dir = !area[p - 1] ? 0 : !area[p + 1] ? 1 : !area[p - W] ? 2 : !area[p + W] ? 3 : -1;
    if (dir < 0) continue;
    const n = owner(p); if (n < 0) continue;
    const sIn = [0, 0, 0], sOut = [0, 0, 0], qOut = [0, 0, 0]; let nIn = 0, nOut = 0;
    for (let a = -1; a <= 1; a++) for (let b = -6; b <= 6; b++) {
      const q = dir < 2 ? p + a * W + b : p + b * W + a, j = q * 3;
      if (est[q]) { for (let c = 0; c < 3; c++) sIn[c] += data[j + c]; nIn++; }
      else if (!area[q]) { for (let c = 0; c < 3; c++) { sOut[c] += base[j + c]; qOut[c] += base[j + c] ** 2; } nOut++; }
    }
    if (nIn < 6 || nOut < 6) continue;
    const spread = Math.max(...[0, 1, 2].map(c => Math.sqrt(Math.max(0, qOut[c] / nOut - (sOut[c] / nOut) ** 2))));
    edges.push({ x, y, n, d: [0, 1, 2].map(c => sOut[c] / nOut - sIn[c] / nIn), steady: spread <= 6, dir });
  }
  // A ghost: a stretch of the outline (24 px, one side) whose steady points step the same way (70 % of them by 2 or more
  // along their mean step, that at least 4). The rows it reaches (8 above and below) are where the old shape shows.
  const CELL = 24, stretches = new Map<string, Edge[]>(), ghostRows = footprints.map(() => new Float32Array(H));
  for (const e of edges) if (e.steady) { const k = `${e.n},${Math.floor(e.x / CELL)},${Math.floor(e.y / CELL)},${e.dir}`; (stretches.get(k) ?? stretches.set(k, []).get(k)!).push(e); }
  const ghostly = new Set<Edge>();
  for (const s of stretches.values()) {
    if (s.length < 6) continue;
    const m = [0, 1, 2].map(c => s.reduce((t, e) => t + e.d[c], 0) / s.length), mag = Math.hypot(...m);
    if (mag < 4 || s.filter(e => e.d.reduce((t, v, c) => t + v * m[c], 0) / mag >= 2).length < s.length * 0.7) continue;
    for (const e of s) { ghostly.add(e); for (let y = Math.max(0, e.y - 8); y <= Math.min(H - 1, e.y + 8); y++) ghostRows[e.n][y] = 1; }
  }
  for (const [n] of footprints.entries()) {
    const all = edges.filter(e => e.n === n).length;
    found[n].ghost = all ? edges.filter(e => e.n === n && ghostly.has(e)).length / all : 0;
    const r = ghostRows[n], soft = new Float32Array(H);
    for (let y = 0; y < H; y++) { let s = 0, k = 0; for (let d = -4; d <= 4; d++) if (y + d >= 0 && y + d < H) { s += r[y + d]; k++; } soft[y] = s / k; }
    ghostRows[n] = soft;
  }

  // The shift over the estimate, row by row. At each end of a row of it, the step across its outline: the original's
  // mean colour within 6 px beyond it (over 3 rows; its old shadow cleaned) less the estimate's within it — steady where
  // the original's side is of one colour, a tint of at most 40 a channel. A row is busy where the estimate along it
  // crosses its middle colour 6 times or more in some channel (by 5 either way, smoothed over 5 px): rays, a pattern
  // the estimate drew there — not a patch's edge or two.
  //   Across the whole row (one that is not busy; from one end's shift to the other's) where both ends see the same
  // artwork (within 12) stepping the same way (within 8) over 24 rows on end: a tint over the whole place. Fewer such
  // rows can be a coincidence (the estimate's rays meeting the original's a little off at both ends), and a shift across
  // would draw a stripe through the rays: a thin band of the artwork through it, a border's stripe, keeps the estimate's
  // colour.
  //   Else at an end whose step holds (within 6) for 9 rows on end — a seam along the outline — near it only, gone 24 px
  // in. A step at a few rows only is left as it is. Then down the rows, among rows of a similar shift (within 8: a
  // surface's edge or a band across it stays where it is).
  type End = { out: number[]; d: number[] };
  type Run = { y: number; x0: number; x1: number; L?: End; R?: End; across: boolean; busy: boolean };
  const off = (a: number[], b: number[]) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
  const endOf = (y: number, x: number, inward: 1 | -1): End | undefined => {
    const o = [0, 0, 0], q = [0, 0, 0], e = [0, 0, 0]; let no = 0, ne = 0;
    for (let yy = Math.max(0, y - 1); yy <= Math.min(H - 1, y + 1); yy++) {
      for (let k = 1; k <= 6; k++) { const xx = x - inward * k; if (xx < 0 || xx >= W) break; const p = yy * W + xx; if (area[p]) continue; for (let c = 0; c < 3; c++) { o[c] += base[p * 3 + c]; q[c] += base[p * 3 + c] ** 2; } no++; }
      for (let k = 0, got = 0; k <= 10 && got < 6; k++) { const xx = x + inward * k; if (xx < 0 || xx >= W) break; const p = yy * W + xx; if (!est[p]) continue; for (let c = 0; c < 3; c++) e[c] += data[p * 3 + c]; ne++; got++; }
    }
    if (no < 6 || ne < 6 || Math.max(...[0, 1, 2].map(c => Math.sqrt(Math.max(0, q[c] / no - (o[c] / no) ** 2)))) > 6) return undefined;
    const out = o.map(v => v / no), d = out.map((v, c) => v - e[c] / ne);
    return Math.max(...d.map(Math.abs)) <= 40 ? { out, d } : undefined;
  };
  const busyAlong = (y: number, x0: number, x1: number) => {
    const at: number[] = [];
    for (let x = x0; x <= x1; x++) if (est[y * W + x]) at.push((y * W + x) * 3);
    if (at.length < 24) return false;
    return [0, 1, 2].some(c => {
      const l = at.map(i => data[i + c]), sm = l.map((_, i) => { let s = 0, k = 0; for (let j = Math.max(0, i - 2); j <= Math.min(l.length - 1, i + 2); j++) { s += l[j]; k++; } return s / k; });
      const m = median([...sm]);
      let side = 0, crossings = 0;
      for (const v of sm) { const now = v > m + 5 ? 1 : v < m - 5 ? -1 : side; if (side && now !== side) crossings++; side = now; }
      return crossings >= 6;
    });
  };
  const runsAt: Run[][] = Array.from({ length: H }, () => []), busyAt = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!area[y * W + x]) continue;
    let end = x; while (end + 1 < W && area[y * W + end + 1]) end++;
    const L = endOf(y, x, 1), R = endOf(y, end, -1), busy = busyAlong(y, x, end);
    runsAt[y].push({ y, x0: x, x1: end, L, R, busy, across: !busy && !!L && !!R && off(L.out, R.out) <= 12 && off(L.d, R.d) <= 8 });
    if (busy) busyAt.fill(1, y * W + x, y * W + end + 1);
    x = end;
  }
  // How many rows on end (up to `need`) the run's side holds: the run of each row above and below with that end within
  // 8 px of the last one's, while `ok`.
  const holds = (r: Run, side: 'x0' | 'x1', ok: (s: Run) => boolean, need: number) => {
    let k = 1;
    for (const dir of [-1, 1]) {
      let s: Run | undefined = r;
      for (let yy = r.y + dir; yy >= 0 && yy < H && k < need; yy += dir) { const from: Run = s!; s = runsAt[yy].find(t => Math.abs(t[side] - from[side]) <= 8); if (!s || !ok(s)) break; k++; }
    }
    return k;
  };
  const mid = (r: Run) => [0, 1, 2].map(c => (r.L!.d[c] + r.R!.d[c]) / 2);

  const rowShift = new Float32Array(W * H * 3), shifted = new Uint8Array(W * H);
  for (const row of runsAt) for (const r of row) {
    const across = r.across && holds(r, 'x0', s => s.across && off(mid(s), mid(r)) <= 8 && off(s.L!.out, r.L!.out) <= 12 && off(s.R!.out, r.R!.out) <= 12, 24) >= 24;
    const L = r.L && (across || holds(r, 'x0', s => !!s.L && off(s.L.d, r.L!.d) <= 6, 9) >= 9) ? r.L : undefined;
    const R = r.R && (across || holds(r, 'x1', s => !!s.R && off(s.R.d, r.R!.d) <= 6, 9) >= 9) ? r.R : undefined;
    if (!L && !R) continue;
    for (let k = r.x0; k <= r.x1; k++) {
      const t = r.x1 > r.x0 ? (k - r.x0) / (r.x1 - r.x0) : 0.5, p = r.y * W + k;
      const l = across ? 1 - t : Math.max(0, 1 - (k - r.x0) / 24), rr = across ? t : Math.max(0, 1 - (r.x1 - k) / 24);
      for (let c = 0; c < 3; c++) rowShift[p * 3 + c] = (L ? L.d[c] * l : 0) + (R ? R.d[c] * rr : 0);
      shifted[p] = 1;
    }
  }
  const smoothShift = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x; if (!shifted[p]) continue;
    const s = [0, 0, 0]; let k = 0;
    for (let d = -10; d <= 10; d++) {
      const q = p + d * W; if (y + d < 0 || y + d >= H || !shifted[q]) continue;
      if (Math.max(...[0, 1, 2].map(c => Math.abs(rowShift[q * 3 + c] - rowShift[p * 3 + c]))) > 8) continue;
      for (let c = 0; c < 3; c++) s[c] += rowShift[q * 3 + c]; k++;
    }
    for (let c = 0; c < 3; c++) smoothShift[p * 3 + c] = Math.max(-40, Math.min(40, s[c] / k));
  }

  // The estimate (and the soft edge): filled again where it stood on rows with a ghost — where the fill can be trusted,
  // on rows that are not busy, and where the estimate is a shade of what the fill finds there (within 24 a channel, none
  // from 36: the old product's patch on the podium, on the floor) or a shadow on it (darker, the same hue). An estimate
  // of another colour there is something the estimate drew (a riser's top behind the product), or what cannot be told
  // from it: kept, shifted. Elsewhere shifted.
  const result = base;
  for (let p = 0; p < W * H; p++) {
    if (!area[p]) continue;
    const i = p * 3, n = owner(p), y = Math.floor(p / W), own = data.subarray(i, i + 3), fill = smooth.subarray(i, i + 3), shade = shadowOf(own, fill) ? 1 : clamp((36 - off([...own], [...fill])) / 12);
    // (The soft edge where it stood is the old product's own outline: filled wherever the fill can be trusted.)
    const w = n < 0 || !hole[p] || busyAt[p] ? 0 : ring[p] ? zone(n, y) * trust[p] : zone(n, y) * ghostRows[n][y] * trust[p] * shade;
    let moved = 0;
    for (let c = 0; c < 3; c++) {
      const kept = data[i + c] + smoothShift[i + c];
      result[i + c] = Math.max(0, Math.min(255, Math.round(kept + (smooth[i + c] - kept) * w)));
      moved = Math.max(moved, Math.abs(result[i + c] - data[i + c]));
    }
    if (n >= 0 && moved >= 1) { if (w >= 0.5) found[n].replaced++; else found[n].corrected++; }
  }
  // The soft edge on a surface of one colour (each side within 3 px steady, as they are now): between the original
  // beyond it and the estimate within it, half and half — the old outline goes. Where artwork crosses it (a border, rays),
  // it stays as the estimate's rows have it: the old product's faint share of it does not show there, a blend would.
  const edged = Uint8Array.from(result), steadyOf = (sum: number[], sq: number[], k: number) => Math.max(...[0, 1, 2].map(c => Math.sqrt(Math.max(0, sq[c] / k - (sum[c] / k) ** 2)))) <= 6;
  for (let p = 0; p < W * H; p++) {
    if (!ring[p]) continue;
    const x = p % W, y = Math.floor(p / W), o = [0, 0, 0], oq = [0, 0, 0], e = [0, 0, 0], eq = [0, 0, 0]; let no = 0, ne = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      if (x + dx < 0 || x + dx >= W || y + dy < 0 || y + dy >= H) continue;
      const q = p + dy * W + dx, j = q * 3;
      if (est[q]) { for (let c = 0; c < 3; c++) { e[c] += result[j + c]; eq[c] += result[j + c] ** 2; } ne++; }
      else if (!area[q]) { for (let c = 0; c < 3; c++) { o[c] += result[j + c]; oq[c] += result[j + c] ** 2; } no++; }
    }
    if (no < 3 || ne < 3 || !steadyOf(o, oq, no) || !steadyOf(e, eq, ne)) continue;
    const i = p * 3;
    for (let c = 0; c < 3; c++) edged[i + c] = Math.round((o[c] / no + e[c] / ne) / 2);
  }
  result.set(edged);
  for (const f of found) f.kept = f.ghost === 0 && f.replaced === 0 && f.shadow === 0;
  let changed = 0;
  for (let i = 0; i < W * H; i++) if (result[i * 3] !== data[i * 3] || result[i * 3 + 1] !== data[i * 3 + 1] || result[i * 3 + 2] !== data[i * 3 + 2]) changed++;
  return { png: await sharp(Buffer.from(result), { raw: { width: W, height: H, channels: 3 } }).png().toBuffer(), filled: changed, report: { reference: reference ? 'original' : 'none', footprints: found } };
}
