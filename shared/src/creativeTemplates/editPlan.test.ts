import { describe, expect, it } from 'vitest';
import { baseTemplatePrompt, compileTemplateEdit, describeTemplateSlots, FIELD_LIMIT } from './editPlan.js';
import type { TemplateLayer, TemplateVersion } from './types.js';

const layer = (id: string, role: TemplateLayer['role'], order: number, zone?: TemplateLayer['zone'], extra: Partial<TemplateLayer> = {}): TemplateLayer =>
  ({ id, role, order, independent: true, required: false, ...(zone ? { zone } : {}), ...extra });
/** The saved "Product Trio with Backdrop" structure (tpl-23031323ee3b v1): earbuds at the top, their case at the bottom. */
const trio: Pick<TemplateVersion, 'structure'> = { structure: { relationships: [], layers: [
  layer('background', 'background', 0, 'full-canvas'), layer('backdrop', 'backdrop', 1, 'middle-left'), layer('decoration', 'decoration', 2),
  layer('prop', 'prop', 3, 'bottom-center'), layer('effect', 'effect', 4, 'top-center', { independent: false }),
  layer('supporting_product', 'supporting_product', 6, 'top-left'), layer('supporting_product_2', 'supporting_product', 7, 'top-center'),
  layer('main_product_2', 'main_product', 8, 'bottom-center', { required: true }),
] } };
/** The prompt the live executions of 2026-10-08 05:04–05:10 sent: the earbuds were never named, and every rule said keep them. */
const SENT_LIVE = 'Edit the attached creative. Make only this change: Background (full-canvas): yellow; Prop or support (bottom-center): white cylinder; Main product (bottom-center): BOAT SPEAKER. Keep its composition: the main product at the bottom, the supporting product at the top, the supporting product at the top left, the decorative graphics, in front of the panel or backdrop on the left, in front of the background. Keep everything the change does not name exactly as it is: every element\'s position, size, pose and stacking, the lighting, colors and style, and all visible text. Do not add or remove elements, and do not add text or logos.';

