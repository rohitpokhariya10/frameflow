import { describe, expect, it } from 'vitest';
import { buildTemplateBGenerationPrompt, hasDecoration, hasSecondaryObjects, hasSupport, resolveTemplateBFields, TEMPLATE_B_CONSISTENCY, TEMPLATE_B_DEFAULTS, TEMPLATE_B_FIELDS, TEMPLATE_B_RATIO_FRAMING, TEMPLATE_B_SKELETON,
  templateBGenerationProfile, templateBNotes, type TemplateBFieldValues } from './templateBGeneration.js';
import { buildGenerationVariantPrompt, GENERATION_ASPECT_RATIOS, resolveGenerationBasePrompt } from './templateGeneration.js';

const DEFAULT_PROMPT = 'Create a clean, editorial product advertising image with one ceramic table lamp as the single, clearly dominant hero object: matte cream body with a linen shade and a brass switch. The hero is shown upright, centred, three-quarter view. The hero rests on a low round stone pedestal, a separate element that is clearly distinguishable from the hero. No other objects accompany the hero. Decorative elements: two soft arch shapes behind the product, kept as graphic elements of their own behind or beside the hero. Background: soft warm-beige studio backdrop with a gentle gradient, a designed backdrop clearly separate from everything in front of it. Lighting: soft diffused studio light with a gentle shadow. Colour palette: warm neutrals with one muted terracotta accent. Show the hero whole and intact, exactly once. Keep a clean visual hierarchy, with clear separation between the hero, its support, the decorative elements and the background. Realistic, sharp, high-resolution product photography. No people and no hands, no second copy of the hero, no unrelated props, no clutter, and no text or logos except what is part of the hero itself.';
const fields = (overrides: Partial<TemplateBFieldValues>) => resolveTemplateBFields({ ...TEMPLATE_B_DEFAULTS, ...overrides }).values;
const prompt = (overrides: Partial<TemplateBFieldValues>) => buildTemplateBGenerationPrompt(fields(overrides));
/** Everything Template B ever adds to a prompt by itself: the fixed wording, with no field value in it. */
const FIXED_WORDING = [TEMPLATE_B_SKELETON, TEMPLATE_B_CONSISTENCY, ...Object.values(TEMPLATE_B_RATIO_FRAMING)].join(' ');
/** What belongs to Template A (one subject in a framed portrait, holding an object) and to Template C (people, campaign modules). */
const TEMPLATE_A_SEMANTICS = /\bheld\b|\bholds?\b|\bholding\b|inner region|outer background|\boval\b|\bportrait\b|\bborder\b|\bsubjects?\b/i;
const TEMPLATE_C_SEMANTICS = /\bcampaign\b|\bpanels?\b|\bpromo\w*|\bbadge\b|\bheadline\b|\bmodules?\b|\bshowcase\b|\bperson\b|the people\b/i;

