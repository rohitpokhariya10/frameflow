import { afterEach, expect, it, vi } from 'vitest';
import { buildTemplateAPrompt, TEMPLATE_A_CONSISTENCY, TEMPLATE_A_DEFAULTS, TEMPLATE_A_RATIO_FRAMING } from '@frameflow/shared';
import { creationRequest, generationApi, generatorReducer, initialForm, isUnderway, resolvedCreative, variantImageUrl } from './templateAGeneration';

afterEach(() => { vi.unstubAllGlobals(); });
const BASE = buildTemplateAPrompt(TEMPLATE_A_DEFAULTS);

it('the form holds one creative definition and the ratios to generate; every ratio\'s prompt is derived from it', () => {
  const start = initialForm();
  expect(start).toEqual({ values: TEMPLATE_A_DEFAULTS, editedPrompt: null, ratios: ['1:1', '16:9', '4:5'] });
  const resolved = resolvedCreative(start);
  expect(resolved).toMatchObject({ builtPrompt: BASE, basePrompt: BASE, promptEdited: false, errors: [] });
  // The same base and consistency sentence in all three; only the framing sentence differs.
  expect(resolved.prompts).toEqual({ '1:1': `${BASE} ${TEMPLATE_A_CONSISTENCY} ${TEMPLATE_A_RATIO_FRAMING['1:1']}`, '16:9': `${BASE} ${TEMPLATE_A_CONSISTENCY} ${TEMPLATE_A_RATIO_FRAMING['16:9']}`, '4:5': `${BASE} ${TEMPLATE_A_CONSISTENCY} ${TEMPLATE_A_RATIO_FRAMING['4:5']}` });
  const boy = generatorReducer(start, { type: 'field', key: 'subject', value: 'boy' });
  const boyBase = buildTemplateAPrompt({ ...TEMPLATE_A_DEFAULTS, subject: 'boy' });
  expect(Object.values(resolvedCreative(boy).prompts!).every(prompt => prompt.startsWith(`${boyBase} `))).toBe(true);
  // Nothing in the reducer can set a ratio's final prompt.
  expect(Object.keys(boy)).toEqual(['values', 'editedPrompt', 'ratios']);
  const broken = generatorReducer(start, { type: 'field', key: 'outerBackground', value: '' });
  expect(resolvedCreative(broken)).toMatchObject({ errors: ['Outer background is required: it is part of the Template A structure.'] });
  expect(resolvedCreative(broken).prompts).toBeUndefined();
});

it('an edited shared prompt is used for every ratio alike, is sent only when it differs, and can be discarded', () => {
  const edited = generatorReducer(initialForm(), { type: 'editPrompt', value: `${BASE}\nWarm evening light.` });
  const resolved = resolvedCreative(edited);
  expect(resolved).toMatchObject({ builtPrompt: BASE, basePrompt: `${BASE} Warm evening light.`, promptEdited: true, errors: [] });
  expect(Object.values(resolved.prompts!).every(prompt => prompt.startsWith(`${BASE} Warm evening light. ${TEMPLATE_A_CONSISTENCY} `))).toBe(true);
  expect(creationRequest(edited)).toEqual({ fields: TEMPLATE_A_DEFAULTS, basePrompt: `${BASE} Warm evening light.`, aspectRatios: ['1:1', '16:9', '4:5'] });
  // Opened for editing but left as built: not an edit, nothing extra is sent.
  expect(creationRequest(generatorReducer(initialForm(), { type: 'editPrompt', value: BASE }))).toEqual({ fields: TEMPLATE_A_DEFAULTS, aspectRatios: ['1:1', '16:9', '4:5'] });
  // While edited, the fields no longer change the prompt; discarding the edit goes back to the fields.
  const thenField = generatorReducer(edited, { type: 'field', key: 'subject', value: 'boy' });
  expect(resolvedCreative(thenField).basePrompt).toBe(`${BASE} Warm evening light.`);
  expect(resolvedCreative(generatorReducer(thenField, { type: 'editPrompt', value: null })).basePrompt).toBe(buildTemplateAPrompt({ ...TEMPLATE_A_DEFAULTS, subject: 'boy' }));
  expect(resolvedCreative(generatorReducer(initialForm(), { type: 'editPrompt', value: 'Too short' })).errors).toEqual(['The edited prompt is too short to describe the creative.']);
});

it('chooses which ratios to generate now, always in the fixed order, and loads an earlier creative back into the form', () => {
  let form = generatorReducer(initialForm(), { type: 'ratio', ratio: '1:1', on: false });
  form = generatorReducer(form, { type: 'ratio', ratio: '4:5', on: false });
  expect(form.ratios).toEqual(['16:9']);
  form = generatorReducer(form, { type: 'ratio', ratio: '1:1', on: true });
  expect(form.ratios).toEqual(['1:1', '16:9']);
  expect(creationRequest(form).aspectRatios).toEqual(['1:1', '16:9']);
  // An earlier creative: its fields (older ones may lack newer fields: they take defaults), and its prompt only if it was edited.
  const dog = { ...TEMPLATE_A_DEFAULTS, subject: 'golden retriever dog', outfit: '' };
  expect(generatorReducer(form, { type: 'load', group: { fields: dog, basePrompt: 'ignored', promptEdited: false } })).toEqual({ values: dog, editedPrompt: null, ratios: ['1:1', '16:9'] });
  expect(generatorReducer(form, { type: 'load', group: { fields: dog, basePrompt: 'A hand-written description of the creative.', promptEdited: true } }).editedPrompt).toBe('A hand-written description of the creative.');
  expect([isUnderway({ status: 'queued' }), isUnderway({ status: 'generating' }), isUnderway({ status: 'pending' }), isUnderway({ status: 'done' }), isUnderway({ status: 'failed' })]).toEqual([true, true, false, false, false]);
});

it('sends only the creative definition to create, names the group and variant to generate or decompose, and never a final prompt', async () => {
  const requests: { url: string; method?: string; body?: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, method: init?.method, ...(init?.body ? { body: JSON.parse(init.body as string) } : {}) });
    return new Response(JSON.stringify(url.endsWith('/decompose') ? { id: 'run-1' } : { id: 'g1', variants: [] }), { status: 202 });
  }));
  const form = generatorReducer(initialForm(), { type: 'field', key: 'subject', value: 'older man' });
  const before = structuredClone(form);
  await generationApi.create(creationRequest(form));
  await generationApi.generateVariant('g1', '16x9');
  await generationApi.decompose('g1', '4x5', { separateHeldObject: false });
  expect(form).toEqual(before);
  expect(requests).toEqual([
    { url: '/api/layerize-experiment/template-a/groups', method: 'POST', body: { fields: form.values, aspectRatios: ['1:1', '16:9', '4:5'] } },
    { url: '/api/layerize-experiment/template-a/groups/g1/variants/16x9/generate', method: 'POST' },
    { url: '/api/layerize-experiment/template-a/groups/g1/variants/4x5/decompose', method: 'POST', body: { separateHeldObject: false } },
  ]);
  expect(JSON.stringify(requests)).not.toMatch(/"prompt"|generator|cloudflare|gemini/i);
  expect(variantImageUrl('g1', '1x1')).toBe('/api/layerize-experiment/template-a/groups/g1/variants/1x1/image');
});
