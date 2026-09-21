import { describe, expect, it } from 'vitest';
import { CANVAS_PRESETS } from '@frameflow/shared';
import { calculateFitZoom, VIEWPORT } from './viewport';

describe('logical canvas viewport fit', () => {
  it.each(CANVAS_PRESETS)('keeps $name fully visible at 1366 × 768 and 1440 × 900', (canvas) => {
    for (const viewport of [{ width: 838, height: 601 }, { width: 912, height: 733 }]) {
      const zoom = calculateFitZoom(canvas, viewport);
      expect(canvas.width * zoom + VIEWPORT.padding * 2).toBeLessThanOrEqual(viewport.width + 0.001);
      expect(canvas.height * zoom + VIEWPORT.padding * 2).toBeLessThanOrEqual(viewport.height + 0.001);
    }
  });
  it('fits the largest area and extreme aspect ratios without changing the input', () => {
    for (const canvas of [{ width: 3000, height: 4000 }, { width: 4096, height: 256 }, { width: 256, height: 4096 }]) {
      const original = { ...canvas };
      const zoom = calculateFitZoom(canvas, { width: 838, height: 601 });
      expect(zoom).toBeGreaterThan(0);
      expect(canvas.width * zoom).toBeLessThanOrEqual(742);
      expect(canvas.height * zoom).toBeLessThanOrEqual(505);
      expect(canvas).toEqual(original);
    }
  });
  it('recalculates for a smaller workspace and never enlarges small canvases above 100%', () => {
    const canvas = { width: 1080, height: 1350 };
    expect(calculateFitZoom(canvas, { width: 838, height: 601 })).toBeLessThan(calculateFitZoom(canvas, { width: 912, height: 733 }));
    expect(calculateFitZoom({ width: 256, height: 256 }, { width: 1000, height: 1000 })).toBe(1);
  });
});
