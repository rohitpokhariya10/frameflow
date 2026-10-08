import { describe, expect, it } from 'vitest';
import { canonicalStructure, sameTemplateStructure } from './structure.js';
import type { TemplateStructure } from './types.js';

const products = (count: number): TemplateStructure => ({ layers: [
  { id: 'background', role: 'background', order: 0, required: false, independent: true, zone: 'full-canvas' },
  ...Array.from({ length: count }, (_, i) => ({ id: `part_${i}`, role: 'main_product' as const, order: i + 1, required: true, independent: true, zone: 'center' as const })),
], relationships: [] });
describe('semantic structure identity', () => {
  it('two versus three parts in the same main-product region is one product group', () => {
    expect(sameTemplateStructure(products(2), products(3))).toBe(true);
    expect(canonicalStructure(products(3)).layers).toHaveLength(2);
  });
  it('two split products are different from one central group', () => {
    const split = products(2); split.layers[1].zone = 'middle-left'; split.layers[2].zone = 'middle-right';
    expect(sameTemplateStructure(products(2), split)).toBe(false);
  });
  it('unknown geometry and a missing subject do not prove the same layout', () => {
    const unknown = products(1); delete unknown.layers[1].zone;
    expect(sameTemplateStructure(products(1), unknown)).toBe(false);
    const person = products(1); person.layers[1].role = 'primary_subject';
    expect(sameTemplateStructure(products(1), person)).toBe(false);
  });
  it('a held object kept with its parent remains part of the layout identity', () => {
    const person = products(1); person.layers[1].role = 'primary_subject';
    const holding = structuredClone(person);
    holding.layers.push({ id: 'held', role: 'held_object', order: 2, independent: false, required: false, zone: 'center', attachment: { parent: 'part_0', relation: 'held_in_hand', keepWithParent: true, separationRisk: 'high' } });
    expect(sameTemplateStructure(person, holding)).toBe(false);
    expect(sameTemplateStructure(holding, holding)).toBe(true);
  });
});
