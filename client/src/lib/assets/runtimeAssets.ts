import { AI_LIMITS, builtinDiwaliAsset, premiumAssetPath, type ImageResponse } from '@frameflow/shared';
import { createAssetRepository } from './assetRepository';
const repository = createAssetRepository();
// Known same-origin static files. Cache bytes in memory; editor handoff takes its own persistent copy.
const premiumLoads = new Map<string, Promise<{ id:string; blob:Blob; mimeType:string; createdAt:string }>>();
async function premiumAsset(id:string, path:string) {
  if(!premiumLoads.has(id)) premiumLoads.set(id,(async()=>{
    const response=await fetch(path,{signal:AbortSignal.timeout(10_000)});
    if(!response.ok)throw new Error('The bundled template image could not load.');
    const blob=await response.blob();
    if(!['image/webp','image/svg+xml'].includes(blob.type)||blob.size>2_000_000)throw new Error('Invalid bundled template image.');
    return {id,blob,mimeType:blob.type,createdAt:'2026-10-02T00:00:00.000Z'};
  })().catch(error=>{premiumLoads.delete(id);throw error;}));
  return premiumLoads.get(id)!;
}
export const assets = { ...repository, async getAsset(id: string) {
  const path = premiumAssetPath(id);
  if(path)return premiumAsset(id,path);
  const svg = builtinDiwaliAsset(id);
  return svg ? { id, blob: new Blob([svg], { type: 'image/svg+xml' }), mimeType: 'image/svg+xml', createdAt: '2026-10-01T00:00:00.000Z' } : repository.getAsset(id);
}, async hasAsset(id: string) { return !!builtinDiwaliAsset(id) || !!premiumAssetPath(id) || repository.hasAsset(id); } };
/** Leave loading promptly even if browser decoding/storage does not settle. */
export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
  try { return await Promise.race([work, cancelled]); }
  finally { if (cancel) signal.removeEventListener('abort', cancel); }
}
export async function decodeImage(blob: Blob, signal?: AbortSignal): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  const image = new window.Image();
  try {
    image.src = url;
    await (signal ? abortable(image.decode(), signal) : image.decode());
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > AI_LIMITS.imageSide || image.naturalHeight > AI_LIMITS.imageSide || image.naturalWidth * image.naturalHeight > AI_LIMITS.imagePixels) throw new Error('Image dimensions are not supported.');
    return image;
  } finally { URL.revokeObjectURL(url); }
}
export async function storeGeneratedImage(response: ImageResponse, assetId: string, signal?: AbortSignal) {
  let blob: Blob;
  try {
    const binary = atob(response.image.base64);
    if (binary.length > AI_LIMITS.imageBytes) throw new Error('Too large');
    blob = new Blob([Uint8Array.from(binary, (char) => char.charCodeAt(0))], { type: response.image.mimeType });
    const image = await decodeImage(blob, signal);
    if (image.naturalWidth !== response.image.width || image.naturalHeight !== response.image.height) throw new Error('Dimension mismatch');
  } catch { throw new Error('The returned artwork could not be decoded. Your design is unchanged.'); }
  signal?.throwIfAborted();
  try { await assets.putAsset(assetId, blob); }
  catch { throw new Error('Could not store the artwork on this device. Free browser storage and try again. Your design is unchanged.'); }
  // A write can finish after cancellation won the race in the panel.
  if (signal?.aborted) {
    await assets.deleteAsset(assetId).catch(() => undefined);
    signal.throwIfAborted();
  }
}
