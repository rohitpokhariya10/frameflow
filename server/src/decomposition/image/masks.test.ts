import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { applyBrush, constrainMatte, decodeMask, deduplicateMasks, emptyMask, encodeMask, measureMask, morphMask, overlapMasks, resizeMask, unionMasks, validateGuidance } from './masks.js';
import { personHoldingBoardFixture } from './syntheticFixtures.js';

describe('mask encoding and ownership', () => {
  it('distinguishes opaque grayscale from alpha cutouts, supports inversion and binary center sampling', async () => {
    const grayscale = await sharp(Buffer.from([0, 64, 192, 255]), { raw: { width: 2, height: 2, channels: 1 } }).png().toBuffer();
    expect((await decodeMask(grayscale, { encoding: 'luminance' })).data).toEqual(new Uint8Array([0, 64, 192, 255]));
    expect((await decodeMask(grayscale, { encoding: 'luminance', binary: true, invert: true })).data).toEqual(new Uint8Array([255, 255, 0, 0]));
    const cutout = await sharp(Buffer.from([255, 255, 255, 0, 0, 0, 0, 128]), { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
    expect((await decodeMask(cutout, { encoding: 'alpha' })).data).toEqual(new Uint8Array([0, 128]));
    const mask = { width: 2, height: 2, data: new Uint8Array([0, 255, 255, 0]) };
    const up = resizeMask(mask, 5, 3);
    expect(new Set(up.data)).toEqual(new Set([0, 255]));
    expect(up.data[4]).toBe(255); expect(up.data[10]).toBe(255);
    expect((await decodeMask(await encodeMask(mask), { encoding: 'luminance' })).data).toEqual(mask.data);
    expect(validateGuidance(emptyMask(8, 8), {})).toContain('EMPTY_MASK');
    expect(validateGuidance(emptyMask(8, 8, 255), {})).toContain('FULL_CANVAS_MASK');
  });

  it('detects duplicate/nested candidates without deleting disconnected pieces or confusing board ownership', async () => {
    const fixture = await personHoldingBoardFixture();
    const duplicate = { ...fixture.board, data: fixture.board.data.slice() };
    const enclosing = unionMasks(fixture.board, fixture.person);
    const result = deduplicateMasks([{ id: 'board', mask: fixture.board }, { id: 'copy', mask: duplicate }, { id: 'person', mask: fixture.person }, { id: 'enclosing', mask: enclosing }, { id: 'thin', mask: fixture.thin }]);
    expect(result.rejected).toEqual([{ id: 'copy', reason: 'DUPLICATE_MASK', duplicateOf: 'board' }]);
    expect(result.nested).toContainEqual(['board', 'enclosing']);
    expect(measureMask(fixture.thin)).toMatchObject({ area: 124, componentCount: 2 });
    expect(overlapMasks(fixture.board, fixture.person).intersection).toBe(0);
    expect(validateGuidance(fixture.board, { positivePoints: [{ x: 150, y: 200 }], negativePoints: [{ x: 150, y: 50 }, { x: 72, y: 200 }], excludedMask: fixture.exclusions })).toEqual([]);
    expect(validateGuidance(enclosing, { excludedMask: fixture.exclusions })).toContain('PROTECTED_REGION_LEAK');
  });

  it('constrains a matte to the uncertainty band while protecting face/fingers and preserving certain foreground', async () => {
    const { board, exclusions } = await personHoldingBoardFixture();
    const alpha = constrainMatte(board, emptyMask(board.width, board.height, 128), 2, exclusions);
    expect(alpha.data[200 * board.width + 150]).toBe(255);
    expect(alpha.data[162 * board.width + 150]).toBe(128);
    expect(alpha.data[50 * board.width + 150]).toBe(0);
    expect(alpha.data[200 * board.width + 72]).toBe(0);
    expect(alpha.data[10]).toBe(0);
    const point = emptyMask(9, 9); point.data[40] = 255;
    expect(measureMask(morphMask(point, 1, 'dilate')).area).toBe(9);
    expect(measureMask(morphMask(morphMask(point, 1, 'dilate'), 1, 'erode')).area).toBe(1);
  });

  it('interpolates native brush strokes, makes a new mask and rejects unbounded review input', () => {
    const mask = emptyMask(32, 32);
    const result = applyBrush(mask, [{ mode: 'add', radius: 2, points: [{ x: 5, y: 5 }, { x: 25, y: 25 }] }, { mode: 'subtract', radius: 3, points: [{ x: 15, y: 15 }] }]);
    expect(result.data[10 * 32 + 10]).toBe(255);
    expect(result.data[15 * 32 + 15]).toBe(0);
    expect(mask.data.every(value => value === 0)).toBe(true);
    expect(() => applyBrush(mask, [{ mode: 'add', radius: 300, points: [] }])).toThrow(/radius/);
  });
});
