import { describe, expect, it } from 'vitest';
import { addElement, applyCuratedOffer, applyOfferTheme, compileOfferTemplate, createCreative, createTemplateDraft, createTemplateElement, DIWALI_TEMPLATES,
  findElement, reorderElement, removeElement, setCreativeOverride, setRatioLayout, updateElement, type DesignTemplate } from '@frameflow/shared';
import { initialTemplateHistory, templateHistoryReducer as reduce, TEMPLATE_HISTORY_LIMIT, type TemplateHistory } from './templateHistory';

const now = '2026-10-02T00:00:00Z';
const empty = () => createTemplateDraft('base', now);
const sale = () => applyCuratedOffer(empty(), 'diwali-mega-sale');
const edit = <T>(history: TemplateHistory<T>, value: T, group?: string) => reduce(history, { type: 'edit', value, group, session: history.session });
const roundTrip = (before: DesignTemplate, after: DesignTemplate) => {
  const original = structuredClone(before), changed = structuredClone(after);
  const history = edit(initialTemplateHistory(before), after);
  expect(history.past).toHaveLength(1);
  const undone = reduce(history, { type: 'undo' }); expect(undone.present).toEqual(original);
  expect(reduce(undone, { type: 'redo' }).present).toEqual(changed);
  expect(before).toEqual(original);
};

