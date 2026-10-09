import { describe, expect, it } from 'vitest';
import { appliancesAnalysis, holdingBallAnalysis, phoneOfferAnalysis, twoPhonesAnalysis } from '../../../server/src/decomposition/creativeTemplates/scene.fixture.js';
import { applyConflictOption, basePlan, cleanDraft, compileResolvedEdit, productNames, promptContradictions, TEXT_FREE_RULE, type ChangePlan, type SceneDraft } from './changePlan.js';
import { parseSceneDescription, type SceneDescription } from './scene.js';

// Smart edits from empty or partly filled fields: what the rules infer, what they ask, and that the prompt they compile
// never contradicts itself. Rules only (no resolver call): this is what runs when the resolver is off or fails.
const scene = (raw: unknown) => parseSceneDescription(raw);
const draft = (s: SceneDescription, edits: SceneDraft['edits'], extra: Partial<SceneDraft> = {}) => cleanDraft(s, { edits, ...extra });
const changed = (plan: ChangePlan) => plan.entries.filter(e => e.operation !== 'keep').map(e => `${e.targetId}:${e.operation}${e.property ? `:${e.property}` : ''}:${e.source}`);
/** The phone offer with the old brand also advertised on the artwork, and a line naming the old model without the analysis linking it. */
const brandedOffer = (shareBrand = true) => {
  const raw = phoneOfferAnalysis() as ReturnType<typeof phoneOfferAnalysis> & { marks: Record<string, unknown>[]; text_overlays: Record<string, unknown>[] };
  raw.marks.push({ id: 'apple_logo', kind: 'product_brand', text: 'Apple', owner_id: '', overlay: true, box: { x: 0.8, y: 0.04, w: 0.12, h: 0.07, certainty: 'approximate' } });
  raw.text_overlays.push({ id: 'tag', role: 'caption', text: 'Meet iPhone 15 Pro', refers_to: [], box: { x: 0.1, y: 0.18, w: 0.3, h: 0.05, certainty: 'approximate' } });
  if (!shareBrand) (raw.objects[3] as { identity: Record<string, unknown> }).identity = { brand: '', model: '', evidence: '', confidence: 0, markings: 'none' };
  return scene(raw);
};
/** Items by what they are (canonical ids follow reading order, so they are looked up, not assumed). */
const ids = (s: SceneDescription) => ({
  printed: s.marks.find(m => m.ownerId === 'smartphone_1' && !m.overlay)!.id, logo: s.marks.find(m => m.overlay && m.text === 'Apple')!.id,
  store: s.marks.find(m => m.kind === 'merchant_logo')!.id, bank: s.marks.find(m => m.kind === 'bank_logo')!.id,
  headline: s.overlays.find(t => t.text.startsWith('iPhone'))!.id, tag: s.overlays.find(t => t.text.startsWith('Meet'))!.id, bankOffer: s.overlays.find(t => t.role === 'offer')!.id,
});

