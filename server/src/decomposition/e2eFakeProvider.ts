/**
 * Deterministic, geometry-based stand-ins for SAM 3.1 and BiRefNet, for browser/flow tests ONLY (never a live path).
 *
 * Fake SAM returns three candidates per request, deliberately ordered so index 0 is wrong:
 *   0: a tiny high-confidence patch, 1: the guided region (box, honoring positive/negative points), 2: the whole canvas.
 * Group member checks (request key "...-member-N") return sub-regions of the last guided box for that image; other
 * box-less requests (guided refinement) reuse that box, still honoring points.
 */
import sharp from 'sharp';
import { sha256 } from './phases/source.js';
import type { InferenceOutput, InferenceRequest } from './providers/inference.js';

type Rect = { x: number; y: number; width: number; height: number };
const lastBox = new Map<string, Rect>();

async function png(width: number, height: number, inside: (x: number, y: number) => boolean) {
  const data = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = inside(x, y) ? 255 : 0;
  return sharp(data, { raw: { width, height, channels: 1 } }).png().toBuffer();
}
const within = (r: Rect, x: number, y: number) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;

export async function fakeSam(request: InferenceRequest): Promise<InferenceOutput> {
  const t = request.transform!, W = t.modelWidth, H = t.modelHeight, key = sha256(request.image);
  const positives = request.points?.filter(p => p.label === 1) ?? [], negatives = request.points?.filter(p => p.label === 0) ?? [];
  const given = request.boxes?.[0];
  let region: Rect;
  if (given) { region = { x: given.x, y: given.y, width: given.width, height: given.height }; lastBox.set(key, region); }
  else if (lastBox.has(key) && /-member-\d+$/.test(request.key ?? '')) {
    // Member check: the first hint owns the larger left part of the last guided box, the second the lower right part.
    const b = lastBox.get(key)!, first = /-member-0$/.test(request.key ?? '');
    region = first ? { x: b.x + b.width * 0.05, y: b.y + b.height * 0.05, width: b.width * 0.6, height: b.height * 0.9 } : { x: b.x + b.width * 0.55, y: b.y + b.height * 0.4, width: b.width * 0.4, height: b.height * 0.3 };
  } else if (lastBox.has(key)) region = lastBox.get(key)!; // Guided refinement without a new box keeps the target region.
  else if (positives.length) {
    const xs = positives.map(p => p.x), ys = positives.map(p => p.y);
    region = { x: Math.min(...xs) - W * 0.1, y: Math.min(...ys) - H * 0.1, width: Math.max(...xs) - Math.min(...xs) + W * 0.2, height: Math.max(...ys) - Math.min(...ys) + H * 0.2 };
  } else region = { x: W * 0.25, y: H * 0.25, width: W * 0.5, height: H * 0.5 };
  const inset = { x: region.x + region.width * 0.02, y: region.y + region.height * 0.02, width: region.width * 0.96, height: region.height * 0.96 };
  const radius = Math.max(W, H) * 0.03;
  const near = (x: number, y: number, p: { x: number; y: number }) => (x - p.x) ** 2 + (y - p.y) ** 2 <= radius ** 2;
  // SAM-like guidance: positives add nearby pixels, negatives remove them.
  const guided = await png(W, H, (x, y) => (within(inset, x, y) || positives.some(p => near(x, y, p))) && !negatives.some(p => near(x, y, p)));
  const seed = positives[0] ?? { x: region.x + region.width / 2, y: region.y + region.height / 2 };
  const tiny = await png(W, H, (x, y) => Math.abs(x - seed.x) < W * 0.015 && Math.abs(y - seed.y) < H * 0.015);
  const full = await png(W, H, () => true);
  return Object.assign([tiny, guided, full], { scores: [0.97, 0.9, 0.55], requestId: `e2e-fake-sam-${Date.now()}` });
}

export async function fakeBiRefNet(request: InferenceRequest): Promise<InferenceOutput> {
  const t = request.transform!;
  // A fully opaque matte: any softening must come from the constrained boundary band, never from the fake.
  return Object.assign([await png(t.modelWidth, t.modelHeight, () => true)], { requestId: `e2e-fake-birefnet-${Date.now()}` });
}
