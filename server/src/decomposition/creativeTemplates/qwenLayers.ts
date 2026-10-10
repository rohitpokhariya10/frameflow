/**
 * Editor layers from Qwen-Image-Layered (fal-ai/qwen-image-layered), for a creative Seedream refused. The model returns
 * N full-canvas RGBA layers, back to front, at its own working size: the input stretched to about 640×640 pixels, each
 * side rounded to a multiple of 32 (an 819×1024 input comes back 576×704, a 1024×572 one 864×480). Measured on every
 * saved Qwen result: the layers line up with the input stretched to that size (per-axis scale, no crop, no padding),
 * never cropped or letterboxed. Every result is checked again here before it is used (qwenAlignment); one that does
 * not line up is refused, never placed by guesswork.
 *
 * What reaches the editor:
 *   - visible pixels are the creative's own, at its full size: each layer is un-composited from the source where it is
 *     seen (its colour is solved from the source and the layers under it), so the layers rebuild the creative;
 *   - only what no one can see in the creative (the background behind objects, the hidden parts of overlapped objects)
 *     comes from Qwen's generated pixels, scaled up from its working size, and is reported as AI-generated;
 *   - layers no one can see (a plate fully covered by an opaque one above) and near-empty haze layers are left out;
 *   - the lowest full-canvas opaque layer is the background; without one, the background is the creative with its
 *     objects filled locally (continueScenery).
 * Qwen names nothing and may group several objects into one layer or split one object: layers are named from the
 * creative's analysed objects they cover, when there is an analysis, and the grouping is reported as the model's.
 *
 * Seedream stays the provider of every extraction; this is only an alternative a person chooses after Seedream refused
 * the image. One request, sent once, never retried automatically.
 */
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { continueScenery, type PixelBox } from './variantCompose.js';
import type { VariantRunLayer } from './composedRun.js';
import { buildProviderInput, endpointRegistry, normalizeProviderOutput, ProviderError } from '../providers/adapters.js';
import type { FalTransport } from '../providers/falClient.js';

export class QwenLayersError extends Error {
  constructor(public readonly code: 'QWEN_LAYERS_UNALIGNED' | 'QWEN_LAYERS_EMPTY' | 'QWEN_LAYERS_INVALID' | 'QWEN_REQUEST_FAILED', message: string) { super(message); this.name = 'QwenLayersError'; }
}
export const QWEN_ENDPOINT = endpointRegistry.qwen.endpoint;
/** The side the image is uploaded at: Qwen works at about 640×640 whatever it is sent, and the whole frame is kept. */
const UPLOAD_SIDE = 1024;

/**
 * One Qwen-Image-Layered request for this image: uploaded at most 1024 px on its long side (whole frame, same aspect
 * ratio), safety checking on, a seed fixed by the image so the request is reproducible. Returns the layer PNGs as
 * returned, in order. The request and response (without URLs) are saved; the layers are the caller's to save.
 */
