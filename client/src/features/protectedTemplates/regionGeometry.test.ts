import { describe, expect, it } from 'vitest';
import { boxCorners } from '@frameflow/shared';
import { drawnBox, fitView, handlePoint, nudge, resizeBox, rotateTowards, snapBox, toLocal, zoomView } from './regionGeometry';

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe('region editor geometry (source pixels)', () => {
  it('resizes from any handle, keeping the opposite edge fixed, also when rotated', () => {
    const start = { x: 100, y: 100, width: 200, height: 100, rotation: 0 };
    expect(resizeBox(start, 'se', { x: 350, y: 260 })).toEqual({ x: 100, y: 100, width: 250, height: 160, rotation: 0 });
    expect(resizeBox(start, 'w', { x: 40, y: 500 })).toEqual({ x: 40, y: 100, width: 260, height: 100, rotation: 0 });
    // Past the opposite edge it stops at the minimum size instead of flipping.
    expect(resizeBox(start, 'e', { x: 0, y: 150 })).toMatchObject({ x: 100, width: 4 });
    const rotated = { ...start, rotation: 30 };
    const fixed = boxCorners(rotated)[0]; // the top-left corner, opposite the bottom-right handle
    const grown = resizeBox(rotated, 'se', handlePoint({ ...rotated, width: 260, height: 140, x: rotated.x, y: rotated.y }, 'se'));
    const after = boxCorners(grown)[0];
    close(after[0], fixed[0]); close(after[1], fixed[1]);
    expect(grown.rotation).toBe(30);
  });
  it('puts the rotate handle above the top edge\'s centre, also when rotated', () => {
    expect(handlePoint({ x: 100, y: 100, width: 200, height: 100, rotation: 0 }, 'rotate', 20)).toEqual({ x: 200, y: 80 });
    const p = handlePoint({ x: 100, y: 100, width: 200, height: 100, rotation: 90 }, 'rotate', 20);
    close(p.x, 270); close(p.y, 150);
    expect(handlePoint({ x: 0, y: 0, width: 10, height: 10, rotation: 0 }, 'se')).toEqual({ x: 10, y: 10 });
  });
  it('rotates towards the pointer, with 15° steps on request, and maps points into the box frame', () => {
    const b = { x: 0, y: 0, width: 100, height: 100, rotation: 0 };
    expect(rotateTowards(b, { x: 50, y: -100 }).rotation).toBe(0);
    expect(rotateTowards(b, { x: 150, y: 50 }).rotation).toBe(90);
    // 58° from the top (dx 100, dy −62.5 about the centre) snaps to 60°.
    expect(rotateTowards(b, { x: 150, y: -12.5 }, true).rotation).toBe(60);
    const local = toLocal({ ...b, rotation: 90 }, { x: 50, y: 0 });
    close(local.x, -50); close(local.y, 0);
  });
  it('draws from any two corners and snaps to the canvas, other regions and whole pixels', () => {
    expect(drawnBox({ x: 300, y: 80 }, { x: 100.4, y: 20 })).toEqual({ x: 100.4, y: 20, width: 199.6, height: 60, rotation: 0 });
    const size = { width: 1000, height: 800 }, other = { x: 400, y: 300, width: 100, height: 50, rotation: 0 };
    expect(snapBox({ x: 3.4, y: 197.2, width: 50, height: 30, rotation: 0 }, size, [other], 6)).toEqual({ x: 0, y: 197, width: 50, height: 30, rotation: 0 });
    expect(snapBox({ x: 503.5, y: 302, width: 50, height: 30, rotation: 0 }, size, [other], 6)).toEqual({ x: 500, y: 300, width: 50, height: 30, rotation: 0 });
    expect(snapBox({ x: 600.6, y: 600.4, width: 50, height: 30, rotation: 0 }, size, [other], 6)).toEqual({ x: 601, y: 600, width: 50, height: 30, rotation: 0 });
    expect(nudge({ x: 10, y: 10, width: 5, height: 5, rotation: 0 }, 'ArrowLeft', true)).toMatchObject({ x: 0 });
    expect(nudge({ x: 10, y: 10, width: 5, height: 5, rotation: 0 }, 'a', false)).toBeUndefined();
  });
  it('fits, zooms about the pointer and clamps the zoom range', () => {
    const fit = fitView({ width: 1820, height: 2420 }, 1);
    expect(fit).toEqual({ x: -300, y: 0, width: 2420, height: 2420 });
    const anchor = { x: 910, y: 1210 }, zoomed = zoomView(fit, 2, anchor, fit);
    // The anchor keeps its place in the viewport.
    close((anchor.x - zoomed.x) / zoomed.width, (anchor.x - fit.x) / fit.width);
    expect(zoomed.width).toBe(1210);
    expect(zoomView(fit, 1000, anchor, fit).width).toBeCloseTo(2420 / 32, 6);
  });
});
