import { describe, expect, it } from 'vitest';
import { AI_LIMITS } from './ai.js';
import { buildTemplateAPrompt, buildTemplateAVariantPrompt, hasHeldObject, hasVisibleBorder, resolveTemplateABasePrompt, resolveTemplateAFields, TEMPLATE_A_ASPECT_RATIOS, TEMPLATE_A_CONSISTENCY, TEMPLATE_A_DEFAULTS, TEMPLATE_A_FIELDS,
  TEMPLATE_A_IMAGE_SIZES, TEMPLATE_A_PROMPT_LIMITS, TEMPLATE_A_RATIO_FRAMING, TEMPLATE_A_SKELETON, templateAVariantId, withArticle, type TemplateAAspectRatio } from './templateAGeneration.js';

const DEFAULT_PROMPT = 'Create a clean, poster-style advertising portrait with one smiling adult woman, natural studio portrait styling, as the clearly dominant subject, centered, waist-up. Place the subject inside a clearly distinguishable upright oval inner region filled with a soft sky-blue studio backdrop, visually separate from the outer background, which fills the rest of the canvas with muted forest green and leaves a clear margin around the inner region. The inner region is edged by a thin warm-gold border. The subject holds a smartphone, holding the phone naturally in one hand, clearly visible and not hidden by the hands. Expression: warm, confident smile. Lighting and mood: soft, even studio lighting. The subject may be cropped by the lower edge of the inner region. Keep the composition simple and clean, with strong separation between the outer background, the inner region, the subject and the smartphone. Realistic, sharp, high-resolution photography. No other people or animals, no unrelated props, no clutter, no text or logos.';
const fields = (overrides: Partial<typeof TEMPLATE_A_DEFAULTS>) => resolveTemplateAFields({ ...TEMPLATE_A_DEFAULTS, ...overrides }).values;

