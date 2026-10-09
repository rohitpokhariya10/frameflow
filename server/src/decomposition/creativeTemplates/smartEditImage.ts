/**
 * The one image call of a smart edit, made the way its strategy says (editStrategy), and the result at the source's own
 * size and aspect. The source is contained in the image model's canvas (edges mirrored outward) and the answer is mapped
 * back from where it sits there. Sent once, never retried automatically; the request (without image bytes), the response
 * (without image bytes), the model's own output, the mask it was given and the result are saved with the execution.
 *
 *   local       the mask lets the model paint only the changed regions; the result is the source with those regions
 *               blended in through a soft inner edge, so every pixel outside them is exactly the source's own
 *   background  the products that stay are protected in the mask and composed back as their own pixels (the creative
 *               variant method: ghost removal, contact shadows, exact preservation measured)
 *   global      the whole image is painted; only its size and aspect are kept
 */
import { createHash } from 'node:crypto';
import { toFile } from 'openai';
import sharp from 'sharp';
import { closestGenerationRatio, GENERATION_IMAGE_SIZES, type EditStrategy, type ExecutionImage, type SmartEditPreservation } from '@frameflow/shared';
import { imageFailureCode, imageFileType, responseWithoutImage, returnedImage, supportsProductReference, type ApiFailure, type GenerationConfig } from '../generationGroups.js';
import { RunError } from '../layerizeExperiment.js';
import { ImageEditError } from './imageEdit.js';
import { composeVariant, generationInputs, refineEdges, sourceRaster, type Raster, type VariantSubject } from './variantCompose.js';

export type SmartEditResult = {
  image: ExecutionImage; bytes: Buffer; generated: ExecutionImage; size: string; model: string; requestFile: string; responseFile: string; durationMs: number; requestId?: string;
  preservation: SmartEditPreservation;
};
type Save = (file: string, value: Buffer | object) => void;
const FILES = { request: 'edit.openai-request.json', response: 'edit.openai-response.json', error: 'edit.provider-error.json', input: 'edit-input.png', mask: 'edit-mask.png', generated: 'edit-generated.png', result: 'edited.png' };
const imageOf = (file: string, bytes: Buffer, width: number, height: number): ExecutionImage => ({ file, mimeType: 'image/png', width, height, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });

/** A region in source pixels (its edges on the image's own border stay there). */
const pixelBox = (box: { x: number; y: number; w: number; h: number }, width: number, height: number) => {
  const x0 = Math.max(0, Math.floor(box.x * width)), y0 = Math.max(0, Math.floor(box.y * height));
  return { x0, y0, x1: Math.min(width, Math.ceil((box.x + box.w) * width)), y1: Math.min(height, Math.ceil((box.y + box.h) * height)) };
};
/**
 * How much of the model's answer each pixel takes: 1 deep inside a region, easing to 0 at its edge over `feather` pixels
 * (an edge on the image border needs no easing), 0 everywhere outside. Overlapping regions take the larger value.
 */