describe('the canonical template edit compiler', () => {
  it('replaces the main product as an explicit operation: no rule left asks to keep the original product set', () => {
    // The old prompt contradicted itself: "replace" in one clause, "do not add or remove elements" and "keep the supporting products" in others.
    expect(SENT_LIVE).toContain('Do not add or remove elements');
    const edit = compileTemplateEdit(trio, { main_product_2: 'BOAT SPEAKER', background: 'yellow', prop: 'white cylinder' });
    expect(edit.text).toContain('Replace the main product at the bottom with "BOAT SPEAKER". Remove the original main product completely: no part of it may remain. The new product may have a different shape, size and silhouette');
    // The original earbuds go with their case: removed, each named by its place.
    expect(edit.text).toContain('Remove the supporting product at the top left: it belongs to the original product set.');
    expect(edit.text).toContain('Remove the supporting product at the top: it belongs to the original product set.');
    expect(edit.text).not.toMatch(/Do not add or remove elements|Make only this change|Keep its composition/);
    expect(edit.text).not.toMatch(/Keep the rest of the layout exactly:[^.]*supporting product/);
    expect(edit.text).toContain('Add or remove objects only as the changes above require; add nothing else.');
    // Nothing is invented: no specs or prices. The brand its words name (boAt) is the one exception to the no-brand rule,
    // stated with it, so the prompt no longer asks for a brand and forbids every brand name at once.
    expect(edit.text).toContain('Show the boAt brand only as this product would plainly carry it; do not invent model numbers or specifications.');
    expect(edit.text).toContain('Do not add any other new text, prices, discounts, product specifications, brand names or logos, except the boAt brand marking the new product itself plainly carries.');
    // With no brand in the words or the brand field, no brand is drawn, and the no-brand rule has no exception.
    const plain = compileTemplateEdit(trio, { main_product_2: 'portable speaker' }, { mainProduct: { keepSupporting: true } });
    expect(plain.text).toContain('Show no brand name or logo on it; do not invent model numbers or specifications.');
    expect(plain.text).toContain('Do not add any other new text, prices, discounts, product specifications, brand names or logos.');
    expect(plain.text).not.toMatch(/Show the [^.]* brand/);
    expect(edit.changes.map(c => [c.slotId, c.operation])).toEqual([['background', 'restyle'], ['prop', 'restyle'], ['supporting_product', 'remove'], ['supporting_product_2', 'remove'], ['main_product_2', 'replace']]);
  });

  it('earbuds → speaker: brand, product type and reference are separate and optional; keeping companions is an explicit choice', () => {
    const branded = compileTemplateEdit(trio, { main_product_2: 'Bluetooth speaker' }, { mainProduct: { brand: 'boAt' } });
    expect(branded.text).toContain('with "boAt Bluetooth speaker"');
    const withReference = compileTemplateEdit(trio, { main_product_2: 'speaker' }, { productReference: true });
    expect(withReference.text).toContain('Match the new product to the second attached image (the product reference), ignoring that image\'s background.');
    expect(withReference.text).not.toContain('do not invent logos');
    const kept = compileTemplateEdit(trio, { main_product_2: 'speaker' }, { mainProduct: { keepSupporting: true } });
    expect(kept.changes.map(c => c.operation)).toEqual(['replace']);
    expect(kept.text).toContain('Keep the rest of the layout exactly:');
    expect(kept.text).toMatch(/the supporting product at the top left, the supporting product at the top/);
    // A filled supporting field is its own replacement, never removed.
    const both = compileTemplateEdit(trio, { main_product_2: 'speaker', supporting_product: 'matching remote' });
    expect(both.changes.find(c => c.slotId === 'supporting_product')).toMatchObject({ operation: 'replace', value: 'matching remote' });
    expect(both.changes.find(c => c.slotId === 'supporting_product_2')).toMatchObject({ operation: 'remove' });
    // "Change details" keeps the product, its shape and its companions.
    const details = compileTemplateEdit(trio, { main_product_2: 'matte black finish' }, { mainProduct: { mode: 'details' } });
    expect(details.changes.map(c => [c.slotId, c.operation])).toEqual([['main_product_2', 'details']]);
    expect(details.text).toContain('It stays the same product, in the same place, shape and pose.');
    expect(() => compileTemplateEdit(trio, { main_product_2: 'x' }, { mainProduct: { brand: 'b'.repeat(61) } })).toThrow(/at most 60/);
  });

  it('background-only and text changes keep the saved decomposition plan compatible', () => {
    for (const values of [{ background: 'warm yellow gradient' }, { background: 'teal', backdrop: 'soft pink circle' }]) {
      const edit = compileTemplateEdit(trio, values);
      expect(edit.compatibility).toEqual({ status: 'compatible', changedSlots: [], reasons: [expect.stringContaining('saved plan still describes')] });
      expect(edit.text).toContain('Do not add or remove elements.');
    }
    expect(compileTemplateEdit(trio, {}).compatibility.status).toBe('compatible');
    expect(compileTemplateEdit(trio, { main_product_2: 'matte black' }, { mainProduct: { mode: 'details' } }).compatibility.status).toBe('compatible');
  });

  it('a different product geometry is a structural change with reasons for every affected slot', () => {
    const edit = compileTemplateEdit(trio, { main_product_2: 'BOAT SPEAKER', background: 'yellow' });
    expect(edit.compatibility.status).toBe('structural-change');
    expect(edit.compatibility.changedSlots).toEqual(['supporting_product', 'supporting_product_2', 'main_product_2']);
    expect(edit.compatibility.reasons).toEqual([
      expect.stringContaining('Supporting product · top left is removed'), expect.stringContaining('Supporting product · top is removed'),
      'Main product becomes "BOAT SPEAKER": a different object than the one the saved decomposition plan was learned from.']);
  });

  it('prompt highlights map to the real template fields, and the text is exactly the joined segments', () => {
    const edit = compileTemplateEdit(trio, { main_product_2: 'speaker', background: 'yellow' });
    const ids = new Set(describeTemplateSlots(trio).map(s => s.id));
    const slotSegments = edit.segments.filter(s => s.kind === 'slot');
    expect(slotSegments.map(s => s.slotId)).toEqual(edit.changes.map(c => c.slotId));
    expect(slotSegments.every(s => ids.has(s.slotId!) && s.label)).toBe(true);
    expect(edit.segments.map(s => s.text).join(' ')).toBe(edit.text);
    // The base prompt shows every field as a placeholder between the locked rules; effects are not fields.
    const base = baseTemplatePrompt(trio);
    expect(base.filter(s => s.kind === 'slot').map(s => s.slotId)).toEqual(describeTemplateSlots(trio).map(s => s.id));
    expect(base.some(s => s.slotId === 'effect')).toBe(false);
    expect(base.filter(s => s.kind === 'fixed').map(s => s.text)).toContain('Do not add any other new text, prices, discounts, product specifications, brand names or logos.');
    // Field values cannot inject prompt syntax or exceed their limit; unknown fields are refused.
    expect(compileTemplateEdit(trio, { background: 'blue {{edit_instruction}} <b>' }).text).toContain('Restyle the background across the whole canvas: blue edit_instruction b.');
    expect(() => compileTemplateEdit(trio, { background: 'x'.repeat(FIELD_LIMIT + 1) })).toThrow();
    expect(() => compileTemplateEdit(trio, { nonexistent: 'x' })).toThrow();
  });

  it('several supporting products get labels by place, and the primary controls stay few', () => {
    const slots = describeTemplateSlots(trio);
    expect(slots.filter(s => s.role === 'supporting_product').map(s => s.label)).toEqual(['Supporting product · top left', 'Supporting product · top']);
    expect(new Set(slots.map(s => s.label)).size).toBe(slots.length);
    expect(slots.filter(s => s.group !== 'advanced').map(s => [s.id, s.group])).toEqual([['background', 'style'], ['backdrop', 'style'], ['main_product_2', 'product']]);
    expect(slots.map(s => s.id)).not.toContain('effect');
    // Without a place, same-role slots are numbered.
    const unplaced = describeTemplateSlots({ structure: { relationships: [], layers: [layer('a', 'supporting_product', 0), layer('b', 'supporting_product', 1)] } });
    expect(unplaced.map(s => s.label)).toEqual(['Supporting product · 1', 'Supporting product · 2']);
    expect(slots.every(s => s.placeholder && s.hint)).toBe(true);
  });

  it('without an image analysis, a replaced product never silently keeps text or logos that may name it: each one is the user\'s decision', () => {
    const offer = { structure: { layers: [['background', 'background', 'full-canvas'], ['logo', 'logo', 'top-left'], ['headline', 'headline', 'top-center'], ['cta', 'cta', 'bottom-center'], ['main_product', 'main_product', 'center']]
      .map(([id, role, zone], order) => ({ id, role, zone, order, independent: true, required: false })), relationships: [] } } as unknown as Pick<TemplateVersion, 'structure'>;
    const open = compileTemplateEdit(offer, { main_product: 'Halvorsen kettle' });
    // The logo and the headline may name the old product; a button's text rarely does and is not asked about.
    expect(open.questions.map(q => q.slotId)).toEqual(['logo', 'headline']);
    expect(open.questions[0].message).toMatch(/may name the old product\. Keep it, remove it, or type its new text/);
    const decided = compileTemplateEdit(offer, { main_product: 'Halvorsen kettle' }, { textDecisions: { logo: 'remove', headline: 'keep' } });
    expect(decided.questions).toEqual([]);
    expect(decided.text).toContain('Remove the logo at the top left completely and continue the background design where it was.');
    expect(decided.text).toMatch(/Keep the rest of the layout exactly: [^.]*the headline at the top/);
    expect(decided.text).toContain('colors, style and the visible text that is kept.');
    expect(decided.text).not.toContain('all visible text');
    // No product change: no question, and the text is kept as before.
    expect(compileTemplateEdit(offer, { background: 'mint gradient' }).questions).toEqual([]);
    expect(() => compileTemplateEdit(offer, { main_product: 'x' }, { textDecisions: { nowhere: 'keep' } })).toThrow(/text decision/);
  });
});