describe('Template A base prompt (fields in, fixed skeleton filled)', () => {
  it('builds the full prompt from the defaults alone', () => {
    const { values, errors } = resolveTemplateAFields(undefined);
    expect(errors).toEqual([]);
    expect(values).toEqual(TEMPLATE_A_DEFAULTS);
    expect(buildTemplateAPrompt(values)).toBe(DEFAULT_PROMPT);
    for (const f of TEMPLATE_A_FIELDS) expect(TEMPLATE_A_SKELETON).toContain(`{${f.key}}`);
  });

  it('requires only subject, inner backdrop and outer background, with real letters, and bounds every field', () => {
    expect(TEMPLATE_A_FIELDS.filter(f => f.required).map(f => f.key)).toEqual(['subject', 'innerBackdrop', 'outerBackground']);
    for (const bad of ['', '   ', '...', '12', '!!']) expect(resolveTemplateAFields({ subject: bad }).errors).toEqual(['Subject is required: it is part of the Template A structure.']);
    for (const key of ['subjectDetails', 'composition', 'heldObject', 'pose', 'expression', 'outfit', 'frameShape', 'frameBorder', 'lighting', 'extraNotes']) expect(resolveTemplateAFields({ [key]: '' }).errors).toEqual([]);
    expect(resolveTemplateAFields({ subject: 42, prompt: 'x' }).errors).toEqual(['Unknown field "prompt".', 'Subject must be text.']);
    expect(resolveTemplateAFields({ extraNotes: 'x'.repeat(301) }).errors).toEqual(['Extra notes is 301 characters; at most 300.']);
    expect(resolveTemplateAFields({ subject: '  older   man. ' }).values.subject).toBe('older man');
  });

  it('resolves the older man + guitar example: rounded arch, no border, pastel pink', () => {
    const prompt = buildTemplateAPrompt(fields({ subject: 'older man', subjectDetails: '', heldObject: 'acoustic guitar', pose: 'holding the guitar naturally across his body', innerBackdrop: 'soft peach studio backdrop', frameShape: 'rounded arch', frameBorder: 'none', outerBackground: 'pastel pink' }));
    expect(prompt).toContain('with one older man as the clearly dominant subject, centered, waist-up.');
    expect(prompt).toContain('inside a clearly distinguishable rounded arch inner region filled with a soft peach studio backdrop, visually separate from the outer background, which fills the rest of the canvas with pastel pink');
    expect(prompt).toContain('No visible border around the inner region.');
    expect(prompt).toContain('The subject holds an acoustic guitar, holding the guitar naturally across his body, clearly visible and not hidden by the hands.');
    expect(prompt).toContain('the subject and the acoustic guitar.');
    expect(prompt).not.toMatch(/edged by|gold/);
  });

  it('never invents a border and never writes "holds" without an object', () => {
    for (const none of ['', 'none', 'no visible border', 'No border', 'without a border', 'borderless']) {
      expect(hasVisibleBorder({ frameBorder: none })).toBe(false);
      expect(buildTemplateAPrompt(fields({ frameBorder: none }))).toContain('No visible border around the inner region.');
    }
    expect(hasVisibleBorder({ frameBorder: 'thick cream border' })).toBe(true);
    // No object: a valid no-object sentence, with the pose if given; the separation sentence names no object.
    for (const empty of ['', 'none', 'nothing']) expect(hasHeldObject({ heldObject: empty })).toBe(false);
    const bare = buildTemplateAPrompt(fields({ heldObject: '', pose: '' }));
    expect(bare).toContain('The subject holds no object, in a natural pose that keeps the subject clearly visible.');
    expect(bare).toContain('the inner region, the subject.');
    expect(buildTemplateAPrompt(fields({ heldObject: '', pose: 'arms folded, leaning slightly forward' }))).toContain('The subject holds no object; arms folded, leaning slightly forward, in a natural pose that keeps the subject clearly visible.');
  });

  it('keeps the structure for any subject, object, shape, framing and optional part left empty', () => {
    const cases = [
      fields({ subject: 'boy', heldObject: 'football', frameShape: 'circle', innerBackdrop: 'warm yellow graphic backdrop', outerBackground: 'flat navy blue' }),
      fields({ subject: 'golden retriever dog', subjectDetails: '', heldObject: 'red frisbee', pose: 'holding it in its mouth', outfit: '', expression: 'happy and alert', frameShape: 'circle', frameBorder: 'no visible border' }),
      fields({ subject: 'young man', composition: 'slightly turned to the left, upper-body portrait', frameShape: '', heldObject: 'dumbbells' }),
    ];
    const prompts = cases.map(buildTemplateAPrompt);
    expect(prompts[0]).toContain('The subject holds a football,');
    expect(prompts[1]).toContain('with one golden retriever dog as the clearly dominant subject, centered, waist-up.');
    expect(prompts[1]).not.toContain('Outfit');
    expect(prompts[2]).toContain('as the clearly dominant subject, slightly turned to the left, upper-body portrait.');
    expect(prompts[2]).toContain('inside a clearly distinguishable inner region filled with');
    expect(prompts[2]).toContain('The subject holds dumbbells,');
    for (const prompt of [DEFAULT_PROMPT, ...prompts]) {
      expect(prompt).toMatch(/^Create a clean, poster-style advertising portrait with one .* as the clearly dominant subject/);
      expect(prompt).toMatch(/clearly distinguishable .*inner region filled with .*, visually separate from the outer background, which fills the rest of the canvas with/);
      expect(prompt).toMatch(/No other people or animals, no unrelated props, no clutter, no text or logos\.$/);
    }
    expect(buildTemplateAPrompt(fields({ extraNotes: 'soft film grain' }))).toMatch(/no text or logos\. Additional notes: soft film grain\.$/);
    expect([withArticle('smartphone'), withArticle('acoustic guitar'), withArticle('the red ball'), withArticle('two apples'), withArticle('dumbbells'), withArticle('glass')]).toEqual(['a smartphone', 'an acoustic guitar', 'the red ball', 'two apples', 'dumbbells', 'a glass']);
    // Every field at its maximum length exceeds the prompt limit: refused, never cut.
    expect(() => buildTemplateAPrompt(Object.fromEntries(TEMPLATE_A_FIELDS.map(f => [f.key, 'x'.repeat(f.maxLength)])) as typeof TEMPLATE_A_DEFAULTS)).toThrow(/at most 2000/);
  });
});