export function regionAlpha(regions: { x: number; y: number; w: number; h: number }[], width: number, height: number, feather: number): Float32Array {
  const alpha = new Float32Array(width * height);
  for (const r of regions) {
    const b = pixelBox(r, width, height), far = Number.POSITIVE_INFINITY;
    for (let y = b.y0; y < b.y1; y++) for (let x = b.x0; x < b.x1; x++) {
      const d = Math.min(b.x0 === 0 ? far : x - b.x0 + 0.5, b.x1 === width ? far : b.x1 - x - 0.5, b.y0 === 0 ? far : y - b.y0 + 0.5, b.y1 === height ? far : b.y1 - y - 0.5);
      const a = Math.min(1, d / feather), i = y * width + x;
      if (a > alpha[i]) alpha[i] = a;
    }
  }
  return alpha;
}
/** The model's answer for the source's own area, at the source's own size. */
async function mappedBack(generated: Buffer, placement: { x: number; y: number; width: number; height: number }, width: number, height: number): Promise<Raster> {
  const { data } = await sharp(generated).removeAlpha().extract({ left: placement.x, top: placement.y, width: placement.width, height: placement.height })
    .resize(width, height, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer({ resolveWithObject: true });
  return { rgb: data, width, height };
}

export async function smartEditImage(config: GenerationConfig, input: { bytes: Buffer; file: string }, prompt: string, strategy: Pick<EditStrategy, 'kind' | 'regions'>, save: Save,
  options: { reference?: { bytes: Buffer; file: string }; subjects?: VariantSubject[] } = {}): Promise<SmartEditResult> {
  if (strategy.kind === 'none') throw new RunError('NO_CHANGES', 'Nothing changes: use the original image (no image request).');
  if (options.reference && !supportsProductReference(config.model)) throw new ImageEditError('INVALID_REQUEST', `The configured image model ${config.model} does not accept a product reference image.`, FILES.request, 0);
  if (strategy.kind === 'background' && !options.subjects?.length) throw new RunError('INVALID_REQUEST', 'A background restyle needs the cutouts of the products it keeps.');
  const source = await sourceRaster(input.bytes), { width: W, height: H } = source, n = W * H;
  const ratio = closestGenerationRatio(W, H), size = GENERATION_IMAGE_SIZES[ratio], sizeText = `${size.width}x${size.height}`;
  // What the model may paint (mask transparent) and what it is shown but must keep (opaque).
  let reference: Raster = source, keep: Uint8Array = new Uint8Array(n), subjects = options.subjects ?? [];
  if (strategy.kind === 'local') {
    keep.fill(255);
    for (const r of strategy.regions) { const b = pixelBox(r.box, W, H); for (let y = b.y0; y < b.y1; y++) keep.fill(0, y * W + b.x0, y * W + b.x1); }
  } else if (strategy.kind === 'background') {
    // Soft edges refined from their colours first (as variants do): no old background tints the kept products.
    const refined = refineEdges(source, subjects.map(x => x.mask));
    reference = refined.reference; keep = refined.union; subjects = subjects.map((x, k) => ({ ...x, mask: refined.masks[k] }));
  }
  const inputs = await generationInputs(reference, keep, size, { keepPadding: strategy.kind === 'local' });
  save(FILES.input, inputs.image); save(FILES.mask, inputs.mask);
  const request = { model: config.model, prompt, size: sizeText, n: 1, output_format: 'png' as const };
  const shown = strategy.kind === 'local' ? `<the creative contained in the canvas; the mask lets only ${strategy.regions.length} changed region${strategy.regions.length === 1 ? '' : 's'} be painted>`
    : strategy.kind === 'background' ? '<the creative contained in the canvas; the mask protects the products that stay>' : '<the creative contained in the canvas; the whole image may be painted>';
  save(FILES.request, { method: 'images.edit', ...request, strategy: strategy.kind, image: options.reference ? [shown, `<the product reference: ${options.reference.file}>`] : shown, mask: `<${FILES.mask}>` });
  const started = Date.now();
  let response: Awaited<ReturnType<ReturnType<GenerationConfig['client']>['images']['edit']>>;
  try {
    const creative = await toFile(inputs.image, 'creative.png', { type: 'image/png' });
    const image = options.reference ? [creative, await toFile(options.reference.bytes, options.reference.file, { type: imageFileType(options.reference.file) })] : creative;
    response = await config.client().images.edit({ ...request, image, mask: await toFile(inputs.mask, 'mask.png', { type: 'image/png' }) });
  } catch (error) {
    const api: ApiFailure = error instanceof RunError ? {} : error as ApiFailure;
    if (api.status !== undefined) save(FILES.error, { requestId: api.requestID ?? null, capturedAt: new Date().toISOString(), status: api.status, body: api.error ?? null });
    throw new ImageEditError(imageFailureCode(error), `The image edit failed: ${error instanceof Error ? error.message : String(error)}`, FILES.request, Date.now() - started);
  }
  const durationMs = Date.now() - started, requestId = (response as { _request_id?: string | null })._request_id ?? undefined;
  save(FILES.response, responseWithoutImage(response));
  const returned = await returnedImage(response.data?.[0]?.b64_json);
  // Another shape cannot be mapped back onto the source; the same shape at another size is brought to the canvas size.
  if (Math.abs(returned.width / returned.height - size.width / size.height) > 0.01) throw new ImageEditError('UNEXPECTED_SIZE', `The image model returned ${returned.width}×${returned.height}, not ${sizeText}; nothing was used.`, FILES.request, durationMs);
  const generatedPng = returned.width === size.width && returned.height === size.height ? await sharp(returned.bytes).png().toBuffer()
    : await sharp(returned.bytes).resize(size.width, size.height, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer();
  save(FILES.generated, generatedPng);
  const generated = imageOf(FILES.generated, generatedPng, size.width, size.height);
  // The result at the source's own size.
  let result: Buffer, preservation: SmartEditPreservation;
  if (strategy.kind === 'background') {
    const composed = await composeVariant(generatedPng, inputs.placement, reference, subjects), p = composed.preservation;
    if (!p.ok) throw new ImageEditError('PRESERVATION_FAILED', `The kept products' own pixels did not survive the composite (max difference ${p.maxDifference}; soft edges ${p.edgeMaxError}; outside the masks ${p.outsideAlphaPixels}). The result was not used.`, FILES.request, durationMs);
    result = await sharp(composed.composite).removeAlpha().png().toBuffer();
    preservation = { method: 'protected-products', unchangedPixels: p.checkedPixels, unchangedPercent: Math.round(1000 * p.checkedPixels / n) / 10, maxDifferenceOutside: p.maxDifference, products: p };
  } else {
    const mapped = await mappedBack(generatedPng, inputs.placement, W, H);
    if (strategy.kind === 'local') {
      const alpha = regionAlpha(strategy.regions.map(r => r.box), W, H, Math.max(2, Math.round(0.015 * Math.min(W, H)))), out = Buffer.alloc(n * 3);
      let unchanged = 0, maxOutside = 0;
      for (let i = 0; i < n; i++) {
        const a = alpha[i];
        for (let c = 0; c < 3; c++) out[i * 3 + c] = a === 0 ? source.rgb[i * 3 + c] : Math.round(source.rgb[i * 3 + c] * (1 - a) + mapped.rgb[i * 3 + c] * a);
        if (a === 0) { unchanged++; for (let c = 0; c < 3; c++) maxOutside = Math.max(maxOutside, Math.abs(out[i * 3 + c] - source.rgb[i * 3 + c])); }
      }
      result = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
      preservation = { method: 'outside-regions', unchangedPixels: unchanged, unchangedPercent: Math.round(1000 * unchanged / n) / 10, maxDifferenceOutside: maxOutside };
    } else {
      result = await sharp(mapped.rgb, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
      preservation = { method: 'none', unchangedPixels: 0, unchangedPercent: 0, maxDifferenceOutside: 0 };
    }
  }
  save(FILES.result, result);
  return { image: imageOf(FILES.result, result, W, H), bytes: result, generated, size: sizeText, model: config.model, requestFile: FILES.request, responseFile: FILES.response, durationMs, ...(requestId ? { requestId } : {}), preservation };
}