export async function requestQwenLayers(transport: FalTransport, image: Buffer, options: { caption: string; numLayers: number; save: (file: string, value: object) => void;
  /** Called once the request is accepted for processing (a sent request, whatever its outcome). */
  onSubmitted?: (requestId: string) => void;
  sleep?: (ms: number) => Promise<void>; pollMs?: number; timeoutMs?: number }): Promise<{ requestId: string; seed?: number; images: Buffer[] }> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(done => setTimeout(done, ms))), pollMs = options.pollMs ?? 2000, timeoutMs = options.timeoutMs ?? 300_000;
  const meta = await sharp(image).metadata(), scale = Math.min(1, UPLOAD_SIDE / Math.max(meta.width!, meta.height!));
  const size = { width: Math.max(1, Math.round(meta.width! * scale)), height: Math.max(1, Math.round(meta.height! * scale)) };
  const upload = scale < 1 ? await sharp(image).resize(size.width, size.height, { fit: 'fill' }).png().toBuffer() : image;
  const seed = parseInt(createHash('sha256').update(image).digest('hex').slice(0, 7), 16);
  try {
    const imageUrl = await transport.upload(upload, 'image/png');
    const input = buildProviderInput('qwen', { imageUrl, prompt: options.caption, numLayers: options.numLayers, seed });
    options.save('request.json', { endpoint: QWEN_ENDPOINT, input: { ...input, image_url: `<uploaded copy, ${size.width}x${size.height}>` } });
    const { requestId } = await transport.submit(QWEN_ENDPOINT, input), started = Date.now();
    options.onSubmitted?.(requestId);
    for (;;) {
      const status = await transport.status(QWEN_ENDPOINT, requestId);
      if (status === 'COMPLETED') break;
      if (Date.now() - started > timeoutMs) throw new QwenLayersError('QWEN_REQUEST_FAILED', `The Qwen request ${requestId} did not finish in ${Math.round(timeoutMs / 1000)} s.`);
      await sleep(pollMs);
    }
    const output = normalizeProviderOutput('qwen', await transport.result(QWEN_ENDPOINT, requestId), 6);
    const images = await Promise.all(output.images.map(i => transport.download(i.url)));
    options.save('response.json', { requestId, seed: output.seed ?? seed, layers: output.images.map(i => ({ width: i.width ?? null, height: i.height ?? null, contentType: i.contentType ?? null })) });
    return { requestId, seed: output.seed ?? seed, images };
  } catch (error) {
    const detail = error instanceof ProviderError ? error.providerDetail : undefined;
    options.save('error.json', { message: error instanceof Error ? error.message : String(error), code: (error as { code?: string }).code ?? null, ...(detail ? { provider: detail } : {}) });
    if (error instanceof QwenLayersError) throw error;
    const said = detail?.messages[0]?.msg;
    throw new QwenLayersError('QWEN_REQUEST_FAILED', `The Qwen request failed${detail ? ` (HTTP ${detail.status}${detail.billableUnits ? `, billed ${detail.billableUnits} units` : ''})` : ''}: ${said ?? (error instanceof Error ? error.message : String(error))}`);
  }
}
export type QwenLayerLabel = { label: string; box: PixelBox };
export type QwenAlignment = {
  providerWidth: number; providerHeight: number;
  /** Mean absolute RGB error (0–255) of the layers' composite against the source mapped each way. */
  errors: { stretch: number; cover: number; contain: number };
  mapping: 'stretch'; order: 'as-returned' | 'reversed'; ok: boolean; reason?: string;
};
export type QwenLayersReport = {
  version: 1; returned: number; kept: number; dropped: { index: number; reason: 'hidden' | 'empty' }[];
  alignment: QwenAlignment; background: 'qwen' | 'local-fill';
  /** Share of the canvas whose background pixels are AI-generated (hidden behind objects in the creative). */
  aiFilledBackgroundPercent: number;
  /** How exactly the editor layers rebuild the creative (mean / max absolute RGB error, 0–255). */
  reconstruction: { mae: number; max: number; over24Percent: number };
  layers: { file: string; sourceIndex: number; name: string; box: PixelBox; aiPercent: number; labels: string[] }[];
};

/** Above this composite error the layers do not show the creative (a re-composed or wrong result): refused. */
const MAX_ALIGNMENT_ERROR = 14;
/** Layers seen on less than this share of the canvas are left out (hidden plates, empty haze). */
const MIN_VISIBLE_SHARE = 0.0005;
/** Alpha below this (of 255) is Qwen's haze, not content: measured on its saved layers, nearly all of it is 1–3. */
const HAZE_ALPHA = 4;
/** A layer this opaque over the canvas is a background plate. */
const FULL_CANVAS_SHARE = 0.95;

