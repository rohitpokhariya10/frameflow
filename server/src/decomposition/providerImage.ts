/**
 * Every image sent to Seedream layer decomposition passes here first (Feature 1 scenery splits, Feature 2 creatives,
 * template creation, retries): it is fully decoded and checked against the endpoint's published contract, and the
 * provider gets a canonical copy (8-bit sRGB, opaque, no ICC/EXIF, 72 dpi, its own pixels and size) while the creative
 * itself is never changed. The upload is then read back and must be exactly that copy before anything is submitted.
 *
 * What this does NOT do: make a valid image acceptable to the provider. 139 recorded requests show valid, identical
 * bytes both accepted and rejected (fal 422 "could not be processed for layer decomposition", and partner content
 * checks): those are upstream decisions this layer can only record honestly (classifySeedreamRejection).
 */
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';

/** fal's published contract for bytedance/seedream/v5/pro/layerize (image_url). */
export const SEEDREAM_IMAGE_LIMITS = { minPixels: 512 * 512, maxPixels: 6000 * 6000, minAspect: 1 / 16, maxAspect: 16, maxBytes: 30 * 1024 * 1024 } as const;
export class ProviderImageError extends Error {
  constructor(public readonly code: 'IMAGE_UNREADABLE' | 'IMAGE_FORMAT_UNSUPPORTED' | 'IMAGE_DIMENSIONS_INVALID' | 'IMAGE_TOO_LARGE' | 'UPLOAD_MISMATCH' | 'UPLOAD_UNREADABLE', message: string) { super(message); this.name = 'ProviderImageError'; }
}
export interface ProviderImageReport {
  /** The creative as stored (never changed). */
  source: { sha256: string; bytes: number; format: string; declaredMime?: string; width: number; height: number; channels: number; space: string; depth: string; alpha: boolean; icc: boolean; exif: boolean; orientation?: number; density?: number };
  /** What is uploaded: the creative itself when it is already canonical, else a canonical copy of its pixels. */
  provider: { sha256: string; bytes: number; mime: 'image/png' | 'image/jpeg'; width: number; height: number; normalized: boolean; steps: string[] };
  /** sha256 of the decoded RGB pixels the provider gets (equal to the creative's own when nothing visual changed). */
  pixelsSha256: string;
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
/** A PNG with a pHYs chunk of 72 dpi (2835 pixels per metre) right after IHDR, as every accepted upload on record has. */
export function withDensityChunk(png: Buffer): Buffer {
  const ihdrEnd = 8 + 8 + png.readUInt32BE(8) + 4, data = Buffer.alloc(9);
  data.writeUInt32BE(2835, 0); data.writeUInt32BE(2835, 4); data[8] = 1;
  const type = Buffer.from('pHYs', 'ascii'), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(9); crc.writeUInt32BE(crc32(Buffer.concat([type, data])) >>> 0);
  return Buffer.concat([png.subarray(0, ihdrEnd), length, type, data, crc, png.subarray(ihdrEnd)]);
}
/** The container the bytes actually are, from their magic numbers (a declared MIME can be wrong). */
export function sniffFormat(b: Buffer): 'png' | 'jpeg' | 'webp' | 'gif' | 'unknown' {
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('ascii', 0, 6))) return 'gif';
  return 'unknown';
}
/**
 * The image as Seedream should receive it, or a local refusal (no upload, no call) when it cannot be valid input.
 * `declaredMime`: what the caller would have sent it as (a mismatch is corrected, and reported).
 */
