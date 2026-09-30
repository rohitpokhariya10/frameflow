import sharp from 'sharp';
import { decodeRgba } from './extract.js';
import { emptyMask } from './masks.js';
import { assertMask, assertSameSize, assertSize, ImageValidationError } from './types.js';
import type { Mask, Rect } from './types.js';

/** Restore every unauthorized pixel locally even if the provider changed the entire scene. */
export async function compositeGenerated(master: Buffer, generated: Buffer, generationMask: Mask, protectedMask?: Mask): Promise<{ image: Buffer; generatedSupport: Mask; changedProtectedPixels: number }> {
  const source = await decodeRgba(master), candidate = await decodeRgba(generated);
  assertSameSize(source, candidate); assertMask(generationMask); assertSameSize(source, generationMask);
  if (protectedMask) { assertMask(protectedMask); assertSameSize(source, protectedMask); }
  const output = Buffer.from(source.data), support = emptyMask(source.width, source.height);
  let changedProtectedPixels = 0;
  for (let i = 0; i < support.data.length; i++) {
    const weight = protectedMask?.data[i] ? 0 : generationMask.data[i] / 255;
    if (!weight) {
      if (protectedMask?.data[i] && source.data.subarray(i * 4, i * 4 + 4).some((value, channel) => value !== candidate.data[i * 4 + channel])) changedProtectedPixels++;
      continue;
    }
    support.data[i] = generationMask.data[i];
    for (let channel = 0; channel < 3; channel++) output[i * 4 + channel] = Math.round(source.data[i * 4 + channel] * (1 - weight) + candidate.data[i * 4 + channel] * weight);
    // Editing existing transparent canvas is never implicit. Source coverage stays authoritative.
    output[i * 4 + 3] = source.data[i * 4 + 3];
  }
  return { image: await sharp(output, { raw: { width: source.width, height: source.height, channels: 4 } }).png().toBuffer(), generatedSupport: support, changedProtectedPixels };
}

export async function compositeLayers(width: number, height: number, layers: { rgba: Buffer; bbox: Rect }[]): Promise<Buffer> {
  assertSize(width, height);
  // Straight-alpha source-over, avoiding repeated premultiplication round trips through libvips.
  const output = Buffer.alloc(width * height * 4);
  for (const layer of layers) {
    const image = await decodeRgba(layer.rgba), { bbox } = layer;
    assertSameSize(image, bbox);
    if (![bbox.x, bbox.y].every(Number.isSafeInteger) || bbox.x < 0 || bbox.y < 0 || bbox.x + bbox.width > width || bbox.y + bbox.height > height) throw new ImageValidationError('LAYER_BOUNDS', 'Layer placement is outside the composition.');
    for (let y = 0; y < bbox.height; y++) for (let x = 0; x < bbox.width; x++) {
      const from = (y * image.width + x) * 4, to = ((y + bbox.y) * width + x + bbox.x) * 4;
      const sourceAlpha = image.data[from + 3] / 255, destAlpha = output[to + 3] / 255, alpha = sourceAlpha + destAlpha * (1 - sourceAlpha);
      if (!alpha) continue;
      for (let channel = 0; channel < 3; channel++) output[to + channel] = Math.round((image.data[from + channel] * sourceAlpha + output[to + channel] * destAlpha * (1 - sourceAlpha)) / alpha);
      output[to + 3] = Math.round(alpha * 255);
    }
  }
  return sharp(output, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

/** A completed alpha is constrained to accepted hidden support plus all original visible support. */
export function completedObjectAlpha(visible: Mask, resegmented: Mask, hidden: Mask, excluded?: Mask): Mask {
  assertMask(visible); assertMask(resegmented); assertMask(hidden);
  assertSameSize(visible, resegmented); assertSameSize(visible, hidden);
  if (excluded) { assertMask(excluded); assertSameSize(visible, excluded); }
  return { ...visible, data: visible.data.map((value, i) => value ? value : excluded?.data[i] ? 0 : Math.min(resegmented.data[i], hidden.data[i])) };
}
