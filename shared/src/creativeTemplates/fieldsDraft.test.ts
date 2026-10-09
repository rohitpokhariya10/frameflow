import { describe, expect, it } from 'vitest';
import { appliancesAnalysis, holdingBallAnalysis, phoneOfferAnalysis } from '../../../server/src/decomposition/creativeTemplates/scene.fixture.js';
import { applyConflictOption, basePlan, cleanDraft, compileResolvedEdit, mergeResolution, promptContradictions, TEXT_FREE_RULE, type ChangePlan, type ResolverProposal } from './changePlan.js';
import { describeTemplateSlots } from './editPlan.js';
import { editStrategy } from './editStrategy.js';
import { draftFromTemplateFields, type FieldsDraftInput } from './fieldsDraft.js';
import { mapSceneToSlots, parseSceneDescription, type SceneDescription } from './scene.js';
import type { TemplateRole, TemplateZone } from './roles.js';

// The normal Generate's template fields, read through the image's own analysis: the same change-planning engine as the
// item cards, for any category. The phone, appliance and person cases are representative; the kettle and fragrance
// cases use made-up brands and categories nothing in the code knows.
const scene = (raw: unknown) => parseSceneDescription(raw);
const template = (layers: [string, TemplateRole, TemplateZone?][]) => ({ structure: { layers: layers.map(([id, role, zone], order) => ({ id, role, order, independent: true, required: false, ...(zone ? { zone } : {}) })), relationships: [] } });
const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, certainty: 'approximate' });
const none = { brand: '', model: '', evidence: '', confidence: 0, markings: 'none' };
const object = (id: string, kind: string, importance: string, category: string, b: ReturnType<typeof box>, extra: Record<string, unknown> = {}) =>
  ({ id, kind, importance, category, description: category, box: b, occluded: false, properties: [], identity: none, confidence: 0.9, ...extra });
/** Fields → draft → plan (rules only), with the answers given so far. */
function plan(s: SceneDescription, version: ReturnType<typeof template>, input: FieldsDraftInput) {
  const mapping = mapSceneToSlots(s, version), slots = describeTemplateSlots(version), fields = draftFromTemplateFields(s, mapping, slots, input);
  return { fields, plan: basePlan(s, cleanDraft(s, fields.draft), { slots: mapping.slots }), mapping, slots };
}
const changed = (p: ChangePlan) => p.entries.filter(e => e.operation !== 'keep').map(e => `${e.targetId}:${e.operation}${e.property ? `:${e.property}` : ''}`);
const clean = (s: SceneDescription, p: ChangePlan) => { const text = compileResolvedEdit(s, p).text; expect(promptContradictions(s, p, text)).toEqual([]); return text; };

const offer = template([['background', 'background', 'full-canvas'], ['headline', 'headline', 'top-center'], ['main_product', 'main_product', 'center'], ['supporting_product', 'supporting_product', 'bottom-right']]);

