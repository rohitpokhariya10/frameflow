/**
 * Clean-background reconstruction for the recursive decomposition (recursiveDecomposition.ts): the scene as it would
 * look if the extracted foreground layers had never been there.
 *
 *   ORIGINAL image + final FOREGROUND UNION MASK (grown a little) + a short background-only instruction
 *     → ONE OpenAI image edit (images.edit with a mask, the image model in aiModels.ts)
 *     → composited back into the original only inside the feathered mask, at the canvas's own resolution
 *
 * Outside the mask every pixel is the original's, so repeated passes never degrade the background (no copy of a copy)
 * and a 4K source keeps its detail. The edit is never retried (maxRetries 0); when it fails, is unavailable or would need
 * a new paid call during a resume, the same mask is filled locally instead (fillMasked) and that is reported as a
 * fallback, never as clean.
 */
import OpenAI, { toFile } from 'openai';
import sharp from 'sharp';
import type { Canvas } from './layerizeArtifacts.js';
import { boxBlur, fillMasked } from './outerBackground.js';

/** Compact on purpose: the edit model gets the mask, the image and this. Products are never named (naming invites them back). */
export const CLEAN_BACKGROUND_PROMPT = 'Edit only the transparent area of the mask: remove everything there and reconstruct only the underlying background scene. Continue the surrounding gradient, wall, floor or table surface, lighting, environmental shadows and background patterns naturally, matching the original colors, lighting and perspective, and keep decorations that are part of the background. Leave everything outside the mask unchanged. Do not recreate the removed products or objects, and do not add any new product, person, text, logo or foreground subject.';

export type BackgroundReconstructionRequest = { image: Buffer; mask: Buffer; prompt: string; size: { width: number; height: number } };
export type BackgroundReconstructionResult = { image: Buffer; requestId?: string; response?: unknown };
/** model: named before the call, so a saved result can be matched to it (cache key). One call = one paid image edit. */
export type BackgroundReconstructor = { model: string; reconstruct: (request: BackgroundReconstructionRequest) => Promise<BackgroundReconstructionResult> };

type ImagesClient = Pick<OpenAI, 'images'>;
/** One image request can take minutes; it is billed once sent, so it is given time and never retried. */
const IMAGE_TIMEOUT_MS = 300_000;
/**
 * OpenAI images.edit with a mask (transparent = edit). `client` is created per call, so a missing key is a recorded
 * failure of that one step (and a fallback), never a broken server.
 */
export function createOpenAIBackgroundReconstructor(options: { apiKey?: string; model: string; client?: () => ImagesClient }): BackgroundReconstructor {
  return { model: options.model, reconstruct: async ({ image, mask, prompt, size }) => {
    if (!options.client && !options.apiKey?.trim()) throw new Error('Set OPENAI_API_KEY in server/.env.');
    if (!options.model) throw new Error('No OpenAI image model is configured (OPENAI_IMAGE_MODEL).');
    const client = options.client ? options.client() : new OpenAI({ apiKey: options.apiKey, maxRetries: 0, timeout: IMAGE_TIMEOUT_MS });
    const response = await client.images.edit({ model: options.model, prompt, size: `${size.width}x${size.height}`, n: 1, output_format: 'png',
      image: await toFile(image, 'source.png', { type: 'image/png' }), mask: await toFile(mask, 'mask.png', { type: 'image/png' }) });
    const encoded = response.data?.[0]?.b64_json;
    if (!encoded) throw new Error('OpenAI returned no image.');
    const requestId = (response as { _request_id?: string | null })._request_id ?? undefined;
    return { image: Buffer.from(encoded, 'base64'), ...(requestId ? { requestId } : {}),
      response: { ...response, data: (response.data ?? []).map(({ b64_json, ...rest }) => ({ ...rest, b64_json: b64_json ? `<${b64_json.length} base64 characters: clean-background-ai.png>` : undefined })) } };
  } };
}

/**
 * The edit's size for a canvas: both sides multiples of 16, aspect within 1:3–3:1 (else undefined: no edit is possible),
 * at most 2560 on the long side and 2560×1440 worth of pixels (larger is experimental), at least about 1 MP. The result
 * is resized back to the canvas and only used inside the mask, so this never changes the background's own resolution.
 */
export function reconstructionSize(canvas: Canvas): { width: number; height: number } | undefined {
  const aspect = canvas.width / canvas.height;
  if (aspect > 3 || aspect < 1 / 3) return undefined;
  const pixels = canvas.width * canvas.height, most = 2560 * 1440, least = 1024 * 1024;
  let scale = pixels > most ? Math.sqrt(most / pixels) : pixels < least ? Math.sqrt(least / pixels) : 1;
  scale = Math.min(scale, 2560 / Math.max(canvas.width, canvas.height));
  const step = (value: number) => Math.max(16, (scale > 1 ? Math.ceil : scale < 1 ? Math.floor : Math.round)(value * scale / 16) * 16);
  return { width: step(canvas.width), height: step(canvas.height) };
}

