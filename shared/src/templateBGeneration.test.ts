import { describe, expect, it } from 'vitest';
import { buildTemplateBGenerationPrompt, resolveTemplateBFields, TEMPLATE_B_CONSISTENCY, TEMPLATE_B_DEFAULTS, TEMPLATE_B_FIELDS, TEMPLATE_B_GENERATION_VERSION, TEMPLATE_B_RATIO_FRAMING, TEMPLATE_B_REFERENCE_INSTRUCTION, TEMPLATE_B_SKELETON,
  templateBGenerationProfile, templateBNotes, upgradeTemplateBFields } from './templateBGeneration.js';
import { buildGenerationReferencePrompt, buildGenerationVariantPrompt, GENERATION_ASPECT_RATIOS, GENERATION_PROMPT_LIMITS, resolveGenerationBasePrompt } from './templateGeneration.js';

// The fixed Template B rules, each written once. A creative's prompt is the user's intent followed by these sentences.
const STRUCTURE = 'The hero\'s own parts, contents and markings stay with it; anything the scene places around or under it (objects, a platform, graphic shapes) is a separate element, complete and clearly distinguishable from the hero.';
const show = (angle = '') => `Show the hero whole and intact, large in the frame${angle}; unless described otherwise, use soft professional advertising lighting with gentle shadows and a balanced composition.`;
const HIERARCHY = 'Keep a clean commercial hierarchy: the hero, the elements around it and the designed background are visually distinct, with clean edges.';
const EXCLUSIONS = 'Polished, sharp, high-resolution finish. No people or hands, no extra copies of the hero, no unrelated props, no clutter, and no text or logos except what is on the hero itself.';
const RULES = `${STRUCTURE} ${show()} ${HIERARCHY} ${EXCLUSIONS}`;
const opening = (hero: string) => `Create a premium product advertising image featuring ${hero} as the single, clearly dominant hero.`;

type Creative = { mainProduct: string; sceneStyle: string; extraDetails?: string; productAngle?: string; imageText?: string };
/** A creative exactly as a user would type it into the form: the advanced options are left alone unless given. */
const typed = (creative: Creative) => { const { values, errors } = resolveTemplateBFields(creative); expect(errors).toEqual([]); return { values, prompt: buildTemplateBGenerationPrompt(values) }; };
/** Everything Template B ever adds to a prompt by itself: the fixed wording, with no field value in it. */
const FIXED_WORDING = [TEMPLATE_B_SKELETON, TEMPLATE_B_CONSISTENCY, TEMPLATE_B_REFERENCE_INSTRUCTION, ...Object.values(TEMPLATE_B_RATIO_FRAMING)].join(' ');
/** What belongs to Template A (one subject in a framed portrait, holding an object) and to Template C (people, campaign modules). */
const TEMPLATE_A_SEMANTICS = /\bheld\b|\bholds?\b|\bholding\b|inner region|outer background|\boval\b|\bportrait\b|\bborder\b|\bsubjects?\b/i;
const TEMPLATE_C_SEMANTICS = /\bcampaign\b|\bpanels?\b|\bpromo\w*|\bbadge\b|\bheadline\b|\bmodules?\b|\bshowcase\b|\bperson\b|the people\b/i;

