import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { ImageValidationError } from '../image/types.js';
import { withImageSlot } from '../image/limits.js';

export type SourceLimits = { maxBytes: number; minSide: number; maxSide: number; maxPixels: number };
export const defaultSourceLimits: SourceLimits = { maxBytes: 25 * 1024 * 1024, minSide: 256, maxSide: 4096, maxPixels: 12_000_000 };
export type NormalizedSource = {
  original: Buffer; master: Buffer; width: number; height: number;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  originalSha256: string; workingMasterSha256: string;
  orientationNormalized: boolean; hadAlpha: boolean; colorSpace: 'srgb';
};
export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function magicMime(bytes: Buffer): NormalizedSource['mimeType'] {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new ImageValidationError('UNSUPPORTED_IMAGE', 'Upload a static PNG, JPEG or WebP image. SVG, animated images and other encodings are not supported.');
}

/** Original bytes are immutable; fidelity is measured against this separately normalized working master. */
export async function normalizeSource(original: Buffer, overrides: Partial<SourceLimits> = {}): Promise<NormalizedSource> {
  const limits = { ...defaultSourceLimits, ...overrides };
  if (original.length === 0 || original.length > limits.maxBytes) throw new ImageValidationError('UPLOAD_SIZE', `Image must be nonempty and no larger than ${limits.maxBytes} bytes.`);
  const mimeType = magicMime(original);
  return withImageSlot(async () => {
  try {
    const decoder = sharp(original, { failOn: 'warning', limitInputPixels: limits.maxPixels, animated: true });
    const metadata = await decoder.metadata();
    if ((metadata.pages ?? 1) !== 1 || metadata.pageHeight && metadata.pageHeight !== metadata.height) throw new ImageValidationError('ANIMATED_IMAGE', 'Animated and multipage images are not supported; export a single static frame.');
    // Inspect PNG IHDR too: libvips may expose a converted depth for indexed inputs.
    if ((metadata.depth && metadata.depth !== 'uchar') || (metadata.bitsPerSample ?? 8) > 8 || mimeType === 'image/png' && original[24] > 8) {
      throw new ImageValidationError('UNSUPPORTED_PRECISION', 'Only 8-bit SDR images are supported. Export an 8-bit sRGB copy of this image.');
    }
    if (!metadata.width || !metadata.height || !metadata.channels || metadata.channels > 4) throw new ImageValidationError('INVALID_IMAGE', 'The image has unsupported dimensions or channels.');
    // Decode every scanline before publishing either source artifact. autoOrient applies EXIF then removes it.
    const decoded = await decoder.autoOrient().toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width, height } = decoded.info;
    if (width < limits.minSide || height < limits.minSide || width > limits.maxSide || height > limits.maxSide || width * height > limits.maxPixels) {
      throw new ImageValidationError('IMAGE_DIMENSIONS', `Image sides must be ${limits.minSide}–${limits.maxSide} pixels, at most ${limits.maxPixels} pixels in total.`);
    }
    const master = await sharp(decoded.data, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 6 }).toBuffer();
    return { original: Buffer.from(original), master, width, height, mimeType, originalSha256: sha256(original), workingMasterSha256: sha256(master),
      orientationNormalized: (metadata.orientation ?? 1) !== 1, hadAlpha: metadata.hasAlpha ?? false, colorSpace: 'srgb' };
  } catch (error) {
    if (error instanceof ImageValidationError) throw error;
    throw new ImageValidationError('INVALID_IMAGE', 'Image could not be fully decoded. It may be truncated, corrupt, unsupported, or exceed the pixel limit.');
  }
  });
}
