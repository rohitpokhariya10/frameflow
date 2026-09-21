import { describe, expect, it } from 'vitest';
import { CANVAS_PRESETS, validateCanvasSize } from './index';

describe('canvas dimension contract', () => {
  it.each(CANVAS_PRESETS)('accepts the $name preset', ({ width, height }) => {
    expect(validateCanvasSize(width, height)).toEqual({ valid: true, size: { width, height } });
  });
  it.each(['', ' ', '0', '-400', '1080.5', '1080.0', 'NaN', 'Infinity', '1e3', '0x400', '256px', '255', '4097', NaN, Infinity, -Infinity, 300.5])('rejects invalid side %s', (side) => {
    expect(validateCanvasSize(side, 1080).valid).toBe(false);
    expect(validateCanvasSize(1080, side).valid).toBe(false);
  });
  it('accepts both side boundaries and the exact area boundary', () => {
    for (const [width, height] of [[256, 256], [4096, 256], [3000, 4000]]) {
      expect(validateCanvasSize(width, height).valid).toBe(true);
    }
    expect(validateCanvasSize(3001, 4000)).toMatchObject({ valid: false, errors: { area: expect.any(String) } });
    expect(validateCanvasSize(4096, 4096).valid).toBe(false);
  });
});
