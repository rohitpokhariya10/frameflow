import { describe, expect, it } from 'vitest';
import { buildTemplateAPrompt, buildTemplateAVariantPrompt, resolveTemplateABasePrompt, resolveTemplateAFields, TEMPLATE_A_ASPECT_RATIOS, TEMPLATE_A_CONSISTENCY, TEMPLATE_A_DEFAULTS, TEMPLATE_A_FIELDS, TEMPLATE_A_GENERATION_VERSION, TEMPLATE_A_IMAGE_SIZES,
  TEMPLATE_A_PROMPT_LIMITS, TEMPLATE_A_RATIO_FRAMING, TEMPLATE_A_SKELETON, templateAGenerationProfile } from './templateAGeneration.js';
import { templateBGenerationProfile } from './templateBGeneration.js';
import { templateCGenerationProfile } from './templateCGeneration.js';
import { buildGenerationVariantPrompt, GENERATION_ASPECT_RATIOS, GENERATION_IMAGE_SIZES, GENERATION_PROMPT_LIMITS, GENERATION_TEMPLATE_KEYS, resolveGenerationBasePrompt, saysSo, type GenerationProfile } from './templateGeneration.js';
import { GENERATION_PROFILES, generationProfile } from './templateGenerationProfiles.js';

const PROFILES = [templateAGenerationProfile, templateBGenerationProfile, templateCGenerationProfile];
/** What a profile itself puts into a prompt: its fixed wording, and the prompts of its default creative. */
const wording = (profile: GenerationProfile) => {
  const base = profile.buildBasePrompt(profile.defaults);
  return [profile.skeleton, profile.consistency, ...Object.values(profile.framing), base, ...GENERATION_ASPECT_RATIOS.map(ratio => buildGenerationVariantPrompt(profile, base, ratio))].join(' ');
};
const keys = (profile: GenerationProfile) => profile.fields.map(field => field.key);

