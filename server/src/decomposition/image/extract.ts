import sharp from 'sharp';
import { cropMask, encodeMask, maskBounds } from './masks.js';
import { assertMask, assertSameSize, ImageValidationError } from './types.js';
import type { Mask, Rect } from './types.js';

export type ExtractedLayer = { id: string; label: string; bbox: Rect; rgba: Buffer; alpha: Buffer; visibleOwnership: Buffer };
export type RawRgba = { data: Buffer; width: number; height: number };

export async function decodeRgba(bytes: Buffer): Promise<RawRgba> {
  const decoded = await sharp(bytes, { limitInputPixels: 12_000_000, failOn: 'warning' }).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: decoded.data, width: decoded.info.width, height: decoded.info.height };
}

/** Write straight alpha directly. Never resize, premultiply or color-decontaminate source RGB. */
export async function extractLayer(source: RawRgba, mask: Mask, id: string, label: string, padding = 2): Promise<ExtractedLayer> {
  assertMask(mask); assertSameSize(source, mask);
  const alpha = { ...mask, data: mask.data.map((value, i) => Math.round(value * source.data[i * 4 + 3] / 255)) };
  const bbox = maskBounds(alpha, padding);
  if (!bbox) throw new ImageValidationError('EMPTY_MASK', `The selected object ${id} has no visible pixels.`);
  const croppedAlpha = cropMask(alpha, bbox), croppedOwnership = cropMask(mask, bbox);
  const pixels = Buffer.alloc(bbox.width * bbox.height * 4);
  for (let y = 0; y < bbox.height; y++) for (let x = 0; x < bbox.width; x++) {
    const from = ((bbox.y + y) * source.width + bbox.x + x) * 4, to = (y * bbox.width + x) * 4;
    source.data.copy(pixels, to, from, from + 3);
    pixels[to + 3] = croppedAlpha.data[y * bbox.width + x];
  }
  return { id, label, bbox, rgba: await sharp(pixels, { raw: { width: bbox.width, height: bbox.height, channels: 4 } }).png().toBuffer(),
    alpha: await encodeMask(croppedAlpha), visibleOwnership: await encodeMask(croppedOwnership) };
}
