import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { createLayerProposals } from './proposals.js';
import { segmentObjects } from './segmentation.js';
import { refineObjects } from './refinement.js';
import { emptyMask, encodeMask, overlapMasks } from '../image/masks.js';
import type { Mask } from '../image/masks.js';
import type { Infer } from '../providers/inference.js';
import { ProviderError } from '../providers/adapters.js';

function rect(mask: Mask, x: number, y: number, width: number, height: number) {
  for (let yy = y; yy < y + height; yy++) for (let xx = x; xx < x + width; xx++) mask.data[yy * mask.width + xx] = 255;
  return mask;
}
async function fixture() {
  const width = 128, height = 96;
  const board = rect(emptyMask(width, height), 34, 45, 60, 26);
  const person = rect(emptyMask(width, height), 45, 10, 35, 26);
  rect(person, 38, 36, 54, 45);
  const exclusions = rect(emptyMask(width, height), 45, 10, 35, 26);
  rect(exclusions, 32, 51, 7, 11); rect(exclusions, 89, 49, 8, 11);
  for (let i = 0; i < board.data.length; i++) {
    if (exclusions.data[i]) board.data[i] = 0;
    if (board.data[i]) person.data[i] = 0;
  }
  // A disconnected selected detail must survive candidate selection and refinement.
  rect(board, 95, 72, 2, 2);
  const source = await sharp({ create: { width, height, channels: 3, background: '#789abc' } }).png().toBuffer();
  return { width, height, board, person, exclusions, source, boardPng: await encodeMask(board), personPng: await encodeMask(person) };
}

describe('phase 03 proposal geometry', () => {
  it('records actual geometry, alpha support and generic labels without accepting proposal RGB', async () => {
    const f = await fixture();
    const rgba = await sharp(f.source).joinChannel(Buffer.from(f.board.data), { raw: { width: f.width, height: f.height, channels: 1 } }).png().toBuffer();
    const shiftedSize = await sharp(rgba).resize(64, 48).png().toBuffer();
    const result = await createLayerProposals(f.source, async () => [rgba, shiftedSize]);
    expect(result.proposals[0]).toMatchObject({ label: 'Object 1', width: 128, height: 96, registered: true });
    expect(result.proposals[1]).toMatchObject({ width: 64, height: 48, registered: false });
    expect(result.warnings).toContain('PROPOSAL_UNRELIABLE');
    expect(result.proposals[0].alpha.data).toEqual(f.board.data);
  });
  it('allows source segmentation fallback for invalid proposals but never retries safety/auth', async () => {
    const f = await fixture();
    await expect(createLayerProposals(f.source, async () => { throw new ProviderError('PROVIDER_EMPTY_OUTPUT', 'empty'); })).resolves.toMatchObject({ proposals: [], warnings: ['PROPOSAL_UNRELIABLE', 'PROVIDER_EMPTY_OUTPUT'] });
    await expect(createLayerProposals(f.source, async () => { throw new ProviderError('PROVIDER_SAFETY_REFUSAL', 'refused'); })).rejects.toMatchObject({ code: 'PROVIDER_SAFETY_REFUSAL' });
  });
});

describe('phase 04 visible ownership', () => {
  it('retains board/person separation and disconnected pixels, deduplicates and requires generic ownership review', async () => {
    const f = await fixture();
    const result = await segmentObjects(f.source, async () => [f.boardPng, f.personPng, f.boardPng]);
    expect(result.candidates).toHaveLength(2);
    expect(result.rejected).toContainEqual(expect.objectContaining({ reason: 'DUPLICATE_MASK' }));
    expect(result.candidates[0].statistics.componentCount).toBe(2);
    expect(overlapMasks(result.candidates[0].mask, f.exclusions).intersection).toBe(0);
    expect(result.reviewRequired).toBe(true);
    expect(result.warnings).toContain('OWNERSHIP_CONFIRMATION_REQUIRED');
  });
  it('rejects automatic board face/finger leaks with an actionable review state', async () => {
    const f = await fixture();
    const leakingBoard = rect(emptyMask(f.width, f.height), 32, 10, 65, 71);
    const infer: Infer = async model => model === 'sam2' ? [f.personPng] : [await encodeMask(leakingBoard)];
    const result = await segmentObjects(f.source, infer, { targets: [{ label: 'board', excludedMask: f.exclusions, points: [{ x: 50, y: 55, label: 1 }, { x: 60, y: 20, label: 0 }, { x: 35, y: 55, label: 0 }] }] });
    expect(result.reviewRequired).toBe(true);
    expect(result.warnings).toContain('NEGATIVE_GUIDANCE_LEAK');
    expect(result.warnings).toContain('PROTECTED_REGION_LEAK');
  });
  it('asks for selection when cap is exceeded without deleting candidate options', async () => {
    const f = await fixture();
    const result = await segmentObjects(f.source, async () => [f.boardPng, f.personPng], { maxObjects: 1 });
    expect(result.candidates).toHaveLength(2);
    expect(result.selectedIds).toEqual([]);
    expect(result.warnings).toContain('OBJECT_SELECTION_REQUIRED');
  });
});

