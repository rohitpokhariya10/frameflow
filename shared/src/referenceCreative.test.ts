import { describe, expect, it } from 'vitest';
import { referenceCreativeFixture } from '../../server/src/decomposition/referenceCreative.fixture.js';
import { airPodsAnalysisFixture } from '../../server/src/decomposition/airPodsAnalysis.fixture.js';
import { IMAGE_ANALYSIS_SCHEMA, normalizeImageAnalysis, parseImageAnalysisResponse } from './imageTemplateAnalysis.js';
import { IMAGE_TEMPLATE_LIMITS, IMAGE_TEMPLATE_RATIOS, IMAGE_TEMPLATE_REFERENCE_INSTRUCTION, IMAGE_TEMPLATE_REQUEST_LIMIT, imageTemplateVariantPrompt } from './imageTemplateGeneration.js';
import { buildReferenceCreativePrompt, createReferenceCreative, editReferenceChoices, parseReferenceCreative, rebuildReferencePrompt, referenceBlueprint, validateReferenceGeneration } from './referenceCreative.js';
import { createTemplateDraft } from './designTemplates/editing.js';
import { emptyLibrary, parseLibrary, saveDesignTemplate, serializeLibrary } from './designTemplates/library.js';
const analysis = parseImageAnalysisResponse(referenceCreativeFixture).analysis;