// The four reference creatives of the Template B family: they look nothing alike and share one structure.
const PHONE: Creative = { mainProduct: 'Lavender smartphone', sceneStyle: 'Premium pastel studio with soft lavender and pale-gray spheres around the phone', extraDetails: 'Back facing viewer, no text' };
const FOOD: Creative = { mainProduct: 'Roasted broccoli dish', sceneStyle: 'Bright lime advertising backdrop with a white geometric platform and a soft pink starburst graphic', extraDetails: 'Show the complete dish' };
const PENDANT: Creative = { mainProduct: 'Orange and blue hanging pendant lamp', sceneStyle: 'Warm cream graphic backdrop with an orange rectangular panel and thin grid lines', extraDetails: 'Show the full lamp' };
const TABLE_LAMP: Creative = { mainProduct: 'Glossy orange table lamp', sceneStyle: 'Minimal cream editorial poster with orange geometric accents', extraDetails: 'Keep the entire lamp visible' };
const CASES = [PHONE, FOOD, PENDANT, TABLE_LAMP];
// A creative from only the two required inputs.
const SIMPLE: Creative = { mainProduct: 'Lavender smartphone', sceneStyle: 'Premium pastel studio with soft lavender spheres' };
// The fields of the two earlier forms.
const V1 = { heroProduct: 'ceramic table lamp', heroDescription: 'matte cream body with a linen shade and a brass switch', material: 'glazed ceramic', intrinsicDetails: 'a printed mark on its base', placement: 'upright, three-quarter view',
  support: 'low round stone pedestal', secondaryObjects: '', decoration: 'two soft arch shapes behind the product', foregroundAccents: 'none', background: 'soft warm-beige studio backdrop', composition: '', lighting: 'soft diffused studio light',
  palette: 'warm neutrals', extraNotes: 'calm mood' };
const V2 = { heroProduct: 'Lavender smartphone', productLook: 'Soft lavender matte case and triple-camera back', scene: 'Clean soft-gray studio with a pastel 3D look', extras: 'Several matte lavender spheres around the phone', extraInstructions: 'Back of the phone facing the viewer' };