export async function prepareProviderImage(bytes: Buffer, declaredMime?: string): Promise<{ bytes: Buffer; report: ProviderImageReport }> {
  const container = sniffFormat(bytes);
  if (container === 'unknown') throw new ProviderImageError('IMAGE_FORMAT_UNSUPPORTED', 'The image is not a PNG, JPEG or WebP file (its bytes match none of them). Nothing was sent.');
  if (container === 'gif') throw new ProviderImageError('IMAGE_FORMAT_UNSUPPORTED', 'GIF images are not sent for layer extraction. Nothing was sent.');
  let meta: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>, rgb: Buffer, width: number, height: number;
  try {
    meta = await sharp(bytes).metadata();
    // A full decode (not only the header): a truncated or corrupt file fails here, locally.
    const decoded = await sharp(bytes, { failOn: 'error' }).rotate().toColourspace('srgb').flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    rgb = decoded.data; width = decoded.info.width; height = decoded.info.height;
  } catch (error) { throw new ProviderImageError('IMAGE_UNREADABLE', `The image cannot be decoded (${error instanceof Error ? error.message : String(error)}). Nothing was sent.`); }
  const pixels = width * height, aspect = width / height;
  if (pixels < SEEDREAM_IMAGE_LIMITS.minPixels || pixels > SEEDREAM_IMAGE_LIMITS.maxPixels || aspect < SEEDREAM_IMAGE_LIMITS.minAspect || aspect > SEEDREAM_IMAGE_LIMITS.maxAspect)
    throw new ProviderImageError('IMAGE_DIMENSIONS_INVALID', `The image is ${width}×${height}: layer extraction needs between 512×512 and 6000×6000 pixels in total and an aspect ratio between 1:16 and 16:1. Nothing was sent.`);
  const source: ProviderImageReport['source'] = { sha256: sha(bytes), bytes: bytes.length, format: container, ...(declaredMime ? { declaredMime } : {}), width: meta.width ?? width, height: meta.height ?? height,
    channels: meta.channels ?? 0, space: meta.space ?? 'unknown', depth: meta.depth ?? 'unknown', alpha: !!meta.hasAlpha, icc: !!meta.icc, exif: !!meta.exif, ...(meta.orientation ? { orientation: meta.orientation } : {}), ...(meta.density ? { density: meta.density } : {}) };
  // Canonical already: an 8-bit, 3-channel sRGB PNG or JPEG with no profile, no EXIF and no rotation, declared as what it
  // is. Sent byte for byte, as before (every accepted upload on record looks like this).
  const steps: string[] = [];
  if (container !== 'png' && container !== 'jpeg') steps.push(`re-encoded from ${container}`);
  if (declaredMime && declaredMime !== `image/${container}`) steps.push(`declared ${declaredMime} but is ${container}`);
  if (meta.hasAlpha) steps.push('alpha flattened onto white');
  if ((meta.channels ?? 3) !== 3 && !meta.hasAlpha) steps.push(`${meta.channels} channels made RGB`);
  if (meta.space && meta.space !== 'srgb') steps.push(`${meta.space} converted to sRGB`);
  if (meta.depth && meta.depth !== 'uchar') steps.push(`${meta.depth} reduced to 8-bit`);
  if (meta.icc) steps.push('ICC profile removed (pixels in sRGB)');
  if (meta.exif) steps.push('EXIF removed');
  if (meta.orientation && meta.orientation !== 1) steps.push(`EXIF orientation ${meta.orientation} applied`);
  // A PNG without a density chunk is valid (the contract names none) and is sent as it is: only the report notes it.
  const pixelsSha256 = sha(rgb);
  if (!steps.length) {
    // The pass-through path still has to obey the encoded-size limit; previously only converted PNGs were checked.
    if (bytes.length > SEEDREAM_IMAGE_LIMITS.maxBytes) throw new ProviderImageError('IMAGE_TOO_LARGE', 'The image exceeds the 30 MB layer-extraction upload limit. Nothing was sent.');
    return { bytes, report: { source, provider: { sha256: source.sha256, bytes: bytes.length, mime: `image/${container}` as 'image/png' | 'image/jpeg', width, height, normalized: false, steps: [] }, pixelsSha256 } };
  }
  // A canonical PNG of the same pixels (lossless: nothing visual changes beyond what the steps say).
  // A plain PNG of the pixels plus one pHYs chunk (72 dpi, as accepted uploads carry): sharp's density options would also add EXIF or an ICC profile.
  const png = withDensityChunk(await sharp(rgb, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 9 }).toBuffer());
  if (png.length > SEEDREAM_IMAGE_LIMITS.maxBytes) throw new ProviderImageError('IMAGE_TOO_LARGE', `The image is ${Math.round(png.length / 1024 / 1024)} MB as a PNG; layer extraction accepts at most 30 MB. Nothing was sent.`);
  const check = await sharp(png).raw().toBuffer();
  if (sha(check) !== pixelsSha256) throw new ProviderImageError('IMAGE_UNREADABLE', 'The provider copy did not decode to the same pixels. Nothing was sent.');
  return { bytes: png, report: { source, provider: { sha256: sha(png), bytes: png.length, mime: 'image/png', width, height, normalized: true, steps }, pixelsSha256 } };
}
/** The uploaded asset, read back from its URL: it must be exactly the bytes prepared, or nothing is submitted. */
export async function verifyUploadedImage(url: string, expectedSha256: string, download: (url: string) => Promise<Buffer>): Promise<void> {
  let served: Buffer;
  try { served = await download(url); } catch (error) { throw new ProviderImageError('UPLOAD_UNREADABLE', `The uploaded image could not be read back from fal storage (${error instanceof Error ? error.message : String(error)}). Nothing was submitted.`); }
  if (!served?.length || sha(served) !== expectedSha256) throw new ProviderImageError('UPLOAD_MISMATCH', 'fal storage does not serve the exact image that was uploaded. Nothing was submitted.');
}

