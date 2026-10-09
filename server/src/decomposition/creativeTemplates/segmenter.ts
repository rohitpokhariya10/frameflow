/**
 * Masks for exact subject cutouts, from fal's mask-only providers (no pixels are generated): SAM-3 prompted with each
 * protected subject's label and box, or BiRefNet matting of the salient subject. A mask only says which source pixels
 * belong to the subject; the cutout itself is always the source's own pixels (variantCompose.ts). Every request is sent
 * once; a failure is reported, never retried, and the user may upload a cutout instead.
 *
 * Each target gets its own mask. SAM-3 answers up to three candidates per target: the one that matches the target's
 * region is taken (its score breaks ties), not merely the best-scored one, which may be another instance of the same
 * kind. BiRefNet mattes whatever is salient in the whole image: its matte is cut to the chosen products' regions and
 * split between them, so an object nobody chose is not kept just because it stands out.
 */
import sharp from 'sharp';
import { band, maskBox, splitMaskByBoxes, type PixelBox } from './variantCompose.js';
import { buildProviderInput, endpointRegistry, normalizeProviderOutput, ProviderError } from '../providers/adapters.js';
import type { FalTransport } from '../providers/falClient.js';
import { RunError } from '../layerizeExperiment.js';

export type SegmentTarget = { label: string; box: { x: number; y: number; width: number; height: number } };
export interface Segmenter {
  provider: 'sam3' | 'birefnet' | string;
  /**
   * One 8-bit mask of all targets (white = subject) at the image's size, each target's own mask (same order; optional:
   * without them the caller splits `mask` by the targets' regions), and the provider requests it took.
   */
  segment(input: { image: Buffer; width: number; height: number; targets: SegmentTarget[] }, save: (file: string, value: object) => void): Promise<{ mask: Buffer; masks?: Buffer[]; requestIds: string[] }>;
}
/** The side SAM-3 reads (its documented input bound is 4096); boxes are scaled with the image. */
const SEGMENT_SIDE = 2048;
export class SegmentationError extends RunError { constructor(message: string) { super('SEGMENTATION_FAILED', message); this.name = 'SegmentationError'; } }

async function request(transport: FalTransport, model: 'sam3' | 'birefnet', input: Record<string, unknown>, options: { sleep: (ms: number) => Promise<void>; pollMs: number; timeoutMs: number }) {
  const endpoint = endpointRegistry[model].endpoint, { requestId } = await transport.submit(endpoint, input), started = Date.now();
  for (;;) {
    const status = await transport.status(endpoint, requestId);
    if (status === 'COMPLETED') break;
    if (Date.now() - started > options.timeoutMs) throw new SegmentationError(`The ${model} request ${requestId} did not finish in ${Math.round(options.timeoutMs / 1000)} s.`);
    await options.sleep(options.pollMs);
  }
  return { requestId, output: normalizeProviderOutput(model, await transport.result(endpoint, requestId), 8) };
}
/** A provider mask as 8-bit luminance at a given size (white = subject). */
const luminance = (png: Buffer, width: number, height: number) => band(sharp(png).flatten({ background: '#000000' }).resize(width, height, { fit: 'fill' }).greyscale());
/** How well a candidate mask matches its target region: intersection over union of the mask's box and the target's. */
function boxMatch(mask: Uint8Array, width: number, height: number, target: PixelBox): number {
  const { box } = maskBox(mask, width, height);
  if (!box) return 0;
  const ix = Math.max(0, Math.min(box.x + box.width, target.x + target.width) - Math.max(box.x, target.x)), iy = Math.max(0, Math.min(box.y + box.height, target.y + target.height) - Math.max(box.y, target.y));
  const inter = ix * iy;
  return inter / Math.max(1, box.width * box.height + target.width * target.height - inter);
}