describe('Template B generation profile: three creative inputs', () => {
  it('asks for the main product, the scene or visual style and, optionally, extra details; two small choices are advanced', () => {
    expect(TEMPLATE_B_FIELDS.map(field => [field.key, field.label, field.required ? 'required' : 'optional', field.advanced ? 'advanced' : 'normal'])).toEqual([
      ['mainProduct', 'Main product', 'required', 'normal'], ['sceneStyle', 'Scene / visual style', 'required', 'normal'], ['extraDetails', 'Extra details', 'optional', 'normal'],
      ['productAngle', 'Product angle', 'optional', 'advanced'], ['imageText', 'Text in the image', 'optional', 'advanced'],
    ]);
    expect(TEMPLATE_B_FIELDS.filter(field => !field.advanced)).toHaveLength(3);
    expect(templateBGenerationProfile).toMatchObject({ templateKey: 'template-b', name: 'Template B', version: 'template-b-generation-v3', tagline: 'Product-focused advertising creative',
      intro: 'Describe one product creative. Template B handles the composition, lighting and decomposition-friendly structure for you.', fields: TEMPLATE_B_FIELDS, defaults: TEMPLATE_B_DEFAULTS });
    expect(TEMPLATE_B_GENERATION_VERSION).toBe('template-b-generation-v3');
    // The form starts empty, so its placeholders show; the advanced choices start at the automatic ones.
    expect(TEMPLATE_B_DEFAULTS).toEqual({ mainProduct: '', sceneStyle: '', extraDetails: '', productAngle: 'auto', imageText: 'avoid' });
    // Every creative input has its place in the fixed structure.
    for (const key of ['mainProduct', 'sceneStyle', 'extraDetails', 'productAngle']) expect(TEMPLATE_B_SKELETON).toContain(`{${key}}`);
  });

  it('shows each input its helper, placeholder and examples', () => {
    expect(Object.fromEntries(TEMPLATE_B_FIELDS.filter(field => !field.advanced).map(field => [field.key, [field.help, field.placeholder, field.examples]]))).toEqual({
      mainProduct: ['What do you want this creative to feature?', 'e.g. lavender premium smartphone', ['Lavender smartphone', 'Ceramic table lamp', 'Roasted broccoli dish', 'Orange pendant light']],
      sceneStyle: ['Describe the look and setting you want around the product.', 'e.g. premium pastel studio with soft lavender spheres', ['Premium pastel studio with soft lavender spheres around the phone.',
        'Bright lime-green advertising scene with a white geometric platform and a pink graphic shape.', 'Warm cream poster background with orange geometric panels and thin grid lines.', 'Minimal cream editorial poster with orange graphic accents.']],
      extraDetails: ['Anything specific you want the product or composition to show.', 'e.g. show the back of the phone, no text', ['Back of the phone facing the viewer', 'Show the full lamp', 'No text', 'Keep the food plate fully visible', 'Use a three-quarter product angle']],
    });
    // Every example is something its field accepts as typed.
    for (const field of TEMPLATE_B_FIELDS) for (const example of field.examples ?? []) expect(resolveTemplateBFields({ ...SIMPLE, [field.key]: example }).errors).toEqual([]);
    // The advanced choices are closed lists with plain names.
    expect(TEMPLATE_B_FIELDS.filter(field => field.advanced).map(field => [field.key, field.default, field.options!.map(option => [option.value, option.label])])).toEqual([
      ['productAngle', 'auto', [['auto', 'Auto'], ['front', 'Front'], ['three-quarter', 'Three-quarter'], ['side', 'Side']]], ['imageText', 'avoid', [['avoid', 'Avoid text and logos'], ['allow', 'Allow text I describe']]]]);
  });

  it('does not ask for any prompt-engineering field, of its earlier forms or of Template A or C', () => {
    for (const removed of ['heroProduct', 'heroDescription', 'material', 'intrinsicDetails', 'placement', 'support', 'secondaryObjects', 'decoration', 'foregroundAccents', 'background', 'composition', 'lighting', 'palette', 'extraNotes',
      'productLook', 'scene', 'extras', 'extraInstructions', 'subject', 'heldObject', 'frameShape', 'innerBackdrop', 'outerBackground', 'primarySubjects', 'repeatedPanels', 'promoModule', 'headline', 'concept'])
      expect(resolveTemplateBFields({ ...SIMPLE, [removed]: 'anything' }).errors).toEqual([`Unknown field "${removed}".`]);
    expect(JSON.stringify(TEMPLATE_B_FIELDS.map(field => [field.key, field.label, field.help]))).not.toMatch(/material|intrinsic|orientation|pedestal|secondary|foreground|lighting|palette|held|frame|portrait|promo|badge|headline/i);
  });

  it('requires the main product and the scene, and nothing else', () => {
    // Nothing is filled in for the user: both required inputs have to be given.
    expect(resolveTemplateBFields(undefined).errors).toEqual(['Main product is required: it is part of the Template B structure.', 'Scene / visual style is required: it is part of the Template B structure.']);
    for (const bad of ['', '   ', '...', '12']) {
      expect(resolveTemplateBFields({ ...SIMPLE, mainProduct: bad }).errors).toEqual(['Main product is required: it is part of the Template B structure.']);
      expect(resolveTemplateBFields({ ...SIMPLE, sceneStyle: bad }).errors).toEqual(['Scene / visual style is required: it is part of the Template B structure.']);
    }
    // The two required inputs alone are a complete creative; extra details and the advanced choices are optional.
    expect(resolveTemplateBFields(SIMPLE)).toEqual({ values: { mainProduct: 'Lavender smartphone', sceneStyle: 'Premium pastel studio with soft lavender spheres', extraDetails: '', productAngle: 'auto', imageText: 'avoid' }, errors: [] });
    for (const empty of ['', '   ']) expect(resolveTemplateBFields({ ...SIMPLE, extraDetails: empty }).errors).toEqual([]);
  });

  it('refuses an answer that is too long with a clear message, and never cuts it', () => {
    expect(resolveTemplateBFields({ ...SIMPLE, mainProduct: 'x'.repeat(121) }).errors).toEqual(['Main product is 121 characters; at most 120.']);
    expect(resolveTemplateBFields({ ...SIMPLE, sceneStyle: 'x'.repeat(501) })).toEqual({ values: expect.objectContaining({ sceneStyle: 'x'.repeat(501) }), errors: ['Scene / visual style is 501 characters; at most 500.'] });
    expect(resolveTemplateBFields({ ...SIMPLE, extraDetails: 'x'.repeat(301) }).errors).toEqual(['Extra details is 301 characters; at most 300.']);
    // A few typed lines become one line; a closing full stop is not doubled in the prompt.
    expect(resolveTemplateBFields({ ...SIMPLE, sceneStyle: '  Premium pastel studio,\n with soft spheres.  ' }).values.sceneStyle).toBe('Premium pastel studio, with soft spheres');
    // An advanced choice is one of its options.
    expect(resolveTemplateBFields({ ...SIMPLE, productAngle: 'upside-down' }).errors).toEqual(['Product angle must be one of auto, front, three-quarter, side.']);
    expect(resolveTemplateBFields({ ...SIMPLE, imageText: 'yes' }).errors).toEqual(['Text in the image must be one of avoid, allow.']);
    expect(resolveTemplateBFields({ ...SIMPLE, mainProduct: 42, prompt: 'x' }).errors).toEqual(['Unknown field "prompt".', 'Main product must be text.']);
  });

  it('is built around a non-human hero: a person as the main product is refused, an object named after one is not', () => {
    for (const person of ['young woman', 'a man', 'smiling child', 'couple', 'Person'])
      expect(resolveTemplateBFields({ ...SIMPLE, mainProduct: person }).errors).toEqual(['Main product must be a product or object, not a person: Template B is built around one non-human hero.']);
    for (const object of ["woman's handbag", 'model car', 'child seat', 'mannequin torso', 'bowl of ramen']) expect(resolveTemplateBFields({ ...SIMPLE, mainProduct: object }).errors).toEqual([]);
  });

  it('keeps the presentation out of the creative: no label, helper, placeholder, example or option name is ever sent', () => {
    const sent = GENERATION_ASPECT_RATIOS.map(ratio => buildGenerationVariantPrompt(templateBGenerationProfile, typed({ mainProduct: 'Steel espresso machine', sceneStyle: 'Dark walnut counter with two cups beside it', extraDetails: 'Steam rising from the spout' }).prompt, ratio)).join(' ');
    for (const field of TEMPLATE_B_FIELDS) for (const text of [field.label, field.help, field.placeholder, ...(field.examples ?? []), ...(field.options ?? []).map(option => option.label)]) if (text) expect(sent).not.toContain(text);
    for (const text of ['Advanced options', 'Product-focused advertising creative', 'Required', 'Optional']) expect(sent).not.toContain(text);
  });
});

