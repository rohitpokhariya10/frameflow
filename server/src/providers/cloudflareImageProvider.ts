import { imageSize } from 'image-size';
import { AI_LIMITS, type CanvasSize } from '@frameflow/shared';
import { AiError, mapProviderError, type GenerateImage } from '../services/aiService.js';

export const CLOUDFLARE_IMAGE_MODEL = '@cf/black-forest-labs/flux-2-klein-4b';
// Keep generation near 1 megapixel, within the model's 256–1920 side limits.
// Logical document dimensions remain exact; returned artwork uses uniform cover.
export function cloudflareDimensions(target: CanvasSize): CanvasSize {
  const scale = Math.min(1, 1024 / Math.max(target.width, target.height));
  const side = (value: number) => Math.max(256, Math.min(1920, Math.round(value * scale / 16) * 16));
  return { width: side(target.width), height: side(target.height) };
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const ERROR_STATUS: Record<number, number> = { 10000: 401, 10001: 401, 3003: 400, 5004: 400, 5007: 404, 3042: 404, 5018: 403, 5016: 403, 3023: 403, 3041: 403, 5035: 403, 3006: 413, 3007: 408, 3008: 408, 3036: 429, 3040: 429 };
function failure(status: number, envelope?: Record<string, unknown>) {
  const error = Array.isArray(envelope?.errors) ? envelope.errors.find(record) : undefined;
  const code = error && typeof error.code === 'number' ? error.code : undefined;
  const mappedStatus = code !== undefined && ERROR_STATUS[code] ? ERROR_STATUS[code] : status;
  const normalized = mapProviderError({ status: mappedStatus });
  // Only known numeric codes enter logs; provider messages and account/token never do.
  normalized.providerDiagnostic = { ...normalized.providerDiagnostic, providerStatus: status,
    ...(code !== undefined && ERROR_STATUS[code] ? { canonicalCode: `CLOUDFLARE_${code}` } : {}) };
  return normalized;
}
async function boundedJSON(response: Response): Promise<unknown> {
  const maxBytes = Math.ceil(AI_LIMITS.imageBytes / 3) * 4 + 64 * 1024;
  if (!response.body) throw new AiError('INVALID_IMAGE', 'The image service returned an empty response.');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw new AiError('INVALID_IMAGE', 'The image service returned oversized artwork.'); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new AiError('INVALID_IMAGE', 'The image service returned an invalid response.');
    throw error;
  } finally { reader.releaseLock(); }
}

/** REST multipart contract; image-input fields can be added here for M6, not in the client. */
export function cloudflareImageProvider(accountId: string, token: string, model: string): GenerateImage {
  return async (prompt, ratio, signal, target) => {
    const [w, h] = ratio.split(':').map(Number);
    const size = cloudflareDimensions(target ?? { width: w * 1024, height: h * 1024 });
    const body = new FormData(); body.set('prompt', prompt); body.set('width', String(size.width)); body.set('height', String(size.height));
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body, signal, redirect: 'error',
    });
    let envelope: unknown;
    try { envelope = await boundedJSON(response); }
    catch (error) { if (!response.ok) throw failure(response.status); throw error; }
    if (!response.ok || (record(envelope) && envelope.success === false)) throw failure(response.status, record(envelope) ? envelope : undefined);
    if (!record(envelope) || envelope.success !== true || !record(envelope.result) || typeof envelope.result.image !== 'string') throw new AiError('NO_IMAGE', 'The image service returned no artwork.');
    const data = envelope.result.image;
    if (!data || data.length > Math.ceil(AI_LIMITS.imageBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) throw new AiError('INVALID_IMAGE', 'The image service returned invalid artwork.');
    // The JSON envelope does not guarantee MIME/dimensions: inspect actual bytes.
    let mimeType: string;
    try { mimeType = ({ png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' } as Record<string, string>)[imageSize(Buffer.from(data, 'base64')).type ?? ''] ?? ''; }
    catch { throw new AiError('INVALID_IMAGE', 'The image service returned damaged artwork.'); }
    return { data, mimeType };
  };
}