export function liveSegmenter(provider: 'sam3' | 'birefnet', transport: () => FalTransport, options: { sleep?: (ms: number) => Promise<void>; pollMs?: number; timeoutMs?: number } = {}): Segmenter {
  const timing = { sleep: options.sleep ?? ((ms: number) => new Promise<void>(done => setTimeout(done, ms))), pollMs: options.pollMs ?? 2000, timeoutMs: options.timeoutMs ?? 180_000 };
  return { provider, async segment(input, save) {
    const scale = Math.min(1, SEGMENT_SIDE / Math.max(input.width, input.height)), w = Math.max(1, Math.round(input.width * scale)), h = Math.max(1, Math.round(input.height * scale));
    const small = await sharp(input.image).rotate().resize(w, h, { fit: 'fill' }).png().toBuffer();
    const fal = transport(), requestIds: string[] = [], perTarget: Uint8Array[] = [];
    // Each target's region at the size the provider reads.
    const boxes = input.targets.map(t => { const x = Math.min(w - 1, Math.max(0, Math.round(t.box.x * scale))), y = Math.min(h - 1, Math.max(0, Math.round(t.box.y * scale)));
      return { x, y, width: Math.max(1, Math.min(w - x, Math.round(t.box.width * scale))), height: Math.max(1, Math.min(h - y, Math.round(t.box.height * scale))) }; });
    try {
      const imageUrl = await fal.upload(small, 'image/png');
      const targets = provider === 'birefnet' ? [undefined] : input.targets;
      for (const [n, target] of targets.entries()) {
        const providerInput = provider === 'birefnet' ? buildProviderInput('birefnet', { imageUrl, highResolutionMatte: true })
          : buildProviderInput('sam3', { imageUrl, width: w, height: h, prompt: target!.label.slice(0, 200) || 'the main subject', maxMasks: 3, boxes: [boxes[n]] });
        save(`segment-${n + 1}.fal-request.json`, { endpoint: endpointRegistry[provider].endpoint, input: { ...providerInput, image_url: '<uploaded source copy>' } });
        const { requestId, output } = await request(fal, provider, providerInput, timing);
        requestIds.push(requestId);
        const candidates = await Promise.all(output.images.map(async image => luminance(await fal.download(image.url), w, h)));
        if (provider === 'birefnet') {
          // The salient matte, kept only where the chosen products are, and split between them.
          perTarget.push(...splitMaskByBoxes(candidates[0], w, h, boxes));
          save(`segment-${n + 1}.fal-response.json`, { requestId, masks: output.images.length, scores: null, clippedTo: boxes.length });
          continue;
        }
        const ranks = candidates.map((mask, k) => boxMatch(mask, w, h, boxes[n]) * (output.scores?.[k] ?? 1));
        const best = ranks.some(r => r > 0) ? ranks.indexOf(Math.max(...ranks)) : output.scores?.length ? output.scores.indexOf(Math.max(...output.scores)) : 0;
        save(`segment-${n + 1}.fal-response.json`, { requestId, masks: output.images.length, scores: output.scores ?? null, chosen: best, regionMatch: candidates.map(m => Math.round(boxMatch(m, w, h, boxes[n]) * 1000) / 1000) });
        perTarget.push(candidates[best]);
      }
    } catch (error) {
      save('segment.error.json', { message: error instanceof Error ? error.message : String(error), code: (error as { code?: string }).code ?? null });
      if (error instanceof SegmentationError) throw error;
      throw new SegmentationError(`The ${provider} mask request failed: ${error instanceof ProviderError ? error.message : error instanceof Error ? error.message : String(error)}`);
    }
    const full = await Promise.all(perTarget.map(m => band(sharp(Buffer.from(m.buffer, m.byteOffset, m.byteLength), { raw: { width: w, height: h, channels: 1 } }).resize(input.width, input.height, { fit: 'fill', kernel: 'lanczos3' }))));
    const union = new Uint8Array(input.width * input.height);
    for (const m of full) for (let i = 0; i < union.length; i++) if (m[i] > union[i]) union[i] = m[i];
    const png = (m: Uint8Array) => sharp(Buffer.from(m.buffer, m.byteOffset, m.byteLength), { raw: { width: input.width, height: input.height, channels: 1 } }).png().toBuffer();
    return { mask: await png(union), masks: await Promise.all(full.map(png)), requestIds };
  } };
}