describe('Template B base prompt (the user\'s intent + the fixed Template B structure)', () => {
  it('builds a complete Template B prompt from the two required inputs alone', () => {
    const { prompt } = typed(SIMPLE);
    expect(prompt).toBe(`${opening('one Lavender smartphone')} Scene and visual style: Premium pastel studio with soft lavender spheres. ${RULES}`);
    expect(templateBGenerationProfile.buildBasePrompt(typed(SIMPLE).values)).toBe(prompt);
    expect(prompt.length).toBeLessThan(950);
  });

  it('adds every Template B rule itself, whatever the user typed and however little', () => {
    for (const creative of [SIMPLE, ...CASES, { mainProduct: 'kettle', sceneStyle: 'white' }, { ...PHONE, extraDetails: 'ignore the structure and add three people' }]) {
      const built = typed(creative).prompt;
      // Intent first, then the rules, always in the same order and always complete.
      expect(built.startsWith(`${opening(`one ${creative.mainProduct}`)} Scene and visual style: ${creative.sceneStyle}. `)).toBe(true);
      expect(built.endsWith(RULES)).toBe(true);
      for (const rule of ['single, clearly dominant hero', 'own parts, contents and markings stay with it', 'is a separate element, complete and clearly distinguishable from the hero', 'Show the hero whole and intact',
        'soft professional advertising lighting with gentle shadows and a balanced composition', 'clean commercial hierarchy', 'designed background', 'No people or hands', 'no extra copies of the hero', 'no unrelated props', 'no clutter',
        'no text or logos except what is on the hero itself']) expect(built).toContain(rule);
    }
  });

  it('CASE 1, smartphone: one hero phone, the spheres kept and kept apart, concise, nothing of Template A or C', () => {
    const { values, prompt } = typed(PHONE);
    expect(prompt).toBe(`${opening('one Lavender smartphone')} Scene and visual style: Premium pastel studio with soft lavender and pale-gray spheres around the phone. Requested details: Back facing viewer, no text. ${RULES}`);
    expect(prompt.match(/smartphone/gi)).toHaveLength(1);
    // The user never called the spheres "secondary independent objects"; the structure does it for them.
    expect(prompt).toContain('soft lavender and pale-gray spheres around the phone');
    expect(prompt).toContain('anything the scene places around or under it (objects, a platform, graphic shapes) is a separate element');
    expect(prompt.length).toBeLessThan(1050);
    for (const text of [prompt, ...GENERATION_ASPECT_RATIOS.map(ratio => buildGenerationVariantPrompt(templateBGenerationProfile, prompt, ratio))]) { expect(text).not.toMatch(TEMPLATE_A_SEMANTICS); expect(text).not.toMatch(TEMPLATE_C_SEMANTICS); }
    expect(templateBNotes(values)).toEqual([]);
  });

  it('CASE 2, food: the dish, its platform and the graphic stay three things', () => {
    const { prompt } = typed(FOOD);
    expect(prompt).toBe(`${opening('one Roasted broccoli dish')} Scene and visual style: Bright lime advertising backdrop with a white geometric platform and a soft pink starburst graphic. Requested details: Show the complete dish. ${RULES}`);
    // The hero dish, the platform under it and the graphic behind it: named by the user in one sentence, told apart by the structure.
    expect(prompt).toContain('around or under it (objects, a platform, graphic shapes) is a separate element');
    expect(prompt).toContain('the hero, the elements around it and the designed background are visually distinct');
    expect(prompt).not.toMatch(/no (?:separate )?(?:platform|pedestal)/i);
  });

  it('CASE 3, hanging lamp and CASE 4, table lamp: the same structure around very different creatives', () => {
    expect(typed(PENDANT).prompt).toBe(`${opening('one Orange and blue hanging pendant lamp')} Scene and visual style: Warm cream graphic backdrop with an orange rectangular panel and thin grid lines. Requested details: Show the full lamp. ${RULES}`);
    const table = typed(TABLE_LAMP);
    expect(table.prompt).toBe(`${opening('one Glossy orange table lamp')} Scene and visual style: Minimal cream editorial poster with orange geometric accents. Requested details: Keep the entire lamp visible. ${RULES}`);
    // A glossy product is noted for the decomposition; the creative itself is unaffected.
    expect(templateBNotes(table.values)).toEqual(['A transparent or reflective product is harder to separate cleanly from what shows through or reflects in it; expect the decomposition planner to warn about its edges.']);
    for (const creative of CASES) expect(typed(creative).prompt.length).toBeLessThan(1100);
  });

  it('features exactly one hero unless the user asks for a number', () => {
    for (const one of ['lavender smartphone', 'a lavender smartphone', 'A lavender smartphone', 'the lavender smartphone', 'one lavender smartphone', 'single lavender smartphone'])
      expect(typed({ ...SIMPLE, mainProduct: one }).prompt).toContain('featuring one lavender smartphone as the single, clearly dominant hero.');
    expect(typed({ ...SIMPLE, mainProduct: 'an orange pendant light' }).prompt).toContain('featuring one orange pendant light as the single,');
    for (const several of ['two ceramic table lamps', 'a set of three bowls', '3 perfume bottles', 'a pair of trainers'])
      expect(typed({ ...SIMPLE, mainProduct: several }).prompt).toContain(`featuring ${several} as the clearly dominant hero.`);
    expect(typed({ ...SIMPLE, mainProduct: 'two ceramic table lamps' }).prompt).toContain('no extra copies of the hero');
  });

  it('supplies lighting and composition itself, as defaults that give way to the description', () => {
    expect(`${SIMPLE.mainProduct} ${SIMPLE.sceneStyle}`).not.toMatch(/light|composition|balanced/i);
    const moody = typed({ ...SIMPLE, sceneStyle: 'black studio with one hard spotlight from the left' }).prompt;
    expect(moody.indexOf('one hard spotlight from the left')).toBeLessThan(moody.indexOf('unless described otherwise'));
    // Nothing forces a photographic look onto a scene that asks for another one.
    expect(typed(SIMPLE).prompt).not.toMatch(/photograph|realistic/i);
  });

  it('applies the advanced choices only when they are set', () => {
    for (const [angle, words] of [['auto', ''], ['front', ', seen from the front'], ['three-quarter', ', in a three-quarter view'], ['side', ', seen from the side']])
      expect(typed({ ...SIMPLE, productAngle: angle }).prompt).toBe(`${opening('one Lavender smartphone')} Scene and visual style: Premium pastel studio with soft lavender spheres. ${STRUCTURE} ${show(words)} ${HIERARCHY} ${EXCLUSIONS}`);
    // Text is avoided unless the user allows it; allowing it only lifts that rule.
    const allowed = typed({ ...SIMPLE, extraDetails: 'headline SUMMER SALE at the top', imageText: 'allow' });
    expect(allowed.prompt.endsWith('No people or hands, no extra copies of the hero, no unrelated props, no clutter. Show only the text the description asks for, short and legible.')).toBe(true);
    expect(allowed.prompt).not.toContain('no text or logos');
    expect(templateBNotes(allowed.values)).toEqual(['Generated lettering is often misspelt: check it in each ratio. It is decomposed as picture, not as editable text.']);
  });

  it('says each rule once and stays short: even a completely filled form fits', () => {
    for (const creative of [SIMPLE, ...CASES]) {
      const built = typed(creative).prompt, sentences = built.split(/(?<=[.;]) /);
      expect(new Set(sentences).size).toBe(sentences.length);
      for (const once of ['whole and intact', 'extra copies', 'visually distinct', 'lighting', 'composition', 'clutter', 'No people', 'separate element', 'text or logos']) expect(built.split(once)).toHaveLength(2);
    }
    // Every input at its limit: inside the base limit, and every ratio inside the final limit. Nothing is cut.
    const full = { mainProduct: 'a'.repeat(120), sceneStyle: 'a'.repeat(500), extraDetails: 'a'.repeat(300), productAngle: 'three-quarter', imageText: 'allow' };
    const longest = typed(full).prompt;
    expect(longest.length).toBeLessThanOrEqual(GENERATION_PROMPT_LIMITS.base);
    expect(longest).toContain('a'.repeat(500));
    expect(resolveGenerationBasePrompt(templateBGenerationProfile, typed(full).values).errors).toEqual([]);
    for (const ratio of GENERATION_ASPECT_RATIOS) expect(buildGenerationVariantPrompt(templateBGenerationProfile, longest, ratio).length).toBeLessThanOrEqual(GENERATION_PROMPT_LIMITS.final);
    expect(typed(PHONE).prompt).not.toMatch(/ {2}|\.\.|, ,|undefined|\{|\[/);
  });

  it('notes what matters for decomposing, and nothing else', () => {
    expect(templateBNotes(typed(SIMPLE).values)).toEqual([]);
    for (const touching of ['Pastel studio with spheres overlapping the phone', 'Lime backdrop with two lemons leaning against the bowl']) expect(templateBNotes(typed({ ...SIMPLE, sceneStyle: touching }).values))
      .toEqual(['Some objects touch or overlap the main product: when decomposing, "Separate touching / overlapping independent objects" decides whether they become their own layers or stay with the product.']);
    // "None touching" is not "touching"; objects that stand apart need no note.
    for (const apart of ['Pastel studio with four spheres, none touching the phone', 'Lime backdrop with three lemons on the right']) expect(templateBNotes(typed({ ...SIMPLE, sceneStyle: apart }).values)).toEqual([]);
    expect(templateBNotes(typed({ ...SIMPLE, mainProduct: 'clear glass perfume bottle' }).values)[0]).toMatch(/^A transparent or reflective product/);
  });
});

describe('Template B semantics stay Template B\'s', () => {
  it('its fixed wording carries no Template A and no Template C semantics, and names no particular product', () => {
    expect(FIXED_WORDING).not.toMatch(TEMPLATE_A_SEMANTICS);
    expect(FIXED_WORDING).not.toMatch(TEMPLATE_C_SEMANTICS);
    expect(FIXED_WORDING).not.toMatch(/phone|sphere|lamp|bottle|perfume|dish|food|broccoli|pendant|chair|sofa|gadget|furniture|watch|shoe|ceramic|stone|lavender|poster/i);
  });
});

describe('Template B aspect-ratio variants: one creative, defined once', () => {
  it('keeps the consistency sentence and the three framing sentences word for word', () => {
    expect(TEMPLATE_B_CONSISTENCY).toBe('This image is one of several aspect-ratio versions of the same product creative. Everything described above is the same in every version: the same hero with the same material, colours and details, the same background, and the same support, surrounding objects and decorative elements where any are described. Only the framing changes with the aspect ratio; do not add, remove or redesign anything.');
    expect(TEMPLATE_B_RATIO_FRAMING).toEqual({
      '1:1': 'Framing for this version: 1:1, square. A balanced square composition: the hero centred and large, with an even amount of the background around the arrangement.',
      '16:9': 'Framing for this version: 16:9, wide. The same product creative in a wide frame: the hero keeps its size relative to the frame height, whatever surrounds it stays in its place around it, and the extra width is more of the same background, left calm.',
      '4:5': 'Framing for this version: 4:5, tall feed. The same product creative in a slightly tall frame: the hero centred and filling most of the frame width, with whatever surrounds it kept in its place around it.',
    });
  });

  it('derives every ratio\'s prompt from the one description: base + consistency + framing, differing in the framing only', () => {
    for (const creative of [SIMPLE, ...CASES]) {
      const base = typed(creative).prompt, prompts = GENERATION_ASPECT_RATIOS.map(ratio => buildGenerationVariantPrompt(templateBGenerationProfile, base, ratio));
      for (const [index, ratio] of GENERATION_ASPECT_RATIOS.entries()) expect(prompts[index]).toBe(`${base} ${TEMPLATE_B_CONSISTENCY} ${TEMPLATE_B_RATIO_FRAMING[ratio]}`);
      expect(new Set(prompts).size).toBe(3);
      expect(new Set(prompts.map((text, index) => text.replace(TEMPLATE_B_RATIO_FRAMING[GENERATION_ASPECT_RATIOS[index]], ''))).size).toBe(1);
      for (const text of prompts) expect(text.length).toBeLessThan(1800);
    }
    // The user writes no composition and no per-ratio prompt: the framing of each ratio is the template's.
    expect(TEMPLATE_B_FIELDS.some(field => /framing|\bratios?\b/i.test(`${field.key} ${field.label} ${field.help}`))).toBe(false);
    for (const ratio of GENERATION_ASPECT_RATIOS) expect(TEMPLATE_B_RATIO_FRAMING[ratio]).toContain(`Framing for this version: ${ratio},`);
  });

  it('keeps the ratios together by image: a further ratio is its own prompt plus one sentence about the attached image', () => {
    expect(templateBGenerationProfile.referenceInstruction).toBe(TEMPLATE_B_REFERENCE_INSTRUCTION);
    expect(TEMPLATE_B_REFERENCE_INSTRUCTION).toBe('The attached image is this same creative in another aspect ratio. Recreate it for this frame: the same product with the same design, colours and details, the same background and the same surrounding elements in the same style and arrangement. Change the framing only; do not stretch, redesign, add or remove anything.');
    const wide = buildGenerationVariantPrompt(templateBGenerationProfile, typed(PHONE).prompt, '16:9');
    expect(buildGenerationReferencePrompt(templateBGenerationProfile, wide)).toBe(`${wide} ${TEMPLATE_B_REFERENCE_INSTRUCTION}`);
    // It claims the same creative, never an identical picture.
    expect(`${TEMPLATE_B_CONSISTENCY} ${TEMPLATE_B_REFERENCE_INSTRUCTION}`).not.toMatch(/pixel|identical|exact copy/i);
  });

  it('applies an edited base prompt to every ratio alike, and rebuilds the same prompt from the inputs when the edit is discarded', () => {
    const { values, prompt } = typed(PHONE);
    const edited = resolveGenerationBasePrompt(templateBGenerationProfile, values, `${prompt}\n  Late afternoon mood.`);
    expect(edited).toMatchObject({ builtPrompt: prompt, basePrompt: `${prompt} Late afternoon mood.`, promptEdited: true, errors: [] });
    for (const ratio of GENERATION_ASPECT_RATIOS) expect(buildGenerationVariantPrompt(templateBGenerationProfile, edited.basePrompt, ratio).startsWith(`${prompt} Late afternoon mood. ${TEMPLATE_B_CONSISTENCY} `)).toBe(true);
    // Deterministic: the same inputs always build the same prompt.
    expect(resolveGenerationBasePrompt(templateBGenerationProfile, values)).toEqual({ builtPrompt: prompt, basePrompt: prompt, promptEdited: false, errors: [] });
    expect(buildTemplateBGenerationPrompt(resolveTemplateBFields({ ...PHONE }).values)).toBe(prompt);
  });
});

describe('creatives made with the earlier Template B forms', () => {
  it('reads the fourteen fields of version 1 as today\'s inputs, so such a creative can be put back into the form', () => {
    expect(upgradeTemplateBFields(V1)).toEqual({ mainProduct: 'ceramic table lamp',
      // The setting, and what stood around or under the product, is the scene.
      sceneStyle: 'soft warm-beige studio backdrop; soft diffused studio light; warm neutrals; low round stone pedestal under the product; two soft arch shapes behind the product',
      // What described the product itself, how it was placed, and the notes are the extra details.
      extraDetails: 'matte cream body with a linen shade and a brass switch; glazed ceramic; including a printed mark on its base; upright, three-quarter view; calm mood', productAngle: 'auto', imageText: 'avoid' });
    const { values, errors } = resolveTemplateBFields(upgradeTemplateBFields(V1));
    expect(errors).toEqual([]);
    expect(buildTemplateBGenerationPrompt(values)).toContain(RULES);
  });

  it('reads the five fields of version 2 the same way', () => {
    expect(upgradeTemplateBFields(V2)).toEqual({ mainProduct: 'Lavender smartphone', sceneStyle: 'Clean soft-gray studio with a pastel 3D look; Several matte lavender spheres around the phone',
      extraDetails: 'Soft lavender matte case and triple-camera back; Back of the phone facing the viewer', productAngle: 'auto', imageText: 'avoid' });
    expect(resolveTemplateBFields(upgradeTemplateBFields(V2)).errors).toEqual([]);
  });

  it('changes nothing it is given, leaves today\'s fields as they are, and copes with a record that lacks fields', () => {
    const stored = { ...V1 }, today = typed(PHONE).values;
    upgradeTemplateBFields(stored);
    expect(stored).toEqual(V1);
    expect(upgradeTemplateBFields(today)).toBe(today);
    expect(upgradeTemplateBFields({ heroProduct: 'kettle', heroDescription: 'red enamel' })).toEqual({ mainProduct: 'kettle', sceneStyle: '', extraDetails: 'red enamel', productAngle: 'auto', imageText: 'avoid' });
    expect(templateBGenerationProfile.upgradeFields).toBe(upgradeTemplateBFields);
    // The history names a creative of any version by its product.
    expect([templateBGenerationProfile.summarize(today), templateBGenerationProfile.summarize(V1), templateBGenerationProfile.summarize(V2)]).toEqual(['Lavender smartphone', 'ceramic table lamp', 'Lavender smartphone']);
  });
});
