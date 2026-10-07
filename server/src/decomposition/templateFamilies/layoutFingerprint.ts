/**
 * A free, local layout fingerprint of an image: where its foreground regions are, ignoring colour. The background is
 * modelled from the border as a plane (flat colours and linear gradients), every pixel that departs from it is
 * foreground, and the foreground's connected regions give normalized boxes. A blue and a red version of one layout
 * give the same regions; a photographic background is reported as unreliable, so it can never decide a match alone.
 */
import sharp from 'sharp';
import { elementSimilarity, type LayoutFingerprint, type NormalizedBox, type StructuralSignature } from '@frameflow/shared';

const N = 64, CELLS = 8, MIN_AREA = 0.004, MAJOR = 0.01, UNEXPLAINED = 0.03;
const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));

/** Least squares plane c = a + b·x + d·y over the border pixels, per channel. */
function fitPlane(points: { x: number; y: number; v: number }[]): [number, number, number] {
  let n = 0, sx = 0, sy = 0, sv = 0, sxx = 0, syy = 0, sxy = 0, sxv = 0, syv = 0;
  for (const p of points) { n++; sx += p.x; sy += p.y; sv += p.v; sxx += p.x * p.x; syy += p.y * p.y; sxy += p.x * p.y; sxv += p.x * p.v; syv += p.y * p.v; }
  // Solve the 3×3 normal equations by Cramer's rule.
  const m = [[n, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]], r = [sv, sxv, syv];
  const det = (a: number[][]) => a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const d = det(m);
  if (Math.abs(d) < 1e-9) return [sv / Math.max(1, n), 0, 0];
  const col = (i: number) => m.map((row, k) => row.map((v, j) => j === i ? r[k] : v));
  return [det(col(0)) / d, det(col(1)) / d, det(col(2)) / d];
}

