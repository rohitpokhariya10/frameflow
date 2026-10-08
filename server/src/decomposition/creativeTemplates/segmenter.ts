/**
 * Masks for exact subject cutouts, from fal's mask-only providers (no pixels are generated): SAM-3 prompted with each
 * protected subject's label and box, or BiRefNet matting of the salient subject. A mask only says which source pixels
 * belong to the subject; the cutout itself is always the source's own pixels (variantCompose.ts). Every request is sent
 * once; a failure is reported, never retried, and the user may upload a cutout instead.
 */
import sharp from 'sharp';
import { buildProviderInput, endpointRegistry, normalizeProviderOutput, ProviderError } from '../providers/adapters.js';
import type { FalTransport } from '../providers/falClient.js';
import { RunError } from '../layerizeExperiment.js';

export type SegmentTarget = { label: string; box: { x: number; y: number; width: number; height: number } };
export interface Segmenter {
  provider: 'sam3' | 'birefnet' | string;
  /** One 8-bit mask (white = subject) at the image's size, and the provider requests it took. */
  segment(input: { image: Buffer; width: number; height: number; targets: SegmentTarget[] }, save: (file: string, value: object) => void): Promise<{ mask: Buffer; requestIds: string[] }>;
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
const luminance = (png: Buffer, width: number, height: number) => sharp(png).flatten({ background: '#000000' }).resize(width, height, { fit: 'fill' }).greyscale().raw().toBuffer();

export function liveSegmenter(provider: 'sam3' | 'birefnet', transport: () => FalTransport, options: { sleep?: (ms: number) => Promise<void>; pollMs?: number; timeoutMs?: number } = {}): Segmenter {
  const timing = { sleep: options.sleep ?? ((ms: number) => new Promise<void>(done => setTimeout(done, ms))), pollMs: options.pollMs ?? 2000, timeoutMs: options.timeoutMs ?? 180_000 };
  return { provider, async segment(input, save) {
    const scale = Math.min(1, SEGMENT_SIDE / Math.max(input.width, input.height)), w = Math.max(1, Math.round(input.width * scale)), h = Math.max(1, Math.round(input.height * scale));
    const small = await sharp(input.image).rotate().resize(w, h, { fit: 'fill' }).png().toBuffer();
    const fal = transport(), requestIds: string[] = [], union = Buffer.alloc(w * h);
    try {
      const imageUrl = await fal.upload(small, 'image/png');
      const targets = provider === 'birefnet' ? [undefined] : input.targets;
      for (const [n, target] of targets.entries()) {
        const providerInput = provider === 'birefnet' ? buildProviderInput('birefnet', { imageUrl, highResolutionMatte: true })
          : buildProviderInput('sam3', { imageUrl, width: w, height: h, prompt: target!.label.slice(0, 200) || 'the main subject', maxMasks: 3,
            boxes: [{ x: Math.min(w - 1, Math.max(0, Math.round(target!.box.x * scale))), y: Math.min(h - 1, Math.max(0, Math.round(target!.box.y * scale))),
              width: Math.max(1, Math.min(w - Math.round(target!.box.x * scale), Math.round(target!.box.width * scale))), height: Math.max(1, Math.min(h - Math.round(target!.box.y * scale), Math.round(target!.box.height * scale))) }] });
        save(`segment-${n + 1}.fal-request.json`, { endpoint: endpointRegistry[provider].endpoint, input: { ...providerInput, image_url: '<uploaded source copy>' } });
        const { requestId, output } = await request(fal, provider, providerInput, timing);
        requestIds.push(requestId);
        save(`segment-${n + 1}.fal-response.json`, { requestId, masks: output.images.length, scores: output.scores ?? null });
        // The best-scored mask of each target (SAM-3 returns up to three); BiRefNet returns one.
        const best = output.scores?.length ? output.scores.indexOf(Math.max(...output.scores)) : 0;
        const mask = await luminance(await fal.download(output.images[best].url), w, h);
        for (let i = 0; i < union.length; i++) union[i] = Math.max(union[i], mask[i]);
      }
    } catch (error) {
      save('segment.error.json', { message: error instanceof Error ? error.message : String(error), code: (error as { code?: string }).code ?? null });
      if (error instanceof SegmentationError) throw error;
      throw new SegmentationError(`The ${provider} mask request failed: ${error instanceof ProviderError ? error.message : error instanceof Error ? error.message : String(error)}`);
    }
    const mask = await sharp(union, { raw: { width: w, height: h, channels: 1 } }).resize(input.width, input.height, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer();
    return { mask, requestIds };
  } };
}