describe('generation profiles: shared mechanics, separate semantics', () => {
  it('has one profile per template, each under its own key', () => {
    expect(GENERATION_TEMPLATE_KEYS).toEqual(['template-a', 'template-b', 'template-c']);
    expect(Object.keys(GENERATION_PROFILES)).toEqual([...GENERATION_TEMPLATE_KEYS]);
    for (const key of GENERATION_TEMPLATE_KEYS) { expect(GENERATION_PROFILES[key].templateKey).toBe(key); expect(generationProfile(key)).toBe(GENERATION_PROFILES[key]); }
    expect([generationProfile('template-a'), generationProfile('template-b'), generationProfile('template-c')]).toEqual(PROFILES);
    for (const unknown of ['template-d', '', 'constructor', 'toString']) expect(() => generationProfile(unknown)).toThrow();
  });

  it('gives every template the same three ratios and sizes, and nothing else in common', () => {
    expect(GENERATION_ASPECT_RATIOS).toEqual(['1:1', '16:9', '4:5']);
    expect(GENERATION_IMAGE_SIZES).toEqual({ '1:1': { width: 1024, height: 1024 }, '16:9': { width: 1536, height: 864 }, '4:5': { width: 1216, height: 1520 } });
    for (const profile of PROFILES) expect(Object.keys(profile.framing)).toEqual(GENERATION_ASPECT_RATIOS);
    // No fixed sentence of one template is used by another.
    const sentences = PROFILES.map(profile => [profile.skeleton, profile.consistency, ...Object.values(profile.framing), profile.family, profile.sameAcrossRatios, profile.mayDiffer, profile.version]);
    expect(new Set(sentences.flat()).size).toBe(sentences.flat().length);
    expect(PROFILES.map(profile => profile.version)).toEqual(['template-a-generation-v3', 'template-b-generation-v1', 'template-c-generation-v1']);
  });

  it('1–2. each template has its own field schema and refuses the fields of the others', () => {
    for (const profile of PROFILES) {
      expect(profile.resolveFields(undefined)).toEqual({ values: profile.defaults, errors: [] });
      expect(Object.keys(profile.defaults)).toEqual(keys(profile));
      for (const other of PROFILES.filter(item => item !== profile)) {
        const foreign = keys(other).filter(key => !keys(profile).includes(key));
        // Most of another template's fields mean nothing here.
        expect(foreign.length).toBeGreaterThanOrEqual(9);
        for (const key of foreign) expect(profile.resolveFields({ [key]: 'a plain description' }).errors).toEqual([`Unknown field "${key}".`]);
        // A whole creative of another template is never accepted as this template's.
        expect(profile.resolveFields(other.defaults).errors.length).toBeGreaterThan(0);
      }
    }
    // Validation messages name the template whose structure it is.
    expect(PROFILES.map(profile => profile.resolveFields({ [profile.fields[0].key]: '' }).errors[0])).toEqual(['Subject is required: it is part of the Template A structure.',
      'Hero product / object is required: it is part of the Template B structure.', 'Campaign / creative concept is required: it is part of the Template C structure.']);
  });

  it('3–4. no template\'s prompt carries another template\'s semantics', () => {
    const [a, b, c] = PROFILES.map(wording);
    // Template A: a subject in a framed inner region. Not a hero product; no campaign modules.
    expect(a).toMatch(/dominant subject/);
    expect(a).not.toMatch(/\bhero\b|\bpedestal\b|\bplatform\b|\bproducts?\b|surrounding objects/i);
    expect(a).not.toMatch(/\bcampaign\b|\bpanels?\b|\bpromo\w*|\bbadge\b|\bheadline\b|\bmodules?\b|\bshowcase\b|the people\b/i);
    // Template B: a hero product. No framed subject, no held object; no campaign modules.
    expect(b).toMatch(/dominant hero object/);
    expect(b).not.toMatch(/\bheld\b|\bholds?\b|inner region|outer background|\boval\b|\bportrait\b|\bborder\b|\bsubjects?\b/i);
    expect(b).not.toMatch(/\bcampaign\b|\bpanels?\b|\bpromo\w*|\bbadge\b|\bheadline\b|\bmodules?\b|\bshowcase\b|\bperson\b|the people\b/i);
    // Template C: people and modules. No framed subject with a held object; no hero product.
    expect(c).toMatch(/clear modular hierarchy/);
    expect(c).not.toMatch(/held object|inner region|outer background|\boval\b|\bportrait\b|\bborder\b|\bsubjects?\b/i);
    expect(c).not.toMatch(/\bhero\b|\bpedestal\b|\bplatform\b|product photography|product advertising|exactly once|no people/i);
  });

  it('5. every template builds a variant as its own base + its own consistency + its own framing, within the limits', () => {
    expect(GENERATION_PROMPT_LIMITS).toEqual({ base: 2000, final: 3000 });
    for (const profile of PROFILES) {
      const base = profile.buildBasePrompt(profile.defaults);
      expect(resolveGenerationBasePrompt(profile, profile.defaults)).toEqual({ builtPrompt: base, basePrompt: base, promptEdited: false, errors: [] });
      for (const ratio of GENERATION_ASPECT_RATIOS) expect(buildGenerationVariantPrompt(profile, base, ratio)).toBe(`${base} ${profile.consistency} ${profile.framing[ratio]}`);
      // Even a base prompt at its limit fits: a variant is never cut and never refused for its template's fixed wording.
      const longest = Math.max(...Object.values(profile.framing).map(text => text.length));
      expect(GENERATION_PROMPT_LIMITS.base + 1 + profile.consistency.length + 1 + longest).toBeLessThanOrEqual(GENERATION_PROMPT_LIMITS.final);
      expect(() => buildGenerationVariantPrompt(profile, base, '9:16' as never)).toThrow('Aspect ratio must be one of 1:1, 16:9, 4:5.');
    }
  });

  it('warns per template, never across: a creative of one template gets only that template\'s notes', () => {
    expect(templateAGenerationProfile.notes(TEMPLATE_A_DEFAULTS)).toEqual([]);
    const notes = [templateBGenerationProfile.notes({ ...templateBGenerationProfile.defaults, secondaryObjects: 'two cups touching the hero', support: '' }).join(' '),
      templateCGenerationProfile.notes({ ...templateCGenerationProfile.defaults, repeatedPanels: 'three panels' }).join(' ')];
    expect(notes[0]).toContain('"Separate touching / overlapping independent objects"');
    expect(notes[0]).not.toMatch(/held object|people|panels/i);
    expect(notes[1]).toContain('"Separate individual people / human subjects"');
    expect(notes[1]).toContain('"Separate repeated subject / showcase panels"');
    expect(notes[1]).not.toMatch(/held object|touching|hero/i);
  });

  it('reads a negated mention as not said', () => {
    const touching = /\b(?:touch\w*|overlap\w*)\b/i;
    expect(['two touch it', 'overlapping at the shoulders', 'one not touching and one touching'].map(text => saysSo(text, touching))).toEqual([true, true, true]);
    expect(['none touching it', 'not overlapping', 'without any overlap', 'no two of them touch', 'standing apart'].map(text => saysSo(text, touching))).toEqual([false, false, false, false, false]);
  });
});

