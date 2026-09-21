import { describe, expect, it } from 'vitest';
import { imagePlacement } from './BackgroundArtwork';

describe('artwork fit in logical canvas coordinates', () => {
  it.each([
    [{ width: 1024, height: 1024 }, { width: 1600, height: 900 }],
    [{ width: 1600, height: 900 }, { width: 1080, height: 1920 }],
    [{ width: 1024, height: 1280 }, { width: 1080, height: 1350 }],
  ])('covers %o onto %o without stretching', (image, canvas) => {
    const placed = imagePlacement(image, canvas, 'cover');
    expect(placed.width / placed.height).toBeCloseTo(image.width / image.height);
    expect(placed.x).toBeLessThanOrEqual(0);
    expect(placed.y).toBeLessThanOrEqual(0);
    expect(placed.x + placed.width).toBeGreaterThanOrEqual(canvas.width);
    expect(placed.y + placed.height).toBeGreaterThanOrEqual(canvas.height);
    expect(placed.x + placed.width / 2).toBeCloseTo(canvas.width / 2);
    expect(placed.y + placed.height / 2).toBeCloseTo(canvas.height / 2);
  });

  it('contains an image with centered letterboxing when requested', () => {
    expect(imagePlacement({ width: 100, height: 100 }, { width: 1600, height: 900 }, 'contain')).toEqual({ x: 350, y: 0, width: 900, height: 900 });
  });

  it('uses normalized focal points to anchor a cover crop', () => {
    const image = { width: 1600, height: 900 }, canvas = { width: 900, height: 900 };
    expect(imagePlacement(image, canvas, 'cover', { x: 0, y: 0 }).x).toBeCloseTo(0);
    const right = imagePlacement(image, canvas, 'cover', { x: 1, y: 1 });
    expect(right.x + right.width).toBe(canvas.width);
    expect(right.width / right.height).toBeCloseTo(image.width / image.height);
  });
});
