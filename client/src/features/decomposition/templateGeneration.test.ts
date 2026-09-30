import { afterEach, describe, expect, it, vi } from 'vitest';
import { GENERATION_PROFILES, GENERATION_TEMPLATE_KEYS, templateAGenerationProfile, templateBGenerationProfile, templateCGenerationProfile } from '@frameflow/shared';
import type { TemplateEntry } from './layerizeExperiment';
import { creationRequestFor, decomposeRequestFor, decompositionControlsFor, decompositionLabel, GENERATION_DECOMPOSITION, generationApiFor, generatorReducerFor, HELD_OBJECT_CHOICE, initialFormFor, resolvedCreativeFor, variantImageUrlFor } from './templateGeneration';

afterEach(() => { vi.unstubAllGlobals(); });
// The template list as the server serves it (layerizeTemplates.ts): Template A has its held-object checkbox, B and C their own options.
const A_ENTRY: TemplateEntry = { key: 'template-a', name: 'Template A', description: '', grouping: { label: 'Separate held object from subject', checked: '', unchecked: '', minReason: '', modeName: 'Held object mode' } };
const B_ENTRY: TemplateEntry = { key: 'template-b', name: 'Template B', description: '', options: [{ key: 'separateTouchingIndependentObjects', label: 'Separate touching / overlapping independent objects', help: '', default: false }] };
const C_ENTRY: TemplateEntry = { key: 'template-c', name: 'Template C', description: '', options: [{ key: 'separateHumanSubjects', label: 'Separate individual people / human subjects', help: '', default: false },
  { key: 'separateRepeatedModules', label: 'Separate repeated subject / showcase panels', help: '', default: false }] };
const ENTRIES = { 'template-a': A_ENTRY, 'template-b': B_ENTRY, 'template-c': C_ENTRY };
const withObject = { structure: { visibleBorder: true, heldObject: true } }, bare = {};
const labels = (controls: ReturnType<typeof decompositionControlsFor>) => controls.kind === 'held-object' ? [controls.label] : controls.kind === 'options' ? controls.options.map(option => option.label) : [];

describe.each([templateBGenerationProfile, templateCGenerationProfile])('$name generator form (the shared form, this template\'s profile)', (profile) => {
  const BASE = profile.buildBasePrompt(profile.defaults), reducer = generatorReducerFor(profile), required = profile.fields.find(field => field.required)!;

  it('holds this template\'s creative definition and derives every ratio\'s prompt from it', () => {
    const start = initialFormFor(profile);
    expect(start).toEqual({ values: profile.defaults, editedPrompt: null, ratios: ['1:1', '16:9', '4:5'] });
    // Only this template's fields: nothing of Template A's form.
    expect(Object.keys(start.values)).toEqual(profile.fields.map(field => field.key));
    for (const foreign of ['subject', 'heldObject', 'frameShape', 'frameBorder', 'innerBackdrop', 'outerBackground']) expect(start.values).not.toHaveProperty(foreign);
    const resolved = resolvedCreativeFor(profile, start);
    expect(resolved).toMatchObject({ builtPrompt: BASE, basePrompt: BASE, promptEdited: false, errors: [] });
    expect(resolved.prompts).toEqual({ '1:1': `${BASE} ${profile.consistency} ${profile.framing['1:1']}`, '16:9': `${BASE} ${profile.consistency} ${profile.framing['16:9']}`, '4:5': `${BASE} ${profile.consistency} ${profile.framing['4:5']}` });
    const changed = reducer(start, { type: 'field', key: 'background', value: 'plain white seamless backdrop' });
    expect(Object.values(resolvedCreativeFor(profile, changed).prompts!).every(prompt => prompt.includes('Background: plain white seamless backdrop,') && prompt.includes(profile.consistency))).toBe(true);
    const broken = reducer(start, { type: 'field', key: required.key, value: '' });
    expect(resolvedCreativeFor(profile, broken)).toMatchObject({ errors: [`${required.label} is required: it is part of the ${profile.name} structure.`] });
    expect(resolvedCreativeFor(profile, broken).prompts).toBeUndefined();
    // A field of another template typed into this form is an error, never part of the prompt.
    expect(resolvedCreativeFor(profile, reducer(start, { type: 'field', key: 'heldObject', value: 'smartphone' })).errors).toEqual(['Unknown field "heldObject".']);
  });

  it('sends an edited shared prompt only when it differs, and loads an earlier creative of this template back', () => {
    const edited = reducer(initialFormFor(profile), { type: 'editPrompt', value: `${BASE}\nOvercast daylight.` });
    expect(creationRequestFor(profile, edited)).toEqual({ fields: profile.defaults, basePrompt: `${BASE} Overcast daylight.`, aspectRatios: ['1:1', '16:9', '4:5'] });
    expect(creationRequestFor(profile, reducer(initialFormFor(profile), { type: 'editPrompt', value: BASE }))).toEqual({ fields: profile.defaults, aspectRatios: ['1:1', '16:9', '4:5'] });
    const earlier = { ...profile.defaults, background: 'pale mint wall' };
    const loaded = reducer(reducer(edited, { type: 'ratio', ratio: '16:9', on: false }), { type: 'load', group: { fields: earlier, basePrompt: 'ignored', promptEdited: false } });
    expect(loaded).toEqual({ values: earlier, editedPrompt: null, ratios: ['1:1', '4:5'] });
  });

  it('talks to this template\'s endpoints only, and never sends a final prompt', async () => {
    const requests: { url: string; method?: string; body?: unknown }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, method: init?.method, ...(init?.body ? { body: JSON.parse(init.body as string) } : {}) });
      return new Response(JSON.stringify({ id: 'g1', variants: [], groups: [] }), { status: 200 });
    }));
    const api = generationApiFor(profile.templateKey), at = `/api/layerize-experiment/${profile.templateKey}`, entry = ENTRIES[profile.templateKey];
    const request = decomposeRequestFor(decompositionControlsFor(profile.templateKey, entry, bare), { [entry.options![0].key]: true })!;
    await api.info(); await api.list(); await api.get('g1');
    await api.create(creationRequestFor(profile, initialFormFor(profile)));
    await api.generateVariant('g1', '16x9');
    await api.decompose('g1', '4x5', request);
    expect(requests).toEqual([
      { url: `${at}/generator`, method: undefined }, { url: `${at}/groups`, method: undefined }, { url: `${at}/groups/g1`, method: undefined },
      { url: `${at}/groups`, method: 'POST', body: { fields: profile.defaults, aspectRatios: ['1:1', '16:9', '4:5'] } },
      { url: `${at}/groups/g1/variants/16x9/generate`, method: 'POST' },
      { url: `${at}/groups/g1/variants/4x5/decompose`, method: 'POST', body: { templateOptions: { ...Object.fromEntries(entry.options!.map(option => [option.key, false])), [entry.options![0].key]: true } } },
    ]);
    expect(JSON.stringify(requests)).not.toMatch(/"prompt"|separateHeldObject|template-a/);
    expect(variantImageUrlFor(profile.templateKey)('g1', '1x1')).toBe(`${at}/groups/g1/variants/1x1/image`);
  });
});

