import { describe, expect, it } from 'vitest';
import {
  blueprintFromAnalysis, blueprintProblems, compareSignatures, compileDecompositionPlan, compileGenerationPrompt, compileTemplate, decide, DEFAULT_MATCH_THRESHOLDS, FAMILY_SEEDS,
  instanceSlotValues, matchThresholds, planSlotChanges, PromptTemplateError, reuseBaseline, reuseSaving, safeLayoutName, sanitizeSlotValue, seedBlueprint, signatureKey, slotFormModel,
  templateProblems, validateMatch, type StructuralSignature, type StructureAnalysis,
} from '../index.js';

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
/** A centred product offer: headline above, CTA below, badge top-right. Only the product's own shape varies. */
export function centeredOffer(product = box(0.3, 0.32, 0.4, 0.34), background: StructuralSignature['background'] = 'gradient'): StructuralSignature {
  return { version: 1, background, relations: [], elements: [
    { id: 'headline', role: 'headline', z: 3, box: box(0.18, 0.07, 0.64, 0.12) },
    { id: 'product', role: 'product', z: 2, box: product },
    { id: 'cta', role: 'cta', z: 3, box: box(0.36, 0.8, 0.28, 0.08) },
    { id: 'badge', role: 'badge', z: 4, box: box(0.76, 0.05, 0.18, 0.12) },
  ] };
}
const headphones = centeredOffer(box(0.28, 0.33, 0.44, 0.32));
const iphone = centeredOffer(box(0.39, 0.26, 0.22, 0.46));
const analysisOf = (signature: StructuralSignature, instance: StructureAnalysis['instance'] = { elements: {}, background: '' }): StructureAnalysis =>
  ({ signature, instance, layoutName: 'Centered Product Offer', decompositionRecipe: 'template-b', confidence: 0.9 });
const required = (s: StructuralSignature) => s.elements.filter(e => ['product', 'person', 'headline', 'cta', 'frame'].includes(e.role)).map(e => e.id);

describe('structural matching', () => {
  it('CASE 1: headphones → iPhone in the same layout is the same family', () => {
    const c = compareSignatures(headphones, iphone);
    expect(c.hardMismatch).toBeUndefined();
    expect(decide(c.score, DEFAULT_MATCH_THRESHOLDS)).toBe('high');
    expect(validateMatch(headphones, iphone, required(headphones), c)).toEqual({ passed: true, problems: [] });
  });
  it('CASE 2: blue → red background is not structure: identical signatures score 1', () => {
    const blue = centeredOffer(undefined, 'gradient'), red = centeredOffer(undefined, 'gradient');
    expect(compareSignatures(blue, red).score).toBe(1);
    expect(signatureKey(blue)).toBe(signatureKey(red));
    // flat vs gradient is still a plain background: the same family.
    expect(decide(compareSignatures(blue, centeredOffer(undefined, 'flat')).score, DEFAULT_MATCH_THRESHOLDS)).toBe('high');
  });
  it('CASE 3: the same roles in a different arrangement is not a high-confidence match', () => {
    const sideways: StructuralSignature = { version: 1, background: 'gradient', relations: [], elements: [
      { id: 'product', role: 'product', z: 2, box: box(0.04, 0.25, 0.42, 0.5) },
      { id: 'headline', role: 'headline', z: 3, box: box(0.52, 0.25, 0.44, 0.14) },
      { id: 'cta', role: 'cta', z: 3, box: box(0.56, 0.6, 0.3, 0.08) },
      { id: 'badge', role: 'badge', z: 4, box: box(0.04, 0.05, 0.18, 0.12) },
    ] };
    const c = compareSignatures(headphones, sideways);
    expect(decide(c.score, DEFAULT_MATCH_THRESHOLDS)).not.toBe('high');
    expect(validateMatch(headphones, sideways, required(headphones), c).passed).toBe(false);
  });
  it('CASE 11: one centred product vs two split products never match, whatever else is shared', () => {
    const dual: StructuralSignature = { version: 1, background: 'gradient', relations: [], elements: [
      { id: 'headline', role: 'headline', z: 3, box: box(0.18, 0.07, 0.64, 0.12) },
      { id: 'left', role: 'product', z: 2, box: box(0.06, 0.3, 0.4, 0.4) },
      { id: 'right', role: 'product', z: 2, box: box(0.54, 0.3, 0.4, 0.4) },
      { id: 'cta', role: 'cta', z: 3, box: box(0.36, 0.8, 0.28, 0.08) },
    ] };
    const c = compareSignatures(headphones, dual);
    expect(c.hardMismatch).toMatch(/product count/);
    expect(c.score).toBeLessThanOrEqual(0.35);
    expect(decide(c.score, DEFAULT_MATCH_THRESHOLDS)).toBe('new');
  });
  it('rejects a match with a large unexplained foreground region', () => {
    const extra = centeredOffer();
    extra.elements.push({ id: 'person', role: 'person', z: 2, box: box(0.02, 0.3, 0.25, 0.65) });
    const c = compareSignatures(centeredOffer(), extra);
    expect(validateMatch(centeredOffer(), extra, required(centeredOffer()), c).passed).toBe(false);
  });
  it('thresholds are configurable and validated', () => {
    expect(matchThresholds({ high: '0.9', ambiguous: 0.5 })).toMatchObject({ high: 0.9, ambiguous: 0.5 });
    expect(matchThresholds({ high: 'x', ambiguous: 2 })).toMatchObject({ high: 0.85, ambiguous: 0.6 });
    expect(decide(0.7, matchThresholds({ high: 0.65 }))).toBe('high');
  });
});

