import { imageSize } from 'image-size';
import { AI_LIMITS, IMAGE_MIMES, type GenerateRequest, type ImageResponse, type ImageMime, type CanvasSize, type AdaptRequest, type ImageProvider, ADAPT_LIMITS } from '@frameflow/shared';

export interface ProviderDiagnostic { providerStatus?: number; canonicalCode?: string; reason?: string }
export class AiError extends Error {
  constructor(public code: string, message: string, public status = 502, public retryable = false, public providerDiagnostic?: ProviderDiagnostic) { super(message); }
}
export interface ProviderImage { data: string; mimeType: string }
export type GenerateImage = (prompt: string, ratio: string, signal: AbortSignal, target?: CanvasSize) => Promise<ProviderImage>;
export type AdaptImage = (prompt: string, ratio: string, signal: AbortSignal, target: CanvasSize, reference: ProviderImage) => Promise<ProviderImage>;
export const RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '1:4', '4:1', '1:8', '8:1'] as const;
export function aspectRatio(width: number, height: number) {
  return RATIOS.reduce((best, ratio) => {
    const distance = (value: string) => { const [w, h] = value.split(':').map(Number); return Math.abs(Math.log(width / height) - Math.log(w / h)); };
    return distance(ratio) < distance(best) ? ratio : best;
  });
}
export function artworkPrompt(request: GenerateRequest, ratio: string) {
  const { styleBrief: s, quietRegion: q } = request;
  return `Create background artwork for an editable ${s.theme} design.\nVisual direction: ${request.prompt}\nPalette: ${s.palette.join(', ')}.\nMotifs: ${s.motifs.join(', ')}.\nMood: ${s.mood}.\nTarget format: ${ratio}.\nReserve the normalized rectangle x=${q.x}, y=${q.y}, width=${q.width}, height=${q.height} as calm, light, low-detail space for dark editable text added by the application. Keep decorative elements away from this region.\nDo not add event wording, letters, logos, signatures, or visible watermarks to the artwork.`;
}
export function validateImage(image: ProviderImage): ImageResponse['image'] {
  if (!IMAGE_MIMES.includes(image.mimeType as ImageMime) || !image.data || image.data.length > Math.ceil(AI_LIMITS.imageBytes / 3) * 4
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data) || image.data.length % 4 !== 0) throw new AiError('INVALID_IMAGE', 'The image service returned invalid artwork. Your design is unchanged.');
  const bytes = Buffer.from(image.data, 'base64');
  if (!bytes.length || bytes.length > AI_LIMITS.imageBytes || bytes.toString('base64') !== image.data) throw new AiError('INVALID_IMAGE', 'The image service returned invalid artwork.');
  try {
    const size = imageSize(bytes);
    const mime = ({ png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' } as Record<string, string>)[size.type ?? ''];
    if (mime !== image.mimeType || !size.width || !size.height || size.width > AI_LIMITS.imageSide || size.height > AI_LIMITS.imageSide || size.width * size.height > AI_LIMITS.imagePixels) throw new Error('Invalid dimensions');
    return { mimeType: image.mimeType as ImageMime, base64: image.data, width: size.width, height: size.height };
  } catch { throw new AiError('INVALID_IMAGE', 'The image service returned unsupported or damaged artwork.'); }
}
const CANONICAL_CODES = new Set(['CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS', 'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED', 'invalid_request', 'too_many_requests']);
const CONFIGURATION_REASONS = new Set(['API_KEY_INVALID', 'API_KEY_SERVICE_BLOCKED', 'API_KEY_HTTP_REFERRER_BLOCKED', 'API_KEY_IP_ADDRESS_BLOCKED', 'API_KEY_ANDROID_APP_BLOCKED', 'API_KEY_IOS_APP_BLOCKED', 'ACCESS_TOKEN_EXPIRED', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'SERVICE_DISABLED', 'BILLING_DISABLED', 'CONSUMER_INVALID']);
const NETWORK_REASONS = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'APIConnectionError', 'ConnectionError']);
const TIMEOUT_REASONS = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'APIConnectionTimeoutError', 'RequestTimeoutError', 'TimeoutError']);
const ABORT_REASONS = new Set(['APIUserAbortError', 'RequestAbortedError', 'AbortError']);
const PROVIDER_REASONS = new Set([...CONFIGURATION_REASONS, ...NETWORK_REASONS, ...TIMEOUT_REASONS, ...ABORT_REASONS, 'RATE_LIMIT_EXCEEDED', 'QUOTA_EXCEEDED', 'MODEL_NOT_FOUND', 'MODEL_NOT_SUPPORTED']);

