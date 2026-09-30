import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { createAnalysis } from './analysis.js';
import { normalizeSource } from './source.js';
import { createTransform, modelToNative, nativeToModel, modelRectToNative } from '../image/coordinates.js';
import { emptyMask, mapMaskToNative } from '../image/masks.js';

describe('phase 02 coordinate fidelity', () => {
  it.each([[511, 997], [1920, 1080], [3840, 2160], [257, 259]])('preserves aspect and native placement for %i×%i', async (width, height) => {
    const input = await sharp({ create: { width, height, channels: 4, background: '#77554480' } }).png().toBuffer();
    const result = await createAnalysis(input);
    expect(result.transform.scaleX).toBe(result.width / width);
    expect(result.transform.scaleY).toBe(result.height / height);
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(1024);
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(Math.max(width, height));
    for (const point of [{ x: 0.5, y: 0.5 }, { x: width - 0.5, y: height - 0.5 }]) {
      const restored = modelToNative(nativeToModel(point, result.transform), result.transform);
      expect(restored.x).toBeCloseTo(point.x, 9); expect(restored.y).toBeCloseTo(point.y, 9);
    }
    expect((await sharp(result.analysis).metadata()).hasAlpha).toBe(false);
    expect((await sharp(result.preview).metadata()).hasAlpha).toBe(true);
  });

  it('unpads first and maps binary border pixels into the native crop without stretching', () => {
    const transform = createTransform(511, 997, 127, { x: 15, y: 23, width: 103, height: 207 }, { left: 3, top: 5, right: 4, bottom: 6 });
    const mask = emptyMask(transform.modelWidth, transform.modelHeight, 255);
    const restored = mapMaskToNative(mask, transform);
    expect(restored.data[23 * 511 + 15]).toBe(255);
    expect(restored.data[229 * 511 + 117]).toBe(255);
    expect(restored.data[230 * 511 + 117]).toBe(0);
    expect(restored.data[23 * 511 + 14]).toBe(0);
    expect(modelRectToNative({ x: 3, y: 5, width: transform.resizedWidth, height: transform.resizedHeight }, transform)).toEqual(transform.crop);
    expect(() => mapMaskToNative(emptyMask(20, 20), transform)).toThrow(/dimensions differ/);
  });

  it('uses oriented master dimensions for analysis and no upscale for small sources', async () => {
    const input = await sharp({ create: { width: 320, height: 256, channels: 3, background: '#112233' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const source = await normalizeSource(input), result = await createAnalysis(source.master);
    expect([result.width, result.height]).toEqual([256, 320]);
    expect(result.transform.crop).toEqual({ x: 0, y: 0, width: 256, height: 320 });
  });
});