describe('prompt templates', () => {
  it('compiles values and sections, and refuses undeclared placeholders', () => {
    expect(compileTemplate('A {{#p}}with {{p}}{{/p}}{{^p}}keep it{{/p}}.', { p: 'iPhone' })).toBe('A with iPhone.');
    expect(compileTemplate('A {{#p}}with {{p}}{{/p}}{{^p}}keep it{{/p}}.', { p: '' }, ['p'])).toBe('A keep it.');
    expect(() => compileTemplate('{{headphones}}', {}, ['product'])).toThrow(PromptTemplateError);
    expect(templateProblems('{{#a}}{{#b}}x{{/b}}{{/a}}', ['a', 'b'])).toContain('Nested sections are not supported.');
  });
  it('a value can never open a placeholder or inject markup', () => {
    expect(sanitizeSlotValue('{{product}} <b>x</b>\nnext')).toBe('product b x /b next');
    expect(compileTemplate('Show {{p}}.', { p: '{{#q}}evil{{/q}}' }, ['p', 'q'])).toBe('Show #q evil /q.');
  });
});

describe('blueprints', () => {
  const blueprint = blueprintFromAnalysis(analysisOf(headphones, { elements: { product: { label: 'black over-ear headphones', text: '' }, headline: { label: 'headline', text: 'Summer Sale' } }, background: 'blue gradient' }), { familyId: 'fam-test', origin: 'test', now: '2026-10-07T00:00:00.000Z' });
  it('derives slots, templates and plans with no instance content inside them', () => {
    expect(blueprint.slots.map(s => s.id)).toEqual(['product', 'background', 'headline', 'badge', 'cta']);
    const stored = JSON.stringify(blueprint);
    for (const word of ['headphones', 'Summer', 'blue']) expect(stored).not.toContain(word);
    expect(blueprintProblems(blueprint)).toEqual([]);
    expect(blueprint.curationPolicy).toEqual({ expectedEditorLayers: { min: 4, max: 7 }, maxRawLayers: 8 });
  });
  it('CASE 9: the compiled prompt for an iPhone carries no stale headphones', () => {
    const first = compileGenerationPrompt(blueprint, { product: 'black over-ear headphones', headline: 'Summer Sale' });
    const second = compileGenerationPrompt(blueprint, { product: 'iPhone 17 in red', headline: 'Mega Offer', background: 'deep red gradient' });
    expect(first).toContain('headphones');
    expect(second).toContain('Replace the product (center) with iPhone 17 in red');
    expect(second).toContain('reads exactly "Mega Offer"');
    expect(second).not.toMatch(/headphones|Summer/);
    expect(compileGenerationPrompt(blueprint, {})).toContain('Keep the product (center) exactly as it is.');
  });
  it('CASE 10: the decomposition plan keeps the structure and uses the current values', () => {
    const a = compileDecompositionPlan(blueprint, { product: 'black over-ear headphones' }), b = compileDecompositionPlan(blueprint, { product: 'iPhone 17' });
    expect(a.plan.elements.map(e => e.id)).toEqual(b.plan.elements.map(e => e.id));
    expect(b.plan.downstream_decomposition_prompt).toContain('the iPhone 17 in the center');
    expect(b.plan.downstream_decomposition_prompt).not.toContain('headphones');
    expect(b.plan.downstream_decomposition_prompt).toMatch(/^Create 5 layers back-to-front/);
    expect(b.plan.downstream_decomposition_prompt).toContain('Do not create separate layers for shadows');
    expect(b.plan.recommended_layer_count).toBe(5);
    expect(b.requiredElements).toEqual(['background', 'product', 'cta', 'headline']);
  });
  it('keeps a held product with its person (protected interactions)', () => {
    const held = blueprintFromAnalysis(analysisOf({ version: 1, background: 'photo', elements: [
      { id: 'woman', role: 'person', z: 2, box: box(0.3, 0.15, 0.4, 0.8) }, { id: 'phone', role: 'product', z: 3, box: box(0.45, 0.4, 0.12, 0.2) },
    ], relations: [{ from: 'woman', to: 'phone', type: 'holds' }] }), { familyId: 'fam-held', origin: 'test' });
    const { plan } = compileDecompositionPlan(held, {});
    expect(plan.elements.find(e => e.id === 'product')!.attachment).toMatchObject({ relation: 'held_in_hand', parent_id: 'subject', keep_with_parent: true });
    expect(held.decompositionPlanTemplate.backgroundPolicy).toBe('scene-plate');
  });
  it('separates native edits from generative ones (rule 20)', () => {
    expect(planSlotChanges(blueprint, { headline: 'Mega Offer', cta: 'Buy' })).toMatchObject({ needsImage: false, native: ['headline', 'cta'], generative: [] });
    expect(planSlotChanges(blueprint, { product: 'iPhone', headline: 'Mega' })).toMatchObject({ needsImage: true, generative: ['product'] });
    expect(planSlotChanges(blueprint, { unknown: 'x' } as Record<string, string>).changed).toEqual([]);
  });
  it('renders form fields from slots, current values from this image only', () => {
    const fields = slotFormModel(blueprint, instanceSlotValues(blueprint, { elements: { product: { label: 'iPhone', text: '' } }, background: '' }));
    expect(fields.map(f => f.label)).toEqual(['Product', 'Background', 'Headline', 'Badge', 'Button text']);
    expect(fields[0]).toMatchObject({ current: 'iPhone', native: false });
    expect(fields.find(f => f.id === 'headline')).toMatchObject({ native: true });
  });
  it('never names a family after the content of its first creative', () => {
    expect(safeLayoutName('Headphones Summer Sale', headphones, { elements: { p: { label: 'headphones', text: 'Summer Sale' } }, background: '' })).toBe('Centered Product Offer');
    expect(safeLayoutName('Hero Offer Grid', headphones)).toBe('Hero Offer Grid');
  });
});

