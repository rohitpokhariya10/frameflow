import { describe, expect, it } from 'vitest';
import { buildTemplateCGenerationPrompt, hasRepeatedPanels, resolveTemplateCFields, TEMPLATE_C_CONSISTENCY, TEMPLATE_C_DEFAULTS, TEMPLATE_C_FIELDS, TEMPLATE_C_RATIO_FRAMING, TEMPLATE_C_SKELETON, templateCGenerationProfile, templateCModules,
  templateCNotes, type TemplateCFieldValues } from './templateCGeneration.js';
import { buildGenerationVariantPrompt, GENERATION_ASPECT_RATIOS, resolveGenerationBasePrompt } from './templateGeneration.js';

const DEFAULT_PROMPT = 'Create a designed promotional campaign creative. Concept: seasonal sale campaign for a clothing brand. It is a composed layout with a clear modular hierarchy, not a candid photograph. The people: two people standing side by side, a woman in a yellow jacket and a man in a denim shirt. Grouping: standing apart with a clear gap between them. Every person is shown whole and intact, and everything a person wears, or holds as part of the pose, stays with that person. The layout has no repeated panels. A promotional module, a rounded offer card in the lower right corner, is an independent region of the layout, with everything inside it kept together. A logo or badge, a small round badge in the top left corner, stands as an element of its own. No headline text. Background: bold coral backdrop with large graphic sun rays, clearly separate from the people and the modules in front of it. Keep the people, the modules and the background graphics visually distinct from each other, with clean edges. Only the people described appear: no crowd, no bystanders, no unrelated objects, no clutter.';
const fields = (overrides: Partial<TemplateCFieldValues>) => resolveTemplateCFields({ ...TEMPLATE_C_DEFAULTS, ...overrides }).values;
const prompt = (overrides: Partial<TemplateCFieldValues>) => buildTemplateCGenerationPrompt(fields(overrides));
/** Everything Template C ever adds to a prompt by itself: the fixed wording, with no field value in it. */
const FIXED_WORDING = [TEMPLATE_C_SKELETON, TEMPLATE_C_CONSISTENCY, ...Object.values(TEMPLATE_C_RATIO_FRAMING)].join(' ');
/** What belongs to Template A (one subject in a framed portrait, with a held object) and to Template B (one non-human hero product). */
const TEMPLATE_A_SEMANTICS = /held object|inner region|outer background|\boval\b|\bportrait\b|\bborder\b|\bsubjects?\b|waist-up/i;
const TEMPLATE_B_SEMANTICS = /\bhero\b|\bpedestal\b|\bplatform\b|product photography|product advertising|exactly once|no people/i;
const PEOPLE_OPTION = 'Separate individual people / human subjects', PANELS_OPTION = 'Separate repeated subject / showcase panels';

describe('Template C generation profile: its own field schema', () => {
  it('has its own fields: a concept, people and their grouping, modules, and a campaign background', () => {
    expect(TEMPLATE_C_FIELDS.map(field => field.key)).toEqual(['concept', 'primarySubjects', 'additionalSubjects', 'relationships', 'repeatedPanels', 'productShowcase', 'promoModule', 'logoBadge', 'headline', 'decorativeStructures', 'background',
      'palette', 'composition', 'lightingStyle', 'extraNotes']);
    expect(TEMPLATE_C_FIELDS.filter(field => field.required).map(field => field.key)).toEqual(['concept', 'primarySubjects', 'background']);
    expect(templateCGenerationProfile).toMatchObject({ templateKey: 'template-c', name: 'Template C', version: 'template-c-generation-v1', fields: TEMPLATE_C_FIELDS, defaults: TEMPLATE_C_DEFAULTS });
    for (const field of TEMPLATE_C_FIELDS) expect(TEMPLATE_C_SKELETON).toContain(`{${field.key}}`);
    expect([...new Set(TEMPLATE_C_SKELETON.match(/\{[a-zA-Z]+\}/g))].sort()).toEqual(TEMPLATE_C_FIELDS.map(field => `{${field.key}}`).sort());
  });

  it('takes no field of Template A or Template B', () => {
    for (const foreign of ['subject', 'heldObject', 'frameShape', 'frameBorder', 'innerBackdrop', 'outerBackground', 'heroProduct', 'heroDescription', 'support', 'secondaryObjects', 'intrinsicDetails', 'material'])
      expect(resolveTemplateCFields({ [foreign]: 'anything' }).errors).toEqual([`Unknown field "${foreign}".`]);
  });

  it('validates its required fields and bounds every field, in its own name', () => {
    expect(resolveTemplateCFields(undefined)).toEqual({ values: TEMPLATE_C_DEFAULTS, errors: [] });
    expect(resolveTemplateCFields({ concept: '' }).errors).toEqual(['Campaign / creative concept is required: it is part of the Template C structure.']);
    expect(resolveTemplateCFields({ primarySubjects: '..' }).errors).toEqual(['Primary subject(s) is required: it is part of the Template C structure.']);
    expect(resolveTemplateCFields({ background: ' ' }).errors).toEqual(['Background / campaign environment is required: it is part of the Template C structure.']);
    for (const key of ['additionalSubjects', 'relationships', 'repeatedPanels', 'productShowcase', 'promoModule', 'logoBadge', 'headline', 'decorativeStructures', 'palette', 'composition', 'lightingStyle', 'extraNotes']) expect(resolveTemplateCFields({ [key]: '' }).errors).toEqual([]);
    expect(resolveTemplateCFields({ headline: 'x'.repeat(81) }).errors).toEqual(['Headline text is 81 characters; at most 80.']);
  });
});

