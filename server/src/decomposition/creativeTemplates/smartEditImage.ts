/**
 * The image call(s) of a smart edit (Feature 2), made the way its strategy says (editStrategy), and the result at the
 * source's own size and aspect. The model's canvas has the source's OWN aspect ratio (editCanvasSize), so nothing is
 * padded and nothing is cropped when the answer is mapped back: a product cannot come out larger or cut at the edge
 * because the model composed across padding. Each call is sent once, never retried automatically; its request (without
 * image bytes), response (without image bytes), the model's own output, the mask it was given and the result are saved.
 *
 *   local       the mask lets the model paint only the changed regions (their slots); the result is the source with
 *               those regions blended in through a soft inner edge, so every pixel outside them is exactly the source's own
 *   background  the products that stay are protected in the mask and composed back as their own pixels (the creative
 *               variant method: ghost removal, contact shadows, exact preservation measured)
 *   layered     two calls: the background pass (every product kept as its own pixels, in place), then a local pass that
 *               repaints each changed object only inside its own slot of that image
 *   global      the whole image is painted (a new kind of product); only its size and aspect are kept
 */
import { createHash } from 'node:crypto';
import { toFile } from 'openai';
import sharp from 'sharp';
import { closestGenerationRatio, editCanvasSize, GENERATION_IMAGE_SIZES, type EditStrategy, type ExecutionImage, type SmartEditPreservation } from '@frameflow/shared';
import { imageFailureCode, imageFileType, responseWithoutImage, returnedImage, supportsProductReference, type ApiFailure, type GenerationConfig } from '../generationGroups.js';
import { RunError } from '../layerizeExperiment.js';
import { ImageEditError } from './imageEdit.js';
import { composeVariant, generationInputs, refineEdges, sourceRaster, type Raster, type VariantSubject } from './variantCompose.js';

export type SmartEditResult = {
  image: ExecutionImage; bytes: Buffer; generated: ExecutionImage; size: string; model: string; requestFile: string; responseFile: string; durationMs: number; requestId?: string;
  preservation: SmartEditPreservation;
  /** Image requests made (a layered edit makes two). */
  calls: number;
  /** Slots whose new content runs into the slot's own edge (it may be cut there): their labels. */
  edgeContact: string[];
};
type Save = (file: string, value: Buffer | object) => void;
const filesOf = (prefix: string) => ({ request: `${prefix}.openai-request.json`, response: `${prefix}.openai-response.json`, error: `${prefix}.provider-error.json`, input: `${prefix}-input.png`, mask: `${prefix}-mask.png`, generated: `${prefix}-generated.png` });
const FILES = { ...filesOf('edit'), result: 'edited.png' };
/** The model's canvas for an edit: the source's own ratio (SMART_EDIT_CANVAS=fixed restores the three fixed ratio sizes). */
export function editCanvas(width: number, height: number) {
  return process.env.SMART_EDIT_CANVAS === 'fixed' ? GENERATION_IMAGE_SIZES[closestGenerationRatio(width, height)] : editCanvasSize(width, height);
}
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