describe('legacy A/B/C seeds (CASE 15)', () => {
  it('are ordinary blueprints with the legacy decomposition recipes', () => {
    expect(FAMILY_SEEDS.map(s => [s.key, s.analysis.decompositionRecipe])).toEqual([['template-a', 'template-a'], ['template-b', 'template-b'], ['template-c', 'template-c']]);
    for (const seed of FAMILY_SEEDS) expect(blueprintProblems(seedBlueprint(seed, 1))).toEqual([]);
    expect(seedBlueprint(FAMILY_SEEDS[0], 1).pattern).toBe('framed-portrait');
    expect(seedBlueprint(FAMILY_SEEDS[1], 1).pattern).toBe('centered-product');
    expect(seedBlueprint(FAMILY_SEEDS[2], 1).pattern).toBe('people-campaign');
  });
  it('a centred product creative matches the Template B family, not A or C', () => {
    const scores = FAMILY_SEEDS.map(seed => compareSignatures(seed.analysis.signature, { ...headphones, elements: headphones.elements.filter(e => e.role !== 'badge') }).score);
    expect(scores[1]).toBeGreaterThan(0.85);
    expect(Math.max(scores[0], scores[2])).toBeLessThanOrEqual(0.35);
  });
});

describe('reuse saving (CASE 12, rule 41)', () => {
  it('prices only avoided calls, from family observations when they exist', () => {
    const baseline = reuseBaseline({ observed: { analysis: { calls: 2, usd: 0.004 }, planner: { calls: 1, usd: 0.11 } } });
    expect(baseline.source).toBe('family-observed');
    const saving = reuseSaving({ analysis: 1, planner: 1 }, baseline, 90);
    expect(saving.inr).toBeCloseTo((0.002 + 0.11) * 90, 6);
    expect(saving.confidence).toBe('Estimated');
    expect(reuseSaving({ analysis: 0, planner: 0 }, baseline, 90)).toMatchObject({ usd: 0, confidence: 'Calculated' });
  });
  it('falls back to the documented default usage', () => {
    const baseline = reuseBaseline();
    expect(baseline.source).toBe('default-estimate');
    // Sol: 3,376 × $4/M + 4,835 × $20/M.
    expect(baseline.plannerUsd).toBeCloseTo(3376 * 4e-6 + 4835 * 20e-6, 9);
  });
});
