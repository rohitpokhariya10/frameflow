import { describe, expect, it } from 'vitest';
import { appliancesAnalysis, holdingBallAnalysis, phoneOfferAnalysis, sofaAnalysis, twoPhonesAnalysis } from '../../../server/src/decomposition/creativeTemplates/scene.fixture.js';
import { applySceneCorrections, mapSceneToSlots, mainIsAmbiguous, parseSceneDescription, protectedGroup, SceneValidationError, type SceneDescription } from './scene.js';
import { applyConflictOption, basePlan, canonicalDraft, cleanDraft, compileResolvedEdit, DraftError, inventsFacts, mergeResolution, needsResolver, parseResolverProposal, planCompatibility, TEXT_FREE_RULE, type ResolverProposal, type SceneDraft } from './changePlan.js';
import { compileVariantPrompt, scenePromptProblems, sceneSimilarity } from './variants.js';
import { parseVerificationAnswer, planExpectations, verificationStatus } from './verification.js';
import type { TemplateStructure } from './types.js';

const scene = (raw: unknown) => parseSceneDescription(raw);
const draft = (s: SceneDescription, edits: SceneDraft['edits'], extra: Partial<SceneDraft> = {}, hasReference = false) => cleanDraft(s, { edits, ...extra }, { hasReference });
const noProposal = (): ResolverProposal => ({ understanding: [], inferred: [], conflicts: [], productPhoto: { present: false, category: '', brand: '', evidence: '', matchesRequest: 'unclear', description: '' } });