describe('template session history', () => {
  it.each(['heading', 'product', 'decorative', 'rectangle'] as const)('restores adding %s', role => {
    const before = empty(); roundTrip(before, addElement(before, createTemplateElement(role, 'added', 0)));
  });
  it('restores a deleted themed headline with exact typography, role, geometry and order', () => {
    const before = sale(); roundTrip(before, removeElement(before, 'offer-headline'));
  });
  it('duplicates independently and restores layer ordering', () => {
    const before = sale(), source = findElement(before, 'offer-headline')!;
    roundTrip(before, addElement(before, { ...structuredClone(source), id: 'copy' }));
    roundTrip(before, reorderElement(before, source.id, 'back'));
  });
  it.each([{ x: .12, y: .3 }, { width: .4, height: .2 }, { rotation: 20 }])('restores a committed move/resize/rotate: %j', layout => {
    const before = sale(); roundTrip(before, setRatioLayout(before, 'offer-headline', '16:9', layout));
  });
  it('restores only the edited ratio geometry', () => {
    const before = sale(), after = setRatioLayout(before, 'offer-product', '16:9', { x: .5 });
    const a = findElement(before, 'offer-product')!, b = findElement(after, 'offer-product')!;
    for (const ratio of ['1:1', '4:5', '3:4', '9:16'] as const) expect(b.ratioLayouts![ratio]).toEqual(a.ratioLayouts![ratio]);
    roundTrip(before, after);
  });
  it('groups continuous text and number editing, ends on blur, and separates later fields', () => {
    let h = initialTemplateHistory(sale()); const original = h.present;
    for (const text of ['D', 'Diwali', 'Diwali Mega Sale']) h = edit(h, updateElement(h.present, 'offer-headline', e => e.type === 'text' ? { ...e, defaultContent: { text } } : e), 'focus-1');
    expect(h.past).toHaveLength(1);
    expect(reduce(h, { type: 'undo' }).present).toEqual(original);
    h = reduce(h, { type: 'end-group' });
    for (const x of [.1, .11, .12]) h = edit(h, setRatioLayout(h.present, 'offer-headline', '1:1', { x }), 'focus-2');
    expect(h.past).toHaveLength(2);
  });
  it.each([{ fontFamily: 'Yatra One' }, { fontSize: .06 }, { fontWeight: 600 as const }, { color: '#FFFFFF' }])('restores text style %j', style => {
    const before = sale(); roundTrip(before, updateElement(before, 'offer-headline', e => e.type === 'text' ? { ...e, style: { ...e.style, ...style } } : e));
  });
  it.each(['product', 'logo'])('restores %s replacement using IDs, without copying images', role => {
    const replace = (t: DesignTemplate, assetId: string) => updateElement(t, `offer-${role}`, e => e.type === 'image' ? { ...e, defaultContent: { assetId } } : e);
    const before = replace(sale(), 'asset-A'), after = replace(before, 'asset-B'); roundTrip(before, after);
    expect(JSON.stringify(edit(initialTemplateHistory(before), after))).not.toMatch(/data:image|blob:/);
    roundTrip(after, updateElement(after, `offer-${role}`, e => e.type === 'image' ? { ...e, behavior: { ...e.behavior, fit: 'cover' } } : e));
  });
  it.each(DIWALI_TEMPLATES)('applies $name atomically, restoring the complete old canvas', definition => {
    const before = addElement(empty(), createTemplateElement('heading', 'custom', 0)); roundTrip(before, applyCuratedOffer(before, definition.id));
  });
  it('restores AI Apply and legacy theme styling locally as single actions', () => {
    const before = sale(); roundTrip(before, compileOfferTemplate(before, DIWALI_TEMPLATES[1].spec, 'ai', 'diwali-ai'));
    roundTrip(before, applyOfferTheme(before, 'holi', 'style'));
  });
  it('discards the abandoned redo branch on a new edit', () => {
    let h = edit(initialTemplateHistory(empty()), sale()); h = reduce(h, { type: 'undo' });
    h = edit(h, { ...h.present, name: 'Different' }); expect(h.future).toEqual([]); expect(reduce(h, { type: 'redo' })).toBe(h);
  });
  it('caps actions and ignores unchanged values', () => {
    let h = initialTemplateHistory(empty());
    expect(edit(h, structuredClone(h.present))).toBe(h);
    for (let i = 1; i <= 75; i++) h = edit(h, { ...h.present, name: `Edit ${i}` });
    expect(h.past).toHaveLength(TEMPLATE_HISTORY_LIMIT);
    for (let i = 0; i < TEMPLATE_HISTORY_LIMIT; i++) h = reduce(h, { type: 'undo' });
    expect(h.present.name).toBe('Edit 25'); expect(h.future).toHaveLength(TEMPLATE_HISTORY_LIMIT);
  });
  it('copies incoming snapshots so later caller mutations cannot corrupt history', () => {
    const before = sale(), after = structuredClone(before); after.name = 'Edited';
    const h = edit(initialTemplateHistory(before), after);
    before.elements[0].name = 'Mutated'; after.elements[0].name = 'Also mutated';
    expect(h.present.elements[0].name).toBe('Campaign background'); expect(h.past[0].elements[0].name).toBe('Campaign background');
  });
  it('resets template sessions and ignores stale asynchronous updates', () => {
    const a = edit(initialTemplateHistory(empty()), sale()); const b = reduce(a, { type: 'reset', value: { ...empty(), id: 'other' } });
    expect(b.past).toEqual([]); expect(b.future).toEqual([]); expect(reduce(b, { type: 'undo' })).toBe(b);
    expect(reduce(b, { type: 'edit', value: sale(), session: a.session })).toBe(b);
  });
  it('retains history through saving and ratio navigation without new entries', () => {
    const h = edit(initialTemplateHistory(empty()), sale()); const navigated = reduce(h, { type: 'replace', value: { ...h.present, version: 2 } });
    expect(navigated.past).toEqual(h.past); expect(reduce(navigated, { type: 'undo' }).present).toEqual(empty());
  });
  it('keeps creative history independent of its base and preserves the currently viewed ratio', () => {
    const template = sale(), base = structuredClone(template), creative = createCreative(template, { id: 'creative', name: 'Creative', now });
    let h = edit(initialTemplateHistory(creative), setCreativeOverride(creative, template, 'offer-headline', { text: 'Derived' }, now));
    h = reduce(h, { type: 'replace', value: { ...h.present, aspectRatio: '16:9' } });
    const undone = reduce(h, { type: 'undo', restore: (next, current) => ({ ...next, aspectRatio: current.aspectRatio }) });
    expect(undone.present.contentOverrides).toEqual({}); expect(undone.present.aspectRatio).toBe('16:9'); expect(template).toEqual(base);
  });
});
