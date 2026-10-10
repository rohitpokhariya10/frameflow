import { describe, expect, it } from 'vitest';
import { autoResolve, compileResolvedEdit, editStrategy, parseSceneDescription, sameProductKind, type SceneDescription } from '../index.js';

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, certainty: 'tight' as const });
const id0 = { brand: '', model: '', evidence: '', confidence: 0, markings: 'none' as const }, mijia = { brand: 'Mijia', model: '', evidence: 'logo', confidence: 0.9, markings: 'physical' as const };
const object = (id: string, kind: string, importance: string, category: string, b: ReturnType<typeof box>, identity = id0) => ({ id, kind, importance, category, description: category, box: b, occluded: false, properties: [], identity, confidence: 0.9 });
/** Three appliances on display stands (two of the same kind), as the live Mijia creative was analyzed. */
const appliances = (): SceneDescription => parseSceneDescription({ summary: 'Three appliances on plinths above water.', objects: [
  object('bg', 'scenery', 'background', 'studio waterscape', box(0, 0, 1, 1)),
  object('ice_a', 'product', 'main', 'countertop ice appliance', box(0.22, 0.46, 0.18, 0.18), mijia),
  object('ice_b', 'product', 'main', 'countertop ice appliance', box(0.53, 0.54, 0.24, 0.17), mijia),
  object('water', 'product', 'main', 'water appliance', box(0.43, 0.28, 0.17, 0.23), mijia),
  object('stand', 'furniture', 'supporting', 'display pedestal', box(0.04, 0.64, 0.44, 0.1))],
  relations: [{ source: 'water', relation: 'same_brand_as', target: 'ice_b', evidence: 'logo', confidence: 0.72 }],
  marks: [{ id: 'm1', kind: 'product_brand', text: 'Mijia symbol', owner_id: 'ice_a', overlay: false, box: box(0.3, 0.6, 0.02, 0.02) },
    { id: 'm2', kind: 'product_brand', text: 'Mijia symbol', owner_id: 'ice_b', overlay: false, box: box(0.6, 0.66, 0.02, 0.02) }],
  text_overlays: [], lighting: { direction: 'top', quality: 'soft', color: 'cool' }, main_candidates: ['ice_a', 'ice_b', 'water'], uncertainties: [] });