type Rgba = { data: Buffer; width: number; height: number };
async function rgbaAt(png: Buffer, width?: number, height?: number): Promise<Rgba> {
  let pipeline = sharp(png).ensureAlpha();
  if (width && height) pipeline = pipeline.resize(width, height, { fit: 'fill', kernel: 'lanczos3' });
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
const ramp = (x: number, from: number) => x <= from ? 0 : x >= 1 ? 1 : (x - from) / (1 - from);

/** The layers composited over black at their own size, in this order. */
function compose(layers: Rgba[], order: number[]): Float32Array {
  const { width, height } = layers[0], out = new Float32Array(width * height * 3);
  for (const k of order) { const d = layers[k].data; for (let p = 0; p < width * height; p++) { const a = d[p * 4 + 3] / 255; if (!a) continue; for (let c = 0; c < 3; c++) out[p * 3 + c] = d[p * 4 + c] * a + out[p * 3 + c] * (1 - a); } }
  return out;
}
/** Mean absolute error of a composite (w×h) against the source sampled at x = sx·(u+½)+tx, y = sy·(v+½)+ty (bilinear), where that lands inside. */
function mappedError(comp: Float32Array, w: number, h: number, src: Rgba, sx: number, sy: number, tx: number, ty: number): number {
  let sum = 0, n = 0;
  const at = (x: number, y: number, c: number) => src.data[(y * src.width + x) * 4 + c];
  for (let v = 0; v < h; v += 2) for (let u = 0; u < w; u += 2) {
    const x = sx * (u + 0.5) + tx - 0.5, y = sy * (v + 0.5) + ty - 0.5;
    if (x < -0.5 || y < -0.5 || x > src.width - 0.5 || y > src.height - 0.5) continue;
    const fx = Math.min(Math.max(x, 0), src.width - 1), fy = Math.min(Math.max(y, 0), src.height - 1), x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, src.width - 1), y1 = Math.min(y0 + 1, src.height - 1), ax = fx - x0, ay = fy - y0;
    for (let c = 0; c < 3; c++) sum += Math.abs(comp[(v * w + u) * 3 + c] - ((at(x0, y0, c) * (1 - ax) + at(x1, y0, c) * ax) * (1 - ay) + (at(x0, y1, c) * (1 - ax) + at(x1, y1, c) * ax) * ay));
    n += 3;
  }
  return n ? sum / n : Infinity;
}

/**
 * Whether Qwen's layers line up with the source stretched to their size (and in which order they stack), measured on
 * their composite: the stretch must explain the image at least as well as a centre crop or a letterbox, and closely.
 */
export async function qwenAlignment(source: Buffer, outputs: Buffer[]): Promise<QwenAlignment> {
  const layers = await Promise.all(outputs.map(png => rgbaAt(png)));
  const { width: w, height: h } = layers[0];
  if (layers.some(l => l.width !== w || l.height !== h)) throw new QwenLayersError('QWEN_LAYERS_INVALID', 'Qwen returned layers of different sizes; they cannot be stacked.');
  const src = await rgbaAt(source), W = src.width, H = src.height;
  const forward = layers.map((_, i) => i), compForward = compose(layers, forward), compReverse = compose(layers, [...forward].reverse());
  const stretch = (comp: Float32Array) => mappedError(comp, w, h, src, W / w, H / h, 0, 0);
  const [errForward, errReverse] = [stretch(compForward), stretch(compReverse)];
  const order = errReverse < errForward * 0.8 ? 'reversed' as const : 'as-returned' as const, comp = order === 'reversed' ? compReverse : compForward;
  const cover = Math.min(W / w, H / h), contain = Math.max(W / w, H / h);
  const errors = { stretch: Math.min(errForward, errReverse), cover: mappedError(comp, w, h, src, cover, cover, (W - cover * w) / 2, (H - cover * h) / 2),
    contain: mappedError(comp, w, h, src, contain, contain, (W - contain * w) / 2, (H - contain * h) / 2) };
  const round = (x: number) => Math.round(x * 100) / 100, rounded = { stretch: round(errors.stretch), cover: round(errors.cover), contain: round(errors.contain) };
  // When the source already has the working size's aspect ratio, all three mappings are the same one.
  const sameAspect = Math.abs(W / H - w / h) / (w / h) < 0.005;
  const reason = errors.stretch > MAX_ALIGNMENT_ERROR ? `Qwen's layers do not show this creative closely enough (mean error ${rounded.stretch}/255 > ${MAX_ALIGNMENT_ERROR}).`
    : !sameAspect && errors.stretch > Math.min(errors.cover, errors.contain) ? `Qwen's layers line up better with a crop or a letterbox of the creative than with the stretch it is known to use (${rounded.stretch} vs ${round(Math.min(errors.cover, errors.contain))}): not placed by guesswork.`
    : undefined;
  return { providerWidth: w, providerHeight: h, errors: rounded, mapping: 'stretch', order, ok: !reason, ...(reason ? { reason } : {}) };
}