export async function layoutFingerprint(bytes: Buffer): Promise<LayoutFingerprint> {
  const meta = await sharp(bytes).rotate().metadata();
  const turned = (meta.orientation ?? 1) >= 5, width = (turned ? meta.height : meta.width) ?? 1, height = (turned ? meta.width : meta.height) ?? 1;
  const raw = await sharp(bytes).rotate().flatten({ background: '#ffffff' }).resize(N, N, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const px = (x: number, y: number, c: number) => raw[(y * N + x) * 3 + c];
  const border: { x: number; y: number }[] = [];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (x < 2 || y < 2 || x >= N - 2 || y >= N - 2) border.push({ x, y });
  const planes = [0, 1, 2].map(c => fitPlane(border.map(p => ({ x: p.x / N, y: p.y / N, v: px(p.x, p.y, c) }))));
  const model = (x: number, y: number, c: number) => planes[c][0] + planes[c][1] * (x / N) + planes[c][2] * (y / N);
  const diff = (x: number, y: number) => Math.max(...[0, 1, 2].map(c => Math.abs(px(x, y, c) - model(x, y, c))));
  const borderRms = Math.sqrt(border.reduce((s, p) => s + diff(p.x, p.y) ** 2, 0) / border.length);
  const threshold = Math.max(30, 3 * borderRms);
  const mask = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) mask[y * N + x] = diff(x, y) > threshold ? 1 : 0;
  // One-pixel dilation joins the letters of a text line into one region.
  const grown = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (!mask[y * N + x]) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < N && yy < N) grown[yy * N + xx] = 1; }
  }
  const seen = new Uint8Array(N * N), regions: LayoutFingerprint['regions'] = [];
  for (let start = 0; start < N * N; start++) {
    if (!grown[start] || seen[start]) continue;
    let minX = N, minY = N, maxX = -1, maxY = -1, count = 0;
    const stack = [start]; seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!, x = i % N, y = Math.floor(i / N);
      if (mask[i]) count++;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy, j = yy * N + xx;
        if (xx >= 0 && yy >= 0 && xx < N && yy < N && grown[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    const box = { x: minX / N, y: minY / N, width: (maxX - minX + 1) / N, height: (maxY - minY + 1) / N };
    if (box.width * box.height >= MIN_AREA && count > 2) regions.push({ box, area: count / (N * N) });
  }
  regions.sort((a, b) => b.area - a.area);
  const occupancy = Array.from({ length: CELLS * CELLS }, (_, i) => {
    const cx = i % CELLS, cy = Math.floor(i / CELLS), step = N / CELLS;
    let on = 0;
    for (let y = cy * step; y < (cy + 1) * step; y++) for (let x = cx * step; x < (cx + 1) * step; x++) on += mask[y * N + x];
    return Math.round((on / (step * step)) * 1000) / 1000;
  });
  const coverage = mask.reduce((s, v) => s + v, 0) / (N * N);
  // Reliable on flat colour and gradients; a textured or photographic border means the mask is a guess.
  const reliability = clamp(1 - (borderRms - 6) / 30) * (coverage > 0.6 ? 0.5 : 1);
  return { version: 1, aspect: Math.round((width / height) * 1000) / 1000, background: borderRms < 12 ? 'plain' : 'complex', reliability: Math.round(reliability * 1000) / 1000, coverage: Math.round(coverage * 1000) / 1000,
    regions: regions.slice(0, 12), occupancy };
}

/** Labels each region of an analyzed exemplar with the element its centre falls in (the smallest such element). */
export function labelRegions(fingerprint: LayoutFingerprint, signature: StructuralSignature): LayoutFingerprint {
  const inside = (b: NormalizedBox, x: number, y: number) => x >= b.x - 0.02 && x <= b.x + b.width + 0.02 && y >= b.y - 0.02 && y <= b.y + b.height + 0.02;
  return { ...fingerprint, regions: fingerprint.regions.map((r) => {
    const cx = r.box.x + r.box.width / 2, cy = r.box.y + r.box.height / 2;
    const element = signature.elements.filter(e => inside(e.box, cx, cy)).sort((a, b) => a.box.width * a.box.height - b.box.width * b.box.height)[0];
    return { box: r.box, area: r.area, ...(element ? { role: element.role, element: element.id } : {}) };
  }) };
}

/** The elements a labelled fingerprint shows as major regions: the ones a local comparison can confirm, or miss. */
export const visibleElements = (fingerprint: LayoutFingerprint) => new Set(fingerprint.regions.filter(r => r.area >= MAJOR && r.element).map(r => r.element!));

export interface FingerprintComparison { score: number; mapping: Record<number, number>; unexplained: number[]; regionScore: number; occupancy: number }
/** Similarity of two fingerprints, 0..1, capped by the weaker one's reliability (0.6 + 0.4 × reliability). */
export function compareFingerprints(a: LayoutFingerprint, b: LayoutFingerprint): FingerprintComparison {
  const majorA = a.regions.map((r, i) => ({ r, i })).filter(x => x.r.area >= MAJOR), majorB = b.regions.map((r, i) => ({ r, i })).filter(x => x.r.area >= MAJOR);
  const pairs = majorA.flatMap(x => majorB.map(y => ({ x, y, sim: elementSimilarity(x.r.box, y.r.box) }))).filter(p => p.sim >= 0.45).sort((p, q) => q.sim - p.sim);
  const mapping: Record<number, number> = {}, used = new Set<number>();
  let matched = 0;
  for (const p of pairs) { if (p.x.i in mapping || used.has(p.y.i)) continue; mapping[p.x.i] = p.y.i; used.add(p.y.i); matched += p.sim * (p.x.r.area + p.y.r.area); }
  const total = [...majorA, ...majorB].reduce((s, x) => s + x.r.area, 0);
  const regionScore = total ? matched / total : 1;
  const sumA = a.occupancy.reduce((s, v) => s + v, 0), sumB = b.occupancy.reduce((s, v) => s + v, 0);
  const occupancy = sumA + sumB ? 1 - a.occupancy.reduce((s, v, i) => s + Math.abs(v - b.occupancy[i]), 0) / (sumA + sumB) : 1;
  const aspect = Math.abs(Math.log(a.aspect / b.aspect)) > 0.25 ? 0.9 : 1, background = a.background === b.background ? 1 : 0.5;
  // Region geometry is the structure; occupancy also reflects each object's own shape (headphones vs a phone), so it weighs less.
  const raw = (0.7 * regionScore + 0.2 * occupancy + 0.1 * background) * aspect;
  const score = Math.min(raw, 0.6 + 0.4 * Math.min(a.reliability, b.reliability));
  const unexplained = b.regions.map((r, i) => ({ r, i })).filter(x => !used.has(x.i) && x.r.area >= UNEXPLAINED).map(x => x.i);
  return { score: Math.round(score * 10000) / 10000, mapping, unexplained, regionScore: Math.round(regionScore * 10000) / 10000, occupancy: Math.round(occupancy * 10000) / 10000 };
}

/**
 * The creative's structure from a local match: the exemplar's analyzed signature with each element moved to the
 * creative's matched regions. Elements the exemplar's regions never showed stay where the exemplar had them, and are
 * reported as unverified: a required one means the local match cannot be accepted on its own.
 */
export function signatureFromLocalMatch(exemplar: { signature: StructuralSignature; fingerprint: LayoutFingerprint }, creative: LayoutFingerprint, comparison: FingerprintComparison): { signature: StructuralSignature; unverified: string[] } {
  const unverified: string[] = [];
  const elements = exemplar.signature.elements.map((e) => {
    const regions = exemplar.fingerprint.regions.map((r, i) => ({ r, i })).filter(x => x.r.element === e.id);
    const mapped = regions.map(x => comparison.mapping[x.i]).filter((i): i is number => i !== undefined).map(i => creative.regions[i].box);
    if (!mapped.length) { unverified.push(e.id); return e; }
    const x0 = Math.min(...mapped.map(b => b.x)), y0 = Math.min(...mapped.map(b => b.y)), x1 = Math.max(...mapped.map(b => b.x + b.width)), y1 = Math.max(...mapped.map(b => b.y + b.height));
    return { ...e, box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } };
  });
  return { signature: { ...exemplar.signature, elements }, unverified };
}