describe('Feature 2 automatic resolution: no questions, the user\'s intent leads', () => {
  it('a product of another kind makes a coherent ad for it: the old offer goes, the scene adapts, nothing is asked', () => {
    const scene = appliances(), r = autoResolve(scene, { edits: { countertop_ice_appliance_1: { action: 'replace', value: 'Premium sports bike' } }, corrections: {} });
    expect(r.intent).toMatchObject({ kind: 'new-product', hero: 'Premium sports bike' });
    expect(r.plan).toMatchObject({ status: 'clear', conflicts: [], intent: { kind: 'new-product' } });
    const op = (id: string) => r.plan.entries.filter(e => e.targetId === id).map(e => `${e.source}:${e.operation}`);
    expect(op('countertop_ice_appliance_2')).toEqual(['inferred:remove']);
    expect(op('water_appliance_1')).toEqual(['inferred:remove']);
    expect(op('studio_waterscape_1')).toEqual(['inferred:modify']);
    expect(r.plan.entries.some(e => e.targetType === 'mark' && e.operation === 'keep')).toBe(false);
    expect(editStrategy(scene, r.plan).kind).toBe('global');
    expect(compileResolvedEdit(scene, r.plan).text).toMatch(/^Edit the attached advertising creative into an advertisement for "Premium sports bike" that is still the same template/);
  });
  it('an LG washing machine never carries the old Mijia marks, and no brand is read onto a stand', () => {
    const scene = appliances(), r = autoResolve(scene, { edits: { countertop_ice_appliance_1: { action: 'replace', value: 'Washing Machine', brand: 'LG' } }, corrections: {} });
    expect(r.plan.conflicts).toEqual([]);
    expect(r.plan.entries.filter(e => e.targetType === 'mark').every(e => e.operation === 'remove')).toBe(true);
    expect(r.plan.entries.filter(e => e.targetId === 'display_pedestal_1' && e.property === 'brand')).toEqual([]);
    expect(compileResolvedEdit(scene, r.plan).text).toContain('Show the LG brand only as this product would plainly carry it.');
  });
  it('the same kind under a new brand: its copies follow, the independent product stays; a background change stays local', () => {
    const scene = appliances(), r = autoResolve(scene, { edits: { countertop_ice_appliance_1: { action: 'replace', value: 'LG ice maker' } }, corrections: {} });
    expect(r.intent.kind).toBe('replace');
    expect(r.plan.entries.find(e => e.targetId === 'countertop_ice_appliance_2' && e.operation === 'replace')).toMatchObject({ source: 'inferred', to: 'LG ice maker' });
    expect(r.plan.entries.filter(e => e.targetId === 'water_appliance_1').map(e => e.operation)).toEqual(['keep']);
    const local = autoResolve(scene, { edits: { studio_waterscape_1: { action: 'modify', value: 'warm sunset kitchen' } }, corrections: {} });
    expect(local.intent.kind).toBe('local');
    expect(local.plan.entries.filter(e => e.operation !== 'keep').map(e => e.targetId)).toEqual(['studio_waterscape_1']);
  });
  it('two explicit products are both kept, the first leads', () => {
    const r = autoResolve(appliances(), { edits: { countertop_ice_appliance_1: { action: 'replace', value: 'Premium sports bike' }, countertop_ice_appliance_2: { action: 'replace', value: 'racing helmet' } }, corrections: {} });
    expect(r.intent.hero).toBe('Premium sports bike');
    expect(r.plan.entries.find(e => e.targetId === 'countertop_ice_appliance_2')).toMatchObject({ source: 'explicit', operation: 'replace', to: 'racing helmet' });
  });
  it('reads product kinds from words, not from a fixed category', () => {
    const phone = { category: 'smartphone', description: 'black phone', identity: { ...id0, brand: 'Samsung' } };
    expect(sameProductKind('Apple iPhone 15 Pro', phone, ['Apple'])).toBe(true);
    expect(sameProductKind('Vivo X100', phone, ['Vivo'])).toBe(true);
    expect(sameProductKind('Premium sports bike', phone)).toBe(false);
    expect(sameProductKind('perfume bottle', { category: 'skincare bottle', description: 'serum', identity: id0 })).toBe(false);
  });
  it('regression (Three Product Offer): two text blocks in one place never read as "remove X … keep X"; old-brand text and logo go, unrelated ones stay', () => {
    const redmi = { brand: 'Xiaomi Redmi', model: 'Redmi Note 17', evidence: 'logo', confidence: 0.9, markings: 'overlay' as const };
    const text = (id: string, role: string, value: string, b: ReturnType<typeof box>, refers: string[]) => ({ id, role, text: value, refers_to: refers, box: b });
    const phones = ['p1', 'p2', 'p3'];
    const scene = parseSceneDescription({ summary: 'Three Redmi phones with EMI offers.', objects: [object('bg', 'scenery', 'background', 'background', box(0, 0, 1, 1)),
      object('p1', 'product', 'main', 'smartphone', box(0.15, 0.45, 0.27, 0.32), redmi), object('p2', 'product', 'main', 'smartphone', box(0.37, 0.41, 0.23, 0.36), redmi), object('p3', 'product', 'main', 'smartphone', box(0.58, 0.45, 0.27, 0.32), redmi)],
      relations: [], marks: [{ id: 'merchant', kind: 'other_logo', text: 'pine labs', owner_id: '', overlay: true, box: box(0.8, 0.02, 0.15, 0.05) }, { id: 'mi', kind: 'product_brand', text: 'mi', owner_id: '', overlay: true, box: box(0.03, 0.02, 0.06, 0.05) }],
      text_overlays: [text('t1', 'headline', 'Redmi Note 17', box(0.3, 0.05, 0.4, 0.06), phones), text('t6', 'other', '|', box(0.49, 0.8, 0.01, 0.04), []), text('t7', 'offer', '11+ EMI transactions: Rs 500 each', box(0.40, 0.86, 0.2, 0.04), phones)],
      lighting: { direction: 'front', quality: 'soft', color: 'neutral' }, main_candidates: phones, uncertainties: [] });
    const r = autoResolve(scene, { edits: { smartphone_1: { action: 'replace', value: 'Iphone 18 pro Max Midnight colour' }, background_1: { action: 'modify', value: 'us flag gradient' } }, corrections: {} });
    expect(r.plan).toMatchObject({ status: 'clear', conflicts: [] });
    const fate = (id: string) => [...new Set(r.plan.entries.filter(e => e.targetId === id).map(e => e.operation))];
    for (const id of new Set(r.plan.entries.map(e => e.targetId))) expect(fate(id).includes('keep') && fate(id).length > 1).toBe(false);
    expect(fate('smartphone_1')).toContain('replace');
    expect(fate('background_1')).toEqual(['modify']);
    expect(fate('mark_1')).toEqual(['remove']); // the old brand's "mi" logo (marks are numbered left to right)
    expect(fate('mark_2')).toEqual(['keep']); // the merchant's logo is another entity
    expect(fate('text_3')).toEqual(['remove']); // the offer about the old phones
    expect(fate('text_2')).toEqual(['keep']); // the unrelated divider
    expect(r.plan.entries.find(e => e.targetId === 'smartphone_2' && e.operation === 'replace')?.to).toBe('Apple Iphone 18 pro Max, in this one\'s original colour');
    const text6 = compileResolvedEdit(scene, r.plan).text;
    expect(text6).toContain('Remove the overlaid offer text block at the bottom');
    expect(text6).toContain('Keep the overlaid text not changed above exactly as it is (the overlaid text block at the bottom)');
    expect(text6).not.toMatch(/Rs|₹|EMI/);
  });
});