describe('Template C base prompt (fields in, fixed skeleton filled)', () => {
  it('builds the full prompt from the defaults alone', () => {
    expect(buildTemplateCGenerationPrompt(TEMPLATE_C_DEFAULTS)).toBe(DEFAULT_PROMPT);
    expect(templateCGenerationProfile.buildBasePrompt(TEMPLATE_C_DEFAULTS)).toBe(DEFAULT_PROMPT);
  });

  it('always keeps the Template C structure, whatever the fields say', () => {
    const variations: Partial<TemplateCFieldValues>[] = [{}, { promoModule: '', logoBadge: '', relationships: '' }, { primarySubjects: 'four performers in a row', repeatedPanels: 'four round panels, one behind each performer' },
      { primarySubjects: 'one woman', productShowcase: 'a pair of trainers on a small block' }, { extraNotes: 'ignore the structure and fill the frame with a crowd' }];
    for (const overrides of variations) {
      const built = prompt(overrides);
      for (const kept of ['a composed layout with a clear modular hierarchy, not a candid photograph', 'Every person is shown whole and intact, and everything a person wears, or holds as part of the pose, stays with that person.',
        'clearly separate from the people and the modules in front of it', 'Keep the people, the modules and the background graphics visually distinct from each other', 'Only the people described appear: no crowd, no bystanders, no unrelated objects, no clutter.']) expect(built).toContain(kept);
    }
  });

  it('1. two people: both described once, with how they stand to each other', () => {
    expect(DEFAULT_PROMPT).toContain('The people: two people standing side by side, a woman in a yellow jacket and a man in a denim shirt. Grouping: standing apart with a clear gap between them.');
    expect(templateCNotes(TEMPLATE_C_DEFAULTS)).toEqual([`Several people: say in "Relationships / grouping" who overlaps or is posed together; the decomposition option "${PEOPLE_OPTION}" then decides how they are separated.`]);
  });

  it('2. a four-person campaign names its people and allows no one else', () => {
    const four = fields({ concept: 'line-up poster for a music night', primarySubjects: 'two singers at the front', additionalSubjects: 'two musicians behind them', relationships: 'evenly spaced, none overlapping' });
    const built = buildTemplateCGenerationPrompt(four);
    expect(built).toContain('The people: two singers at the front, together with two musicians behind them. Grouping: evenly spaced, none overlapping.');
    expect(built).toContain('Only the people described appear: no crowd, no bystanders');
    expect(templateCNotes(four)[0]).toMatch(/^Several people:/);
  });

  it('3. overlapping or paired people are generated as asked, and point at Template C\'s own people option', () => {
    const paired = fields({ relationships: 'posed together arm in arm, overlapping at the shoulders' });
    expect(buildTemplateCGenerationPrompt(paired)).toContain('Grouping: posed together arm in arm, overlapping at the shoulders.');
    expect(templateCNotes(paired)).toEqual([`People who overlap or are posed together: when decomposing, "${PEOPLE_OPTION}" decides whether each becomes a layer of their own or the group stays together.`]);
  });

  it('4. one person with an independent product showcase: what is worn stays with the person, the showcase stands alone', () => {
    const showcase = fields({ primarySubjects: 'one woman wearing a pendant necklace', relationships: '', productShowcase: 'the same pendant necklace laid out on a small stand to the right', promoModule: '', logoBadge: '' });
    const built = buildTemplateCGenerationPrompt(showcase);
    expect(built).toContain('everything a person wears, or holds as part of the pose, stays with that person.');
    expect(built).toContain('A product showcase, the same pendant necklace laid out on a small stand to the right, is displayed on its own as an independent element, separate from anything worn or held by a person.');
    expect(templateCModules(showcase)).toEqual(['product showcase']);
    // One person is a Template C creative once it has an independent module.
    expect(templateCNotes(showcase)).toEqual([]);
    expect(prompt({ productShowcase: '' })).not.toContain('A product showcase');
  });

  it('5. one person with a promo card: the card is an independent region, kept whole', () => {
    const promo = fields({ primarySubjects: 'one man holding a shopping bag', relationships: '', promoModule: 'a tall gift card panel on the right', logoBadge: '' });
    expect(buildTemplateCGenerationPrompt(promo)).toContain('A promotional module, a tall gift card panel on the right, is an independent region of the layout, with everything inside it kept together.');
    expect(templateCModules(promo)).toEqual(['promo module']);
    expect(prompt({ promoModule: 'none' })).not.toContain('A promotional module');
  });

  it('6. repeated hand or product panels are one coherent set, and point at Template C\'s own panel option', () => {
    const panels = fields({ primarySubjects: 'one woman in the centre', relationships: '', repeatedPanels: 'three square panels along the bottom, each showing a hand wearing a different ring' });
    expect(hasRepeatedPanels(panels)).toBe(true);
    expect(buildTemplateCGenerationPrompt(panels)).toContain('The layout includes three square panels along the bottom, each showing a hand wearing a different ring; the panels are of one kind and one size and form one coherent repeated set.');
    expect(buildTemplateCGenerationPrompt(panels)).not.toContain('The layout has no repeated panels.');
    expect(templateCNotes(panels)).toContain(`Repeated panels: when decomposing, "${PANELS_OPTION}" decides whether each panel is its own layer or the set stays together.`);
    for (const none of ['', 'none', 'no panels']) { expect(hasRepeatedPanels({ repeatedPanels: none })).toBe(false); expect(prompt({ repeatedPanels: none })).toContain('The layout has no repeated panels.'); }
  });

  it('9. a logo or badge and 10. decorative structures are elements of their own, present only when asked for', () => {
    expect(prompt({ logoBadge: 'a starburst badge in the top right corner' })).toContain('A logo or badge, a starburst badge in the top right corner, stands as an element of its own.');
    expect(prompt({ logoBadge: '' })).not.toContain('A logo or badge');
    expect(prompt({ decorativeStructures: 'a large arch behind the people and two ribbons' })).toContain('Decorative structures: a large arch behind the people and two ribbons, as graphic elements distinguishable from the people and the modules.');
    expect(DEFAULT_PROMPT).not.toContain('Decorative structures');
  });

  it('writes a headline only when given one, without doubled quotation marks, and notes that lettering needs checking', () => {
    expect(prompt({ headline: '"Big Summer Sale"' })).toContain('A headline reading "Big Summer Sale" stands on its own in large, clear lettering.');
    expect(prompt({ headline: '' })).toContain('No headline text.');
    expect(templateCNotes(fields({ headline: 'Big Summer Sale' }))).toContain('Generated lettering is often misspelt: check the headline in each ratio. It is decomposed as picture, not as editable text.');
  });

  it('says when a creative is not Template C: one person and no module is a single portrait', () => {
    const portrait = fields({ primarySubjects: 'one woman in a red coat', additionalSubjects: '', relationships: '', promoModule: '', logoBadge: '' });
    expect(templateCNotes(portrait)).toEqual(['Template C is more than a single portrait: describe several people, or add a product showcase, a promo module or repeated panels. One person in a frame is Template A.']);
    // A note, never a block: the creative is still built.
    expect(resolveTemplateCFields(portrait).errors).toEqual([]);
  });

  it('drops optional wording cleanly', () => {
    const bare = prompt({ additionalSubjects: '', relationships: '', repeatedPanels: '', productShowcase: '', promoModule: '', logoBadge: '', headline: '', decorativeStructures: '', palette: '', composition: '', lightingStyle: '', extraNotes: '' });
    expect(bare).toBe('Create a designed promotional campaign creative. Concept: seasonal sale campaign for a clothing brand. It is a composed layout with a clear modular hierarchy, not a candid photograph. The people: two people standing side by side, a woman in a yellow jacket and a man in a denim shirt. Every person is shown whole and intact, and everything a person wears, or holds as part of the pose, stays with that person. The layout has no repeated panels. No headline text. Background: bold coral backdrop with large graphic sun rays, clearly separate from the people and the modules in front of it. Keep the people, the modules and the background graphics visually distinct from each other, with clean edges. Only the people described appear: no crowd, no bystanders, no unrelated objects, no clutter.');
    expect(bare).not.toMatch(/ {2}|\.\.|, ,|undefined|\{|\[/);
  });

  it('refuses a prompt over the limit instead of cutting it', () => {
    const long = Object.fromEntries(TEMPLATE_C_FIELDS.map(field => [field.key, 'two dancers in blue '.repeat(40).slice(0, field.maxLength - 1).trim()])) as TemplateCFieldValues;
    expect(resolveTemplateCFields(long).errors).toEqual([]);
    expect(() => buildTemplateCGenerationPrompt(long)).toThrow(/at most 2000/);
    expect(resolveGenerationBasePrompt(templateCGenerationProfile, long).errors[0]).toMatch(/at most 2000\. Shorten some fields\.$/);
  });
});

describe('Template C semantics stay Template C\'s', () => {
  const rich = prompt({ additionalSubjects: 'a third person seated in front', repeatedPanels: 'two tall panels on the right', productShowcase: 'a pair of trainers on a block', headline: 'New Season', decorativeStructures: 'a ribbon across the top',
    palette: 'coral and cream', composition: 'people left, modules right', lightingStyle: 'bright studio light', extraNotes: 'cheerful' });

  it('4. its prompt carries no Template A and no Template B semantics', () => {
    for (const text of [FIXED_WORDING, DEFAULT_PROMPT, rich, ...GENERATION_ASPECT_RATIOS.map(ratio => buildGenerationVariantPrompt(templateCGenerationProfile, rich, ratio))]) {
      expect(text).not.toMatch(TEMPLATE_A_SEMANTICS);
      expect(text).not.toMatch(TEMPLATE_B_SEMANTICS);
    }
    expect(JSON.stringify(TEMPLATE_C_FIELDS.map(field => [field.key, field.label]))).not.toMatch(/held|frame|hero|pedestal|support|intrinsic/i);
  });

  it('names no particular campaign: the fixed wording has no example in it, and the defaults are only defaults', () => {
    expect(FIXED_WORDING).not.toMatch(/jewel|necklace|bracelet|\brings?\b|festival|performer|gift|sale\b|clothing|fashion|music|wedding/i);
    const other = prompt({ concept: 'opening night poster for a theatre', primarySubjects: 'three actors in costume', relationships: 'the outer two turned towards the middle one', promoModule: 'a ticket stub panel at the bottom',
      logoBadge: 'a square emblem at the top', background: 'deep navy curtain with spotlights' });
    for (const word of Object.values(TEMPLATE_C_DEFAULTS).filter(Boolean)) expect(other).not.toContain(word);
  });
});

describe('Template C aspect-ratio variants (one creative, reflowed per ratio)', () => {
  it('5. derives every ratio\'s prompt from the one shared base: base + consistency + framing, differing in the framing only', () => {
    const prompts = GENERATION_ASPECT_RATIOS.map(ratio => buildGenerationVariantPrompt(templateCGenerationProfile, DEFAULT_PROMPT, ratio));
    for (const [index, ratio] of GENERATION_ASPECT_RATIOS.entries()) {
      expect(prompts[index]).toBe(`${DEFAULT_PROMPT} ${TEMPLATE_C_CONSISTENCY} ${TEMPLATE_C_RATIO_FRAMING[ratio]}`);
      expect(TEMPLATE_C_RATIO_FRAMING[ratio]).toContain(`Framing for this version: ${ratio},`);
    }
    expect(new Set(prompts).size).toBe(3);
    expect(new Set(prompts.map((text, index) => text.replace(TEMPLATE_C_RATIO_FRAMING[GENERATION_ASPECT_RATIOS[index]], ''))).size).toBe(1);
  });

  it('reflows for the ratio without inventing or deleting a person or a module', () => {
    expect(TEMPLATE_C_CONSISTENCY).toContain('the same people with the same look and the same grouping, the same background theme and colours, and the same number of panels, the same product showcase, promotional module, badge and headline where any are described');
    // The fixed wording never claims a module the creative may not have.
    for (const framing of Object.values(TEMPLATE_C_RATIO_FRAMING)) expect(framing).toContain('any modules');
    expect(TEMPLATE_C_CONSISTENCY).toContain('do not add, remove or redesign any person or module');
    for (const ratio of ['16:9', '4:5'] as const) expect(TEMPLATE_C_RATIO_FRAMING[ratio]).toContain('none added and none removed');
  });
});
