import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { liveSegmenter } from './segmenter.js';
import { band, maskBox, type PixelBox } from './variantCompose.js';
import { falSegmentation } from './variantTestKit.js';

// The mask providers behind a fake fal transport: what is asked of SAM-3 and BiRefNet, and which of their answers become
// each product's mask. No request leaves this machine.
const rectMask = (width: number, height: number, ...boxes: PixelBox[]) => {
  const raw = Buffer.alloc(width * height);
  for (const b of boxes) for (let y = b.y; y < b.y + b.height; y++) for (let x = b.x; x < b.x + b.width; x++) raw[y * width + x] = 255;
  return sharp(raw, { raw: { width, height, channels: 1 } }).png().toBuffer();
};
const boxOf = async (png: Buffer) => { const meta = await sharp(png).metadata(); return maskBox(await band(sharp(png).greyscale()), meta.width!, meta.height!).box; };
const image = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: '#808080' } }).png().toBuffer();
const noSave = () => undefined;

describe('SAM-3: one request per product, and the candidate that matches the product\'s region', () => {
  it('takes the matching instance over a better-scored one of another product of the same kind', async () => {
    const left = { x: 100, y: 200, width: 200, height: 400 }, right = { x: 650, y: 200, width: 200, height: 400 };
    // The first product's request answers with both phones: the other one first, and better scored.
    const [rightPng, leftPng] = await Promise.all([rectMask(1000, 800, right), rectMask(1000, 800, left)]);
    const answers = falSegmentation((_input, n) => n === 0 ? { masks: [rightPng, leftPng], scores: [0.95, 0.8] } : { masks: [rightPng], scores: [0.9] });
    const result = await liveSegmenter('sam3', () => answers.transport).segment({ image: await image(1000, 800), width: 1000, height: 800,
      targets: [{ label: 'smartphone', box: { x: 95, y: 190, width: 210, height: 420 } }, { label: 'smartphone', box: { x: 640, y: 195, width: 215, height: 410 } }] }, noSave);
    expect(answers.submitted).toHaveLength(2);
    expect(answers.submitted.map(s => s.prompt)).toEqual(['smartphone', 'smartphone']);
    expect((answers.submitted[0].box_prompts as { x_min: number; y_min: number }[])[0]).toMatchObject({ x_min: 95, y_min: 190 });
    expect(result.masks).toHaveLength(2);
    expect(await boxOf(result.masks![0])).toEqual(left);
    expect(await boxOf(result.masks![1])).toEqual(right);
    const all = await boxOf(result.mask);
    expect(all).toEqual({ x: 100, y: 200, width: 750, height: 400 });
    expect(result.requestIds).toEqual(['kit-1', 'kit-2']);
  });

  it('reads a large image at 2048 px and returns each mask aligned at the source size', async () => {
    const product = { x: 600, y: 300, width: 900, height: 1200 }, w = 2048, h = Math.round(2000 * 2048 / 3000);
    const scaled = { x: Math.round(600 * w / 3000), y: Math.round(300 * h / 2000), width: Math.round(900 * w / 3000), height: Math.round(1200 * h / 2000) };
    const png = await rectMask(w, h, scaled);
    const fal = falSegmentation(() => ({ masks: [png], scores: [0.9] }));
    const result = await liveSegmenter('sam3', () => fal.transport).segment({ image: await image(3000, 2000), width: 3000, height: 2000, targets: [{ label: 'speaker', box: product }] }, noSave);
    // The box is sent at the size SAM-3 reads (the image is uploaded at 2048 px on its long side).
    expect((fal.submitted[0].box_prompts as { x_min: number; y_min: number; x_max: number; y_max: number }[])[0]).toEqual({ x_min: scaled.x, y_min: scaled.y, x_max: scaled.x + scaled.width, y_max: scaled.y + scaled.height });
    const box = (await boxOf(result.masks![0]))!;
    for (const key of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(box[key] - product[key])).toBeLessThanOrEqual(4);
  });
});

describe('BiRefNet: one matte of the whole image, kept only at the chosen products', () => {
  it('splits the matte between the chosen products and drops a salient object nobody chose', async () => {
    const a = { x: 80, y: 100, width: 220, height: 300 }, b = { x: 500, y: 150, width: 200, height: 250 }, unchosen = { x: 820, y: 600, width: 150, height: 150 };
    const matte = await rectMask(1000, 800, a, b, unchosen);
    const fal = falSegmentation(() => ({ masks: [matte] }));
    const result = await liveSegmenter('birefnet', () => fal.transport).segment({ image: await image(1000, 800), width: 1000, height: 800,
      targets: [{ label: 'mixer', box: { x: 85, y: 105, width: 210, height: 290 } }, { label: 'kettle', box: { x: 505, y: 160, width: 190, height: 240 } }] }, noSave);
    expect(fal.submitted).toHaveLength(1);
    expect(fal.submitted[0]).not.toHaveProperty('box_prompts');
    expect(await boxOf(result.masks![0])).toEqual(a);
    expect(await boxOf(result.masks![1])).toEqual(b);
    expect(await boxOf(result.mask)).toEqual({ x: 80, y: 100, width: 620, height: 300 });
  });
});
