import sharp from 'sharp';
import { decodeRgba } from './decode.js';
import { assertMask, assertSameSize, ImageValidationError } from './types.js';
import type { Mask } from './types.js';

export type MaskOverlay = { mask: Mask; color?: string | readonly [number, number, number]; opacity?: number };
const colors: readonly (readonly [number, number, number])[] = [[239, 68, 68], [34, 197, 94], [59, 130, 246], [245, 158, 11], [168, 85, 247], [6, 182, 212]];
function parseColor(color: MaskOverlay['color'], fallback: readonly [number, number, number]): readonly [number, number, number] {
  if (color === undefined) return fallback;
  if (typeof color === 'string') {
    if (!/^#[a-f0-9]{6}$/i.test(color)) throw new ImageValidationError('OVERLAY_COLOR', 'Overlay colors must use six hexadecimal digits.');
    return [Number.parseInt(color.slice(1, 3), 16), Number.parseInt(color.slice(3, 5), 16), Number.parseInt(color.slice(5, 7), 16)];
  }
  if (color.length !== 3 || color.some(value => !Number.isSafeInteger(value) || value < 0 || value > 255)) throw new ImageValidationError('OVERLAY_COLOR', 'Overlay RGB values must be bytes.');
  return color;
}

/** Diagnostic PNG only. Ownership masks remain independent lossless grayscale artifacts. */
export async function overlayMasks(image: Buffer, overlays: MaskOverlay[]): Promise<Buffer> {
  if (overlays.length > 64) throw new ImageValidationError('CANDIDATE_LIMIT', 'Overlay exceeds the candidate limit.');
  const source = await decodeRgba(image), pixels = Buffer.from(source.data);
  for (const [index, overlay] of overlays.entries()) {
    assertMask(overlay.mask); assertSameSize(source, overlay.mask);
    const color = parseColor(overlay.color, colors[index % colors.length]), opacity = overlay.opacity ?? 0.45;
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new ImageValidationError('OVERLAY_OPACITY', 'Overlay opacity must be between zero and one.');
    for (let i = 0; i < overlay.mask.data.length; i++) {
      const weight = overlay.mask.data[i] / 255 * opacity;
      if (!weight) continue;
      for (let channel = 0; channel < 3; channel++) pixels[i * 4 + channel] = Math.round(pixels[i * 4 + channel] * (1 - weight) + color[channel] * weight);
    }
  }
  return sharp(pixels, { raw: { width: source.width, height: source.height, channels: 4 } }).png().toBuffer();
}