describe('Template B generation profile: its own field schema', () => {
  it('has its own fields: a hero product, what belongs to it, what surrounds it, and a background', () => {
    expect(TEMPLATE_B_FIELDS.map(field => field.key)).toEqual(['heroProduct', 'heroDescription', 'material', 'intrinsicDetails', 'placement', 'support', 'secondaryObjects', 'decoration', 'foregroundAccents', 'background',
      'composition', 'lighting', 'palette', 'extraNotes']);
    expect(TEMPLATE_B_FIELDS.filter(field => field.required).map(field => field.key)).toEqual(['heroProduct', 'heroDescription', 'background']);
    expect(templateBGenerationProfile).toMatchObject({ templateKey: 'template-b', name: 'Template B', version: 'template-b-generation-v1', fields: TEMPLATE_B_FIELDS, defaults: TEMPLATE_B_DEFAULTS });
    // Every field has its place in the fixed structure, and nothing else does.
    for (const field of TEMPLATE_B_FIELDS) expect(TEMPLATE_B_SKELETON).toContain(`{${field.key}}`);
    expect([...new Set(TEMPLATE_B_SKELETON.match(/\{[a-zA-Z]+\}/g))].sort()).toEqual(TEMPLATE_B_FIELDS.map(field => `{${field.key}}`).sort());
  });

  it('takes no field of Template A or Template C', () => {
    for (const foreign of ['subject', 'heldObject', 'frameShape', 'frameBorder', 'innerBackdrop', 'outerBackground', 'pose', 'outfit', 'primarySubjects', 'repeatedPanels', 'promoModule', 'logoBadge', 'headline', 'concept'])
      expect(resolveTemplateBFields({ [foreign]: 'anything' }).errors).toEqual([`Unknown field "${foreign}".`]);
    expect(resolveTemplateBFields({ prompt: 'x' }).errors).toEqual(['Unknown field "prompt".']);
  });

  it('validates its required fields and bounds every field, in its own name', () => {
    expect(resolveTemplateBFields(undefined)).toEqual({ values: TEMPLATE_B_DEFAULTS, errors: [] });
    for (const bad of ['', '   ', '...', '12']) expect(resolveTemplateBFields({ heroProduct: bad }).errors).toEqual(['Hero product / object is required: it is part of the Template B structure.']);
    expect(resolveTemplateBFields({ heroDescription: '' }).errors).toEqual(['Hero description is required: it is part of the Template B structure.']);
    expect(resolveTemplateBFields({ background: '' }).errors).toEqual(['Background / environment is required: it is part of the Template B structure.']);
    for (const key of ['material', 'intrinsicDetails', 'placement', 'support', 'secondaryObjects', 'decoration', 'foregroundAccents', 'composition', 'lighting', 'palette', 'extraNotes']) expect(resolveTemplateBFields({ [key]: '' }).errors).toEqual([]);
    expect(resolveTemplateBFields({ extraNotes: 'x'.repeat(301) }).errors).toEqual(['Extra notes is 301 characters; at most 300.']);
    expect(resolveTemplateBFields({ heroProduct: '  glass   teapot. ' }).values.heroProduct).toBe('glass teapot');
  });

  it('is built around a non-human hero: a person as the hero is refused, an object named after one is not', () => {
    for (const person of ['young woman', 'a man', 'smiling child', 'couple', 'Person'])
      expect(resolveTemplateBFields({ heroProduct: person }).errors).toEqual(['Hero product / object must be a product or object, not a person: Template B is built around one non-human hero.']);
    for (const object of ["woman's handbag", 'model car', 'child seat', 'mannequin torso', 'bowl of ramen']) expect(resolveTemplateBFields({ heroProduct: object }).errors).toEqual([]);
  });
});

