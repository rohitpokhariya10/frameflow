import { describe, expect, it } from 'vitest';
import type { ProductSnapshot, ReuseItem } from '@frameflow/shared';
import { fitInSlot, productPlaces, slotAnchors } from './reuseStudio.js';

// Slot-anchored replacement: a product taking a template product's place keeps that place (centre, base line, size),
// fitted inside it, never cut. The places are the template's products' slots of a comparable size.
const slot = { box: { x: 604, y: 504, width: 374, height: 652 }, contactY: 1154, targetHeight: 651, z: 12 };
const canvas = { width: 1560, height: 1563 };
const snapshot = { canvas, objects: [
  { id: 'qr', kind: 'product', label: 'QR payment machine', box: { x: 613, y: 507, width: 369, height: 685 }, slot },
  { id: 'phone', kind: 'product', label: 'Smartphone', box: { x: 384, y: 1406, width: 383, height: 39 }, slot: { box: { x: 389, y: 1408, width: 378, height: 41 }, contactY: 1447, targetHeight: 40, z: 17 } },
  { id: 'side', kind: 'product', label: 'Speaker', box: { x: 1100, y: 800, width: 220, height: 380 }, slot: { box: { x: 1100, y: 800, width: 220, height: 380 }, contactY: 1180, targetHeight: 380, z: 13 } },
] } as unknown as ProductSnapshot;
const item = (id: string, category: string, objectId: string | null = null, order = 0) => ({ id, objectId, kind: 'product', label: category, category, included: true, hidden: false, removed: false, order, asset: { kind: 'upload', file: `${id}.png`, sha256: '', width: 600, height: 1100 } }) as unknown as ReuseItem;

describe('slot-anchored replacement', () => {
  it('fits a product in the slot: centred, on the same base line, as tall as the original, inside the slot and canvas', () => {
    const fridge = fitInSlot(slot, { width: 600, height: 1100 }, canvas);
    expect(fridge.height).toBe(651);
    expect(fridge.y + fridge.height).toBe(slot.contactY + 1);
    expect(Math.abs(fridge.x + fridge.width / 2 - (slot.box.x + slot.box.width / 2))).toBeLessThanOrEqual(1);
    expect(fridge.width).toBeLessThanOrEqual(slot.box.width);
    // A wide product: no wider than the slot (no stage), so shorter; its proportions kept, still on the base line.
    const washer = fitInSlot(slot, { width: 1000, height: 700 }, canvas);
    expect(washer.width).toBeLessThanOrEqual(slot.box.width);
    expect(washer.width / washer.height).toBeCloseTo(1000 / 700, 1);
    expect(washer.y + washer.height).toBe(slot.contactY + 1);
    // On a stage wider than the slot it may use up to half again the slot's width, never more.
    const onStage = fitInSlot(slot, { width: 1000, height: 700 }, canvas, { cx: 791, cy: 1100, a: 375, b: 60 });
    expect(onStage.width).toBeGreaterThan(washer.width); expect(onStage.width).toBeLessThanOrEqual(slot.box.width * 1.5 + 1);
    // Near the canvas edge: made smaller and kept inside, never cut.
    const edge = fitInSlot({ ...slot, box: { ...slot.box, x: 1400 }, contactY: 600 }, { width: 600, height: 1100 }, canvas);
    expect(edge.x).toBeGreaterThanOrEqual(0); expect(edge.y).toBeGreaterThanOrEqual(0); expect(edge.x + edge.width).toBeLessThanOrEqual(canvas.width);
  });

  it('gives the main product the most prominent place; small footer places are not places; more products than places are arranged', () => {
    expect(productPlaces(snapshot).map(o => o.id)).toEqual(['qr', 'side']);
    // The refrigerator (the larger kind) takes the QR device's place, the phone the smaller one beside it.
    const two = slotAnchors(snapshot, [item('p1', 'phone', null, 0), item('f1', 'refrigerator', null, 1)]);
    expect(two?.get('f1')?.objectId).toBe('qr'); expect(two?.get('p1')?.objectId).toBe('side');
    // The person's main product first, whatever its kind.
    expect(slotAnchors(snapshot, [item('p1', 'phone'), item('f1', 'refrigerator')], 'p1')?.get('p1')?.objectId).toBe('qr');
    // A template product kept keeps its own place; the added one takes a free place.
    const kept = slotAnchors(snapshot, [item('qr', 'qr', 'qr'), item('f1', 'refrigerator')]);
    expect(kept?.get('qr')?.objectId).toBe('qr'); expect(kept?.get('f1')?.objectId).toBe('side');
    // Three added products, two places: arranged anew instead.
    expect(slotAnchors(snapshot, [item('a', 'phone'), item('b', 'phone'), item('c', 'phone')])).toBeUndefined();
  });
});