type Pass = { kind: 'local' | 'background' | 'global'; regions: EditStrategy['regions'] };
type PassResult = { bytes: Buffer; generated: ExecutionImage; size: string; durationMs: number; requestId?: string; preservation: SmartEditPreservation; edgeContact: string[] };
/** One image request on one image: the mask from the pass's kind, the answer mapped back and composed at the image's own size. */
async function editPass(config: GenerationConfig, bytes: Buffer, prompt: string, pass: Pass, save: Save, files: ReturnType<typeof filesOf>,
  options: { reference?: { bytes: Buffer; file: string }; subjects?: VariantSubject[]; note?: string }): Promise<PassResult> {
  const source = await sourceRaster(bytes), { width: W, height: H } = source, n = W * H;
  const size = editCanvas(W, H), sizeText = `${size.width}x${size.height}`;
  // What the model may paint (mask transparent) and what it is shown but must keep (opaque).
  let reference: Raster = source, keep: Uint8Array = new Uint8Array(n), subjects = options.subjects ?? [];
  if (pass.kind === 'local') {
    keep.fill(255);
    for (const r of pass.regions) { const b = pixelBox(r.box, W, H); for (let y = b.y0; y < b.y1; y++) keep.fill(0, y * W + b.x0, y * W + b.x1); }
  } else if (pass.kind === 'background') {
    // Soft edges refined from their colours first (as variants do): no old background tints the kept products.
    const refined = refineEdges(source, subjects.map(x => x.mask));
    reference = refined.reference; keep = refined.union; subjects = subjects.map((x, k) => ({ ...x, mask: refined.masks[k] }));
  }
  const inputs = await generationInputs(reference, keep, size, { keepPadding: pass.kind === 'local' });
  save(files.input, inputs.image); save(files.mask, inputs.mask);
  const request = { model: config.model, prompt, size: sizeText, n: 1, output_format: 'png' as const };
  const shown = pass.kind === 'local' ? `<the creative on its own-ratio canvas; the mask lets only ${pass.regions.length} changed slot${pass.regions.length === 1 ? '' : 's'} be painted>`
    : pass.kind === 'background' ? '<the creative on its own-ratio canvas; the mask protects every product, in place>' : '<the creative on its own-ratio canvas; the whole image may be painted>';
  save(files.request, { method: 'images.edit', ...request, strategy: pass.kind, ...(options.note ? { pass: options.note } : {}), image: options.reference ? [shown, `<the product reference: ${options.reference.file}>`] : shown, mask: `<${files.mask}>` });
  const started = Date.now();
  let response: Awaited<ReturnType<ReturnType<GenerationConfig['client']>['images']['edit']>>;
  try {
    const creative = await toFile(inputs.image, 'creative.png', { type: 'image/png' });
    const image = options.reference ? [creative, await toFile(options.reference.bytes, options.reference.file, { type: imageFileType(options.reference.file) })] : creative;
    response = await config.client().images.edit({ ...request, image, mask: await toFile(inputs.mask, 'mask.png', { type: 'image/png' }) });
  } catch (error) {
    const api: ApiFailure = error instanceof RunError ? {} : error as ApiFailure;
    if (api.status !== undefined) save(files.error, { requestId: api.requestID ?? null, capturedAt: new Date().toISOString(), status: api.status, body: api.error ?? null });
    throw new ImageEditError(imageFailureCode(error), `The image edit failed: ${error instanceof Error ? error.message : String(error)}`, files.request, Date.now() - started);
  }
  const durationMs = Date.now() - started, requestId = (response as { _request_id?: string | null })._request_id ?? undefined;
  save(files.response, responseWithoutImage(response));
  const returned = await returnedImage(response.data?.[0]?.b64_json);
  // Another shape cannot be mapped back onto the source; the same shape at another size is brought to the canvas size.
  if (Math.abs(returned.width / returned.height - size.width / size.height) > 0.01) throw new ImageEditError('UNEXPECTED_SIZE', `The image model returned ${returned.width}×${returned.height}, not ${sizeText}; nothing was used.`, files.request, durationMs);
  const generatedPng = returned.width === size.width && returned.height === size.height ? await sharp(returned.bytes).png().toBuffer()
    : await sharp(returned.bytes).resize(size.width, size.height, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer();
  save(files.generated, generatedPng);
  const generated = imageOf(files.generated, generatedPng, size.width, size.height);
  if (pass.kind === 'background') {
    const composed = await composeVariant(generatedPng, inputs.placement, reference, subjects), p = composed.preservation;
    if (!p.ok) throw new ImageEditError('PRESERVATION_FAILED', `The kept products' own pixels did not survive the composite (max difference ${p.maxDifference}; soft edges ${p.edgeMaxError}; outside the masks ${p.outsideAlphaPixels}). The result was not used.`, files.request, durationMs);
    return { bytes: await sharp(composed.composite).removeAlpha().png().toBuffer(), generated, size: sizeText, durationMs, ...(requestId ? { requestId } : {}), edgeContact: [],
      preservation: { method: 'protected-products', unchangedPixels: p.checkedPixels, unchangedPercent: Math.round(1000 * p.checkedPixels / n) / 10, maxDifferenceOutside: p.maxDifference, products: p } };
  }
  const mapped = await mappedBack(generatedPng, inputs.placement, W, H);
  if (pass.kind === 'global') return { bytes: await sharp(mapped.rgb, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer(), generated, size: sizeText, durationMs, ...(requestId ? { requestId } : {}), edgeContact: [],
    preservation: { method: 'none', unchangedPixels: 0, unchangedPercent: 0, maxDifferenceOutside: 0 } };
  const feather = Math.max(2, Math.round(0.015 * Math.min(W, H))), alpha = regionAlpha(pass.regions.map(r => r.box), W, H, feather), out = Buffer.alloc(n * 3);
  let unchanged = 0, maxOutside = 0;
  for (let i = 0; i < n; i++) {
    const a = alpha[i];
    for (let c = 0; c < 3; c++) out[i * 3 + c] = a === 0 ? source.rgb[i * 3 + c] : Math.round(source.rgb[i * 3 + c] * (1 - a) + mapped.rgb[i * 3 + c] * a);
    if (a === 0) { unchanged++; for (let c = 0; c < 3; c++) maxOutside = Math.max(maxOutside, Math.abs(out[i * 3 + c] - source.rgb[i * 3 + c])); }
  }
  return { bytes: await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer(), generated, size: sizeText, durationMs, ...(requestId ? { requestId } : {}),
    edgeContact: edgeContact(pass.regions, source, mapped, feather), preservation: { method: 'outside-regions', unchangedPixels: unchanged, unchangedPercent: Math.round(1000 * unchanged / n) / 10, maxDifferenceOutside: maxOutside } };
}
/**
 * Slots whose new content runs into the slot's own edge: along each inner edge of a region (not on the image border), the
 * model's answer and the image around it should agree, since the slot was grown around its object. A large difference
 * there means the new object (or its shadow) reaches the edge and is cut by the blend: a person should look at it.
 */
export function edgeContact(regions: EditStrategy['regions'], around: Raster, mapped: Raster, feather: number): string[] {
  const { width: W, height: H } = around, found: string[] = [];
  for (const r of regions) {
    const b = pixelBox(r.box, W, H), band = Math.max(2, feather);
    let sum = 0, count = 0;
    const take = (x: number, y: number) => { const i = (y * W + x) * 3; sum += (Math.abs(around.rgb[i] - mapped.rgb[i]) + Math.abs(around.rgb[i + 1] - mapped.rgb[i + 1]) + Math.abs(around.rgb[i + 2] - mapped.rgb[i + 2])) / 3; count++; };
    for (let x = b.x0; x < b.x1; x += 2) { if (b.y0 > 0) for (let y = b.y0; y < Math.min(b.y1, b.y0 + band); y++) take(x, y); if (b.y1 < H) for (let y = Math.max(b.y0, b.y1 - band); y < b.y1; y++) take(x, y); }
    for (let y = b.y0; y < b.y1; y += 2) { if (b.x0 > 0) for (let x = b.x0; x < Math.min(b.x1, b.x0 + band); x++) take(x, y); if (b.x1 < W) for (let x = Math.max(b.x0, b.x1 - band); x < b.x1; x++) take(x, y); }
    if (count && sum / count > 38 && !found.includes(r.label)) found.push(r.label);
  }
  return found;
}

export async function smartEditImage(config: GenerationConfig, input: { bytes: Buffer; file: string }, prompt: string | { background: string; objects: string }, strategy: Pick<EditStrategy, 'kind' | 'regions'>, save: Save,
  options: { reference?: { bytes: Buffer; file: string }; subjects?: VariantSubject[] } = {}): Promise<SmartEditResult> {
  if (strategy.kind === 'none') throw new RunError('NO_CHANGES', 'Nothing changes: use the original image (no image request).');
  if (options.reference && !supportsProductReference(config.model)) throw new ImageEditError('INVALID_REQUEST', `The configured image model ${config.model} does not accept a product reference image.`, FILES.request, 0);
  if ((strategy.kind === 'background' || strategy.kind === 'layered') && !options.subjects?.length) throw new RunError('INVALID_REQUEST', 'A background restyle needs the cutouts of the products it keeps.');
  const source = await sourceRaster(input.bytes), { width: W, height: H } = source;
  let final: PassResult, calls = 1, durationMs: number;
  if (strategy.kind === 'layered') {
    if (typeof prompt === 'string') throw new RunError('INVALID_REQUEST', 'A layered edit needs a prompt for each pass.');
    // 1. The background around every product, each kept as its own pixels in place (the template's arrangement is fixed here).
    const first = await editPass(config, input.bytes, prompt.background, { kind: 'background', regions: [] }, save, filesOf('edit-pass1'), { subjects: options.subjects, note: 'background, products kept in place' });
    save('edit-pass1.png', first.bytes);
    // 2. Each changed object repainted inside its own slot of that image; every other pixel stays the first pass's.
    final = await editPass(config, first.bytes, prompt.objects, { kind: 'local', regions: strategy.regions }, save, filesOf('edit'), { ...(options.reference ? { reference: options.reference } : {}), note: 'changed objects, each in its own slot' });
    calls = 2; durationMs = first.durationMs + final.durationMs;
    final = { ...final, preservation: { ...final.preservation, ...(first.preservation.products ? { products: first.preservation.products } : {}) } };
  } else {
    if (typeof prompt !== 'string') throw new RunError('INVALID_REQUEST', 'This edit takes one prompt.');
    final = await editPass(config, input.bytes, prompt, { kind: strategy.kind === 'background' ? 'background' : strategy.kind === 'local' ? 'local' : 'global', regions: strategy.regions }, save, filesOf('edit'), options);
    durationMs = final.durationMs;
  }
  save(FILES.result, final.bytes);
  return { image: imageOf(FILES.result, final.bytes, W, H), bytes: final.bytes, generated: final.generated, size: final.size, model: config.model, requestFile: FILES.request, responseFile: FILES.response, durationMs,
    ...(final.requestId ? { requestId: final.requestId } : {}), preservation: final.preservation, calls, edgeContact: final.edgeContact };
}