describe('template fields through the image\'s analysis (the normal Generate)', () => {
  it('all fields empty: nothing changes, nothing is inferred, no image request is needed', () => {
    const s = scene(phoneOfferAnalysis()), { fields, plan: p } = plan(s, offer, { values: {} });
    expect(fields).toEqual({ draft: { edits: {}, corrections: {} }, problems: [], fieldOf: {}, textFields: [] });
    expect(p.status).toBe('unchanged');
    expect(editStrategy(s, p).kind).toBe('none');
  });

  it('only the product field: the mapped product is replaced; its brand, marks and offer follow from the image, the accessory is asked', () => {
    const s = scene(phoneOfferAnalysis()), { fields, plan: p } = plan(s, offer, { values: { main_product: 'Xiaomi phone' } });
    expect(fields.draft.edits).toEqual({ smartphone_1: { action: 'replace', value: 'Xiaomi phone' } });
    expect(fields.fieldOf).toEqual({ smartphone_1: 'main_product' });
    expect(changed(p)).toEqual(expect.arrayContaining(['smartphone_1:replace', 'smartphone_1:modify:brand', 'mark_2:remove', 'text_1:remove']));
    expect(p.conflicts.map(c => c.kind)).toEqual(['accessory']);
    // Answering keeps the earbuds; the answer travels with the fields, and the plan is clear and consistent.
    const answers = applyConflictOption(fields.draft, p.conflicts[0].options[0]).draft.edits;
    const answered = plan(s, offer, { values: { main_product: 'Xiaomi phone' }, answers });
    expect(answered.plan.status).toBe('clear');
    const text = clean(s, answered.plan);
    expect(text).toContain('Show the Xiaomi brand only as this product would plainly carry it.');
    expect(editStrategy(s, answered.plan).kind).toBe('local');
  });

  it('partial fields: what the user filled is explicit, the rest is inherited, and a filled field always wins over an earlier answer', () => {
    const s = scene(phoneOfferAnalysis());
    const { fields, plan: p } = plan(s, offer, { values: { main_product: 'Xiaomi phone', background: 'warm sunset gradient' }, answers: { earbuds_1: { action: 'keep' }, smartphone_1: { action: 'keep' } } });
    expect(fields.draft.edits).toEqual({ smartphone_1: { action: 'replace', value: 'Xiaomi phone' }, background_1: { action: 'modify', value: 'warm sunset gradient' }, earbuds_1: { action: 'keep' } });
    expect(p.status).toBe('clear');
    // A restyled background around a replaced phone: the earbuds that stay are cut out and kept as their own pixels.
    expect(editStrategy(s, p)).toMatchObject({ kind: 'background', protectIds: ['earbuds_1'] });
    clean(s, p);
    // "Keep the original supporting products" keeps them explicitly; the brand field is the product's brand.
    const kept = plan(s, offer, { values: { main_product: 'speaker' }, mainProduct: { brand: 'boAt', keepSupporting: true } });
    expect(kept.fields.draft.edits).toEqual({ smartphone_1: { action: 'replace', value: 'speaker', brand: 'boAt' }, earbuds_1: { action: 'keep' } });
    expect(kept.plan.status).toBe('clear');
  });

  it('several products: the field changes only its own product and that product\'s own mark', () => {
    const s = scene(appliancesAnalysis()), version = template([['background', 'background', 'full-canvas'], ['main_product', 'main_product', 'middle-left'], ['main_product_2', 'main_product', 'bottom-right']]);
    const { plan: p } = plan(s, version, { values: { main_product: 'black side-by-side refrigerator' } });
    expect(changed(p)).toEqual(['refrigerator_1:replace', 'mark_1:remove']);
    expect(p.status).toBe('clear');
    expect(clean(s, p)).toContain('(the product brand mark on the washing machine at the bottom right)');
  });

  it('a person holding an object: a new person and a new held object are consistent with each other', () => {
    const s = scene(holdingBallAnalysis()), version = template([['background', 'background', 'full-canvas'], ['subject', 'primary_subject', 'center'], ['held', 'held_object', 'center']]);
    const { plan: p } = plan(s, version, { values: { held: 'green water bottle', subject: 'young woman in a yellow saree' } });
    expect(changed(p)).toEqual(expect.arrayContaining(['man_1:replace', 'football_1:replace']));
    const text = clean(s, p);
    expect(text).toContain('holding the new object described below');
    expect(text).not.toContain('holding or wearing the same objects');
  });

  it('a field nothing in the image matches is reported, never dropped; a text field keeps the template\'s own text behaviour', () => {
    const s = scene(phoneOfferAnalysis()), version = template([['background', 'background', 'full-canvas'], ['main_product', 'main_product', 'center'], ['held', 'held_object', 'top-left'], ['headline', 'headline', 'top-center']]);
    const { fields } = plan(s, version, { values: { held: 'umbrella', headline: 'Big days' } });
    expect(fields.problems).toEqual([expect.stringMatching(/^Held object: nothing in your image matches this field/)]);
    expect(fields.textFields).toEqual(['headline']);
    expect(fields.draft.edits).toEqual({});
  });
});

