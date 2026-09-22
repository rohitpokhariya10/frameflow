import { ADAPT_LIMITS, AI_LIMITS, IMAGE_MIMES, type AdaptRequest, type CanvasSize } from '@frameflow/shared';
import { abortable, assets, decodeImage } from './runtimeAssets';

export function referenceSize(source: CanvasSize): CanvasSize {
  const scale = Math.min(1, ADAPT_LIMITS.referenceSide / Math.max(source.width, source.height));
  return { width: Math.max(1, Math.round(source.width * scale)), height: Math.max(1, Math.round(source.height * scale)) };
}
/** Read/decode the original Blob, then create a temporary PNG. Never overwrite storage. */
export async function prepareReference(assetId: string, signal: AbortSignal): Promise<AdaptRequest['referenceImage']> {
  signal.throwIfAborted();
  const asset = await abortable(assets.getAsset(assetId), signal).catch(() => { throw new Error('Could not read the source artwork from this device.'); });
  if (!asset) throw new Error('Source artwork is missing. Restore or generate artwork before adapting.');
  if (!(IMAGE_MIMES as readonly string[]).includes(asset.blob.type) || !asset.blob.size || asset.blob.size > AI_LIMITS.imageBytes) throw new Error('Source artwork must be a valid PNG, JPEG or WebP within 8 MiB.');
  try {
    const image = await decodeImage(asset.blob, signal);
    signal.throwIfAborted();
    const size = referenceSize({ width: image.naturalWidth, height: image.naturalHeight });
    const canvas = document.createElement('canvas'); canvas.width = size.width; canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas unavailable');
    context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, size.width, size.height);
    const blob = await abortable(new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Encoding failed')), 'image/png')), signal);
    if (!blob.size || blob.size > ADAPT_LIMITS.referenceBytes) throw new Error('Reference too large');
    const bytes = new Uint8Array(await abortable(blob.arrayBuffer(), signal));
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    signal.throwIfAborted();
    return { mimeType: 'image/png', base64: btoa(binary), ...size };
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error('Could not prepare the source reference image. Your original artwork is unchanged.', { cause: error });
  }
}