describe('decomposition controls of a generated variant: each template\'s own, never another\'s', () => {
  it('fixes per template which kind of control it has', () => {
    expect(GENERATION_DECOMPOSITION).toEqual({ 'template-a': 'held-object', 'template-b': 'declared-options', 'template-c': 'declared-options' });
    expect(Object.keys(GENERATION_PROFILES)).toEqual([...GENERATION_TEMPLATE_KEYS]);
  });

  it('Template A shows its held-object checkbox and nothing else', () => {
    const controls = decompositionControlsFor('template-a', A_ENTRY, withObject);
    expect(controls).toEqual({ kind: 'held-object', label: 'Separate held object from subject', hasObject: true });
    expect(decompositionControlsFor('template-a', A_ENTRY, { structure: { visibleBorder: true, heldObject: false } })).toMatchObject({ kind: 'held-object', hasObject: false });
    // Works before the template list has loaded, as it always did.
    expect(decompositionControlsFor('template-a', undefined, withObject)).toEqual(controls);
    // Even handed another template's entry, Template A never shows that template's options.
    for (const wrong of [B_ENTRY, C_ENTRY]) expect(decompositionControlsFor('template-a', wrong, withObject).kind).toBe('held-object');
    expect(labels(controls).join(' ')).not.toMatch(/touching|people|panels/i);
  });

  it('Template B shows its touching-objects option, and never "Separate held object"', () => {
    const controls = decompositionControlsFor('template-b', B_ENTRY, bare);
    expect(labels(controls)).toEqual(['Separate touching / overlapping independent objects']);
    expect(labels(controls).join(' ')).not.toMatch(/held object|people|panels/i);
    // A Template B creative never gets the held-object checkbox: not from a stray structure, not without its entry, not from another template's entry.
    for (const [entry, group] of [[B_ENTRY, withObject], [undefined, withObject], [A_ENTRY, withObject], [C_ENTRY, bare]] as const) expect(decompositionControlsFor('template-b', entry, group).kind).not.toBe('held-object');
    expect([decompositionControlsFor('template-b', undefined, bare), decompositionControlsFor('template-b', A_ENTRY, bare), decompositionControlsFor('template-b', C_ENTRY, bare)]).toEqual([{ kind: 'unavailable' }, { kind: 'unavailable' }, { kind: 'unavailable' }]);
  });

  it('Template C shows its people and panel options, not Template A\'s or Template B\'s control', () => {
    const controls = decompositionControlsFor('template-c', C_ENTRY, bare);
    expect(labels(controls)).toEqual(['Separate individual people / human subjects', 'Separate repeated subject / showcase panels']);
    expect(labels(controls).join(' ')).not.toMatch(/held object|touching/i);
    expect(decompositionControlsFor('template-c', B_ENTRY, bare)).toEqual({ kind: 'unavailable' });
    expect(decompositionControlsFor('template-c', undefined, withObject)).toEqual({ kind: 'unavailable' });
  });

  it('sends only the settings of the variant\'s own template', () => {
    const a = decompositionControlsFor('template-a', A_ENTRY, withObject), b = decompositionControlsFor('template-b', B_ENTRY, bare), c = decompositionControlsFor('template-c', C_ENTRY, bare);
    // Template A: separate unless unticked, and combined when the creative has no object.
    expect([decomposeRequestFor(a), decomposeRequestFor(a, { [HELD_OBJECT_CHOICE]: false })]).toEqual([{ separateHeldObject: true }, { separateHeldObject: false }]);
    expect(decomposeRequestFor(decompositionControlsFor('template-a', A_ENTRY, bare), { [HELD_OBJECT_CHOICE]: true })).toEqual({ separateHeldObject: false });
    // Templates B and C: every declared option, at its default unless chosen.
    expect([decomposeRequestFor(b), decomposeRequestFor(b, { separateTouchingIndependentObjects: true })]).toEqual([{ templateOptions: { separateTouchingIndependentObjects: false } }, { templateOptions: { separateTouchingIndependentObjects: true } }]);
    expect(decomposeRequestFor(c, { separateRepeatedModules: true })).toEqual({ templateOptions: { separateHumanSubjects: false, separateRepeatedModules: true } });
    // A choice made for another template's control is not carried into the request.
    expect(decomposeRequestFor(a, { separateTouchingIndependentObjects: true, separateHumanSubjects: true })).toEqual({ separateHeldObject: true });
    expect(decomposeRequestFor(b, { [HELD_OBJECT_CHOICE]: true, separateHumanSubjects: true })).toEqual({ templateOptions: { separateTouchingIndependentObjects: false } });
    expect(decomposeRequestFor(c, { [HELD_OBJECT_CHOICE]: true, separateTouchingIndependentObjects: true })).toEqual({ templateOptions: { separateHumanSubjects: false, separateRepeatedModules: false } });
    // Options that are not known cannot be guessed: nothing is sent.
    expect(decomposeRequestFor({ kind: 'unavailable' })).toBeUndefined();
  });

  it('names an earlier decomposition by the settings of its own template', () => {
    expect(decompositionLabel({ runId: 'r', createdAt: '', separateHeldObject: true, targetLayers: 6 }, A_ENTRY)).toBe('held object separate, target 6');
    expect(decompositionLabel({ runId: 'r', createdAt: '', separateHeldObject: false, targetLayers: 5 })).toBe('combined, target 5');
    expect(decompositionLabel({ runId: 'r', createdAt: '', templateOptions: { separateTouchingIndependentObjects: true } }, B_ENTRY)).toBe('Separate touching / overlapping independent objects: on');
    expect(decompositionLabel({ runId: 'r', createdAt: '', templateOptions: { separateHumanSubjects: true, separateRepeatedModules: false }, targetLayers: 4 }, C_ENTRY))
      .toBe('Separate individual people / human subjects: on, Separate repeated subject / showcase panels: off, target 4');
    expect(decompositionLabel({ runId: 'r', createdAt: '', templateOptions: { separateTouchingIndependentObjects: true } })).toBe('template options');
  });
});

describe('Template A through the shared form is the Template A form', () => {
  it('starts from Template A\'s fields and builds Template A\'s prompts', () => {
    const form = initialFormFor(templateAGenerationProfile), base = templateAGenerationProfile.buildBasePrompt(templateAGenerationProfile.defaults);
    expect(Object.keys(form.values)).toEqual(['subject', 'subjectDetails', 'composition', 'heldObject', 'pose', 'expression', 'outfit', 'innerBackdrop', 'frameShape', 'frameBorder', 'outerBackground', 'lighting', 'extraNotes']);
    expect(resolvedCreativeFor(templateAGenerationProfile, form).prompts!['16:9']).toBe(`${base} ${templateAGenerationProfile.consistency} ${templateAGenerationProfile.framing['16:9']}`);
    // Template C's repeated-panel and Template B's hero fields are not Template A fields.
    const reducer = generatorReducerFor(templateAGenerationProfile);
    for (const foreign of ['repeatedPanels', 'promoModule', 'heroProduct', 'secondaryObjects']) expect(resolvedCreativeFor(templateAGenerationProfile, reducer(form, { type: 'field', key: foreign, value: 'three panels' })).errors).toEqual([`Unknown field "${foreign}".`]);
  });
});
