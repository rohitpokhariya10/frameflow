/**
 * The stage in REAL gpt-image-2 artwork (the approved live check, 2026-10-22; tests/fixtures/recorded/), found locally:
 * values measured by eye on the pictures (the podium's centre, half-width, top-surface centre line and half-depth).
 * The 9:16 one is a top surface on an ornate front band: the surface, not the band, must be found.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { findStage } from '../../server/src/decomposition/protectedTemplates/product/stage.js';
import { zonesOf, type ProductComposition } from '../../server/src/decomposition/protectedTemplates/product/composition.js';
import { HAS_PRIVATE_FIXTURES } from './privateFixtures.js';

const R = 'tests/fixtures/recorded/gpt-image-2-ganesh';
const area = (composition: ProductComposition, canvas: { width: number; height: number }) => {
  const Z = zonesOf(composition, canvas), x0 = Math.max(0, Math.min(Z.products.x, Z.character.x) - canvas.width * 0.08), x1 = Math.min(canvas.width, Math.max(Z.products.x + Z.products.width, Z.character.x + Z.character.width) + canvas.width * 0.08), y0 = Math.min(Z.products.y, Z.character.y);
  return { x: x0, y: y0, width: x1 - x0, height: canvas.height * 0.97 - y0 };
};

describe('the stage in new artwork', { timeout: 60_000 }, () => {
  for (const [file, composition, canvas, want] of [
    ['16x9', 'split-left', { width: 1077, height: 606 }, { cx: 790, cy: 471, a: 265, b: 24 }],
    ['9x16', 'stage-bottom', { width: 607, height: 1079 }, { cx: 302, cy: 477, a: 253, b: 23 }],
    ['1x1', 'stage-top', { width: 607, height: 606 }, { cx: 304, cy: 455, a: 286, b: 15 }],
  ] as const) it.skipIf(!HAS_PRIVATE_FIXTURES)(`finds the podium's top surface in the real ${file} artwork`, async () => {
    const stage = await findStage(readFileSync(`${R}-${file}-2026-10-22.png`), area(composition, canvas));
    expect(stage).toBeTruthy();
    expect(Math.abs(stage!.cx - want.cx)).toBeLessThanOrEqual(30);
    expect(Math.abs(stage!.cy - want.cy)).toBeLessThanOrEqual(12);
    expect(Math.abs(stage!.a - want.a)).toBeLessThanOrEqual(60);
    expect(Math.abs(stage!.b - want.b)).toBeLessThanOrEqual(12);
  });
  it('finds no stage in artwork without one', async () => {
    const plain = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fde68a"/><stop offset="1" stop-color="#f59e0b"/></linearGradient></defs><rect width="600" height="600" fill="url(#g)"/></svg>')).png().toBuffer();
    expect(await findStage(plain, area('stage-top', { width: 600, height: 600 }))).toBeNull();
  });
});