/** Grows a 0/1 mask by r pixels (square). */
function dilate(mask: Uint8Array, width: number, height: number, r: number): Uint8Array {
  if (r < 1) return mask;
  const tmp = new Uint8Array(mask.length), out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) { let last = -1e9; for (let x = 0; x < width; x++) { if (mask[y * width + x]) last = x; if (x - last <= r) tmp[y * width + x] = 1; } last = 1e9; for (let x = width - 1; x >= 0; x--) { if (mask[y * width + x]) last = x; if (last - x <= r) tmp[y * width + x] = 1; } }
  for (let x = 0; x < width; x++) { let last = -1e9; for (let y = 0; y < height; y++) { if (tmp[y * width + x]) last = y; if (y - last <= r) out[y * width + x] = 1; } last = 1e9; for (let y = height - 1; y >= 0; y--) { if (tmp[y * width + x]) last = y; if (last - y <= r) out[y * width + x] = 1; } }
  return out;
}
function alphaBox(alpha: Float32Array, width: number, height: number, threshold: number): PixelBox | undefined {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (alpha[y * width + x] > threshold) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? undefined : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/**
 * The editor layers of a Qwen result on the source's own canvas, back to front (the background first), and what was
 * done to make them. `labels`: the creative's analysed objects (source pixels), to name the layers that cover them.
 */
export async function qwenEditorLayers(source: Buffer, outputs: Buffer[], options: { labels?: QwenLayerLabel[] } = {}): Promise<{ layers: VariantRunLayer[]; report: QwenLayersReport }> {
  if (!outputs.length) throw new QwenLayersError('QWEN_LAYERS_EMPTY', 'Qwen returned no layers.');
  const alignment = await qwenAlignment(source, outputs);
  if (!alignment.ok) throw new QwenLayersError('QWEN_LAYERS_UNALIGNED', `${alignment.reason} The creative is kept; no layers were made.`);
  const src = await rgbaAt(source), W = src.width, H = src.height, n = W * H;
  const order = outputs.map((_, i) => i);
  if (alignment.order === 'reversed') order.reverse();
  // Each layer on the source canvas: the stretch back, the one mapping its working size was made with.
  const up = await Promise.all(order.map(i => rgbaAt(outputs[i], W, H)));
  // Qwen leaves a faint haze (alpha 1–3 of 255) over much of most layers: it is nothing, and is cleared.
  const alpha = up.map(l => { const a = new Float32Array(n); for (let p = 0; p < n; p++) { const v = l.data[p * 4 + 3]; a[p] = v < HAZE_ALPHA ? 0 : v / 255; } return a; });
  const opaqueShare = (k: number) => { let c = 0; for (let p = 0; p < n; p++) if (alpha[k][p] >= 0.98) c++; return c / n; };
  // The background: the topmost layer that covers (nearly) the whole canvas, with every plate under it flattened into
  // it (a dark plate under a full scene is part of no object). Without one, the objects are filled locally.
  let top = -1; for (let k = up.length - 1; k >= 0 && top < 0; k--) if (opaqueShare(k) >= FULL_CANVAS_SHARE) top = k;
  const dropped: QwenLayersReport['dropped'] = [], fore: number[] = [];
  for (let k = 0; k < top; k++) dropped.push({ index: order[k], reason: 'hidden' });
  // What is seen of each layer above it: its alpha times what the layers above leave uncovered.
  {
    const open = new Float32Array(n).fill(1), seen = new Array(up.length).fill(0), solid = new Array(up.length).fill(0);
    for (let k = up.length - 1; k > top; k--) for (let p = 0; p < n; p++) { const a = alpha[k][p]; if (a * open[p] >= 0.5) seen[k]++; if (a >= 0.5) solid[k]++; open[p] *= 1 - a; }
    for (let k = top + 1; k < up.length; k++) {
      if (solid[k] < MIN_VISIBLE_SHARE * n) dropped.push({ index: order[k], reason: 'empty' });
      else if (seen[k] < MIN_VISIBLE_SHARE * n) dropped.push({ index: order[k], reason: 'hidden' });
      else fore.push(k);
    }
  }
  if (top < 0 && !fore.length) throw new QwenLayersError('QWEN_LAYERS_EMPTY', 'None of Qwen\'s layers shows anything of the creative.');
  const qwenBase = top >= 0, keep = qwenBase ? [top, ...fore] : fore;
  if (qwenBase && top > 0) {
    // The plates under the background, flattened into it with Qwen's own pixels.
    const d = up[top].data;
    for (let p = 0; p < n; p++) {
      const a = alpha[top][p]; if (a >= 1) continue;
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < top; k++) { const ak = alpha[k][p], s = up[k].data; r = s[p * 4] * ak + r * (1 - ak); g = s[p * 4 + 1] * ak + g * (1 - ak); b = s[p * 4 + 2] * ak + b * (1 - ak); }
      d[p * 4] = Math.round(d[p * 4] * a + r * (1 - a)); d[p * 4 + 1] = Math.round(d[p * 4 + 1] * a + g * (1 - a)); d[p * 4 + 2] = Math.round(d[p * 4 + 2] * a + b * (1 - a));
      alpha[top][p] = 1;
    }
  }
  // Uncovered above each layer (k → product over the kept layers above it of 1 − alpha).
  const openAbove = new Map<number, Float32Array>();
  { const open = new Float32Array(n).fill(1); for (let j = keep.length - 1; j >= 0; j--) { openAbove.set(keep[j], Float32Array.from(open)); for (let p = 0; p < n; p++) open[p] *= 1 - alpha[keep[j]][p]; } }
  // Pixels whose source colour may hold a foreground object (any foreground alpha, grown by the upscale): the base takes
  // Qwen's own pixels there, so a moved object leaves no ghost of itself behind.
  const scale = Math.max(W / alignment.providerWidth, H / alignment.providerHeight);
  const touched = new Uint8Array(n); for (const k of fore) for (let p = 0; p < n; p++) if (alpha[k][p] > 0.02) touched[p] = 1;
  const nearObject = dilate(touched, W, H, Math.ceil(scale) + 1);
  const S = src.data, comp = new Float32Array(n * 3);
  // The background.
  let baseRgb: Float32Array, aiBase = 0;
  if (qwenBase) {
    const q = up[keep[0]].data, open = openAbove.get(keep[0])!;
    // Qwen's colours matched to the creative's on what both show (one offset per channel).
    const offset = [0, 0, 0]; let m = 0;
    for (let p = 0; p < n; p++) if (!nearObject[p] && open[p] > 0.99) { for (let c = 0; c < 3; c++) offset[c] += S[p * 4 + c] - q[p * 4 + c]; m++; }
    if (m) for (let c = 0; c < 3; c++) offset[c] /= m;
    baseRgb = new Float32Array(n * 3);
    for (let p = 0; p < n; p++) {
      const w = nearObject[p] ? 0 : ramp(open[p], 0.9);
      if (open[p] < 0.5) aiBase++;
      for (let c = 0; c < 3; c++) baseRgb[p * 3 + c] = w * S[p * 4 + c] + (1 - w) * Math.max(0, Math.min(255, q[p * 4 + c] + offset[c]));
    }
  } else {
    const hole = new Uint8Array(n), rgb = Buffer.alloc(n * 3);
    for (let p = 0; p < n; p++) { hole[p] = nearObject[p]; for (let c = 0; c < 3; c++) rgb[p * 3 + c] = S[p * 4 + c]; }
    baseRgb = Float32Array.from(continueScenery(rgb, hole, W, H));
    for (let p = 0; p < n; p++) if (hole[p]) aiBase++;
  }
  comp.set(baseRgb);
  const out: { k: number; rgba: Buffer; ai: number }[] = [];
  // Each foreground layer, bottom up: where it is seen, its colour solved from the creative and what lies under it;
  // where it is hidden, Qwen's own pixels.
  for (const k of fore) {
    const a = alpha[k], q = up[k].data, open = openAbove.get(k)!, rgba = Buffer.alloc(n * 4);
    let ai = 0, area = 0;
    for (let p = 0; p < n; p++) {
      const ap = a[p]; if (!ap) continue;
      const w = ap >= 0.25 ? ramp(open[p], 0.9) : 0;
      if (ap >= 0.5) { area++; if (w < 0.5) ai++; }
      for (let c = 0; c < 3; c++) {
        const solved = w > 0 ? Math.max(0, Math.min(255, (S[p * 4 + c] - (1 - ap) * comp[p * 3 + c]) / ap)) : 0;
        const value = w * solved + (1 - w) * q[p * 4 + c];
        rgba[p * 4 + c] = Math.round(value);
        comp[p * 3 + c] = ap * value + (1 - ap) * comp[p * 3 + c];
      }
      rgba[p * 4 + 3] = Math.round(ap * 255);
    }
    out.push({ k, rgba, ai: area ? ai / area : 0 });
  }
  let sum = 0, max = 0, big = 0;
  for (let p = 0; p < n; p++) for (let c = 0; c < 3; c++) { const e = Math.abs(comp[p * 3 + c] - S[p * 4 + c]); sum += e; if (e > max) max = e; if (e > 24) big++; }
  // Names from the analysed objects each layer covers (most of their box), else a plain number.
  const labels = options.labels ?? [], owner = new Map<number, string[]>();
  for (const label of labels) {
    let best = -1, bestShare = 0.3;
    const b = { x: Math.max(0, Math.round(label.box.x)), y: Math.max(0, Math.round(label.box.y)), x1: Math.min(W, Math.round(label.box.x + label.box.width)), y1: Math.min(H, Math.round(label.box.y + label.box.height)) };
    const boxArea = Math.max(1, (b.x1 - b.x) * (b.y1 - b.y));
    for (const { k } of out) { let c = 0; for (let y = b.y; y < b.y1; y++) for (let x = b.x; x < b.x1; x++) if (alpha[k][y * W + x] >= 0.5) c++; if (c / boxArea > bestShare) { bestShare = c / boxArea; best = k; } }
    if (best >= 0) owner.set(best, [...(owner.get(best) ?? []), label.label]);
  }
  const layers: VariantRunLayer[] = [], reportLayers: QwenLayersReport['layers'] = [];
  const percent = (x: number) => Math.round(x * 1000) / 10;
  const baseName = qwenBase ? `Background (Qwen; ${percent(aiBase / n)}% hidden behind objects is AI-generated)` : 'Background (objects filled locally)';
  const basePng = await sharp(Buffer.from(Uint8Array.from(baseRgb, v => Math.round(v))), { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  layers.push({ file: 'layer-1-background.png', name: baseName, description: qwenBase ? 'Qwen-Image-Layered background: the creative\'s own pixels where they are seen; behind the objects, Qwen\'s generated scenery' : 'The creative with its objects filled locally (no layer of Qwen\'s covered the whole canvas)',
    png: basePng, kind: 'full-canvas', placement: { x: 0, y: 0, width: W, height: H }, semantic: { id: 'background', type: 'background' } });
  reportLayers.push({ file: 'layer-1-background.png', sourceIndex: qwenBase ? order[keep[0]] : -1, name: baseName, box: { x: 0, y: 0, width: W, height: H }, aiPercent: percent(aiBase / n), labels: [] });
  for (const [i, { k, rgba, ai }] of out.entries()) {
    const box = alphaBox(alpha[k], W, H, 0)!, crop = Buffer.alloc(box.width * box.height * 4);
    for (let y = 0; y < box.height; y++) rgba.copy(crop, y * box.width * 4, ((box.y + y) * W + box.x) * 4, ((box.y + y) * W + box.x + box.width) * 4);
    const names = owner.get(k) ?? [], file = `layer-${i + 2}-qwen-${order[k]}.png`;
    const name = names.length ? `${names.slice(0, 3).join(' + ')}${names.length > 3 ? ` + ${names.length - 3} more` : ''}` : `Layer ${i + 1}`;
    layers.push({ file, name, description: `Qwen-Image-Layered layer ${order[k]}: the creative's own pixels where it is seen${ai > 0.005 ? `; ${percent(ai)}% of it was hidden and is AI-generated` : ''}. Grouping chosen by the model.`,
      png: await sharp(crop, { raw: { width: box.width, height: box.height, channels: 4 } }).png().toBuffer(), kind: 'bbox-crop', placement: box, semantic: { id: `qwen_${order[k]}`, type: 'object' } });
    reportLayers.push({ file, sourceIndex: order[k], name, box, aiPercent: percent(ai), labels: names });
  }
  return { layers, report: { version: 1, returned: outputs.length, kept: layers.length, dropped, alignment, background: qwenBase ? 'qwen' : 'local-fill', aiFilledBackgroundPercent: percent(aiBase / n),
    reconstruction: { mae: Math.round(sum / (n * 3) * 100) / 100, max: Math.round(max), over24Percent: Math.round(big / (n * 3) * 10000) / 100 }, layers: reportLayers } };
}
