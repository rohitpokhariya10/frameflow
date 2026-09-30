import { expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { segmentObjects } from './segmentation.js';
import { refineObjects } from './refinement.js';
import { emptyMask, encodeMask, unionMasks, measureMask } from '../image/masks.js';
import { nativePointer } from '@frameflow/shared';
import type { Infer } from '../providers/inference.js';
function rect(x: number, y: number, w: number, h: number, width = 256, height = 256) {
  const mask = emptyMask(width, height);
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) mask.data[yy * width + xx] = 255;
  return mask;
}
it('synthesizes registered proposal support from SAM fragments with provenance, retaining raw options', async () => {
  const head = rect(70, 20, 40, 40), torso = rect(50, 60, 90, 130), phone = rect(140, 90, 25, 35);
  const complete = unionMasks(unionMasks(head, torso), phone);
  const source = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#abcdef' } }).png().toBuffer();
  const result = await segmentObjects(source, async () => Promise.all([head, torso, phone].map(encodeMask)), { proposals: [{ id: 'proposal-1', label: 'Object 1', rgba: source, width: 256, height: 256, alpha: complete, registered: true, warnings: [] }] });
  const group = result.candidates.find(c => c.source === 'synthesized')!;
  expect(group.sourceCandidateIds).toEqual(expect.arrayContaining(['candidate-1', 'candidate-2', 'candidate-3']));
  expect(group.proposalId).toBe('proposal-1');
  expect(group.mask.data).toEqual(complete.data);
  expect(result.candidates.filter(c => c.source === 'sam2')).toHaveLength(3);
  const unregistered = await segmentObjects(source, async () => Promise.all([head, torso].map(encodeMask)), { proposals: [{ id: 'shifted', label: 'Object 1', rgba: source, width: 256, height: 256, alpha: complete, registered: false, warnings: ['PROPOSAL_GEOMETRY_MISMATCH'] }] });
  expect(unregistered.candidates.some(c => c.source === 'synthesized')).toBe(false);
});
it('maps a letterboxed UI missing-region point through native to rounded model pixels, and excludes negative support', async () => {
  const width = 1201, height = 1501;
  const source = await sharp({ create: { width, height, channels: 3, background: '#abcdef' } }).png().toBuffer();
  const partial = rect(300, 250, 300, 300, width, height);
  // A valid positive on a missing phone: displayed in a 600x600 letterboxed container.
  const scale = 600 / height, left = 10 + (600 - width * scale) / 2;
  const point = nativePointer(left + 850 * scale, 20 + 900 * scale, { left: 10, top: 20, width: 600, height: 600 }, width, height)!;
  const infer = vi.fn<Infer>(async (_model, request) => {
    expect(request.points).toContainEqual({ x: Math.floor((point.x + 0.5) * request.transform!.scaleX), y: Math.floor((point.y + 0.5) * request.transform!.scaleY), label: 1 });
    expect(request.transform!.crop).toEqual({ x: 0, y: 0, width, height });
    const t = request.transform!;
    const output = rect(180, 140, 420, 530, t.modelWidth, t.modelHeight);
    return [await encodeMask(output)];
  });
  const result = await refineObjects(source, infer, [{ id: 'chosen', label: 'person_with_phone', mask: partial, ownershipConfirmed: true, correctionMode: true, softEdges: false, points: [{ ...point, label: 1 }, { x: 10, y: 10, label: 0 }] }]);
  expect(infer).toHaveBeenCalledTimes(1);
  expect(result.objects[0].refinementAccepted).toBe(true);
  expect(measureMask(result.objects[0].visibleOwnership).area).toBeGreaterThan(measureMask(partial).area);
  expect(result.objects[0].visibleOwnership.data[10 * width + 10]).toBe(0);
  expect(result.warnings).not.toContain('POSITIVE_POINT_OUTSIDE_MASK');
});
it('rejects invalid source coordinates before any inference, including a later object', async () => {
  const source = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#abcdef' } }).png().toBuffer();
  const infer = vi.fn<Infer>();
  await expect(refineObjects(source, infer, [{ id: 'one', label: 'person', mask: rect(10, 10, 20, 20) }, { id: 'two', label: 'phone', mask: rect(100, 100, 20, 20), correctionMode: true, points: [{ x: 256, y: 2, label: 1 }] }])).rejects.toMatchObject({ code: 'GUIDANCE_BOUNDS' });
  expect(infer).not.toHaveBeenCalled();
});
it('rejects pathological expansion and negative/confirmed-neighbor leaks without rerolls', async () => {
  const source = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#abcdef' } }).png().toBuffer();
  for (const output of [rect(0, 0, 255, 256), rect(10, 10, 100, 100), rect(40, 40, 100, 100)]) {
    const infer = vi.fn<Infer>(async () => [await encodeMask(output)]);
    const result = await refineObjects(source, infer, [{ id: 'target', label: 'selected target', mask: rect(50, 50, 20, 20), correctionMode: true, ownershipConfirmed: true, points: [{ x: 60, y: 60, label: 1 }, { x: 15, y: 15, label: 0 }], excludedMask: rect(120, 120, 10, 10) }]);
    expect(result.objects[0].refinementAccepted).toBe(false);
    expect(infer).toHaveBeenCalledTimes(1);
  }
});
it('allows a negative point inside old support to remove that region during correction', async () => {
  const source = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#abcdef' } }).png().toBuffer();
  const old = rect(40, 40, 80, 80), corrected = rect(70, 40, 80, 80);
  const infer = vi.fn<Infer>(async () => [await encodeMask(corrected)]);
  const result = await refineObjects(source, infer, [{ id: 'target', label: 'selected object', mask: old, correctionMode: true, ownershipConfirmed: true, points: [{ x: 130, y: 80, label: 1 }, { x: 50, y: 80, label: 0 }] }]);
  expect(result.objects[0].refinementAccepted).toBe(true);
  expect(result.objects[0].visibleOwnership.data[80 * 256 + 50]).toBe(0);
  expect(result.objects[0].visibleOwnership.data[80 * 256 + 130]).toBe(255);
  expect(infer).toHaveBeenCalledTimes(1);
});