describe('phase 05 contextual refinement', () => {
  it('maps native guidance through a padded crop and retains protected face/fingers', async () => {
    const f = await fixture();
    const infer = vi.fn<Infer>(async (model, request) => {
      expect(model).toBe('sam3');
      const info = await sharp(request.image).metadata();
      expect(info.width).toBeLessThan(f.width);
      // Crop bounds: board x 34..97, padded 16 => x18..113. Face point extends top to16.
      const left = 18, top = 16;
      expect(request.points).toContainEqual({ x: 50 - left, y: 55 - top, label: 1 });
      expect(request.points).toContainEqual({ x: 60 - left, y: 20 - top, label: 0 });
      const output = await sharp(f.boardPng).extract({ left, top, width: info.width!, height: info.height! }).png().toBuffer();
      return [output];
    });
    const result = await refineObjects(f.source, infer, [{ id: 'board', label: 'board', mask: f.board, excludedMask: f.exclusions, ownershipConfirmed: true, points: [{ x: 50, y: 55, label: 1 }, { x: 60, y: 20, label: 0 }, { x: 35, y: 55, label: 0 }] }]);
    expect(result.objects[0].refinementAccepted).toBe(true);
    expect(result.objects[0].visibleOwnership.data).toEqual(f.board.data);
    expect(overlapMasks(result.objects[0].visibleOwnership, f.exclusions).intersection).toBe(0);
    expect(result.reviewRequired).toBe(false);
    expect(infer).toHaveBeenCalledTimes(1);
  });
  it('limits failed corrections, preserves accepted pixels and asks for review', async () => {
    const f = await fixture();
    const infer = vi.fn<Infer>(async (_model, request) => {
      const info = await sharp(request.image).metadata();
      return [await encodeMask(emptyMask(info.width!, info.height!, 255))];
    });
    const result = await refineObjects(f.source, infer, [{ id: 'board', label: 'board', mask: f.board, excludedMask: f.exclusions, ownershipConfirmed: true, points: [{ x: 50, y: 55, label: 1 }, { x: 60, y: 20, label: 0 }, { x: 35, y: 55, label: 0 }] }]);
    expect(result.objects[0].refinementAccepted).toBe(false);
    expect(result.objects[0].visibleOwnership.data).toEqual(f.board.data);
    expect(result.reviewRequired).toBe(true);
    expect(infer).toHaveBeenCalledTimes(2);
  });
  it('uses BiRefNet only inside a local uncertainty band without an invented trimap input', async () => {
    const width = 80, height = 80;
    const support = rect(emptyMask(width, height), 25, 25, 30, 30);
    const source = await sharp({ create: { width, height, channels: 3, background: '#ff8899' } }).png().toBuffer();
    const infer = vi.fn<Infer>(async (model, request) => {
      const metadata = await sharp(request.image).metadata();
      expect(request).not.toHaveProperty('trimap');
      if (model === 'sam3') return [await encodeMask(rect(emptyMask(metadata.width!, metadata.height!), 16, 16, 30, 30))];
      expect(model).toBe('birefnet');
      return [await encodeMask(emptyMask(metadata.width!, metadata.height!, 128))];
    });
    const result = await refineObjects(source, infer, [{ id: 'hair', label: 'person with loose hair', mask: support, ownershipConfirmed: true, softEdges: true }]);
    expect(result.objects[0].alpha.data[40 * width + 40]).toBe(255);
    expect(result.objects[0].alpha.data[5 * width + 5]).toBe(0);
    expect(result.objects[0].alpha.data[25 * width + 25]).toBe(128);
    expect(result.warnings).toContain('SOFT_EDGE_VISUAL_REVIEW_REQUIRED');
  });
});