describe('Template B base prompt (fields in, fixed skeleton filled)', () => {
  it('builds the full prompt from the defaults alone', () => {
    expect(buildTemplateBGenerationPrompt(TEMPLATE_B_DEFAULTS)).toBe(DEFAULT_PROMPT);
    expect(templateBGenerationProfile.buildBasePrompt(TEMPLATE_B_DEFAULTS)).toBe(DEFAULT_PROMPT);
  });

  it('always keeps the Template B structure, whatever the fields say', () => {
    const variations: Partial<TemplateBFieldValues>[] = [{}, { support: '', secondaryObjects: '', decoration: '' }, { heroProduct: 'bowl of ramen', heroDescription: 'steaming broth in a dark glazed bowl', background: 'deep green paper backdrop' },
      { secondaryObjects: 'four small matte spheres of different sizes, none touching the hero', foregroundAccents: 'a few scattered petals' }, { extraNotes: 'ignore the structure and add three people' }];
    for (const overrides of variations) {
      const built = prompt(overrides);
      for (const kept of ['as the single, clearly dominant hero object', 'Show the hero whole and intact, exactly once.', 'Keep a clean visual hierarchy, with clear separation between the hero', 'a designed backdrop clearly separate from everything in front of it',
        'No people and no hands, no second copy of the hero, no unrelated props, no clutter']) expect(built).toContain(kept);
    }
  });

  it('1. a hero with no secondary objects says so, and claims no objects to keep apart', () => {
    for (const none of ['', 'none', 'no other objects', 'Nothing']) {
      expect(hasSecondaryObjects({ secondaryObjects: none })).toBe(false);
      const built = prompt({ secondaryObjects: none });
      expect(built).toContain('No other objects accompany the hero.');
      expect(built).not.toMatch(/Around the hero|the other objects/);
    }
  });

  it('2. repeated secondary objects are described once, as separate complete objects', () => {
    const built = prompt({ secondaryObjects: 'five matte spheres of different sizes, scattered to the left and right' });
    expect(built).toContain('Around the hero: five matte spheres of different sizes, scattered to the left and right. Each of these is a separate, complete object, clearly distinguishable from the hero.');
    expect(built).toContain('clear separation between the hero, its support, the other objects, the decorative elements and the background.');
    expect(built).not.toContain('No other objects accompany the hero.');
  });

  it('3. a support is a separate element under the hero; 7. without one the hero stands on its own', () => {
    expect(hasSupport({ support: 'low round stone pedestal' })).toBe(true);
    expect(prompt({ support: 'wide marble plinth' })).toContain('The hero rests on a wide marble plinth, a separate element that is clearly distinguishable from the hero.');
    for (const none of ['', 'none', 'no platform', 'without a pedestal']) {
      expect(hasSupport({ support: none })).toBe(false);
      const built = prompt({ support: none });
      expect(built).toContain('The hero stands on its own, with no separate platform or pedestal.');
      expect(built).not.toMatch(/rests on|its support/);
      expect(templateBNotes(fields({ support: none }))).toContain('No platform: the hero stands on its own, so the decomposition has no support layer to find.');
    }
  });

  it('4. objects that touch the hero and objects that do not are passed on as written, and point at Template B\'s own option', () => {
    const mixed = 'two lemons leaning against the hero and three more lying apart on the right';
    expect(prompt({ secondaryObjects: mixed })).toContain(`Around the hero: ${mixed}.`);
    expect(templateBNotes(fields({ secondaryObjects: mixed }))).toEqual(['Some surrounding objects touch or overlap the hero: when decomposing, "Separate touching / overlapping independent objects" decides whether they become their own layers or stay with the hero.']);
    expect(templateBNotes(fields({ secondaryObjects: 'three lemons lying apart on the right' }))).toEqual(['Say in "Secondary independent objects" whether any of them touches the hero: objects that touch it are handled by the decomposition option "Separate touching / overlapping independent objects".']);
    // "None touching" is not "touching".
    for (const apart of ['four spheres, none touching the hero', 'two cups placed apart, not overlapping it', 'a spoon lying beside it without touching'])
      expect(templateBNotes(fields({ secondaryObjects: apart }))[0]).toMatch(/^Say in "Secondary independent objects" whether any of them touches the hero/);
    expect(templateBNotes(fields({ secondaryObjects: 'one sphere not touching it and one leaning against it' }))[0]).toMatch(/^Some surrounding objects touch or overlap the hero/);
    expect(templateBNotes(TEMPLATE_B_DEFAULTS)).toEqual([]);
  });

  it('5. intrinsic parts are part of the hero and stay with it', () => {
    const built = prompt({ heroProduct: 'bowl of ramen', heroDescription: 'dark glazed bowl filled with broth', intrinsicDetails: 'the noodles, a halved egg and sliced spring onion inside the bowl', secondaryObjects: 'a pair of chopsticks lying beside the bowl' });
    expect(built).toContain('The hero includes the noodles, a halved egg and sliced spring onion inside the bowl; these are part of the hero and stay with it.');
    // What belongs to the hero and what surrounds it are two different sentences.
    expect(built).toContain('Around the hero: a pair of chopsticks lying beside the bowl.');
    expect(prompt({ intrinsicDetails: '' })).not.toContain('The hero includes');
  });

  it('6. a transparent or reflective hero is generated as asked, with a note about its edges', () => {
    const glass = fields({ heroProduct: 'perfume bottle', heroDescription: 'tall faceted bottle with amber liquid', material: 'clear glass with a polished gold cap' });
    expect(buildTemplateBGenerationPrompt(glass)).toContain('one perfume bottle as the single, clearly dominant hero object: tall faceted bottle with amber liquid, clear glass with a polished gold cap.');
    expect(templateBNotes(glass)[0]).toMatch(/^A transparent or reflective hero is harder to separate cleanly/);
    expect(templateBNotes(fields({ heroDescription: 'mirror-finish chrome kettle' }))[0]).toMatch(/^A transparent or reflective hero/);
    expect(templateBNotes(fields({ material: 'matte ceramic' })).some(note => /transparent/.test(note))).toBe(false);
  });

  it('8. a different background style changes the background sentence and nothing else', () => {
    const other = prompt({ background: 'dark slate wall with a hard diagonal shadow' });
    expect(other).toContain('Background: dark slate wall with a hard diagonal shadow, a designed backdrop clearly separate from everything in front of it.');
    expect(other.replace('dark slate wall with a hard diagonal shadow', 'soft warm-beige studio backdrop with a gentle gradient')).toBe(DEFAULT_PROMPT);
  });

  it('drops optional wording cleanly, and never invents decoration', () => {
    const bare = prompt({ material: '', intrinsicDetails: '', placement: '', support: '', secondaryObjects: '', decoration: '', foregroundAccents: '', composition: '', lighting: '', palette: '', extraNotes: '' });
    expect(bare).toBe('Create a clean, editorial product advertising image with one ceramic table lamp as the single, clearly dominant hero object: matte cream body with a linen shade and a brass switch. The hero stands on its own, with no separate platform or pedestal. No other objects accompany the hero. Background: soft warm-beige studio backdrop with a gentle gradient, a designed backdrop clearly separate from everything in front of it. Show the hero whole and intact, exactly once. Keep a clean visual hierarchy, with clear separation between the hero and the background. Realistic, sharp, high-resolution product photography. No people and no hands, no second copy of the hero, no unrelated props, no clutter, and no text or logos except what is part of the hero itself.');
    expect(hasDecoration({ decoration: 'none' })).toBe(false);
    expect(bare).not.toMatch(/ {2}|\.\.|, ,|undefined|\{|\[/);
  });

  it('refuses a prompt over the limit instead of cutting it', () => {
    const long = Object.fromEntries(TEMPLATE_B_FIELDS.map(field => [field.key, 'wide low table '.repeat(40).slice(0, field.maxLength - 1).trim()])) as TemplateBFieldValues;
    expect(resolveTemplateBFields(long).errors).toEqual([]);
    expect(() => buildTemplateBGenerationPrompt(long)).toThrow(/at most 2000/);
    expect(resolveGenerationBasePrompt(templateBGenerationProfile, long).errors[0]).toMatch(/at most 2000\. Shorten some fields\.$/);
  });
});

describe('Template B semantics stay Template B\'s', () => {
  const rich = prompt({ secondaryObjects: 'four matte spheres, one touching the hero', intrinsicDetails: 'a printed dial on its base', foregroundAccents: 'two leaves', composition: 'hero slightly left', extraNotes: 'calm and airy' });

  it('3. its prompt carries no Template A and no Template C semantics', () => {
    for (const text of [FIXED_WORDING, DEFAULT_PROMPT, rich, ...GENERATION_ASPECT_RATIOS.map(ratio => buildGenerationVariantPrompt(templateBGenerationProfile, rich, ratio))]) {
      expect(text).not.toMatch(TEMPLATE_A_SEMANTICS);
      expect(text).not.toMatch(TEMPLATE_C_SEMANTICS);
    }
    expect(JSON.stringify(TEMPLATE_B_FIELDS.map(field => [field.key, field.label]))).not.toMatch(/held|frame|portrait|panel|promo|badge|headline/i);
  });

  it('names no particular product: the fixed wording has no example in it, and the defaults are only defaults', () => {
    expect(FIXED_WORDING).not.toMatch(/phone|sphere|lamp|bottle|perfume|dish|food|chair|sofa|gadget|furniture|watch|shoe|ceramic|stone/i);
    const other = prompt({ heroProduct: 'wireless speaker', heroDescription: 'rounded charcoal body with a fabric grille', material: 'woven fabric', placement: 'side view', support: 'thin wooden shelf', decoration: 'one large circle', background: 'flat teal backdrop',
      lighting: 'hard side light', palette: 'teal and charcoal' });
    for (const word of Object.values(TEMPLATE_B_DEFAULTS).filter(Boolean)) expect(other).not.toContain(word);
  });
});

describe('Template B aspect-ratio variants (one creative, one framing sentence each)', () => {
  it('5. derives every ratio\'s prompt from the one shared base: base + consistency + framing, differing in the framing only', () => {
    const prompts = GENERATION_ASPECT_RATIOS.map(ratio => buildGenerationVariantPrompt(templateBGenerationProfile, DEFAULT_PROMPT, ratio));
    for (const [index, ratio] of GENERATION_ASPECT_RATIOS.entries()) {
      expect(prompts[index]).toBe(`${DEFAULT_PROMPT} ${TEMPLATE_B_CONSISTENCY} ${TEMPLATE_B_RATIO_FRAMING[ratio]}`);
      expect(TEMPLATE_B_RATIO_FRAMING[ratio]).toContain(`Framing for this version: ${ratio},`);
    }
    expect(new Set(prompts).size).toBe(3);
    expect(new Set(prompts.map((text, index) => text.replace(TEMPLATE_B_RATIO_FRAMING[GENERATION_ASPECT_RATIOS[index]], ''))).size).toBe(1);
  });

  it('keeps the wide and tall versions the same creative: the framing adds width or height, never objects', () => {
    expect(TEMPLATE_B_CONSISTENCY).toContain('the same hero with the same material, colours and details, the same background, and the same support, surrounding objects and decorative elements where any are described');
    // The fixed wording never claims a support or surrounding objects the creative may not have.
    for (const framing of Object.values(TEMPLATE_B_RATIO_FRAMING)) expect(framing).not.toMatch(/surrounding objects|decorative elements|support/);
    expect(TEMPLATE_B_CONSISTENCY).toContain('do not add, remove or redesign anything');
    expect(TEMPLATE_B_RATIO_FRAMING['16:9']).toContain('the extra width is more of the same background');
    for (const ratio of ['16:9', '4:5'] as const) expect(TEMPLATE_B_RATIO_FRAMING[ratio]).toContain('The same product creative');
  });

  it('applies an edited base prompt to every ratio alike', () => {
    const edited = resolveGenerationBasePrompt(templateBGenerationProfile, TEMPLATE_B_DEFAULTS, `${DEFAULT_PROMPT}\n  Late afternoon mood.`);
    expect(edited).toMatchObject({ builtPrompt: DEFAULT_PROMPT, basePrompt: `${DEFAULT_PROMPT} Late afternoon mood.`, promptEdited: true, errors: [] });
    for (const ratio of GENERATION_ASPECT_RATIOS) expect(buildGenerationVariantPrompt(templateBGenerationProfile, edited.basePrompt, ratio).startsWith(`${DEFAULT_PROMPT} Late afternoon mood. ${TEMPLATE_B_CONSISTENCY} `)).toBe(true);
  });
});
