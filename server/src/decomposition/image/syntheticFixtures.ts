import sharp from 'sharp';
import { emptyMask } from './masks.js';
import type { Mask, Rect } from './types.js';

/** Repository-owned geometric fixtures, generated locally without inference or customer images. */
export async function personHoldingBoardFixture(): Promise<{ image: Buffer; board: Mask; person: Mask; exclusions: Mask; thin: Mask }> {
  const width = 320, height = 400;
  const pixels = Buffer.alloc(width * height * 4);
  const board = emptyMask(width, height), person = emptyMask(width, height), exclusions = emptyMask(width, height), thin = emptyMask(width, height);
  for (let i = 0; i < width * height; i++) pixels.set([205, 228, 239, 255], i * 4);
  const paint = (rect: Rect, color: number[], mask: Mask, erase?: Mask) => {
    for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
      const i = y * width + x; mask.data[i] = 255; if (erase) erase.data[i] = 0; pixels.set([...color, 255], i * 4);
    }
  };
  paint({ x: 90, y: 105, width: 140, height: 210 }, [32, 87, 146], person);
  paint({ x: 125, y: 25, width: 70, height: 80 }, [204, 149, 109], person);
  for (let y = 25; y < 105; y++) for (let x = 125; x < 195; x++) exclusions.data[y * width + x] = 255;
  paint({ x: 66, y: 162, width: 188, height: 100 }, [240, 197, 53], board, person);
  for (const x of [62, 240]) {
    paint({ x, y: 193, width: 18, height: 32 }, [204, 149, 109], person, board);
    for (let y = 193; y < 225; y++) for (let px = x; px < x + 18; px++) exclusions.data[y * width + px] = 255;
  }
  // Small disconnected parts must survive component diagnostics and native extraction.
  paint({ x: 15, y: 20, width: 2, height: 60 }, [30, 40, 50], thin);
  paint({ x: 18, y: 82, width: 2, height: 2 }, [30, 40, 50], thin);
  return { image: await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer(), board, person, exclusions, thin };
}
