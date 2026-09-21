import { imageSize } from 'image-size';
import { AI_LIMITS, IMAGE_MIMES, type GenerateRequest, type ImageResponse, type ImageMime } from '@frameflow/shared';

export class AiError extends Error {
  constructor(public code: string, message: string, public status = 502, public retryable = false) { super(message); }
}
export interface ProviderImage { data: string; mimeType: string }
export type GenerateImage = (prompt: string, ratio: string, signal: AbortSignal) => Promise<ProviderImage>;
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
export function mapProviderError(error: unknown): AiError {
  if (error instanceof AiError) return error;
  const status = error && typeof error === 'object'
    ? Number('statusCode' in error ? error.statusCode : 'status' in error ? error.status : 0) : 0;
  if (status === 429) return new AiError('RATE_LIMIT', 'The image service is busy or its quota is exhausted. Please try later.', 429, true);
  if (status === 401 || status === 403) return new AiError('CONFIGURATION', 'The image service could not authenticate. Ask the owner to check its configuration.', 503);
  return new AiError('PROVIDER_FAILURE', 'The image service is temporarily unavailable. Your design is unchanged.', 502, true);
}
export async function generateArtwork(request: GenerateRequest, requestId: string, model: string, timeoutMs: number, generate: GenerateImage, disconnected?: AbortSignal): Promise<ImageResponse> {
  if (disconnected?.aborted) throw new AiError('CANCELLED', 'Generation was cancelled.', 499);
  const ratio = aspectRatio(request.target.width, request.target.height);
  const prompt = artworkPrompt(request, ratio);
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
    const image = await Promise.race([generate(prompt, ratio, controller.signal), timeout]);
    return { requestId, image: validateImage(image), generation: { mode: 'live', model, requestedAspectRatio: ratio, promptUsed: prompt } };
  } catch (error) { throw mapProviderError(error); }
  finally { clearTimeout(timer); if (cancel) disconnected?.removeEventListener('abort', cancel); }
}