describe('12. Template A is the profile it always was', () => {
  it('the profile is Template A\'s own functions and texts, unchanged', () => {
    expect(templateAGenerationProfile).toMatchObject({ templateKey: 'template-a', name: 'Template A', version: TEMPLATE_A_GENERATION_VERSION, skeleton: TEMPLATE_A_SKELETON, fields: TEMPLATE_A_FIELDS, defaults: TEMPLATE_A_DEFAULTS,
      consistency: TEMPLATE_A_CONSISTENCY, framing: TEMPLATE_A_RATIO_FRAMING });
    expect(templateAGenerationProfile.resolveFields).toBe(resolveTemplateAFields);
    expect([TEMPLATE_A_ASPECT_RATIOS, TEMPLATE_A_IMAGE_SIZES, TEMPLATE_A_PROMPT_LIMITS]).toEqual([GENERATION_ASPECT_RATIOS, GENERATION_IMAGE_SIZES, GENERATION_PROMPT_LIMITS]);
    const creatives = [TEMPLATE_A_DEFAULTS, { ...TEMPLATE_A_DEFAULTS, heldObject: '', frameBorder: 'none' }, { ...TEMPLATE_A_DEFAULTS, subject: 'golden retriever dog', outfit: '', heldObject: 'red ball' }];
    for (const values of creatives) {
      const base = buildTemplateAPrompt(values);
      expect(templateAGenerationProfile.buildBasePrompt(values)).toBe(base);
      expect(resolveGenerationBasePrompt(templateAGenerationProfile, values, `${base} Warm light.`)).toEqual(resolveTemplateABasePrompt(values, `${base} Warm light.`));
      for (const ratio of TEMPLATE_A_ASPECT_RATIOS) {
        expect(buildGenerationVariantPrompt(templateAGenerationProfile, base, ratio)).toBe(buildTemplateAVariantPrompt(base, ratio));
        expect(buildTemplateAVariantPrompt(base, ratio)).toBe(`${base} ${TEMPLATE_A_CONSISTENCY} ${TEMPLATE_A_RATIO_FRAMING[ratio]}`);
      }
    }
  });

  it('keeps the exact Template A texts that were reviewed (a change here is a change to Template A)', () => {
    expect(TEMPLATE_A_CONSISTENCY).toBe('This image is one of several aspect-ratio versions of the same creative. Everything described above is the same in every version: the same subject, styling, held object, inner region, border and backgrounds. Only the framing changes with the aspect ratio; do not add, remove or redesign anything.');
    expect(TEMPLATE_A_RATIO_FRAMING).toEqual({
      '1:1': 'Framing for this version: 1:1, square. A balanced square composition: the inner region centred, with an even margin of the outer background on every side.',
      '16:9': 'Framing for this version: 16:9, wide. The same creative in a wide frame: the inner region keeps its shape, stays centred and fills most of the frame height, and the extra width is more of the same outer background on both sides, left empty.',
      '4:5': 'Framing for this version: 4:5, tall feed. The same creative in a slightly tall frame: the inner region centred and filling most of the frame, with a slim, even margin of the outer background around it.',
    });
    expect(TEMPLATE_A_GENERATION_VERSION).toBe('template-a-generation-v3');
    expect(TEMPLATE_A_FIELDS.map(field => field.key)).toEqual(['subject', 'subjectDetails', 'composition', 'heldObject', 'pose', 'expression', 'outfit', 'innerBackdrop', 'frameShape', 'frameBorder', 'outerBackground', 'lighting', 'extraNotes']);
  });
});
