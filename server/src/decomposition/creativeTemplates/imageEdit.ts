/**
 * The one image call a REUSE_TEMPLATE_WITH_EDIT execution makes: an OpenAI image edit of the uploaded creative with the
 * template's saved edit prompt and the user's change filled in (compiled locally, no prompt-writing call). Sent once,
 * never retried automatically; the request (without image bytes), the response (without image bytes) and the edited
 * image are saved with the execution, and a failure saves the provider's error body.
 */
import { toFile } from 'openai';
import { closestGenerationRatio, GENERATION_IMAGE_SIZES, type ExecutionImage } from '@frameflow/shared';
import { imageFailureCode, imageFileType, responseWithoutImage, returnedImage, supportsProductReference, type ApiFailure, type GenerationConfig } from '../generationGroups.js';
import { RunError } from '../layerizeExperiment.js';

export type ImageEditResult = { image: ExecutionImage; bytes: Buffer; size: string; model: string; requestFile: string; responseFile: string; durationMs: number; requestId?: string };
export class ImageEditError extends RunError {
  constructor(code: string, message: string, public readonly requestFile: string, public readonly durationMs: number) { super(code, message); this.name = 'ImageEditError'; }
}

export async function editTemplateImage(config: GenerationConfig, input: { bytes: Buffer; file: string; width: number; height: number }, prompt: string,
  save: (file: string, value: Buffer | object) => void, reference?: { bytes: Buffer; file: string }): Promise<ImageEditResult> {
  if (reference && !supportsProductReference(config.model)) throw new ImageEditError('INVALID_REQUEST', `The configured image model ${config.model} does not accept a product reference image.`, 'edit.openai-request.json', 0);
  const ratio = closestGenerationRatio(input.width, input.height), { width, height } = GENERATION_IMAGE_SIZES[ratio], size = `${width}x${height}`;
  const files = { request: 'edit.openai-request.json', response: 'edit.openai-response.json', error: 'edit.provider-error.json' };
  const request = { model: config.model, prompt, size, n: 1, output_format: 'png' as const };
  save(files.request, { method: 'images.edit', ...request, image: reference ? [`<the creative to edit: ${input.file}>`, `<the product reference: ${reference.file}>`] : `<the uploaded creative: ${input.file}>` });
  const started = Date.now();
  try {
    const creative = await toFile(input.bytes, input.file, { type: imageFileType(input.file) });
    const image = reference ? [creative, await toFile(reference.bytes, reference.file, { type: imageFileType(reference.file) })] : creative;
    const response = await config.client().images.edit({ ...request, image });
    save(files.response, responseWithoutImage(response));
    const result = await returnedImage(response.data?.[0]?.b64_json), file = `edited.${result.format}`;
    save(file, result.bytes);
    return { image: { file, mimeType: `image/${result.format === 'jpg' ? 'jpeg' : result.format}`, width: result.width, height: result.height, bytes: result.bytes.length, sha256: result.sha256 }, bytes: result.bytes,
      size, model: config.model, requestFile: files.request, responseFile: files.response, durationMs: Date.now() - started, ...((response as { _request_id?: string | null })._request_id ? { requestId: (response as { _request_id?: string })._request_id } : {}) };
  } catch (error) {
    const api: ApiFailure = error instanceof RunError ? {} : error as ApiFailure;
    if (api.status !== undefined) save(files.error, { requestId: api.requestID ?? null, capturedAt: new Date().toISOString(), status: api.status, body: api.error ?? null });
    throw new ImageEditError(imageFailureCode(error), `The image edit failed: ${error instanceof Error ? error.message : String(error)}`, files.request, Date.now() - started);
  }
}