describe('any category: the image\'s own items, brands and relations decide, not a list', () => {
  /** Three kettles of a made-up brand, its logo on the artwork, and a caption naming the old model (not linked to it). */
  const kettles = () => scene({ summary: 'Three Rennick kettles in pastel colours, the brand logo top left and a caption.', objects: [
    object('bg', 'scenery', 'background', 'background', box(0, 0, 1, 1)),
    object('k_mid', 'product', 'main', 'electric kettle', box(0.38, 0.4, 0.24, 0.4), { identity: { brand: 'Rennick', model: 'Arc 2', evidence: 'wordmark on the base', confidence: 0.85, markings: 'physical' } }),
    object('k_left', 'product', 'supporting', 'electric kettle', box(0.08, 0.45, 0.22, 0.36), { identity: { brand: 'Rennick', model: 'Arc 2', evidence: 'same wordmark', confidence: 0.8, markings: 'physical' } }),
    object('k_right', 'product', 'supporting', 'electric kettle', box(0.7, 0.45, 0.22, 0.36), { identity: { brand: 'Rennick', model: 'Arc 2', evidence: 'same wordmark', confidence: 0.8, markings: 'physical' } })],
    relations: [], marks: [{ id: 'logo', kind: 'product_brand', text: 'Rennick', owner_id: 'k_mid', overlay: true, box: box(0.04, 0.04, 0.16, 0.08) }],
    text_overlays: [{ id: 'cap', role: 'caption', text: 'Meet the Arc 2', refers_to: [], box: box(0.25, 0.86, 0.5, 0.06) }],
    lighting: { direction: 'top', quality: 'soft', color: 'neutral' }, main_candidates: ['k_mid'], uncertainties: [] });
  const kettleTemplate = template([['background', 'background', 'full-canvas'], ['logo', 'logo', 'top-left'], ['main_product', 'main_product', 'center'], ['supporting_product', 'supporting_product', 'middle-left'], ['supporting_product_2', 'supporting_product', 'middle-right']]);

  it('a product replaced by another brand: its logo and the line naming its model go, the other copies are asked about once', () => {
    const s = kettles(), { plan: p } = plan(s, kettleTemplate, { values: { main_product: 'Halvorsen kettle' } });
    expect(changed(p)).toEqual(expect.arrayContaining(['electric_kettle_2:replace', 'mark_1:remove', 'text_1:remove']));
    const set = p.conflicts.find(c => c.id === 'rule:set:electric_kettle_2')!;
    expect(set.question).toMatch(/look like the same product as Electric kettle · center \(Rennick\)/);
    expect(set.options.map(o => o.label)).toEqual(['Replace them with "Halvorsen kettle" too', 'Remove them', 'Keep them as they are']);
    const answers = applyConflictOption({ edits: { electric_kettle_2: { action: 'replace', value: 'Halvorsen kettle' } }, corrections: {} }, set.options[0]).draft.edits;
    const all = plan(s, kettleTemplate, { values: { main_product: 'Halvorsen kettle' }, answers });
    expect(all.plan.status).toBe('clear');
    expect(changed(all.plan)).toEqual(expect.arrayContaining(['electric_kettle_1:replace', 'electric_kettle_3:replace']));
    // "Halvorsen" is in no list: by rules alone it is drawn without a brand; the resolver reads it from the words.
    expect(clean(s, all.plan)).toContain('Show no brand name or logo on it.');
    const merged = mergeResolution(s, cleanDraft(s, all.fields.draft), all.plan, { understanding: ['electric_kettle_1', 'electric_kettle_2', 'electric_kettle_3'].map(targetId => ({ targetId, brand: 'Halvorsen', brandSource: 'explicit' as const, identity: 'a Halvorsen kettle', specificity: 'brand_and_category' as const })),
      inferred: [], conflicts: [], productPhoto: { present: false, category: '', brand: '', evidence: '', matchesRequest: 'unclear', description: '' } } satisfies ResolverProposal);
    expect(merged.rejected).toEqual([]);
    const text = clean(s, merged.plan);
    expect(text).toContain('Show the Halvorsen brand only as this product would plainly carry it.');
    expect(text).toContain(`${TEXT_FREE_RULE} The only exception is the Halvorsen brand marking on the new electric kettle`);
  });

  it('a brand the image itself shows is recognised in the user\'s words; a product of that same brand keeps its logo', () => {
    const s = scene({ summary: 'A Lumora perfume bottle with its matching gift box on a marble pedestal.', objects: [
      object('bg', 'scenery', 'background', 'background', box(0, 0, 1, 1)), object('pedestal', 'scenery', 'supporting', 'pedestal', box(0.25, 0.7, 0.5, 0.2)),
      object('bottle', 'product', 'main', 'perfume bottle', box(0.38, 0.3, 0.2, 0.4), { identity: { brand: 'Lumora', model: '', evidence: 'engraved name', confidence: 0.8, markings: 'physical' } }),
      object('box', 'product', 'supporting', 'gift box', box(0.62, 0.5, 0.2, 0.2), { identity: { brand: 'Lumora', model: '', evidence: 'printed name', confidence: 0.8, markings: 'physical' } })],
      relations: [{ source: 'box', relation: 'same_brand_as', target: 'bottle', evidence: 'same name', confidence: 0.9 }], marks: [{ id: 'logo', kind: 'product_brand', text: 'Lumora', owner_id: 'bottle', overlay: true, box: box(0.04, 0.04, 0.16, 0.08) }],
      text_overlays: [], lighting: { direction: 'left', quality: 'soft', color: 'warm' }, main_candidates: ['bottle'], uncertainties: [] });
    const version = template([['background', 'background', 'full-canvas'], ['main_product', 'main_product', 'center'], ['supporting_product', 'supporting_product', 'middle-right'], ['prop', 'prop', 'bottom-center']]);
    const { plan: p } = plan(s, version, { values: { main_product: 'Lumora Noir bottle in smoked glass' } });
    expect(p.entries.find(e => e.id === 'inferred:perfume_bottle_1:modify:brand')).toMatchObject({ to: 'Lumora' });
    expect(p.conflicts).toEqual([]);
    expect(p.entries.find(e => e.targetId === 'mark_1')).toMatchObject({ operation: 'keep' }); // still Lumora: the logo stays
    expect(p.notes.join(' ')).toMatch(/Gift box shows the same brand as Perfume bottle; it stays/);
    expect(clean(s, p)).toContain('Show the Lumora brand only as this product would plainly carry it.');
  });
});