describe('one creative in three aspect ratios (same base prompt, only the framing differs)', () => {
  it('generates 1:1, 16:9 and 4:5 at exact sizes of those ratios', () => {
    expect(TEMPLATE_A_ASPECT_RATIOS).toEqual(['1:1', '16:9', '4:5']);
    expect(TEMPLATE_A_IMAGE_SIZES).toEqual({ '1:1': { width: 1024, height: 1024 }, '16:9': { width: 1536, height: 864 }, '4:5': { width: 1216, height: 1520 } });
    for (const ratio of TEMPLATE_A_ASPECT_RATIOS) {
      const [w, h] = ratio.split(':').map(Number), { width, height } = TEMPLATE_A_IMAGE_SIZES[ratio];
      expect(width * h).toBe(height * w);
    }
    expect(TEMPLATE_A_ASPECT_RATIOS.map(templateAVariantId)).toEqual(['1x1', '16x9', '4x5']);
  });

  it('builds each ratio\'s prompt from the one base prompt, deterministically: base, consistency sentence, that ratio\'s framing', () => {
    const prompts = TEMPLATE_A_ASPECT_RATIOS.map(ratio => buildTemplateAVariantPrompt(DEFAULT_PROMPT, ratio));
    TEMPLATE_A_ASPECT_RATIOS.forEach((ratio, index) => {
      expect(prompts[index]).toBe(`${DEFAULT_PROMPT} ${TEMPLATE_A_CONSISTENCY} ${TEMPLATE_A_RATIO_FRAMING[ratio]}`);
      // The same inputs give the same prompt, every time.
      expect(buildTemplateAVariantPrompt(DEFAULT_PROMPT, ratio)).toBe(prompts[index]);
      expect(TEMPLATE_A_RATIO_FRAMING[ratio]).toContain(`Framing for this version: ${ratio},`);
    });
    // Remove the framing sentence and the three prompts are one and the same text: nothing else drifts between ratios.
    expect(new Set(prompts.map((prompt, index) => prompt.replace(TEMPLATE_A_RATIO_FRAMING[TEMPLATE_A_ASPECT_RATIOS[index]], ''))).size).toBe(1);
    expect(new Set(prompts).size).toBe(3);
    // The framing sentences describe framing only: no subject, styling, object or colour of their own.
    for (const framing of Object.values(TEMPLATE_A_RATIO_FRAMING)) expect(framing).not.toMatch(/woman|man\b|dog|smartphone|phone|green|blue|gold|smil|outfit|holding/i);
    expect(TEMPLATE_A_CONSISTENCY).toContain('the same subject, styling, held object, inner region, border and backgrounds');
    expect(() => buildTemplateAVariantPrompt(DEFAULT_PROMPT, '2:3' as TemplateAAspectRatio)).toThrow('Aspect ratio must be one of 1:1, 16:9, 4:5.');
  });

  it('uses an edited base prompt, tidied to one line, for every ratio alike, and refuses one that is not a description', () => {
    const built = buildTemplateAPrompt(TEMPLATE_A_DEFAULTS);
    expect(resolveTemplateABasePrompt(TEMPLATE_A_DEFAULTS)).toEqual({ builtPrompt: built, basePrompt: built, promptEdited: false, errors: [] });
    // The built prompt sent back unchanged (even re-wrapped) is not an edit.
    expect(resolveTemplateABasePrompt(TEMPLATE_A_DEFAULTS, `  ${built.replace(/\. /g, '.\n')} `)).toMatchObject({ basePrompt: built, promptEdited: false, errors: [] });
    const edited = resolveTemplateABasePrompt(TEMPLATE_A_DEFAULTS, `${built}\n\nThe subject wears a   bright red scarf.`);
    expect(edited).toEqual({ builtPrompt: built, basePrompt: `${built} The subject wears a bright red scarf.`, promptEdited: true, errors: [] });
    for (const ratio of TEMPLATE_A_ASPECT_RATIOS) expect(buildTemplateAVariantPrompt(edited.basePrompt, ratio).startsWith(`${edited.basePrompt} ${TEMPLATE_A_CONSISTENCY} `)).toBe(true);
    expect(resolveTemplateABasePrompt(TEMPLATE_A_DEFAULTS, 'A dog.').errors).toEqual(['The edited prompt is too short to describe the creative.']);
    expect(resolveTemplateABasePrompt(TEMPLATE_A_DEFAULTS, 42).errors).toEqual(['The edited prompt must be text.']);
    expect(resolveTemplateABasePrompt(TEMPLATE_A_DEFAULTS, `A portrait of a smiling woman. ${'x'.repeat(2000)}`).errors[0]).toMatch(/at most 2000/);
    // A base at its limit still leaves room for the consistency and framing sentences; nothing is ever cut.
    expect(TEMPLATE_A_PROMPT_LIMITS.base).toBe(AI_LIMITS.prompt);
    const longest = `${'word '.repeat(399)}words`;
    expect(longest.length).toBe(TEMPLATE_A_PROMPT_LIMITS.base);
    for (const ratio of TEMPLATE_A_ASPECT_RATIOS) expect(buildTemplateAVariantPrompt(longest, ratio).length).toBeLessThanOrEqual(TEMPLATE_A_PROMPT_LIMITS.final);
    expect(() => buildTemplateAVariantPrompt('x'.repeat(TEMPLATE_A_PROMPT_LIMITS.final), '1:1')).toThrow(/at most 3000/);
  });
});