describe('1. a product replaced with the brand field blank', () => {
  it('"Xiaomi phone" carries Xiaomi, loses every Apple marking, offer and line about the old phone, and the prompt says so without contradiction', () => {
    const s = brandedOffer(false), plan = basePlan(s, draft(s, { smartphone_1: { action: 'replace', value: 'Xiaomi phone' } }));
    expect(plan.status).toBe('needs-input'); // the earbuds are an accessory of the phone: asked, never assumed
    const clear = basePlan(s, cleanDraft(s, applyConflictOption(draft(s, { smartphone_1: { action: 'replace', value: 'Xiaomi phone' } }), plan.conflicts[0].options[0]).draft));
    expect(clear.status).toBe('clear');
    const i = ids(s);
    expect(changed(clear)).toEqual(expect.arrayContaining(['smartphone_1:replace:explicit', 'smartphone_1:modify:brand:inferred', `${i.printed}:remove:inferred`, `${i.headline}:remove:inferred`, `${i.logo}:remove:inferred`, `${i.tag}:remove:inferred`]));
    // The merchant and bank logos and the bank's own offer are not about the phone: they stay.
    for (const id of [i.store, i.bank, i.bankOffer]) expect(clear.entries.find(e => e.targetId === id)).toMatchObject({ operation: 'keep', source: 'inherited' });
    const text = compileResolvedEdit(s, clear).text;
    expect(text).toContain('Replace the smartphone in the center with "Xiaomi phone".');
    expect(text).toContain('Show the Xiaomi brand only as this product would plainly carry it.');
    expect(text).not.toContain('Show no brand name or logo');
    expect(text).toContain(`${TEXT_FREE_RULE} The only exception is the Xiaomi brand marking on the new smartphone`);
    expect(promptContradictions(s, clear, text)).toEqual([]);
    // The image's own words are data: no price, offer or number from them reaches the prompt.
    expect(text).not.toMatch(/₹|79,900|cashback|10%|Meet iPhone/);
  });

  it('an Apple logo on the artwork that may be about the Apple earbuds, which stay, is asked about instead of removed', () => {
    const s = brandedOffer(true), i = ids(s), d = draft(s, { smartphone_1: { action: 'replace', value: 'Xiaomi phone' }, earbuds_1: { action: 'keep' } }), plan = basePlan(s, d);
    expect(plan.conflicts.map(c => c.id)).toEqual([`rule:dependency:${i.logo}`]);
    expect(plan.conflicts[0].question).toMatch(/shows the Apple brand of Smartphone on the artwork\. It may also be about Earbuds, which stays/);
    // The line naming the old model is about the old phone only: removed without a question.
    expect(plan.entries.find(e => e.targetId === i.tag)).toMatchObject({ operation: 'remove', source: 'inferred', reason: expect.stringMatching(/names Smartphone's model \(iPhone 15 Pro\)/) });
    // Replacing the earbuds too leaves nothing of Apple: the logo goes without a question.
    const both = basePlan(s, draft(s, { smartphone_1: { action: 'replace', value: 'Xiaomi phone' }, earbuds_1: { action: 'replace', value: 'Xiaomi earbuds' } }));
    expect(both.entries.find(e => e.targetId === i.logo)).toMatchObject({ operation: 'remove', source: 'inferred' });
  });

  it('a product line names its brand; two brands, or a brand field the words contradict, are asked', () => {
    const s = scene(phoneOfferAnalysis());
    const galaxy = basePlan(s, draft(s, { smartphone_1: { action: 'replace', value: 'Galaxy S24 Ultra' }, earbuds_1: { action: 'keep' } }));
    expect(galaxy.entries.find(e => e.id === 'inferred:smartphone_1:modify:brand')).toMatchObject({ to: 'Samsung', reason: 'Galaxy is a Samsung product line.' });
    expect(compileResolvedEdit(s, galaxy).text).toContain('Show the Samsung brand only as this product would plainly carry it.');
    const two = basePlan(s, draft(s, { smartphone_1: { action: 'replace', value: 'Xiaomi phone that looks like an iPhone' }, earbuds_1: { action: 'keep' } }));
    expect(two.conflicts[0]).toMatchObject({ id: 'rule:product-brand:smartphone_1', question: expect.stringMatching(/name more than one brand \(Xiaomi and Apple\)/) });
    expect(two.conflicts[0].options.map(o => o.label)).toEqual(['Xiaomi', 'Apple', 'I will describe it again']);
    const field = { smartphone_1: { action: 'replace' as const, value: 'Xiaomi phone', brand: 'Samsung' }, earbuds_1: { action: 'keep' as const } };
    const contradicts = basePlan(s, draft(s, field));
    expect(contradicts.conflicts[0].question).toMatch(/names Xiaomi, but the brand field says Samsung/);
    const answered = basePlan(s, cleanDraft(s, applyConflictOption(draft(s, field), contradicts.conflicts[0].options[0]).draft));
    expect(answered.status).toBe('clear');
    expect(answered.entries.find(e => e.targetId === 'smartphone_1' && e.source === 'explicit')!.brand).toBe('Xiaomi');
  });
});

describe('2. several products: only the intended one and what depends on it change', () => {
  it('replacing the refrigerator leaves the washing machine and its own brand mark alone', () => {
    const s = scene(appliancesAnalysis()), plan = basePlan(s, draft(s, { refrigerator_1: { action: 'replace', value: 'black Whirlpool refrigerator' } }));
    expect(changed(plan)).toEqual(['refrigerator_1:replace:explicit', 'refrigerator_1:modify:brand:inferred', 'mark_1:remove:inferred']);
    const text = compileResolvedEdit(s, plan).text;
    expect(text).toContain('the washing machine at the bottom right');
    expect(text).toContain('(the product brand mark on the washing machine at the bottom right)');
    expect(promptContradictions(s, plan, text)).toEqual([]);
  });

  it('two similar phones: a colour change of one says which, and keeps the other', () => {
    const s = scene(twoPhonesAnalysis()), plan = basePlan(s, draft(s, { smartphone_2: { action: 'modify', property: 'color', value: 'red' } }));
    expect(changed(plan)).toEqual(['smartphone_2:modify:color:explicit']);
    const text = compileResolvedEdit(s, plan).text;
    expect(text).toMatch(/Change the smartphone on the right: color → "red"\. It stays the same smartphone in the same place, shape and pose\./);
    expect(text).toContain('Keep everything else exactly as it is: the smartphone on the left;');
  });

  it('a product of the same brand is its own product: kept with a note, not a question', () => {
    const raw = phoneOfferAnalysis();
    raw.relations[1] = { source: 'buds', relation: 'same_brand_as', target: 'phone', evidence: 'both white with the same finish', confidence: 0.9 };
    const s = scene(raw), plan = basePlan(s, draft(s, { smartphone_1: { action: 'replace', value: 'Xiaomi phone' } }));
    expect(plan.conflicts).toEqual([]);
    expect(plan.entries.find(e => e.targetId === 'earbuds_1')).toMatchObject({ operation: 'keep', source: 'inherited' });
    expect(plan.notes.join(' ')).toMatch(/Earbuds shows the same brand as Smartphone; it stays as it is unless you change it/);
  });
});

describe('3 and 4. empty and partial fields', () => {
  it('all fields empty: nothing changes and nothing is inferred', () => {
    const s = brandedOffer(), plan = basePlan(s, draft(s, {}));
    expect(plan.status).toBe('unchanged');
    expect(changed(plan)).toEqual([]);
  });

  it('what the user wrote wins over what is inferred: a kept mark, a kept accessory and a typed brand stand', () => {
    const s = brandedOffer(false), logo = ids(s).logo;
    const kept = basePlan(s, draft(s, { smartphone_1: { action: 'replace', value: 'Xiaomi phone' }, earbuds_1: { action: 'keep' }, [logo]: { action: 'keep' } }));
    expect(kept.conflicts.map(c => c.id)).toEqual([`rule:dependency:${logo}`]); // asked, never overwritten
    expect(kept.entries.find(e => e.targetId === 'earbuds_1')).toMatchObject({ operation: 'keep', source: 'explicit' });
    const typed = basePlan(s, draft(s, { smartphone_1: { action: 'replace', value: 'black phone', brand: 'Nokia' }, earbuds_1: { action: 'keep' } }));
    expect(typed.entries.find(e => e.targetId === 'smartphone_1' && e.source === 'explicit')).toMatchObject({ brand: 'Nokia', to: 'Nokia black phone' });
    expect(typed.entries.some(e => e.id === 'inferred:smartphone_1:modify:brand')).toBe(false);
  });
});

describe('5 and 6. a person holding an object; clothing and object edits together', () => {
  it('a new outfit and a new held object are one instruction for the person: no "keep the same clothing" (B4)', () => {
    const s = scene(holdingBallAnalysis()), plan = basePlan(s, draft(s, { man_1: { action: 'modify', property: 'clothing', value: 'red kurta' }, football_1: { action: 'replace', value: 'green water bottle' } }));
    expect(changed(plan)).toEqual(['man_1:modify:clothing:explicit', 'football_1:replace:explicit', 'man_1:adjust:grip:inferred']);
    const text = compileResolvedEdit(s, plan).text;
    expect(text).toContain('(1) Replace the football in the center, held by the man in the center, with "green water bottle".');
    expect(text).toContain('(2) Change the man in the center: clothing → "red kurta". Also adjust the hands: the hand holds the new object naturally. Keep the same person, face, pose and expression, and everything held or worn that is not changed above.');
    expect(text).not.toMatch(/clothing and pose otherwise/);
    expect(text.match(/the man in the center:/g)).toHaveLength(1);
    expect(promptContradictions(s, plan, text)).toEqual([]);
  });

  it('a changed expression or pose is never also kept; a removed held object leaves the hand resting', () => {
    const s = scene(holdingBallAnalysis());
    const smile = compileResolvedEdit(s, basePlan(s, draft(s, { man_1: { action: 'modify', property: 'expression', value: 'laughing' } }))).text;
    expect(smile).toContain('Change the man in the center: expression → "laughing". Keep the same person, face and pose,');
    const removed = basePlan(s, draft(s, { football_1: { action: 'remove' } }));
    expect(changed(removed)).toEqual(['football_1:remove:explicit', 'man_1:adjust:hand:inferred']);
    expect(compileResolvedEdit(s, removed).text).toContain('Adjust the man in the center: the empty hand rests naturally; keep the same person, face, clothing and pose otherwise.');
    const person = compileResolvedEdit(s, basePlan(s, draft(s, { man_1: { action: 'replace', value: 'a young woman in a yellow saree' } }))).text;
    expect(person).toContain('Replace the man in the center with "a young woman in a yellow saree", in the same place, scale, pose and facing direction, holding or wearing the same objects.');
  });
});

describe('8. questions only when an answer is needed', () => {
  it('a restyle, a colour change or a replacement with its brand in the words asks nothing (the accessory with evidence is the one question)', () => {
    const s = scene(phoneOfferAnalysis());
    expect(basePlan(s, draft(s, { background_1: { action: 'modify', value: 'warm sunset gradient' } })).conflicts).toEqual([]);
    expect(basePlan(s, draft(s, { smartphone_1: { action: 'modify', property: 'color', value: 'deep blue' } })).conflicts).toEqual([]);
    expect(basePlan(s, draft(s, { smartphone_1: { action: 'replace', value: 'Xiaomi phone' } })).conflicts.map(c => c.kind)).toEqual(['accessory']);
  });
});

describe('the contradiction check catches the prompts this compiler once wrote', () => {
  const phone = scene(phoneOfferAnalysis()), xiaomi = basePlan(phone, draft(phone, { smartphone_1: { action: 'replace', value: 'Xiaomi phone' }, earbuds_1: { action: 'keep' } }));
  it('B3: a brand to show under a rule forbidding every brand, and "show no brand" for a phone the words name a brand for', () => {
    const fixed = compileResolvedEdit(phone, xiaomi).text;
    expect(promptContradictions(phone, xiaomi, fixed)).toEqual([]);
    const withoutException = fixed.replace(/ The only exception is [^.]+, as described above\./, '');
    expect(promptContradictions(phone, xiaomi, withoutException)[0]).toMatch(/text-free rule forbids every brand name/);
    const noBrand = fixed.replace('Show the Xiaomi brand only as this product would plainly carry it.', 'Show no brand name or logo on it.');
    expect(promptContradictions(phone, xiaomi, noBrand)).toContainEqual(expect.stringMatching(/"Xiaomi phone" names Xiaomi, but the prompt says to show no brand on it/));
  });

  it('B4: a new outfit next to "keep the same person, face, clothing and pose"', () => {
    const s = scene(holdingBallAnalysis()), plan = basePlan(s, draft(s, { man_1: { action: 'modify', property: 'clothing', value: 'red kurta' }, football_1: { action: 'replace', value: 'green water bottle' } }));
    const old = 'Edit the attached advertising creative. Make these changes: (1) Change the man in the center: clothing → "red kurta". Keep the same person, face, pose and expression. (2) Replace the football in the center, held by the man in the center, with "green water bottle". (3) Adjust the man in the center: the hand holds the new object naturally; keep the same person, face, clothing and pose otherwise.';
    expect(promptContradictions(s, plan, old)).toContainEqual(expect.stringMatching(/a new outfit and a kept outfit/));
  });

  it('a kept list that names a changed item, and "do not add or remove" with a replacement', () => {
    const fixed = compileResolvedEdit(phone, xiaomi).text;
    const listed = fixed.replace('Keep everything else exactly as it is: ', 'Keep everything else exactly as it is: the smartphone in the center, ');
    expect(promptContradictions(phone, xiaomi, listed)).toContainEqual('the smartphone in the center is changed but also listed as kept.');
    expect(promptContradictions(phone, xiaomi, fixed.replace('Add or remove objects only as the changes above require; add nothing else.', 'Do not add or remove elements.'))).toContainEqual(expect.stringMatching(/yet the prompt says not to add or remove elements/));
  });
});

describe('the old brand under its other names: short forms, product lines, its own marks', () => {
  const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, certainty: 'approximate' });
  const none = { brand: '', model: '', evidence: '', confidence: 0, markings: 'none' };
  const object = (id: string, kind: string, importance: string, category: string, b: ReturnType<typeof box>, identity: Record<string, unknown> = none) =>
    ({ id, kind, importance, category, description: category, box: b, occluded: false, properties: [], identity, confidence: 0.9 });
  const id = (brand: string, model: string, confidence = 0.85) => ({ brand, model, evidence: 'name printed on it', confidence, markings: 'physical' });
  // Each logo and line in its own place (a real analysis never reads two items at one spot).
  const spots = [[0.04, 0.04], [0.8, 0.04], [0.04, 0.9], [0.8, 0.9], [0.42, 0.04], [0.42, 0.9], [0.04, 0.45], [0.8, 0.45]];
  let next = 0;
  const at = (w: number, h: number) => { const [x, y] = spots[next++ % spots.length]; return box(x, y, w, h); };
  const mark = (mid: string, kind: string, text: string, owner = '', overlay = true) => ({ id: mid, kind, text, owner_id: owner, overlay, box: overlay ? at(0.12, 0.05) : box(0.45, 0.35, 0.06, 0.04) });
  const line = (tid: string, text: string, refers: string[] = [], role = 'caption') => ({ id: tid, role, text, refers_to: refers, box: at(0.14, 0.04) });
  const light = { direction: 'left', quality: 'soft', color: 'warm' };
  const markOf = (s: SceneDescription, text: string, overlay = true) => s.marks.find(m => m.text === text && m.overlay === overlay)!.id;
  const lineOf = (s: SceneDescription, text: string) => s.overlays.find(t => t.text === text)!.id;
  const op = (plan: ChangePlan, target: string) => plan.entries.find(e => e.targetId === target)?.operation;

  /** A Redmi phone (read as Xiaomi) next to an unrelated boAt speaker; the "mi" logo and the Redmi lines are not linked to it. */
  const redmi = (withBand = false) => scene({ summary: 'A Redmi phone and a boAt speaker on a sale banner.', objects: [
    object('bg', 'scenery', 'background', 'background', box(0, 0, 1, 1)), object('pedestal', 'scenery', 'supporting', 'pedestal', box(0.3, 0.72, 0.4, 0.2)),
    object('phone', 'product', 'main', 'smartphone', box(0.36, 0.2, 0.28, 0.52), id('Xiaomi', 'Redmi Note 13')),
    object('speaker', 'product', 'supporting', 'bluetooth speaker', box(0.72, 0.55, 0.2, 0.2), id('boAt', 'Stone 350', 0.8)),
    ...(withBand ? [object('band', 'product', 'supporting', 'fitness band', box(0.08, 0.6, 0.14, 0.14), id('Xiaomi', 'Smart Band 8', 0.8))] : [])],
    relations: [{ source: 'phone', relation: 'on', target: 'pedestal', evidence: '', confidence: 0.9 }],
    marks: [mark('printed', 'product_brand', 'Redmi', 'phone', false), mark('mi', 'product_brand', 'mi'), mark('boat', 'product_brand', 'boAt', 'speaker'),
      mark('store', 'merchant_logo', 'ShopKart'), mark('bank', 'bank_logo', 'HDFC Bank'), mark('sponsor', 'other_logo', 'Jio')],
    text_overlays: [line('headline', 'Redmi Note 13 at ₹14,999', [], 'headline'), line('only', 'Only on Redmi'), line('days', 'REDMI DAYS'),
      line('speaker_offer', 'boAt Stone 350 at ₹1,299', ['speaker'], 'offer'), line('bank_offer', '10% instant discount with HDFC Bank', [], 'offer')],
    lighting: light, main_candidates: ['phone'], uncertainties: [] });

  it('Redmi → iPhone: the "mi" logo and every Redmi line go; the boAt speaker, its logo and offer, and the store, bank and sponsor logos stay', () => {
    const s = redmi(), plan = basePlan(s, draft(s, { smartphone_1: { action: 'replace', value: 'iPhone 16' } }));
    expect(plan.status).toBe('clear');
    expect(plan.entries.find(e => e.id === 'inferred:smartphone_1:modify:brand')).toMatchObject({ to: 'Apple', reason: 'iPhone is a Apple product line.' });
    for (const t of [markOf(s, 'Redmi', false), markOf(s, 'mi'), lineOf(s, 'Redmi Note 13 at ₹14,999'), lineOf(s, 'Only on Redmi'), lineOf(s, 'REDMI DAYS')]) expect(op(plan, t)).toBe('remove');
    expect(plan.entries.find(e => e.targetId === markOf(s, 'mi'))!.reason).toMatch(/shows Mi, the Xiaomi brand of Smartphone, on the artwork/);
    expect(plan.entries.find(e => e.targetId === lineOf(s, 'Only on Redmi'))!.reason).toMatch(/names Redmi, the product line of Smartphone/);
    for (const t of ['bluetooth_speaker_1', markOf(s, 'boAt'), lineOf(s, 'boAt Stone 350 at ₹1,299'), markOf(s, 'ShopKart'), markOf(s, 'HDFC Bank'), markOf(s, 'Jio'), lineOf(s, '10% instant discount with HDFC Bank')])
      expect(plan.entries.find(e => e.targetId === t)).toMatchObject({ operation: 'keep', source: 'inherited' });
    const text = compileResolvedEdit(s, plan).text;
    expect(promptContradictions(s, plan, text)).toEqual([]);
    expect(text).toContain('Show the Apple brand only as this product would plainly carry it.');
    expect(text).not.toMatch(/₹|14,999|Only on Redmi|REDMI DAYS/); // the image's words are data, never copied into the prompt
  });

  it('a short form a kept product of the same brand may also show is asked about; the replaced phone\'s own line and model still go', () => {
    const s = redmi(true), plan = basePlan(s, draft(s, { smartphone_1: { action: 'replace', value: 'iPhone 16' } }));
    const asked = plan.conflicts.find(c => c.targetIds.includes(markOf(s, 'mi')))!;
    expect(asked.question).toMatch(/shows Mi, the Xiaomi brand of Smartphone, on the artwork\. It may also be about Fitness band, which stays/);
    expect(op(plan, markOf(s, 'mi'))).toBe('keep');
    for (const t of [lineOf(s, 'Only on Redmi'), lineOf(s, 'Redmi Note 13 at ₹14,999')]) expect(op(plan, t)).toBe('remove'); // the band is no Redmi
    expect(plan.conflicts).toHaveLength(1);
  });

  it('the same brand, another line: the brand\'s own logo stays, the old line\'s name and model go', () => {
    const s = redmi(), plan = basePlan(s, draft(s, { smartphone_1: { action: 'replace', value: 'Poco X6 in yellow' } }));
    expect(plan.entries.find(e => e.id === 'inferred:smartphone_1:modify:brand')).toMatchObject({ to: 'Xiaomi' });
    expect(op(plan, markOf(s, 'mi'))).toBe('keep');
    for (const t of [lineOf(s, 'Redmi Note 13 at ₹14,999'), lineOf(s, 'Only on Redmi'), lineOf(s, 'REDMI DAYS')]) expect(op(plan, t)).toBe('remove');
    // A newer phone of the same line keeps the line's name, and loses only the old model's.
    const newer = basePlan(s, draft(s, { smartphone_1: { action: 'replace', value: 'Redmi Note 14' } }));
    expect(op(newer, lineOf(s, 'Only on Redmi'))).toBe('keep');
    expect(op(newer, lineOf(s, 'Redmi Note 13 at ₹14,999'))).toBe('remove');
  });

  /** A made-up skincare brand nothing in the code knows: its monogram, its line (from the model) and its name, by the image alone. */
  const serum = () => scene({ summary: 'A Velora serum bottle with an Ostra jade roller.', objects: [
    object('bg', 'scenery', 'background', 'background', box(0, 0, 1, 1)),
    object('bottle', 'product', 'main', 'serum bottle', box(0.35, 0.25, 0.22, 0.5), id('Velora', 'Lumen 2', 0.8)),
    object('roller', 'product', 'supporting', 'jade roller', box(0.65, 0.55, 0.2, 0.2), id('Ostra', '', 0.7))],
    relations: [], marks: [mark('vl_printed', 'product_brand', 'VL', 'bottle', false), mark('vl', 'product_brand', 'VL'), mark('ostra', 'product_brand', 'Ostra'), mark('shop', 'merchant_logo', 'GlowMart')],
    text_overlays: [line('collection', 'Discover the Lumen collection'), line('brand', 'Velora skincare'), line('glow', 'Bright lumen glow'), line('roller_line', 'Glow with Ostra'), line('delivery', 'Free delivery at GlowMart')],
    lighting: light, main_candidates: ['bottle'], uncertainties: [] });

  it('its names come from the image: the brand, the marks it carries and its model\'s line; never a qualifier or its own category word', () => {
    const s = serum(), bottle = s.objects.find(o => o.category === 'serum bottle')!;
    expect(productNames(s, bottle)).toEqual([{ name: 'Velora', kind: 'brand' }, { name: 'Lumen', kind: 'line', asWritten: true }, { name: 'VL', kind: 'brand', asWritten: true }]);
    const named = (model: string, category = 'kettle', brand = '') => {
      const one = scene({ summary: '', objects: [object('k', 'product', 'main', category, box(0.2, 0.2, 0.5, 0.5), id(brand, model))], relations: [], marks: [], text_overlays: [], lighting: light, main_candidates: ['k'], uncertainties: [] });
      return productNames(one, one.objects.find(o => o.category === category)!);
    };
    expect(named('Kestrel 2')).toEqual([{ name: 'Kestrel', kind: 'line', asWritten: true }]);
    expect(named('Kettle 2')).toEqual([]);
    expect(named('Pro Max 15')).toEqual([]);
    expect(named('Redmi Note 13', 'smartphone', 'Redmi').map(n => `${n.kind}:${n.name}`)).toEqual(['brand:Xiaomi', 'line:Redmi', 'brand:Mi', 'brand-line:Poco', 'brand-line:Mijia']);
  });

  it('another brand: the monogram, the line and the brand\'s name go; the other brand, the shop and an everyday word stay', () => {
    const s = serum(), plan = basePlan(s, draft(s, { serum_bottle_1: { action: 'replace', value: 'a frosted glass face cream jar' } }));
    expect(plan.status).toBe('clear');
    for (const t of [markOf(s, 'VL'), lineOf(s, 'Discover the Lumen collection'), lineOf(s, 'Velora skincare')]) expect(op(plan, t)).toBe('remove');
    for (const t of [markOf(s, 'Ostra'), markOf(s, 'GlowMart'), lineOf(s, 'Bright lumen glow'), lineOf(s, 'Glow with Ostra'), lineOf(s, 'Free delivery at GlowMart'), 'jade_roller_1'])
      expect(plan.entries.find(e => e.targetId === t)).toMatchObject({ operation: 'keep', source: 'inherited' });
    const text = compileResolvedEdit(s, plan).text;
    expect(promptContradictions(s, plan, text)).toEqual([]);
    expect(text).toContain('Show no brand name or logo on it.');
  });

  it('the same made-up brand, another line: its monogram and name stay, the old line goes', () => {
    const s = serum(), plan = basePlan(s, draft(s, { serum_bottle_1: { action: 'replace', value: 'Velora Aura cream jar' } }));
    expect(plan.entries.find(e => e.id === 'inferred:serum_bottle_1:modify:brand')).toMatchObject({ to: 'Velora' });
    expect(op(plan, lineOf(s, 'Discover the Lumen collection'))).toBe('remove');
    for (const t of [markOf(s, 'VL'), lineOf(s, 'Velora skincare'), markOf(s, 'Ostra')]) expect(op(plan, t)).toBe('keep');
  });
});