/** A one-channel map resized (linear for soft alpha, nearest for binary masks), whatever channel count sharp hands back. */
export async function resizeMap(map: Uint8Array, from: { width: number; height: number }, to: { width: number; height: number }, kernel: 'linear' | 'nearest' = 'linear'): Promise<Uint8Array> {
  if (from.width === to.width && from.height === to.height) return map;
  const { data, info } = await sharp(Buffer.from(map.buffer, map.byteOffset, map.byteLength), { raw: { width: from.width, height: from.height, channels: 1 } })
    .resize(to.width, to.height, { fit: 'fill', kernel }).raw().toBuffer({ resolveWithObject: true });
  if (info.channels === 1) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const out = new Uint8Array(to.width * to.height);
  for (let i = 0; i < out.length; i++) out[i] = data[i * info.channels];
  return out;
}

/** A grown 0/1 removal mask softened by `featherPx` (box blur), as 0–255 alpha. Pixels deeper than featherPx inside stay 255. */
export function featherMask(core: Uint8Array, w: number, h: number, featherPx: number): Uint8Array {
  const blurred = boxBlur(Float32Array.from(core), w, h, 1, Math.max(0, featherPx)), out = new Uint8Array(core.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(255 * Math.min(1, Math.max(0, blurred[i])));
  return out;
}

/** The edit inputs: the source at the request size, and a black mask that is transparent exactly where `core` (0/1) removes. */
export async function editInputs(source: Buffer, core: { map: Uint8Array; width: number; height: number }, size: { width: number; height: number }): Promise<{ image: Buffer; mask: Buffer }> {
  const image = await sharp(source).resize(size.width, size.height, { fit: 'fill' }).flatten({ background: '#ffffff' }).removeAlpha().png().toBuffer();
  const keep = new Uint8Array(core.map.length);
  for (let i = 0; i < keep.length; i++) keep[i] = core.map[i] ? 0 : 255;
  const alpha = await resizeMap(keep, core, size, 'nearest'), rgba = Buffer.alloc(size.width * size.height * 4);
  for (let i = 0; i < alpha.length; i++) rgba[i * 4 + 3] = alpha[i] > 127 ? 255 : 0;
  return { image, mask: await sharp(rgba, { raw: { width: size.width, height: size.height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer() };
}

/**
 * Canvas-size background: `base` (raw RGB at the canvas) where alpha is 0, `fill` (any image, resized to the canvas)
 * where it is 255, mixed in between. alpha is 0–255 on any grid with the canvas's aspect.
 */
export async function blendIntoCanvas(base: Buffer, fill: Buffer, alpha: { map: Uint8Array; width: number; height: number }, canvas: Canvas): Promise<Buffer> {
  const fillRgb = await sharp(fill).resize(canvas.width, canvas.height, { fit: 'fill' }).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer();
  const a = await resizeMap(alpha.map, alpha, canvas, 'linear'), out = Buffer.alloc(canvas.width * canvas.height * 3);
  for (let i = 0; i < a.length; i++) {
    const k = a[i] / 255;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = k === 0 ? base[i * 3 + c] : Math.round(base[i * 3 + c] * (1 - k) + fillRgb[i * 3 + c] * k);
  }
  return sharp(out, { raw: { width: canvas.width, height: canvas.height, channels: 3 } }).ensureAlpha().png().toBuffer();
}

/**
 * The deterministic fallback, and the residual images' fill: `core` (0/1 on the work grid) filled from the surrounding
 * pixels of `source` on that grid (fillMasked), blended into the full-resolution source inside `alpha`.
 */
export async function localFill(source: Buffer, core: { map: Uint8Array; width: number; height: number }, alpha: { map: Uint8Array; width: number; height: number }, canvas: Canvas): Promise<Buffer> {
  const sourceCanvas = await sharp(source).resize(canvas.width, canvas.height, { fit: 'fill' }).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer();
  if (!core.map.some(Boolean)) return sharp(sourceCanvas, { raw: { width: canvas.width, height: canvas.height, channels: 3 } }).ensureAlpha().png().toBuffer();
  const work = await sharp(source).resize(core.width, core.height, { fit: 'fill' }).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer();
  const { out } = fillMasked(Float32Array.from(work), core.map, core.width, core.height);
  const filled = await sharp(out, { raw: { width: core.width, height: core.height, channels: 3 } }).png().toBuffer();
  return blendIntoCanvas(sourceCanvas, filled, alpha, canvas);
}