/** Read only bounded, allowlisted metadata. Raw messages, bodies, headers and details never leave this function. */
function providerDiagnostic(error: unknown): ProviderDiagnostic | undefined {
  const diagnostic: ProviderDiagnostic = {};
  const queue: unknown[] = [error];
  const seen = new Set<object>();
  for (let index = 0; index < queue.length && index < 24; index++) {
    const value = queue[index];
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const node = value as Record<string, unknown>;
    for (const candidate of [node.statusCode, node.status, node.code]) {
      const status = typeof candidate === 'number' ? candidate : typeof candidate === 'string' && /^\d{3}$/.test(candidate) ? Number(candidate) : undefined;
      if (diagnostic.providerStatus === undefined && status !== undefined && Number.isInteger(status) && status >= 400 && status <= 599) diagnostic.providerStatus = status;
      if (!diagnostic.canonicalCode && typeof candidate === 'string' && CANONICAL_CODES.has(candidate)) diagnostic.canonicalCode = candidate;
    }
    // Structured reasons take precedence over the SDK wrapper's generic connection-error name.
    for (const candidate of [node.reason, node.code, node.name]) {
      if (typeof candidate === 'string' && PROVIDER_REASONS.has(candidate)
        && (!diagnostic.reason || diagnostic.reason === 'APIConnectionError' || diagnostic.reason === 'ConnectionError')) diagnostic.reason = candidate;
    }
    queue.push(node.error, node.cause);
    if (Array.isArray(node.details)) queue.push(...node.details.slice(0, 8));
  }
  return Object.keys(diagnostic).length ? diagnostic : undefined;
}

