import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { extractVisibleLayers } from './extract.js';
async function compositeLayers(width: number, height: number, layers: {rgba: Buffer; bbox: {x:number;y:number}}[]) { return sharp({create:{width,height,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite(layers.map(layer=>({input:layer.rgba,left:layer.bbox.x,top:layer.bbox.y}))).png().toBuffer(); }
import { decodeRgba } from '../image/extract.js';
import { decodeMask } from '../image/masks.js';
import { personHoldingBoardFixture } from '../image/syntheticFixtures.js';

describe('phase 06 native pixel extraction', () => {
  it('preserves every opaque source RGB byte, placement and residual coverage in an independently composed image', async () => {
    const { image, board, person, thin } = await personHoldingBoardFixture();
    const result = await extractVisibleLayers(image, [{ id: 'board', label: 'Board', mask: board }, { id: 'person', label: 'Person', mask: person }, { id: 'thin', label: 'Thin disconnected object', mask: thin }]);
    const source = await decodeRgba(image);
    for (const layer of result.layers) {
      const pixels = await decodeRgba(layer.rgba), alpha = await decodeMask(layer.alpha, { encoding: 'luminance' }), ownership = await decodeMask(layer.visibleOwnership, { encoding: 'luminance' });
      expect([pixels.width, pixels.height]).toEqual([layer.bbox.width, layer.bbox.height]);
      expect([alpha.width, alpha.height]).toEqual([pixels.width, pixels.height]);
      expect([ownership.width, ownership.height]).toEqual([pixels.width, pixels.height]);
      for (let y = 0; y < pixels.height; y++) for (let x = 0; x < pixels.width; x++) {
        const i = (y * pixels.width + x) * 4;
        if (pixels.data[i + 3] === 255) expect(pixels.data.subarray(i, i + 3)).toEqual(source.data.subarray(((y + layer.bbox.y) * source.width + x + layer.bbox.x) * 4, ((y + layer.bbox.y) * source.width + x + layer.bbox.x) * 4 + 3));
      }
      expect(pixels.data.some((value, index) => index % 4 === 3 && value === 0)).toBe(true);
    }
    expect(result.residual).not.toBeNull();
    const composite = await compositeLayers(source.width, source.height, [...(result.residual ? [result.residual] : []), ...result.layers]);
    expect((await decodeRgba(composite)).data).toEqual(source.data);
  });

  it('uses straight source RGB and multiplies alpha exactly once, retaining residual for soft edges', async () => {
    const pixels = Buffer.from([200, 100, 20, 128, 90, 80, 70, 255, 0, 0, 0, 0]);
    const image = await sharp(pixels, { raw: { width: 3, height: 1, channels: 4 } }).png().toBuffer();
    const mask = { width: 3, height: 1, data: new Uint8Array([128, 255, 0]) };
    const result = await extractVisibleLayers(image, [{ id: 'one', label: 'One', mask }], 0);
    const decoded = await decodeRgba(result.layers[0].rgba);
    expect(Array.from(decoded.data.subarray(0, 4))).toEqual([200, 100, 20, 64]);
    const composite = await decodeRgba(await compositeLayers(3, 1, [...(result.residual ? [result.residual] : []), ...result.layers]));
    // libvips integer premultiplication may round recomposed soft channels by one.
    // The extracted straight RGB and alpha above remain exact.
    expect(Math.max(...composite.data.map((value, i) => Math.abs(value - pixels[i])))).toBeLessThanOrEqual(1);
  });

});
