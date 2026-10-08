import { describe, expect, it } from 'vitest';
import { verboseImageAnalysis } from '../../server/src/decomposition/imageTemplateAnalysis.fixture.js';
import { buildImageTemplatePrompt, compactVisualFact, IMAGE_ANALYSIS_LIMITS, normalizeImageAnalysis, parseImageAnalysisResponse } from './imageTemplateAnalysis.js';
import { IMAGE_TEMPLATE_LIMITS, IMAGE_TEMPLATE_REFERENCE_INSTRUCTION, IMAGE_TEMPLATE_RATIOS, IMAGE_TEMPLATE_REQUEST_LIMIT, imageTemplateVariantPrompt } from './imageTemplateGeneration.js';

const compile = (value: unknown) => buildImageTemplatePrompt(normalizeImageAnalysis(value));
describe('structured visual analysis → local bounded prompt', () => {
  it.each([3344, 4002, IMAGE_TEMPLATE_LIMITS.prompt, IMAGE_TEMPLATE_LIMITS.prompt * 2, IMAGE_TEMPLATE_LIMITS.prompt * 5])('compiles %i characters without losing critical fidelity facts', length => {
    const fixture = verboseImageAnalysis(length);
    expect(JSON.stringify(fixture)).toHaveLength(length);
    const { analysis } = parseImageAnalysisResponse(fixture), prompt = buildImageTemplatePrompt(analysis);
    expect(prompt.length).toBeLessThanOrEqual(IMAGE_TEMPLATE_LIMITS.prompt);
    for (const fact of ['lavender smartphone', 'triangular camera module', '4 lavender/white spheres', 'behind left', 'foreground right', 'upper-right', 'lower-left', 'tilted clockwise', 'rear three-quarter view', 'Do not add/remove objects']) expect(prompt).toContain(fact);
    expect(prompt).toBe(buildImageTemplatePrompt(analysis));
    expect(prompt).toMatch(/branding\.$/);
    for (const ratio of IMAGE_TEMPLATE_RATIOS) expect(`${imageTemplateVariantPrompt(prompt, ratio)} ${IMAGE_TEMPLATE_REFERENCE_INSTRUCTION}`.length).toBeLessThanOrEqual(IMAGE_TEMPLATE_REQUEST_LIMIT);
  });
  it.each(['photo', 'illustration', 'poster', 'product', 'person', 'multiple people', 'interior', 'food', 'minimal creative'])('handles a sparse %s with optional sections absent/null/malformed', sceneType => {
    const prompt = compile({ sceneType, palette: null, materials: false, lighting: {}, unknown: 'ignored', composition: null, objects: null });
    expect(prompt).toContain(sceneType);
    expect(prompt).not.toContain('undefined');
    expect(prompt.length).toBeLessThanOrEqual(IMAGE_TEMPLATE_LIMITS.prompt);
  });
  it('bounds a dense scene, reserves every retained object count/position, and deduplicates identical evidence', () => {
    const base = verboseImageAnalysis(4002).analysis;
    const objects = Array.from({ length: IMAGE_ANALYSIS_LIMITS.objects + 20 }, (_, i) => ({ kind: `prop ${i}`, count: i + 1, position: `at ${i}% left`, relationshipToHero: 'behind hero', appearance: 'colorful detail '.repeat(100), relativeScale: 'small' }));
    const analysis = normalizeImageAnalysis({ ...base, objects: objects.flatMap(o => [o, o]), preservationRules: ['keep detail', 'keep detail'], palette: ['gray', 'gray'] });
    expect(analysis.objects).toHaveLength(IMAGE_ANALYSIS_LIMITS.objects);
    expect(analysis.preservationRules).toEqual(['keep detail']);
    expect(analysis.palette).toEqual(['gray']);
    const prompt = buildImageTemplatePrompt(analysis);
    for (let i = 0; i < IMAGE_ANALYSIS_LIMITS.objects; i++) { expect(prompt).toContain(`${i + 1} prop ${i}:`); expect(prompt).toContain(`at ${i}% left`); }
    expect(prompt).toContain('additional objects as in the reference');
    expect(prompt.length).toBeLessThanOrEqual(IMAGE_TEMPLATE_LIMITS.prompt);
  });
  it('reserves worst-case compact core even with all twelve objects and maximum safe counts', () => {
    const text = 'distinctive detail '.repeat(100);
    const analysis = normalizeImageAnalysis({ hero: Object.fromEntries(['identity', 'appearance', 'orientation', 'cameraAngle', 'position'].map(k => [k, text])),
      objects: Array.from({ length: IMAGE_ANALYSIS_LIMITS.objects }, (_, i) => ({ kind: `${i} ${text}`, count: Number.MAX_SAFE_INTEGER, position: text, relationshipToHero: text, appearance: text })) });
    expect(buildImageTemplatePrompt(analysis).length).toBeLessThanOrEqual(IMAGE_TEMPLATE_LIMITS.prompt);
  });
  it('preserves Unicode/emoji and only compacts whole word segments', () => {
    expect(compactVisualFact('lavender smartphone detailed', 20)).toBe('lavender smartphone');
    expect(compactVisualFact('👩🏽‍🎨 lavender smartphone', 9)).toBe('👩🏽‍🎨');
    const prompt = compile({ hero: { identity: '紫色 手机 👩🏽‍🎨', appearance: '柔和 白色 球体 '.repeat(100) } });
    expect(prompt).toContain('紫色 手机 👩🏽‍🎨');
    expect(prompt).not.toContain('\uFFFD');
    expect(prompt.endsWith('.')).toBe(true);
  });
  it('handles punctuation and enormous unbroken fields without cutting an identifier or failing for verbosity', () => {
    const prompt = compile({ hero: { identity: 'x'.repeat(10_000), appearance: 'smooth; smooth; rounded!; rounded!' }, sceneType: 'photography' });
    expect(prompt).toContain('Subject: as in reference.');
    expect(prompt).toContain('Appearance: smooth; rounded.');
    expect(prompt).not.toContain('xxx');
    expect(prompt).not.toMatch(/\.\./);
  });
  it('keeps visible marks and absence of marks explicit without inventing branding', () => {
    const analysis = verboseImageAnalysis(3344).analysis;
    expect(compile(analysis)).toContain('No visible text or branding.');
    expect(compile({ ...analysis, visibleText: { present: true, description: 'SALE at top left' } })).toContain('Visible text/marks: SALE at top left.');
  });
  it('rejects unusable core evidence and invalid counts; never needs a provider', () => {
    for (const input of [null, [], {}, { hero: null, objects: [] }]) expect(() => normalizeImageAnalysis(input)).toThrow(/no usable/);
    for (const count of [-1, 0, 1.5, 'four', Infinity]) expect(() => normalizeImageAnalysis({ objects: [{ kind: 'sphere', count }] })).toThrow(/count/);
  });
});