describe('reference offer creative choices', () => {
  it('reuses validated visual analysis with bounded business zones and a versioned blueprint', () => {
    const blueprint = referenceBlueprint(analysis);
    expect(blueprint.version).toBe(1); expect(blueprint.subjectMode).toBe('single'); expect(blueprint.zones?.cta).toBe('lower bar');
    expect(JSON.stringify(IMAGE_ANALYSIS_SCHEMA)).toContain('panelGeometry');
    expect(referenceBlueprint(normalizeImageAnalysis({ sceneType: 'landscape' })).subjectMode).toBe('unclear');
  });
  it.each(['single', 'collection', 'none', 'unclear'])('accepts subject mode %s without inventing product evidence', subjectMode => {
    const blueprint = referenceBlueprint(normalizeImageAnalysis({ ...analysis, hero: {}, objects: [], design: { ...analysis.design, subjectMode } }));
    expect(blueprint.subjectMode).toBe(subjectMode); expect(blueprint.subject).toBe('No clear product detected');
  });
  it('rejects invalid analysis counts, classifications and executable or remote content', () => {
    expect(() => normalizeImageAnalysis({ ...analysis, design: { subjectMode: 'maybe' } })).toThrow();
    expect(() => normalizeImageAnalysis({ ...analysis, objects: [{ kind: 'phones', count: -1 }] })).toThrow();
    for (const payload of ['<script>x</script>', '<svg/>', '<img src=x onerror=alert(1)>', '<script', 'https://evil.test/image', 'http://evil.test/image', 'data:image/svg+xml;base64,PHN2Zy8+', 'javascript:alert(1)', 'eval("code")']) {
      expect(() => normalizeImageAnalysis({ ...analysis, design: { ...analysis.design, summary: payload } })).toThrow();
      expect(() => parseReferenceCreative({ ...createReferenceCreative(analysis), prompt: payload })).toThrow();
    }
  });
  it('accepts the actual AirPods analysis hierarchy separators and keeps printed brand/website evidence', () => {
    const { analysis: value, templateKey } = parseImageAnalysisResponse(airPodsAnalysisFixture);
    expect(templateKey).toBe('template-b');
    const hierarchy = 'hero headphone (dominant) > headline text > lower product-name panel/CTA > brand mark';
    expect(value.composition.visualHierarchy).toBe(hierarchy);
    expect(value.visibleText.description).toBe(airPodsAnalysisFixture.analysis.visibleText.description);
    expect(value.visibleText.description).toContain('www.apple.com');
    expect(value.visibleText.description).toContain('Air Pod Max');
    expect(value.visibleText.description).toContain('ORDER NOW');
    expect(value.objects.some(object => object.kind === 'Apple logo')).toBe(true);
    const draft = createReferenceCreative(value);
    expect(draft.prompt).toContain(`Composition: ${hierarchy}`);
    expect(draft.prompt.length).toBeLessThanOrEqual(IMAGE_TEMPLATE_LIMITS.prompt);
    expect(validateReferenceGeneration(draft, value)).toEqual(draft);
    const designHierarchy = normalizeImageAnalysis({ ...value, design: { ...value.design, summary: 'Product > headline > CTA' } });
    expect(createReferenceCreative(designHierarchy).prompt).toContain('Reference style: Product > headline > CTA');
  });
  it('keeps a website printed on an existing creative as text evidence, never an asset source', () => {
    const value = normalizeImageAnalysis({ ...analysis, visibleText: { present: true, description: 'Visit https://example.test/shop in the footer' } });
    expect(value.visibleText.description).toBe('Visit https://example.test/shop in the footer');
    expect(createReferenceCreative(value).prompt).not.toContain('https://');
  });
  it('explicit product/background/festival choices override detected values while preserving layout', () => {
    const draft = editReferenceChoices(createReferenceCreative(analysis), analysis, { changes: { product: 'Samsung Galaxy phone', background: 'warm gold', festival: 'Diwali', decorations: 'diyas and marigolds' } });
    expect(draft.prompt).toContain('Product / Object: Samsung Galaxy phone'); expect(draft.prompt).toContain('Background: warm gold');
    expect(draft.prompt).toContain('Festival: Diwali'); expect(draft.prompt).toContain('Layout, hierarchy and spacing');
    expect(draft.prompt).not.toContain('Keep subject: AirPods'); expect(draft.prompt).not.toContain('Background: Soft blue');
  });
  it('unchecked preserves permit adaptation; checked preserves include the evidence', () => {
    const draft = editReferenceChoices(createReferenceCreative(analysis), analysis, { preserve: { lighting: false, camera: false } });
    expect(draft.prompt).toContain('May adapt lighting style'); expect(draft.prompt).not.toContain('Lighting: soft studio');
    expect(draft.prompt).toContain('Panels: large rounded');
  });
  it('custom prompt is exact, survives field changes, and only rebuild explicitly restores guided mode', () => {
    const custom = { ...createReferenceCreative(analysis), mode: 'custom' as const, prompt: 'Use a graphite Samsung phone with bold campaign typography and a clean silver backdrop.' };
    const edited = editReferenceChoices(custom, analysis, { changes: { festival: 'Holi' } });
    expect(edited.prompt).toBe(custom.prompt); expect(validateReferenceGeneration(edited, analysis).prompt).toBe(custom.prompt);
    const rebuilt = rebuildReferencePrompt(edited, analysis); expect(rebuilt.mode).toBe('guided'); expect(rebuilt.prompt).toContain('Festival: Holi');
  });
  it('rejects mismatched guided prompts rather than silently overwriting them', () => {
    const draft = createReferenceCreative(analysis); expect(() => validateReferenceGeneration({ ...draft, prompt: 'Completely unrelated campaign prompt content' }, analysis)).toThrow(/does not match/);
  });
  it.each(['', '   ', 'hello', 'x'.repeat(IMAGE_TEMPLATE_LIMITS.prompt + 1)])('blocks unusable custom prompts (%s)', prompt => {
    expect(() => validateReferenceGeneration({ ...createReferenceCreative(analysis), mode: 'custom', prompt }, analysis)).toThrow();
  });
  it('empty optional changes retain reference and every ratio stays inside the existing request limit', () => {
    const draft = createReferenceCreative(analysis);
    expect(draft.prompt).toContain('Keep subject: AirPods Max'); expect(draft.prompt).not.toContain('undefined');
    expect(draft.prompt.length).toBeLessThanOrEqual(IMAGE_TEMPLATE_LIMITS.prompt); expect(IMAGE_TEMPLATE_RATIOS).toEqual(['1:1', '4:5', '16:9']);
    for (const ratio of IMAGE_TEMPLATE_RATIOS) expect(`${imageTemplateVariantPrompt(draft.prompt, ratio)} ${IMAGE_TEMPLATE_REFERENCE_INSTRUCTION}`.length).toBeLessThanOrEqual(IMAGE_TEMPLATE_REQUEST_LIMIT);
  });
  it('validates field bounds and never truncates user overrides to fit', () => {
    const draft = createReferenceCreative(analysis);
    expect(() => parseReferenceCreative({ ...draft, changes: { ...draft.changes, product: 'a'.repeat(141) } })).toThrow(/140/);
    const long = Object.fromEntries(Object.keys(draft.changes).map(key => [key, 'specific requirements '.repeat(6)])) as typeof draft.changes;
    const off = Object.fromEntries(Object.keys(draft.preserve).map(key => [key, false])) as typeof draft.preserve;
    try { const prompt = buildReferenceCreativePrompt(analysis, long, off); expect(prompt).toContain(long.product.trim()); } catch (error) { expect((error as Error).message).toContain('Shorten'); }
  });
  it('reference association survives save/reload, versions separately and does not replace canvas elements', () => {
    const original = createTemplateDraft('test-template', '2026-10-02T00:00:00Z');
    const first = saveDesignTemplate(emptyLibrary(), original, original.createdAt);
    const second = saveDesignTemplate(first.library, { ...first.template, referenceSetId: '2026-10-02-reference' }, original.createdAt);
    expect(second.outcome).toBe('new-version'); expect(second.template.elements).toEqual(original.elements);
    expect(parseLibrary(serializeLibrary(second.library)).templates.at(-1)?.referenceSetId).toBe('2026-10-02-reference');
  });
});