export function mapProviderError(error: unknown): AiError {
  if (error instanceof AiError) return error;
  const diagnostic = providerDiagnostic(error);
  const status = diagnostic?.providerStatus;
  const code = status === undefined ? diagnostic?.canonicalCode : undefined;
  const reason = diagnostic?.reason ?? '';
  const mapped = (code: string, message: string, status = 502, retryable = false) => new AiError(code, message, status, retryable, diagnostic);
  if (status === 401 || status === 403 || code === 'UNAUTHENTICATED' || code === 'PERMISSION_DENIED' || CONFIGURATION_REASONS.has(reason)) return mapped('CONFIGURATION', 'The image service rejected its credentials or project configuration. Ask the owner to check API access, key restrictions and billing.', 503);
  if (status === 429 || code === 'RESOURCE_EXHAUSTED' || code === 'too_many_requests' || reason === 'RATE_LIMIT_EXCEEDED' || reason === 'QUOTA_EXCEEDED') return mapped('RATE_LIMIT', 'The image service is busy or its quota is exhausted. Please try later.', 429, true);
  if (status === 404 || code === 'NOT_FOUND' || reason === 'MODEL_NOT_FOUND' || reason === 'MODEL_NOT_SUPPORTED') return mapped('MODEL_UNAVAILABLE', 'The configured image model is unavailable for this API or project. Ask the owner to check model access and configuration.', 503);
  if (status === 400 || status === 413 || status === 422 || code === 'INVALID_ARGUMENT' || code === 'OUT_OF_RANGE' || code === 'invalid_request') return mapped('PROVIDER_REQUEST', 'The image service rejected the request configuration. Ask the owner to check the model, API method and image options.', 400);
  if (status === 408 || status === 504 || code === 'DEADLINE_EXCEEDED' || TIMEOUT_REASONS.has(reason)) return mapped('TIMEOUT', 'Generation timed out. Your design is unchanged. Check before retrying; the provider may still be processing.', 504, true);
  if (code === 'CANCELLED' || ABORT_REASONS.has(reason)) return mapped('CANCELLED', 'Generation was cancelled.', 499);
  if (NETWORK_REASONS.has(reason)) return mapped('NETWORK', 'The server could not reach the image service. Check its network connection before trying again. Your design is unchanged.', 502, true);
  return mapped('PROVIDER_FAILURE', 'The image service is temporarily unavailable. Please try later. Your design is unchanged.', 502, true);
}
export function validateReference(request: AdaptRequest): ProviderImage {
  try {
    const reference = { data: request.referenceImage.base64, mimeType: request.referenceImage.mimeType };
    const image = validateImage(reference);
    if (Buffer.from(reference.data, 'base64').length > ADAPT_LIMITS.referenceBytes || image.mimeType !== 'image/png'
      || image.width > ADAPT_LIMITS.referenceSide || image.height > ADAPT_LIMITS.referenceSide
      || image.width !== request.referenceImage.width || image.height !== request.referenceImage.height) throw new Error('Invalid reference');
    return reference;
  } catch { throw new AiError('INVALID_REFERENCE', 'The source reference is invalid or too large. Prepare the source artwork again.', 400); }
}
export function adaptationPrompt(request: AdaptRequest, ratio: string) {
  const composition = request.format === 'landscape'
    ? 'Bias decorative visual weight toward the left and leave calm negative space on the right.'
    : request.format === 'square' ? 'Use a compact balanced square composition with decoration around the perimeter and a calm center.'
      : request.format === 'custom' ? 'Recompose naturally for the custom target frame and keep the reserved text region calm.'
        : 'Use a vertical composition with decorative borders or corners and a calm centered text region.';
  return `Use the supplied source artwork as the visual reference. Preserve its palette, floral/decorative motifs, mood, lighting, artistic treatment and visual identity. Recompose naturally for ${request.target.width} by ${request.target.height} (${ratio}). ${composition} Extend or rearrange the artwork; do not merely stretch or crop the original.\n${artworkPrompt(request, ratio)}\nDo not include letters, words, names, dates, logos, signatures or typography.`;
}
export function generateArtwork(request: GenerateRequest, requestId: string, model: string, timeoutMs: number, generate: GenerateImage, disconnected?: AbortSignal, provider: ImageProvider = 'gemini'): Promise<ImageResponse> {
  const ratio = aspectRatio(request.target.width, request.target.height);
  const prompt = artworkPrompt(request, ratio);
  return runArtwork(requestId, model, ratio, prompt, timeoutMs, (signal) => generate(prompt, ratio, signal, request.target), disconnected, provider);
}
export function adaptArtwork(request: AdaptRequest, requestId: string, model: string, timeoutMs: number, adapt: AdaptImage, disconnected?: AbortSignal, provider: ImageProvider = 'cloudflare'): Promise<ImageResponse> {
  const reference = validateReference(request);
  const ratio = aspectRatio(request.target.width, request.target.height);
  const prompt = adaptationPrompt(request, ratio);
  return runArtwork(requestId, model, ratio, prompt, timeoutMs, (signal) => adapt(prompt, ratio, signal, request.target, reference), disconnected, provider);
}
async function runArtwork(requestId: string, model: string, ratio: string, prompt: string, timeoutMs: number, generate: (signal: AbortSignal) => Promise<ProviderImage>, disconnected: AbortSignal | undefined, provider: ImageProvider): Promise<ImageResponse> {
  if (disconnected?.aborted) throw new AiError('CANCELLED', 'Generation was cancelled.', 499);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new AiError('TIMEOUT', 'Generation timed out. Your design is unchanged. Check before retrying; the provider may still be processing.', 504, true)); }, timeoutMs);
      cancel = () => { controller.abort(); reject(new AiError('CANCELLED', 'Generation was cancelled.', 499)); };
      disconnected?.addEventListener('abort', cancel, { once: true });
      if (disconnected?.aborted) cancel();
    });
    const image = await Promise.race([generate(controller.signal), timeout]);
    return { requestId, image: validateImage(image), generation: { mode: 'live', provider, model, requestedAspectRatio: ratio, promptUsed: prompt } };
  } catch (error) { throw mapProviderError(error); }
  finally { clearTimeout(timer); if (cancel) disconnected?.removeEventListener('abort', cancel); }
}