/** What kind of refusal a Seedream failure is, from fal's own answer (never inferred from our plan). */
export type SeedreamRejectionCategory = 'partner-content' | 'unprocessable-image' | 'image-url' | 'invalid-request' | 'temporary' | 'unknown';
export interface SeedreamRejection {
  category: SeedreamRejectionCategory;
  status?: number; loc?: string; type?: string; reason?: string; message?: string; billableUnits?: string; requestId?: string;
  endpoint: string;
  /** The exact bytes fal was given (the provider copy) and the prompt, so repeats of the same request are recognised. */
  imageSha256?: string; promptSha256?: string;
}
type Detail = { status?: number; messages?: { msg: string; type?: string; loc?: string; reason?: string }[]; billableUnits?: string; requestId?: string } | undefined;
export function classifySeedreamRejection(detail: Detail, context: { endpoint: string; imageSha256?: string; prompt?: string; status?: number }): SeedreamRejection {
  const m = detail?.messages?.[0], status = detail?.status ?? context.status, loc = m?.loc ?? '', text = m?.msg ?? '';
  const category: SeedreamRejectionCategory = m?.type === 'content_policy_violation' || m?.reason === 'partner_validation_failed' ? 'partner-content'
    : /could not be processed for layer decomposition/i.test(text) ? 'unprocessable-image'
    : /image/.test(loc) && /download|fetch|retriev|access|expired|not found|unreachable|invalid url|could not load/i.test(text) ? 'image-url'
    : status === 422 || status === 400 ? 'invalid-request'
    : status === 429 || (status !== undefined && status >= 500) ? 'temporary' : 'unknown';
  return { category, ...(status !== undefined ? { status } : {}), ...(loc ? { loc } : {}), ...(m?.type ? { type: m.type } : {}), ...(m?.reason ? { reason: m.reason } : {}), ...(text ? { message: text } : {}),
    ...(detail?.billableUnits !== undefined ? { billableUnits: detail.billableUnits } : {}), ...(detail?.requestId ? { requestId: detail.requestId } : {}), endpoint: context.endpoint,
    ...(context.imageSha256 ? { imageSha256: context.imageSha256 } : {}), ...(context.prompt ? { promptSha256: sha(Buffer.from(context.prompt)) } : {}) };
}
/** One plain sentence per category: what fal said, and what it means for a retry. */
export function rejectionExplanation(r: SeedreamRejection): string {
  const billed = r.billableUnits === '0' ? ' fal billed 0 units for it.' : '';
  switch (r.category) {
    case 'partner-content': return `fal's partner content check refused this image (${r.loc ?? 'image'}: ${r.reason ?? r.type ?? 'content policy'}); the reason is not disclosed.${billed} The image itself is valid input (checked locally).`;
    case 'unprocessable-image': return `Seedream answered that this image "could not be processed for layer decomposition".${billed} The image is valid input (checked locally) and the reason is not disclosed; identical images have been accepted on a later try before.`;
    case 'image-url': return 'fal could not read the uploaded image from its own storage. Nothing about the image was judged.';
    case 'invalid-request': return `fal refused the request itself (${r.loc ?? 'request'}: ${r.message ?? 'invalid'}).${billed}`;
    case 'temporary': return 'fal was temporarily unavailable.';
    default: return 'fal did not return a usable result.';
  }
}
