import { describe, expect, it } from 'vitest';
import { emptyMask } from '../image/masks.js';
import type { Mask } from '../image/types.js';
import { ownershipQuality } from './qualityGate.js';
import { semanticTarget } from './semanticOwnership.js';

const W = 200, H = 250;
function rect(x: number, y: number, w: number, h: number, base: Mask = emptyMask(W, H)): Mask {
  const m = { ...base, data: Uint8Array.from(base.data) };
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) m.data[j * W + i] = 255;
  return m;
}
const codes = (q: ReturnType<typeof ownershipQuality>) => q.checks.map(c => c.code);

describe('ownership quality gate', () => {
  const person = rect(40, 30, 90, 190), phone = rect(120, 120, 40, 25), group = rect(120, 120, 40, 25, person);

  it('passes a valid coherent target that satisfies guidance', () => {
    const q = ownershipQuality(person, { points: [{ x: 80, y: 100, label: 1 }, { x: 180, y: 20, label: 0 }], box: { x: 40, y: 30, width: 90, height: 190 }, provisional: person, providerScore: 0.9 });
    expect(q).toMatchObject({ tier: 'PASS', checks: [] });
  });

  it('fails a tiny patch, even when it is inside the reviewed region', () => {
    expect(codes(ownershipQuality(rect(80, 100, 5, 5)))).toContain('TINY_PATCH');
    const torso = rect(60, 80, 30, 30);
    const q = ownershipQuality(torso, { provisional: person, target: semanticTarget('woman holding phone', 't') });
    expect(q.tier).toBe('FAIL'); expect(codes(q)).toEqual(expect.arrayContaining(['TARGET_INCOMPLETE']));
  });

  it('fails a mask covering more than 90% of the canvas', () => {
    expect(ownershipQuality(rect(0, 0, W, H))).toMatchObject({ tier: 'FAIL' });
    expect(codes(ownershipQuality(rect(0, 0, W, H)))).toEqual(expect.arrayContaining(['MASK_COVERS_MOST_OF_CANVAS', 'MASK_PATHOLOGICAL']));
  });

  it('fails protected-neighbor overlap and negative leaks', () => {
    expect(codes(ownershipQuality(group, { protectedMask: phone }))).toContain('PROTECTED_OWNERSHIP_OVERLAP');
    expect(ownershipQuality(person, { points: [{ x: 80, y: 100, label: 0 }] })).toMatchObject({ tier: 'FAIL', checks: [{ code: 'NEGATIVE_GUIDANCE_LEAK' }] });
    expect(ownershipQuality(person, { points: [{ x: 190, y: 240, label: 1 }] }).tier).toBe('FAIL');
  });

  it('requires every member of a composite target', () => {
    const target = semanticTarget('woman holding phone', 't');
    expect(ownershipQuality(group, { target, members: [person, phone] }).tier).toBe('PASS');
    // Person only (phone missing) and a partial torso both fail the woman+phone target.
    expect(codes(ownershipQuality(person, { target, members: [person, phone] }))).toContain('GROUP_MEMBER_MISSING');
    expect(ownershipQuality(rect(60, 80, 30, 30), { target, members: [person, phone] }).tier).toBe('FAIL');
    expect(ownershipQuality(group, { target, members: [person] })).toMatchObject({ tier: 'REVIEW', checks: [{ code: 'GROUP_MEMBERS_UNVERIFIED' }] });
  });

  it('asks for review on border contact, disjoint pieces, holes, low confidence and manual edits', () => {
    expect(codes(ownershipQuality(rect(0, 50, 60, 100)))).toContain('BORDER_CONTACT');
    expect(codes(ownershipQuality(rect(150, 10, 30, 30, person)))).toContain('DISJOINT_PIECES');
    const holed = { ...person, data: Uint8Array.from(person.data) };
    for (let j = 100; j < 130; j++) for (let i = 70; i < 100; i++) holed.data[j * W + i] = 0;
    expect(codes(ownershipQuality(holed))).toContain('INTERIOR_HOLES');
    expect(ownershipQuality(person, { providerScore: 0.3 })).toMatchObject({ tier: 'REVIEW' });
    expect(ownershipQuality(person, { manual: true })).toMatchObject({ tier: 'REVIEW', checks: [{ code: 'MANUAL_OWNERSHIP' }] });
  });
});