describe('scene analysis: validated, canonical, per image', () => {
  it('gives stable ids and position-aware labels to similar objects, whatever order the model used', () => {
    const s = scene(twoPhonesAnalysis()), reversed = twoPhonesAnalysis();
    reversed.objects.reverse();
    const again = scene(reversed);
    expect(s.objects.map(o => [o.id, o.label, o.description])).toEqual(again.objects.map(o => [o.id, o.label, o.description]));
    expect(s.objects.filter(o => o.category === 'smartphone').map(o => [o.id, o.label, o.description])).toEqual([['smartphone_1', 'Smartphone · left', 'Black smartphone'], ['smartphone_2', 'Smartphone · right', 'Blue smartphone']]);
    expect(mainIsAmbiguous(s)).toBe(true);
  });

  it('reads products, people with held objects, appliances and furniture dynamically, with marks and text kept apart', () => {
    const phone = scene(phoneOfferAnalysis());
    expect(phone.objects.map(o => o.label)).toEqual(['Background', 'Earbuds', 'Pedestal', 'Smartphone']);
    expect(phone.marks.map(m => [m.label, m.kind, m.ownerId ?? null])).toEqual([['Merchant logo', 'merchant_logo', null], ['Product brand mark', 'product_brand', 'smartphone_1'], ['Bank logo', 'bank_logo', null]]);
    expect(phone.overlays.map(t => [t.id, t.role, t.refersTo])).toEqual([['text_1', 'headline', ['smartphone_1']], ['text_2', 'offer', []]]);
    expect(phone.relations).toContainEqual(expect.objectContaining({ source: 'earbuds_1', relation: 'accessory_of', target: 'smartphone_1' }));
    const ball = scene(holdingBallAnalysis());
    expect(ball.relations).toContainEqual(expect.objectContaining({ source: 'man_1', relation: 'holds', target: 'football_1' }));
    expect(protectedGroup(ball, ['football_1'])).toEqual({ ids: ['football_1', 'man_1'], added: [{ id: 'man_1', because: 'holds or wears Football' }] });
    const appliances = scene(appliancesAnalysis());
    expect(appliances.objects.filter(o => o.kind === 'product').map(o => o.label)).toEqual(['Refrigerator', 'Washing machine']);
    expect(mainIsAmbiguous(appliances)).toBe(true);
    const sofa = scene(sofaAnalysis());
    // A non-Latin category keeps its label and gets a kind-based id.
    expect(sofa.objects.find(o => o.category === 'कुशन')).toMatchObject({ id: 'object_1', label: 'कुशन', kind: 'object' });
    expect(sofa.lighting).toEqual({ direction: 'right', quality: 'soft', color: 'warm' });
  });

  it('rejects invalid analyses whole: unknown references, loops, bad regions, duplicates', () => {
    const bad = (change: (raw: ReturnType<typeof holdingBallAnalysis>) => void) => { const raw = holdingBallAnalysis(); change(raw); return () => scene(raw); };
    expect(bad(r => { r.relations.push({ source: 'ball', relation: 'holds', target: 'man', evidence: '', confidence: 0.9 }); })).toThrow(/loop/);
    expect(bad(r => { r.relations.push({ source: 'man', relation: 'holds', target: 'ghost', evidence: '', confidence: 0.9 }); })).toThrow(SceneValidationError);
    expect(bad(r => { (r.objects[1] as { box: unknown }).box = { x: 0.8, y: 0, w: 0.5, h: 1 }; })).toThrow(/region/);
    expect(bad(r => { (r.objects[2] as { id: string }).id = 'man'; })).toThrow(/unique/);
    expect(bad(r => { (r.objects[1] as { kind: string }).kind = 'robot'; })).toThrow(/kind/);
    expect(bad(r => { (r as { main_candidates: string[] }).main_candidates = ['nobody']; })).toThrow(/main candidate/);
    expect(() => scene({ objects: [] })).toThrow(/1–24 objects/);
  });

  it('treats image text as bounded data and keeps corrections apart from detections', () => {
    const s = scene(phoneOfferAnalysis());
    expect(s.overlays[1].text).not.toMatch(/[<>{}"]/);
    const corrected = applySceneCorrections(s, { smartphone_1: { brand: 'Google' } });
    expect(corrected.objects.find(o => o.id === 'smartphone_1')).toMatchObject({ identity: { brand: 'Google', model: '', evidence: 'corrected by the user' }, corrected: { fields: ['brand'], detected: { brand: 'Apple', model: 'iPhone 15 Pro' } } });
  });

  it('maps detected objects onto a reused template\'s saved fields, repeated roles by position', () => {
    const s = scene(twoPhonesAnalysis());
    const structure: TemplateStructure = { layers: [{ id: 'background', role: 'background', order: 0, independent: true, required: false, zone: 'full-canvas' },
      { id: 'main_product', role: 'main_product', order: 1, independent: true, required: true, zone: 'middle-right' }, { id: 'main_product_2', role: 'main_product', order: 2, independent: true, required: true, zone: 'middle-left' }], relationships: [] };
    expect(mapSceneToSlots(s, { structure }).slots).toEqual({ background_1: 'background', smartphone_2: 'main_product', smartphone_1: 'main_product_2' });
  });
});

describe('change plans: explicit, inherited, inferred, conflicts', () => {
  it('all fields empty: everything inherited, nothing to generate', () => {
    const s = scene(phoneOfferAnalysis()), plan = basePlan(s, draft(s, {}));
    expect(plan.status).toBe('unchanged');
    expect(plan.entries.every(e => e.source === 'inherited' && e.operation === 'keep')).toBe(true);
    expect(compileResolvedEdit(s, plan).text).toContain('Generate a new creative from the reference image');
  });

  it('a background-only change keeps the product, its marks, the logos and the text', () => {
    const s = scene(phoneOfferAnalysis()), plan = basePlan(s, draft(s, { background_1: { action: 'modify', value: 'warm sunset gradient' } }));
    expect(plan.status).toBe('clear');
    expect(plan.entries.filter(e => e.operation !== 'keep').map(e => [e.targetId, e.source])).toEqual([['background_1', 'explicit']]);
    expect(needsResolver(s, draft(s, { background_1: { action: 'modify', value: 'teal' } }))).toBe(false);
    const prompt = compileResolvedEdit(s, plan).text;
    expect(prompt).toContain('Restyle the background: "warm sunset gradient"');
    expect(prompt).toMatch(/Keep every logo and printed marking not changed above exactly as it is, where it is \(the merchant logo at the top left, the product brand mark on the smartphone in the center and the bank logo at the bottom right\)/);
    expect(planCompatibility(plan).status).toBe('compatible');
  });

  it('replacing the phone takes its own brand mark and its offer text along, asks about its accessory, and keeps merchant and bank logos', () => {
    const s = scene(phoneOfferAnalysis()), plan = basePlan(s, draft(s, { smartphone_1: { action: 'replace', value: 'Xiaomi smartphone' } }));
    const by = (target: string) => plan.entries.filter(e => e.targetId === target).map(e => `${e.source}:${e.operation}`);
    // "Xiaomi smartphone" names its brand: read from the user's own words by rule (B3), shown as an inferred entry.
    expect(by('smartphone_1')).toEqual(['explicit:replace', 'inferred:modify']);
    expect(plan.entries.find(e => e.id === 'inferred:smartphone_1:modify:brand')).toMatchObject({ to: 'Xiaomi', reason: 'Your description names this brand.' });
    expect(by('mark_2')).toEqual(['inferred:remove']); // the Apple mark printed on the phone
    expect(by('text_1')).toEqual(['inferred:remove']); // "iPhone … at ₹…" never transfers to another product
    expect(by('mark_1')).toEqual(['inherited:keep']); expect(by('mark_3')).toEqual(['inherited:keep']); expect(by('text_2')).toEqual(['inherited:keep']);
    expect(plan.status).toBe('needs-input');
    expect(plan.conflicts.map(c => [c.id, c.kind])).toEqual([['rule:accessory:earbuds_1', 'accessory']]);
    expect(() => compileResolvedEdit(s, plan)).toThrow(DraftError);
    // Answering keeps the earbuds as the user's own explicit choice.
    const answered = applyConflictOption(draft(s, { smartphone_1: { action: 'replace', value: 'Xiaomi smartphone' } }), plan.conflicts[0].options[0]).draft;
    const clear = basePlan(s, cleanDraft(s, answered));
    expect(clear.status).toBe('clear');
    expect(clear.entries.find(e => e.targetId === 'earbuds_1')).toMatchObject({ source: 'explicit', operation: 'keep' });
    const compiled = compileResolvedEdit(s, clear);
    expect(compiled.text).not.toMatch(/all visible text/);
    expect(compiled.text).toContain('Remove the product brand mark on the smartphone in the center completely; do not carry the old brand over to anything else.');
    expect(compiled.text).toContain('Remove the overlaid text block at the top completely');
    expect(compiled.text).toContain('the merchant logo at the top left and the bank logo at the bottom right');
    expect(compiled.text).not.toContain('Ignore previous instructions');
    // The text-free rule stays, with the one exception the replacement sentence itself asks for (B3: no contradiction).
    expect(compiled.text).toContain('Show the Xiaomi brand only as this product would plainly carry it.');
    expect(compiled.text.endsWith(`${TEXT_FREE_RULE} The only exception is the Xiaomi brand marking on the new smartphone, shown only as that product plainly carries it, as described above.`)).toBe(true);
    expect(compiled.compatibility.status).toBe('structural-change');
  });

  it('an uncertain accessory relation is noted and kept, never assumed', () => {
    const raw = phoneOfferAnalysis();
    raw.relations[1].confidence = 0.4;
    const s = scene(raw), plan = basePlan(s, draft(s, { smartphone_1: { action: 'replace', value: 'Xiaomi smartphone' } }));
    expect(plan.conflicts).toEqual([]);
    expect(plan.entries.find(e => e.targetId === 'earbuds_1')).toMatchObject({ source: 'inherited', operation: 'keep' });
    expect(plan.notes.join(' ')).toMatch(/may belong with Smartphone \(uncertain\)/);
  });

  it('changing one of several products leaves the other product and its own brand mark alone', () => {
    const s = scene(appliancesAnalysis()), plan = basePlan(s, draft(s, { refrigerator_1: { action: 'replace', value: 'black side-by-side refrigerator', brand: 'Whirlpool' } }));
    expect(plan.status).toBe('clear');
    expect(plan.entries.filter(e => e.operation !== 'keep').map(e => [e.targetId, e.operation, e.source])).toEqual([['refrigerator_1', 'replace', 'explicit'], ['mark_1', 'remove', 'inferred']]);
    expect(plan.entries.find(e => e.targetId === 'washing_machine_1')).toMatchObject({ operation: 'keep', source: 'inherited' });
    expect(plan.entries.find(e => e.targetId === 'mark_2')).toMatchObject({ operation: 'keep', source: 'inherited' });
    const text = compileResolvedEdit(s, plan).text;
    expect(text).toContain('Replace the refrigerator on the left with "Whirlpool black side-by-side refrigerator"');
    expect(text).toContain('Show the Whirlpool brand only as this product would plainly carry it.');
    expect(text).toContain('(the product brand mark on the washing machine at the bottom right)');
  });

  it('a held ball replaced by a bottle updates the grip and keeps the person', () => {
    const s = scene(holdingBallAnalysis()), plan = basePlan(s, draft(s, { football_1: { action: 'replace', value: 'green water bottle' } }));
    expect(plan.entries.filter(e => e.operation !== 'keep').map(e => [e.targetId, e.operation, e.source, e.property ?? ''])).toEqual([['football_1', 'replace', 'explicit', ''], ['man_1', 'adjust', 'inferred', 'grip']]);
    const text = compileResolvedEdit(s, plan).text;
    expect(text).toContain('Replace the football in the center, held by the man in the center, with "green water bottle".');
    expect(text).toContain('Adjust the man in the center: the hand holds the new object naturally; keep the same person, face, clothing and pose otherwise.');
  });

  it('a clothing change keeps the person and the held object without a resolver call', () => {
    const s = scene(holdingBallAnalysis()), d = draft(s, { man_1: { action: 'modify', property: 'clothing', value: 'red kurta' } }), plan = basePlan(s, d);
    expect(needsResolver(s, d)).toBe(false);
    expect(plan.entries.filter(e => e.operation !== 'keep').map(e => e.targetId)).toEqual(['man_1']);
    expect(plan.entries.find(e => e.targetId === 'football_1')).toMatchObject({ operation: 'keep', source: 'inherited' });
    expect(compileResolvedEdit(s, plan).text).toContain('Change the man in the center: clothing → "red kurta". Keep the same person, face, pose and expression, and everything held or worn that is not changed above.');
  });

  it('explicit removal differs from omission; removing the holder takes the held object along or asks', () => {
    const s = scene(holdingBallAnalysis());
    expect(basePlan(s, draft(s, {})).entries.find(e => e.targetId === 'football_1')).toMatchObject({ operation: 'keep', source: 'inherited' });
    const removed = basePlan(s, draft(s, { man_1: { action: 'remove' } }));
    expect(removed.entries.find(e => e.targetId === 'football_1')).toMatchObject({ operation: 'remove', source: 'inferred' });
    const contradictory = basePlan(s, draft(s, { man_1: { action: 'remove' }, football_1: { action: 'modify', value: 'blue' } }));
    expect(contradictory.status).toBe('needs-input');
    expect(contradictory.conflicts[0]).toMatchObject({ kind: 'dependency', targetIds: ['football_1', 'man_1'] });
    // Keeping a mark of a replaced product is asked, not silently overwritten.
    const phone = scene(phoneOfferAnalysis()), kept = basePlan(phone, draft(phone, { smartphone_1: { action: 'replace', value: 'Pixel phone' }, mark_2: { action: 'keep' }, earbuds_1: { action: 'keep' } }));
    expect(kept.conflicts.map(c => c.id)).toEqual(['rule:dependency:mark_2']);
    const confirmed = basePlan(phone, cleanDraft(phone, applyConflictOption(draft(phone, { smartphone_1: { action: 'replace', value: 'Pixel phone' }, mark_2: { action: 'keep' }, earbuds_1: { action: 'keep' } }), kept.conflicts[0].options[1]).draft));
    expect(confirmed.status).toBe('clear');
  });

  it('a brand alone is a meaningful request: it asks what the product becomes', () => {
    const s = scene(phoneOfferAnalysis()), plan = basePlan(s, draft(s, { smartphone_1: { action: 'replace', brand: 'Samsung' }, earbuds_1: { action: 'keep' } }));
    expect(plan.status).toBe('needs-input');
    expect(plan.conflicts[0]).toMatchObject({ kind: 'identity-unclear', question: expect.stringMatching(/Only a brand was given/) });
    const generic = applyConflictOption(draft(s, { smartphone_1: { action: 'replace', brand: 'Samsung' }, earbuds_1: { action: 'keep' } }), plan.conflicts[0].options[0]).draft;
    expect(generic.edits.smartphone_1).toEqual({ action: 'replace', value: 'smartphone, no specific model', brand: 'Samsung' });
    expect(compileResolvedEdit(s, basePlan(s, cleanDraft(s, generic))).text).toContain('with "Samsung smartphone, no specific model"');
    // The same brand it already shows changes nothing.
    expect(basePlan(s, draft(s, { smartphone_1: { action: 'modify', brand: 'apple' } })).notes[0]).toMatch(/already shows apple/);
  });

  it('a product photo alone is enough to replace a product, without inventing a description', () => {
    const s = scene(phoneOfferAnalysis()), d = draft(s, { smartphone_1: { action: 'replace' }, earbuds_1: { action: 'keep' } }, { referenceFor: 'smartphone_1' }, true);
    expect(needsResolver(s, d)).toBe(true);
    const plan = basePlan(s, d);
    expect(plan.entries[0]).toMatchObject({ targetId: 'smartphone_1', to: 'the product shown in the attached product photo', reference: true });
    expect(compileResolvedEdit(s, plan, { productReference: true }).text).toContain('Match it to the second attached image (the product photo)');
    expect(() => draft(s, { smartphone_1: { action: 'replace' } })).toThrow(/attach a product photo/);
    expect(() => draft(s, { background_1: { action: 'remove' } })).toThrow(/can only be kept or changed/);
  });

  it('validates a resolver proposal: brand from the user\'s words, no invented specs or offers, explicit choices win', () => {
    const s = scene(phoneOfferAnalysis()), d = draft(s, { smartphone_1: { action: 'replace', value: 'Xiaomi phone' }, earbuds_1: { action: 'keep' } }), base = basePlan(s, d);
    const proposal: ResolverProposal = { ...noProposal(),
      understanding: [{ targetId: 'smartphone_1', brand: 'Xiaomi', brandSource: 'inferred', identity: 'a Xiaomi smartphone', specificity: 'brand_and_category' }],
      inferred: [{ targetId: 'mark_2', operation: 'remove', property: '', to: '', reason: 'Apple logo on the old phone', evidence: '', confidence: 0.9 },
        { targetId: 'smartphone_1', operation: 'modify', property: 'model', to: 'Xiaomi 14 Ultra', reason: 'likely model', evidence: '', confidence: 0.9 },
        { targetId: 'text_2', operation: 'remove', property: '', to: '', reason: 'cashback belongs to the old offer', evidence: '', confidence: 0.4 },
        { targetId: 'earbuds_1', operation: 'replace', property: '', to: 'Xiaomi earbuds', reason: 'match the brand', evidence: '', confidence: 0.95 },
        { targetId: 'background_1', operation: 'adjust', property: 'light', to: 'Rs 999 offer glow', reason: 'x', evidence: '', confidence: 0.9 },
        { targetId: 'nobody', operation: 'remove', property: '', to: '', reason: '', evidence: '', confidence: 1 }] };
    const { plan, rejected } = mergeResolution(s, d, base, proposal);
    expect(plan.entries.find(e => e.id === 'inferred:smartphone_1:modify:brand')).toMatchObject({ to: 'Xiaomi', source: 'inferred' });
    expect(plan.entries.find(e => e.targetId === 'smartphone_1' && e.source === 'explicit')!.brand).toBe('Xiaomi');
    // The rules already read Xiaomi from the words, so the base plan never claims that no brand was given (B3b).
    expect(base.entries.find(e => e.targetId === 'smartphone_1' && e.source === 'explicit')!.brand).toBe('Xiaomi');
    expect([...base.notes, ...plan.notes].join(' ')).not.toMatch(/No brand was given/);
    expect(plan.entries.filter(e => e.id === 'inferred:smartphone_1:modify:brand')).toHaveLength(1);
    expect(rejected.join('\n')).toMatch(/your own choice stands/); // the explicit phone replacement and kept earbuds
    expect(rejected.join('\n')).toMatch(/adds a number, price, offer or specification/);
    expect(rejected.join('\n')).toMatch(/unknown item/);
    // A low-confidence removal becomes a question.
    expect(plan.conflicts.map(c => c.id)).toEqual(['resolver:uncertain:text_2:remove']);
    const text = compileResolvedEdit(s, mergeResolution(s, d, base, { ...proposal, inferred: proposal.inferred.slice(0, 1) }).plan).text;
    expect(text).toContain('Replace the smartphone in the center with "Xiaomi phone".');
    expect(text).toContain('Show the Xiaomi brand only as this product would plainly carry it.');
    expect(text).not.toContain('14 Ultra');
    // A brand nobody named is refused, with the true reason: here the words name another brand.
    const oppo: ResolverProposal = { ...noProposal(), understanding: [{ targetId: 'smartphone_1', brand: 'Oppo', brandSource: 'inferred', identity: '', specificity: 'unclear' }] };
    expect(mergeResolution(s, d, base, oppo).rejected[0]).toMatch(/A brand \(Oppo\) other than the one you gave or your words name \(Xiaomi\)/);
    const plain = draft(s, { smartphone_1: { action: 'replace', value: 'slim phone' }, earbuds_1: { action: 'keep' } });
    expect(mergeResolution(s, plain, basePlan(s, plain), oppo).rejected[0]).toMatch(/neither your words nor the product photo/);
    // A brand the local list does not know comes only from the resolver: accepted when the user's words name it, even
    // when the resolver calls it "explicit" (B3c: that answer was once refused with a false message).
    const z = draft(s, { smartphone_1: { action: 'replace', value: 'Zentro phone' }, earbuds_1: { action: 'keep' } }), zBase = basePlan(s, z);
    expect(zBase.notes.join(' ')).toMatch(/No brand was given for the new smartphone, and your words name none/);
    const zMerged = mergeResolution(s, z, zBase, { ...noProposal(), understanding: [{ targetId: 'smartphone_1', brand: 'Zentro', brandSource: 'explicit', identity: 'a Zentro smartphone', specificity: 'brand_and_category' }] });
    expect(zMerged.rejected).toEqual([]);
    expect(zMerged.plan.entries.find(e => e.targetId === 'smartphone_1' && e.source === 'explicit')!.brand).toBe('Zentro');
    expect(zMerged.plan.notes.join(' ')).not.toMatch(/No brand was given/);
    expect(compileResolvedEdit(s, zMerged.plan).text).toContain('The only exception is the Zentro brand marking on the new smartphone');
  });

  it('flags a product/brand contradiction and a photo that shows another product, as questions with concrete answers', () => {
    const s = scene(phoneOfferAnalysis()), d = draft(s, { smartphone_1: { action: 'replace', value: 'Xiaomi phone', brand: 'Apple' }, earbuds_1: { action: 'keep' } }, { referenceFor: 'smartphone_1' }, true), base = basePlan(s, d);
    const { plan } = mergeResolution(s, d, base, { ...noProposal(),
      conflicts: [{ kind: 'product-brand', targetIds: ['smartphone_1'], question: 'Xiaomi or Apple?', options: [
        { label: 'Xiaomi phone', targetId: 'smartphone_1', action: 'replace', value: 'Xiaomi phone', brand: 'Xiaomi' }, { label: 'Apple phone', targetId: 'smartphone_1', action: 'replace', value: 'phone', brand: 'Apple' }] }],
      productPhoto: { present: true, category: 'smartphone', brand: 'Samsung', evidence: 'Samsung wordmark', matchesRequest: 'no', description: 'Samsung Galaxy smartphone' } });
    expect(plan.status).toBe('needs-input');
    expect(plan.conflicts.map(c => c.kind)).toEqual(['product-brand', 'image-text']);
    const photo = plan.conflicts[1];
    expect(applyConflictOption(d, photo.options[1]).draft.referenceFor).toBeUndefined();
    expect(applyConflictOption(d, photo.options[0]).draft.edits.smartphone_1).toEqual({ action: 'replace', value: 'Samsung Galaxy smartphone', brand: 'Samsung' });
  });

  it('a brand the resolver reads from a "change" also takes the old brand\'s marks and claims along, and is matched as a whole word of that item only', () => {
    const s = scene(phoneOfferAnalysis()), d = draft(s, { smartphone_1: { action: 'modify', value: 'Samsung Galaxy look in blue' }, earbuds_1: { action: 'replace', value: 'white wireless earbuds' } }), base = basePlan(s, d);
    const brand = (targetId: string, value: string): ResolverProposal['understanding'][number] => ({ targetId, brand: value, brandSource: 'inferred', identity: '', specificity: 'brand_and_category' });
    const { plan, rejected } = mergeResolution(s, d, base, { ...noProposal(), understanding: [brand('smartphone_1', 'Samsung'), brand('earbuds_1', 'Samsung')] });
    expect(plan.entries.find(e => e.targetId === 'mark_2')).toMatchObject({ operation: 'remove', source: 'inferred' });
    expect(plan.entries.find(e => e.targetId === 'text_1')).toMatchObject({ operation: 'remove', source: 'inferred' });
    // The earbuds' own words name no brand: the phone's brand is not stamped on them.
    expect(plan.entries.find(e => e.targetId === 'earbuds_1' && e.source === 'explicit')!.brand).toBeUndefined();
    expect(rejected.join(' ')).toMatch(/A brand \(Samsung\)/);
    const text = compileResolvedEdit(s, plan).text;
    expect(text).not.toMatch(/Keep every logo[^.]*product brand mark on the smartphone/);
    // Whole words only.
    const minimal = draft(s, { smartphone_1: { action: 'replace', value: 'minimal opposite pineapple phone' }, earbuds_1: { action: 'keep' } });
    const words = mergeResolution(s, minimal, basePlan(s, minimal), { ...noProposal(), understanding: [brand('smartphone_1', 'Mi'), brand('smartphone_1', 'Oppo'), brand('smartphone_1', 'Apple')] });
    expect(words.plan.entries.find(e => e.targetId === 'smartphone_1' && e.source === 'explicit')!.brand).toBeUndefined();
    expect(words.rejected).toHaveLength(3);
  });

  it('replacing an object with only the brand it already shows asks what replaces it; its own parts go with it', () => {
    const s = scene(phoneOfferAnalysis()), same = basePlan(s, draft(s, { smartphone_1: { action: 'replace', brand: 'Apple' }, earbuds_1: { action: 'keep' } }));
    expect(same.status).toBe('needs-input');
    expect(same.conflicts[0].question).toMatch(/already shows Apple/);
    const watch = scene({ summary: 'A watch.', objects: [{ id: 'bg', kind: 'scenery', importance: 'background', category: 'background', description: 'Grey', box: { x: 0, y: 0, w: 1, h: 1 }, properties: [], confidence: 0.9 },
      { id: 'watch', kind: 'product', importance: 'main', category: 'watch', description: 'Steel watch', box: { x: 0.3, y: 0.2, w: 0.4, h: 0.3 }, properties: [], confidence: 0.9 },
      { id: 'strap', kind: 'object', importance: 'supporting', category: 'strap', description: 'Brown leather strap', box: { x: 0.35, y: 0.5, w: 0.3, h: 0.4 }, properties: [], confidence: 0.9 }],
      relations: [{ source: 'strap', relation: 'part_of', target: 'watch', evidence: 'joined at the lugs', confidence: 0.95 }], marks: [], text_overlays: [], lighting: {}, main_candidates: ['watch'], uncertainties: [] });
    const replaced = basePlan(watch, draft(watch, { watch_1: { action: 'replace', value: 'gold smartwatch' } }));
    expect(replaced.entries.find(e => e.targetId === 'strap_1')).toMatchObject({ operation: 'remove', source: 'inferred', reason: expect.stringMatching(/part of Watch/) });
    expect(compileResolvedEdit(watch, replaced).text).not.toMatch(/Keep everything else exactly as it is: the strap/);
  });

  it('rejects malformed resolver output whole', () => {
    expect(() => parseResolverProposal({ understanding: [], inferred: [{ target_id: 'x', operation: 'explode' }], conflicts: [], product_photo: {} })).toThrow(/invalid/);
    expect(() => parseResolverProposal('nope')).toThrow(/invalid/);
    expect(parseResolverProposal({ understanding: [], inferred_changes: [], conflicts: [], product_photo: { present: false, category: '', brand: '', evidence: '', matches_request: 'unclear', description: '' } })).toEqual(noProposal());
  });

  it('binds a draft canonically and refuses unknown items or misplaced brands', () => {
    const s = scene(phoneOfferAnalysis());
    expect(canonicalDraft({ edits: { b: { action: 'keep' }, a: { value: 'x', action: 'modify' } }, corrections: {} })).toBe(canonicalDraft({ corrections: {}, edits: { a: { action: 'modify', value: 'x' }, b: { action: 'keep' } } }));
    expect(() => draft(s, { ghost_1: { action: 'remove' } })).toThrow(/did not detect/);
    expect(() => draft(s, { mark_1: { action: 'modify', value: 'New logo' } })).toThrow(/can only be kept or removed/);
    expect(() => draft(s, { background_1: { action: 'modify', value: 'teal', brand: 'Nike' } })).toThrow(/brand belongs to a product/);
    expect(() => draft(s, { smartphone_1: { action: 'keep', value: 'x' } })).toThrow(/takes no new value/);
    expect(cleanDraft(s, { edits: { smartphone_1: { action: 'modify', value: 'लाल रंग "{quoted}"' } } }).edits.smartphone_1.value).toBe('लाल रंग \' quoted \'');
  });

  it('never accepts invented numbers, prices or offers', () => {
    expect(inventsFacts('Xiaomi 14', 'Xiaomi phone')).toBe(true);
    expect(inventsFacts('Xiaomi 14', 'Xiaomi 14 phone')).toBe(false);
    expect(inventsFacts('festive discount glow', 'warm background')).toBe(true);
    expect(inventsFacts('128 GB storage', 'phone')).toBe(true);
    expect(inventsFacts('matte black finish', 'phone')).toBe(false);
  });
});

describe('creative variants and semantic checks', () => {
  it('keeps variant scenes text-free and wraps them in locked preservation rules', () => {
    expect(scenePromptProblems('marble plinth under soft window light')).toEqual([]);
    expect(scenePromptProblems('दीयों के साथ उत्सव का दृश्य')).toEqual([]);
    for (const bad of ['a banner that says SALE', 'with the price ₹999', '"Diwali Dhamaka" in gold', 'neon sign behind it', 'छूट के साथ']) expect(scenePromptProblems(bad)).toHaveLength(1);
    const prompt = compileVariantPrompt({ protectedLabels: ['Smartphone'], lighting: { direction: 'left', quality: 'soft', color: 'warm' }, scene: 'marble plinth under soft window light', people: false });
    expect(prompt).toContain('paint only the masked area with new artwork: marble plinth under soft window light.');
    expect(prompt).toContain('the light comes from the left, soft, warm in tone');
    expect(prompt).toContain(TEXT_FREE_RULE);
    expect(() => compileVariantPrompt({ protectedLabels: [], lighting: { direction: 'unclear', quality: 'unclear', color: 'unclear' }, scene: 'big SALE text', people: false })).toThrow(/text-free/);
    expect(sceneSimilarity('marble plinth soft light', 'marble plinth soft light')).toBe(1);
    expect(sceneSimilarity('marble plinth soft light', 'neon city rooftop at night')).toBe(0);
  });

  it('asks exactly the expected checks and never turns a failure into a pass', () => {
    const s = scene(phoneOfferAnalysis()), plan = basePlan(s, draft(s, { smartphone_1: { action: 'replace', value: 'Xiaomi phone', brand: 'Xiaomi' }, earbuds_1: { action: 'keep' } }));
    const asked = planExpectations(s, plan);
    expect(asked.map(a => a.id)).toEqual(['replacement-done', 'brand-consistent', 'old-references-absent', 'protected-kept', 'subject-count', 'no-added-text', 'no-duplicates', 'layout-kept']);
    expect(asked.find(a => a.id === 'protected-kept')!.expectation).toContain('the merchant logo at the top left; the bank logo at the bottom right');
    const answer = (status: string) => ({ checks: asked.map(a => ({ id: a.id, status: a.id === 'no-added-text' ? status : 'pass', message: 'ok' })) });
    expect(verificationStatus(parseVerificationAnswer(answer('pass'), asked))).toBe('passed');
    expect(verificationStatus(parseVerificationAnswer(answer('fail'), asked))).toBe('contradiction');
    expect(verificationStatus(parseVerificationAnswer(answer('uncertain'), asked))).toBe('uncertain');
    expect(() => parseVerificationAnswer({ checks: asked.slice(1).map(a => ({ id: a.id, status: 'pass', message: '' })) }, asked)).toThrow(/skipped/);
    expect(() => parseVerificationAnswer({ checks: [...asked, asked[0]].map(a => ({ id: a.id, status: 'pass', message: '' })) }, asked)).toThrow();
  });
});
