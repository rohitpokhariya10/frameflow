import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildTemplateAPrompt, buildTemplateAVariantPrompt, TEMPLATE_A_DEFAULTS, TEMPLATE_A_RATIO_FRAMING, templateBGenerationProfile, templateCGenerationProfile, type GenerationProfile, type GenerationTemplateKey } from '@frameflow/shared';
import type { FalTransport } from './providers/falClient.js';
import { DEFAULT_IMAGE_MODEL } from './aiModels.js';
import { createGenerationGroup, generationsDirFor, readGroup, type GenerationConfig, type GenerationGroup, type GenerationHandoff } from './generationGroups.js';
import { readRun, type RunnerDeps } from './layerizeExperiment.js';
import { createOpenAIPlanner, PLANNER_INSTRUCTION } from './layerizePlanner.js';
import { createLayerizeRouter } from './layerizeRouter.js';
import { PLAN_SCHEMA_B, PLANNER_INSTRUCTION_B, SEPARATE_TOUCHING, TEMPLATE_B_OPTIONS } from './layerizeTemplateB.js';
import { PLAN_SCHEMA_C, PLANNER_INSTRUCTION_C, SEPARATE_MODULES, SEPARATE_PEOPLE, TEMPLATE_C_OPTIONS } from './layerizeTemplateC.js';
import { listTemplates, type TemplateOption } from './layerizeTemplates.js';
import { templateAHandoff } from './templateAGeneration.js';
import { templateBHandoff } from './templateBGeneration.js';
import { templateCHandoff } from './templateCGeneration.js';

// 14. Every provider here is a fake: no OpenAI, fal or Seedream request is made by this file. To make sure of it, any
// request that leaves this machine fails the test that made it: fetch reaches this test's own local server and nothing else.
const realFetch = globalThis.fetch, outside: string[] = [];
beforeAll(() => {
  vi.stubEnv('OPENAI_API_KEY', ''); vi.stubEnv('FAL_KEY', '');
  vi.stubGlobal('fetch', (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('http://127.0.0.1:')) { outside.push(url); throw new Error(`A test tried to reach ${url}.`); }
    return realFetch(input, init);
  });
});
afterEach(() => { expect(outside).toEqual([]); });
afterAll(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const png = (width: number, height: number, color = '#2f6b2f') => sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
const root = () => mkdtempSync(join(tmpdir(), 'generations-'));
const statuses = (group: GenerationGroup) => Object.fromEntries(group.variants.map(variant => [variant.id, variant.status]));
type ImageRequest = { model: string; prompt: string; size: string; n: number; output_format: string };
/** A fake OpenAI images client: records each request and returns one PNG of the requested size, never two at a time unnoticed. */
function imageFake() {
  const sent: Buffer[] = [];
  let active = 0, mostAtOnce = 0;
  const generate = vi.fn(async (request: ImageRequest): Promise<unknown> => {
    mostAtOnce = Math.max(mostAtOnce, ++active);
    await new Promise(done => setTimeout(done, 2));
    const [width, height] = request.size.split('x').map(Number), bytes = await png(width, height, ['#2f6b2f', '#6b2f2f', '#2f2f6b', '#6b6b2f'][sent.length % 4]);
    sent.push(bytes); active--;
    return Object.defineProperty({ created: 1, output_format: 'png', size: request.size, data: [{ b64_json: bytes.toString('base64') }] }, '_request_id', { value: `req_img_${sent.length}` });
  });
  return { generate, sent, mostAtOnce: () => mostAtOnce, config: { model: DEFAULT_IMAGE_MODEL, client: () => ({ images: { generate } }) as unknown as ReturnType<GenerationConfig['client']> } satisfies GenerationConfig };
}
const apiError = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code, requestID: 'req_img_err', error: { message, code, type: 'server_error' } });

type PlannerRequest = { instructions: string; input: { content: [{ text: string }, { image_url: string }] }[]; text: { format: { schema: unknown } } };
/** What the fake OpenAI planner answers: a plan in the shape of whichever template's schema it was asked for. */
const A_LIST = 'Keep the main subject whole. Separate each held object into its own layer.';
const B_LIST = 'Extract the hero object as one layer, including the parts that belong to it. Extract the surrounding objects together as one layer.';
const C_FACTS = { people: [{ id: 'p1', phrase: 'person on the left', includes: '', grouped_with: ['p2'] }, { id: 'p2', phrase: 'person on the right', includes: '', grouped_with: ['p1'] }], repeated_modules: null,
  elements: [{ phrase: 'rounded offer card', role: 'promo_module', includes: '' }] };
const planFor = (request: PlannerRequest) => request.text.format.schema === PLAN_SCHEMA_C ? { prompt: 'draft', planned_layers: [], warnings: [], ...C_FACTS }
  : { prompt: request.text.format.schema === PLAN_SCHEMA_B ? B_LIST : A_LIST, planned_layers: [], warnings: [] };

const LENGTH_NOTE = 'Keep "prompt" under 400 characters.';
/** Everything that differs between the two templates under test: their own profile, handoff, options and decomposition planner. */
type Case = { key: GenerationTemplateKey; handoff: GenerationHandoff; profile: GenerationProfile; options: TemplateOption[]; instruction: string; schema: unknown;
  /** The run settings line its own planner is given, for each choice of its options. */
  settings: [Record<string, boolean>, Record<string, boolean>, string][]; foreignOptions: string[]; changed: Record<string, string> };
const B: Case = { key: 'template-b', handoff: templateBHandoff, profile: templateBGenerationProfile, options: TEMPLATE_B_OPTIONS, instruction: PLANNER_INSTRUCTION_B, schema: PLAN_SCHEMA_B,
  settings: [
    [{}, { [SEPARATE_TOUCHING]: false }, 'Run setting: separate touching / overlapping independent objects: no.'],
    [{ [SEPARATE_TOUCHING]: true }, { [SEPARATE_TOUCHING]: true }, 'Run setting: separate touching / overlapping independent objects: yes.'],
  ], foreignOptions: [SEPARATE_PEOPLE, SEPARATE_MODULES, 'separateHeldObject'], changed: { background: 'dark slate wall' } };
const C: Case = { key: 'template-c', handoff: templateCHandoff, profile: templateCGenerationProfile, options: TEMPLATE_C_OPTIONS, instruction: PLANNER_INSTRUCTION_C, schema: PLAN_SCHEMA_C,
  settings: [
    [{}, { [SEPARATE_PEOPLE]: false, [SEPARATE_MODULES]: false }, 'separate individual people: no; separate repeated panels: no.'],
    [{ [SEPARATE_PEOPLE]: true }, { [SEPARATE_PEOPLE]: true, [SEPARATE_MODULES]: false }, 'separate individual people: yes; separate repeated panels: no.'],
    [{ [SEPARATE_MODULES]: true }, { [SEPARATE_PEOPLE]: false, [SEPARATE_MODULES]: true }, 'separate individual people: no; separate repeated panels: yes.'],
    [{ [SEPARATE_PEOPLE]: true, [SEPARATE_MODULES]: true }, { [SEPARATE_PEOPLE]: true, [SEPARATE_MODULES]: true }, 'separate individual people: yes; separate repeated panels: yes.'],
  ], foreignOptions: [SEPARATE_TOUCHING, 'separateHeldObject'], changed: { background: 'deep navy curtain' } };

/** The experiment router with every provider faked: the three generators, and decomposition up to a finished run. */
async function server(openai = imageFake()) {
  const runsDir = mkdtempSync(join(tmpdir(), 'layerize-')), dirs: Record<GenerationTemplateKey, string> = { 'template-a': root(), 'template-b': root(), 'template-c': root() };
  const base = await png(64, 64, '#010203'), uploads: Buffer[] = [], submitted: Record<string, unknown>[] = [];
  const create = vi.fn(async (request: PlannerRequest) => ({ status: 'completed', output: [], output_text: JSON.stringify(planFor(request)) }));
  const planner = createOpenAIPlanner({ client: { responses: { create } } as never });
  const transport: FalTransport = { upload: async (image) => { uploads.push(image as Buffer); return 'https://v3b.fal.media/files/t/in.png'; }, submit: async (_endpoint, input) => { submitted.push(input); return { requestId: 'r' }; }, status: async () => 'COMPLETED',
    result: async () => ({ layers: [{ image: { url: 'https://v3b.fal.media/files/t/b.png' }, z_index: 0 }] }), cancel: async () => undefined, download: async () => base };
  const deps = (): RunnerDeps => ({ planner, transport: () => transport, sleep: async () => undefined });
  const app = express().use('/x', createLayerizeRouter({ runsDir, deps, generationsDir: dirs['template-a'], generationDirs: { 'template-b': dirs['template-b'], 'template-c': dirs['template-c'] }, generation: () => openai.config })).listen(0, '127.0.0.1');
  await new Promise(done => app.once('listening', done));
  const { port } = app.address() as AddressInfo;
  const url = (path: string) => `http://127.0.0.1:${port}/x${path}`;
  const get = async (path: string) => { const r = await fetch(url(path)); return { status: r.status, body: await r.json() }; };
  const post = async (path: string, body: unknown = {}) => { const r = await fetch(url(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const idle = async () => { for (let i = 0; i < 300 && (await get('/runs')).body.active; i++) await new Promise(done => setTimeout(done, 20)); };
  /** Waits until no variant of the group is queued or generating, and returns the group. */
  const settled = async (key: GenerationTemplateKey, id: string): Promise<GenerationGroup> => {
    for (let i = 0; i < 400; i++) {
      const group = (await get(`/${key}/groups/${id}`)).body as GenerationGroup;
      if (!group.variants.some(variant => variant.status === 'queued' || variant.status === 'generating')) return group;
      await new Promise(done => setTimeout(done, 10));
    }
    throw new Error('The group never settled.');
  };
  const generate = async (key: GenerationTemplateKey, body: Record<string, unknown> = { fields: {} }) => settled(key, ((await post(`/${key}/groups`, body)).body as GenerationGroup).id);
  /** The last request the decomposition planner was sent. */
  const planned = () => create.mock.calls.at(-1)![0];
  return { app, url, get, post, idle, settled, generate, planned, create, runsDir, dirs, uploads, submitted, openai };
}

describe.each([B, C])('$profile.name test generator (one creative → three aspect-ratio variants → its own decomposition)', (t) => {
  const { key, profile } = t, BASE = profile.buildBasePrompt(profile.defaults);

  it('creates a group without sending anything: its own creative definition once, and a pending variant per ratio', () => {
    const dir = root(), openai = imageFake();
    const { group, requested } = createGenerationGroup(dir, t.handoff, { fields: {} }, openai.config);
    expect(openai.generate).not.toHaveBeenCalled();
    expect(requested).toEqual(['1x1', '16x9', '4x5']);
    expect(group).toMatchObject({ templateKey: key, version: profile.version, fields: profile.defaults, builtPrompt: BASE, basePrompt: BASE, promptEdited: false, aspectRatios: ['1:1', '16:9', '4:5'] });
    // Template A's structure facts (border, held object) are Template A's: this template's records have none.
    expect(group).not.toHaveProperty('structure');
    // 5–6. One shared definition; three variants that stay in one group and differ in their framing sentence only.
    expect(group.variants.map(variant => [variant.id, variant.aspectRatio, variant.size, variant.status, variant.attempts])).toEqual([
      ['1x1', '1:1', { width: 1024, height: 1024 }, 'pending', 0], ['16x9', '16:9', { width: 1536, height: 864 }, 'pending', 0], ['4x5', '4:5', { width: 1216, height: 1520 }, 'pending', 0]]);
    for (const variant of group.variants) {
      expect(variant.prompt).toBe(`${BASE} ${profile.consistency} ${variant.framing}`);
      expect(variant.framing).toBe(profile.framing[variant.aspectRatio as keyof typeof profile.framing]);
      expect(variant.generator).toEqual({ provider: 'openai', model: DEFAULT_IMAGE_MODEL });
    }
    expect(readGroup(dir, group.id)).toEqual(group);
    expect(readdirSync(join(dir, group.id))).toEqual(['group.json']);
    // Its creatives have their own folder, apart from the other templates'.
    expect(generationsDirFor(key).endsWith(`artifacts/decomposition/${key}-generations`)).toBe(true);
  });

  it('1–2. serves its own fields and wording, and accepts only its own creative definition', async () => {
    const s = await server();
    try {
      const info = (await s.get(`/${key}/generator`)).body;
      expect(info).toMatchObject({ templateKey: key, name: profile.name, version: profile.version, family: profile.family, skeleton: profile.skeleton, defaults: profile.defaults, consistency: profile.consistency, framing: profile.framing,
        aspectRatios: ['1:1', '16:9', '4:5'], promptLimits: { base: 2000, final: 3000 }, generator: { provider: 'openai', model: DEFAULT_IMAGE_MODEL } });
      expect(info.fields).toEqual(profile.fields);
      // Nothing of Template A's form is served for this template.
      expect(JSON.stringify(info)).not.toMatch(/heldObject|frameShape|frameBorder|innerBackdrop|outerBackground|Held \/ featured object/);
      // Another template's creative, or a ready-made final prompt, is refused; nothing is stored or sent.
      for (const other of [templateAHandoff, templateBHandoff, templateCHandoff].filter(item => item.profile.templateKey !== key))
        expect(await s.post(`/${key}/groups`, { fields: other.profile.defaults })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_FIELDS' } } });
      expect(await s.post(`/${key}/groups`, { fields: {}, prompt: 'anything' })).toMatchObject({ status: 400, body: { error: { code: 'PROMPT_NOT_ACCEPTED' } } });
      expect(await s.post(`/${key}/groups`, { fields: {}, aspectRatios: ['9:16'] })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_ASPECT_RATIO' } } });
      expect((await s.get(`/${key}/groups`)).body).toEqual({ groups: [] });
      expect(s.openai.generate).not.toHaveBeenCalled();
    } finally { s.app.close(); }
  });

  it('6–8. generates the three ratios as one group; one failing leaves the others, and only the failed one is generated again', async () => {
    const s = await server();
    try {
      // The 16:9 request fails; the two others succeed.
      s.openai.generate.mockImplementationOnce(s.openai.generate.getMockImplementation()!).mockRejectedValueOnce(apiError(500, 'server_error', 'The server had an error.'));
      const started = await s.post(`/${key}/groups`, { fields: {} });
      expect(started.status).toBe(202);
      const group = await s.settled(key, (started.body as GenerationGroup).id);
      expect(statuses(group)).toEqual({ '1x1': 'done', '16x9': 'failed', '4x5': 'done' });
      expect(group.variants[1]).toMatchObject({ attempts: 1, error: { status: 500 } });
      expect(group.variants[1].image).toBeUndefined();
      // Exactly the template's own prompts were sent, each at its own size; a failed request is never resent by itself.
      expect(s.openai.generate.mock.calls.map(([request]) => [request.size, request.prompt, request.model])).toEqual(group.variants.map(variant => [`${variant.size.width}x${variant.size.height}`, variant.prompt, DEFAULT_IMAGE_MODEL]));
      const images = [group.variants[0].image, group.variants[2].image];
      // 10. Generate only the failed ratio again: one request; its siblings and the shared definition are untouched.
      expect((await s.post(`/${key}/groups/${group.id}/variants/16x9/generate`)).status).toBe(202);
      const again = await s.settled(key, group.id);
      expect(statuses(again)).toEqual({ '1x1': 'done', '16x9': 'done', '4x5': 'done' });
      expect(again.variants[1]).toMatchObject({ attempts: 2, image: { width: 1536, height: 864 } });
      expect(again.variants[1].error).toBeUndefined();
      expect([again.variants[0].image, again.variants[2].image]).toEqual(images);
      expect({ fields: again.fields, basePrompt: again.basePrompt, createdAt: again.createdAt }).toEqual({ fields: group.fields, basePrompt: group.basePrompt, createdAt: group.createdAt });
      expect(s.openai.generate).toHaveBeenCalledTimes(4);
      // A finished variant is never generated again.
      expect(await s.post(`/${key}/groups/${group.id}/variants/1x1/generate`)).toMatchObject({ status: 400, body: { error: { code: 'ALREADY_GENERATED' } } });
      expect(s.openai.generate).toHaveBeenCalledTimes(4);
      // Generating is OpenAI images only: no planner request, nothing to fal.
      expect(s.create).not.toHaveBeenCalled();
      expect(s.submitted).toEqual([]);
      // The group's files are in this template's folder and in no other's.
      expect(readdirSync(s.dirs[key])).toEqual([group.id]);
      for (const other of (['template-a', 'template-b', 'template-c'] as const).filter(item => item !== key)) expect(readdirSync(s.dirs[other])).toEqual([]);
    } finally { s.app.close(); }
  });

  it('9, 15. decomposes exactly one variant through its own template, with its own options, linked both ways', async () => {
    const s = await server();
    try {
      const group = await s.generate(key);
      const runs: string[] = [];
      for (const [chosen, effective, line] of t.settings) {
        const started = await s.post(`/${key}/groups/${group.id}/variants/16x9/decompose`, Object.keys(chosen).length ? { templateOptions: chosen } : {});
        expect(started).toMatchObject({ status: 202, body: { templateKey: key, templateOptions: effective, layerTarget: { templateKey: key },
          origin: { kind: `${key}-generation`, generationId: group.id, variantId: '16x9', aspectRatio: '16:9' } } });
        // Template A's held-object mode is not part of this template's run.
        expect(started.body).not.toHaveProperty('separateHeldObject');
        await s.idle();
        runs.push(started.body.id);
        const saved = readRun(join(s.runsDir, started.body.id));
        expect(saved).toMatchObject({ templateKey: key, templateOptions: effective, original: { width: 1536, height: 864 }, origin: { kind: `${key}-generation`, generationId: group.id, variantId: '16x9', aspectRatio: '16:9' } });
        // Its own decomposition planner was asked: its instruction, its schema, its options in its own words.
        const request = s.planned();
        expect(request.instructions).toBe(`${t.instruction}\n\n${LENGTH_NOTE}`);
        expect(request.text.format.schema).toBe(t.schema);
        expect(request.input[0].content[0].text.endsWith(line)).toBe(true);
        expect(request.input[0].content[0].text).not.toMatch(/held object/i);
        // Exactly the generated bytes of the 16:9 variant went to the planner and to fal.
        expect(sha(Buffer.from(request.input[0].content[1].image_url.split(',')[1], 'base64'))).toBe(sha(s.openai.sent[1]));
        expect(sha(s.uploads.at(-1)!)).toBe(sha(s.openai.sent[1]));
      }
      expect(s.create).toHaveBeenCalledTimes(t.settings.length);
      expect(s.submitted).toHaveLength(t.settings.length);
      // 11–12. Only the decomposed variant carries the runs, each with the options it was made with; the image model was not called again.
      const after = (await s.get(`/${key}/groups/${group.id}`)).body as GenerationGroup;
      expect(after.variants.map(variant => variant.decompositions.map(item => [item.runId, item.templateOptions, 'separateHeldObject' in item]))).toEqual([[], t.settings.map(([, effective], index) => [runs[index], effective, false]), []]);
      expect(s.openai.generate).toHaveBeenCalledTimes(3);
      // A ratio without an image has nothing to decompose.
      const partial = await s.generate(key, { fields: t.changed, aspectRatios: ['4:5'] });
      expect(await s.post(`/${key}/groups/${partial.id}/variants/1x1/decompose`)).toMatchObject({ status: 400, body: { error: { code: 'NOT_DECOMPOSABLE' } } });
      expect(await s.post(`/${key}/groups/${partial.id}/variants/9x16/decompose`)).toMatchObject({ status: 404 });
    } finally { s.app.close(); }
  });

  it('10–11. takes only its own decomposition options: another template\'s option or mode is refused and starts nothing', async () => {
    const s = await server();
    try {
      const group = await s.generate(key, { fields: {}, aspectRatios: ['1:1'] });
      const decompose = (body: unknown) => s.post(`/${key}/groups/${group.id}/variants/1x1/decompose`, body);
      // Template A's held-object mode is not a setting of this template.
      for (const value of [true, false]) expect(await decompose({ separateHeldObject: value })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_REQUEST', message: expect.stringContaining(`${profile.name} has no decomposition setting "separateHeldObject"`) } } });
      // Another template's option is not an option of this template.
      for (const foreign of t.foreignOptions) expect(await decompose({ templateOptions: { [foreign]: true } })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_TEMPLATE_OPTIONS', message: expect.stringContaining(`${profile.name} has no option "${foreign}"`) } } });
      expect(await decompose({ templateOptions: { [t.options[0].key]: 'yes' } })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_TEMPLATE_OPTIONS' } } });
      expect(await decompose({ templateOptions: [] })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_TEMPLATE_OPTIONS' } } });
      expect(await decompose({ templateKey: 'template-a' })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_REQUEST' } } });
      // Nothing was planned, uploaded, submitted or recorded.
      expect(s.create).not.toHaveBeenCalled();
      expect([s.uploads, s.submitted, (await s.get('/runs')).body.runs]).toEqual([[], [], []]);
      expect(((await s.get(`/${key}/groups/${group.id}`)).body as GenerationGroup).variants[0].decompositions).toEqual([]);
      // Its options are the ones its decomposition template declares, by their exact keys.
      expect(listTemplates(s.runsDir).find(template => template.key === key)!.options).toEqual(t.options);
    } finally { s.app.close(); }
  });

  it('12–13. a changed field or an edited prompt is a new group; the earlier one is never rewritten', async () => {
    const s = await server();
    try {
      const first = await s.generate(key, { fields: {}, aspectRatios: ['1:1'] });
      const changed = await s.generate(key, { fields: t.changed, aspectRatios: ['1:1'] });
      const edited = await s.generate(key, { fields: {}, basePrompt: `${BASE} Shot on a rainy evening.`, aspectRatios: ['1:1'] });
      expect(new Set([first.id, changed.id, edited.id]).size).toBe(3);
      expect(changed.basePrompt).toContain(t.changed.background);
      // The edit is the shared base of every ratio of the new group, including the ones not generated yet.
      expect(edited).toMatchObject({ builtPrompt: BASE, basePrompt: `${BASE} Shot on a rainy evening.`, promptEdited: true });
      for (const variant of edited.variants) expect(variant.prompt).toBe(`${BASE} Shot on a rainy evening. ${profile.consistency} ${profile.framing[variant.aspectRatio as keyof typeof profile.framing]}`);
      expect(await s.post(`/${key}/groups`, { fields: {}, basePrompt: 'Too short' })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_PROMPT' } } });
      expect((await s.get(`/${key}/groups/${first.id}`)).body).toEqual(first);
      expect(((await s.get(`/${key}/groups`)).body.groups as GenerationGroup[]).map(group => group.id).sort()).toEqual([first.id, changed.id, edited.id].sort());
      expect(s.openai.generate).toHaveBeenCalledTimes(3);
    } finally { s.app.close(); }
  });
});

describe('Template B creatives (edge cases, with fakes)', () => {
  it('records what is worth knowing about a creative, and sends the prompt its fields build', async () => {
    const s = await server();
    try {
      const creatives: [Record<string, string>, RegExp, string[]][] = [
        // 1. no secondary objects, 3. with a support.
        [{}, /No other objects accompany the hero\./, []],
        // 2. repeated secondary objects; 4. some touch the hero, others do not.
        [{ secondaryObjects: 'six small spheres, two resting against the hero and four scattered apart' }, /Around the hero: six small spheres, two resting against the hero and four scattered apart\./, ['Some surrounding objects touch or overlap the hero']],
        // 5. intrinsic components.
        [{ heroProduct: 'layered dessert in a glass', heroDescription: 'three visible layers under a swirl of cream', intrinsicDetails: 'a mint leaf and a berry on top' }, /The hero includes a mint leaf and a berry on top; these are part of the hero and stay with it\./, []],
        // 6. transparent or reflective; 7. no platform; 8. another background.
        [{ material: 'clear glass', support: '', background: 'black reflective studio floor fading into darkness' }, /The hero stands on its own, with no separate platform or pedestal\. .*Background: black reflective studio floor fading into darkness,/, ['A transparent or reflective hero', 'No platform']],
      ];
      for (const [fields, sentence, notes] of creatives) {
        const group = await s.generate('template-b', { fields, aspectRatios: ['1:1'] });
        expect(group.basePrompt).toMatch(sentence);
        expect(s.openai.generate.mock.calls.at(-1)![0].prompt).toBe(group.variants[0].prompt);
        expect((group.notes ?? []).map(note => notes.find(start => note.startsWith(start)))).toEqual(notes);
      }
      // A person is not a Template B hero.
      expect(await s.post('/template-b/groups', { fields: { heroProduct: 'smiling woman' } })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_FIELDS', message: expect.stringContaining('not a person') } } });
    } finally { s.app.close(); }
  });
});

describe('Template C creatives (edge cases, with fakes)', () => {
  it('records what is worth knowing about a creative, and sends the prompt its fields build', async () => {
    const s = await server();
    try {
      const creatives: [Record<string, string>, RegExp, string[]][] = [
        // 1. two people, standing apart.
        [{}, /The people: two people standing side by side/, ['Several people: say in']],
        // 2. four people; 3. some of them paired.
        [{ primarySubjects: 'four performers in a row', relationships: 'the middle two posed together arm in arm, the outer two standing apart' }, /The people: four performers in a row\. Grouping: the middle two posed together arm in arm/, ['People who overlap or are posed together']],
        // 4. one person and an independent product showcase; 9. a badge; 10. decorative structures.
        [{ primarySubjects: 'one woman wearing a wristwatch', relationships: '', productShowcase: 'the same wristwatch on a small block', promoModule: '', decorativeStructures: 'a tall arch behind her' },
          /A product showcase, the same wristwatch on a small block, is displayed on its own.*A logo or badge, a small round badge in the top left corner.*Decorative structures: a tall arch behind her,/, []],
        // 5. one person and a promo card.
        [{ primarySubjects: 'one man in a suit', relationships: '', logoBadge: '' }, /A promotional module, a rounded offer card in the lower right corner, is an independent region/, []],
        // 6. repeated panels.
        [{ primarySubjects: 'one woman in the centre', relationships: '', promoModule: '', repeatedPanels: 'three square panels along the bottom, each showing a hand with a different bracelet' }, /The layout includes three square panels along the bottom.*form one coherent repeated set\./, ['Repeated panels: when decomposing']],
      ];
      for (const [fields, sentence, notes] of creatives) {
        const group = await s.generate('template-c', { fields, aspectRatios: ['1:1'] });
        expect(group.basePrompt).toMatch(sentence);
        expect(s.openai.generate.mock.calls.at(-1)![0].prompt).toBe(group.variants[0].prompt);
        expect((group.notes ?? []).map(note => notes.find(start => note.startsWith(start)))).toEqual(notes);
      }
    } finally { s.app.close(); }
  });
});

describe('isolation: three templates on one set of mechanics', () => {
  it('keeps each template\'s creatives under its own routes, folder and decomposition, even side by side', async () => {
    const s = await server();
    try {
      const a = await s.generate('template-a', { fields: {}, aspectRatios: ['1:1'] }), b = await s.generate('template-b', { fields: {}, aspectRatios: ['1:1'] }), c = await s.generate('template-c', { fields: {}, aspectRatios: ['1:1'] });
      const groups = { 'template-a': a, 'template-b': b, 'template-c': c };
      expect([a.templateKey, b.templateKey, c.templateKey]).toEqual(['template-a', 'template-b', 'template-c']);
      // Each used its own profile: its own version, fields and prompt wording.
      expect([a.version, b.version, c.version]).toEqual(['template-a-generation-v3', 'template-b-generation-v1', 'template-c-generation-v1']);
      expect(a.basePrompt).toBe(buildTemplateAPrompt(TEMPLATE_A_DEFAULTS));
      expect(a.variants[0].prompt).toBe(buildTemplateAVariantPrompt(a.basePrompt, '1:1'));
      expect(b.basePrompt).toBe(templateBGenerationProfile.buildBasePrompt(templateBGenerationProfile.defaults));
      expect(c.basePrompt).toBe(templateCGenerationProfile.buildBasePrompt(templateCGenerationProfile.defaults));
      // Only Template A has structure facts for a decomposition default; only it decomposes with a held-object mode.
      expect([a.structure, b.structure, c.structure]).toEqual([{ visibleBorder: true, heldObject: true }, undefined, undefined]);
      for (const key of ['template-a', 'template-b', 'template-c'] as const) {
        expect(((await s.get(`/${key}/groups`)).body.groups as GenerationGroup[]).map(group => group.id)).toEqual([groups[key].id]);
        expect(readdirSync(s.dirs[key])).toEqual([groups[key].id]);
        // A creative is not reachable through another template: not shown, not generated, not decomposed.
        for (const other of (['template-a', 'template-b', 'template-c'] as const).filter(item => item !== key)) {
          expect((await s.get(`/${other}/groups/${groups[key].id}`)).status).toBe(404);
          expect((await fetch(s.url(`/${other}/groups/${groups[key].id}/variants/1x1/image`))).status).toBe(404);
          expect((await s.post(`/${other}/groups/${groups[key].id}/variants/16x9/generate`)).status).toBe(404);
          expect((await s.post(`/${other}/groups/${groups[key].id}/variants/1x1/decompose`)).status).toBe(404);
        }
      }
      expect(s.create).not.toHaveBeenCalled();
      // Template A takes its held-object mode and no template options.
      expect(await s.post(`/template-a/groups/${a.id}/variants/1x1/decompose`, { templateOptions: { [SEPARATE_TOUCHING]: true } })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_REQUEST', message: expect.stringContaining('Template A has no decomposition setting "templateOptions"') } } });
      expect(await s.post(`/template-a/groups/${a.id}/variants/1x1/decompose`, { [SEPARATE_MODULES]: true })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_REQUEST' } } });
      expect(s.create).not.toHaveBeenCalled();
      // Each decomposes through its own planner: three runs, three different instructions, no setting of another template.
      const expected: [GenerationTemplateKey, unknown, string, Record<string, unknown>][] = [
        ['template-a', { separateHeldObject: false }, PLANNER_INSTRUCTION, { separateHeldObject: false, layerTarget: { templateKey: 'template-a', suggestedLayers: 5, targetLayers: 5 } }],
        ['template-b', { templateOptions: { [SEPARATE_TOUCHING]: true } }, PLANNER_INSTRUCTION_B, { templateOptions: { [SEPARATE_TOUCHING]: true } }],
        ['template-c', { templateOptions: { [SEPARATE_PEOPLE]: true } }, PLANNER_INSTRUCTION_C, { templateOptions: { [SEPARATE_PEOPLE]: true, [SEPARATE_MODULES]: false } }],
      ];
      for (const [key, body, instruction, run] of expected) {
        const started = await s.post(`/${key}/groups/${groups[key].id}/variants/1x1/decompose`, body);
        expect(started).toMatchObject({ status: 202, body: { templateKey: key, ...run, origin: { kind: `${key}-generation`, generationId: groups[key].id, variantId: '1x1', aspectRatio: '1:1' } } });
        await s.idle();
        expect(s.planned().instructions.startsWith(`${instruction}\n\n`)).toBe(true);
        expect('templateOptions' in started.body).toBe(key !== 'template-a');
        expect('separateHeldObject' in started.body).toBe(key === 'template-a');
      }
      expect(new Set(s.create.mock.calls.map(([request]) => request.instructions)).size).toBe(3);
      // Template A's planner was told nothing of B's or C's options; B's and C's nothing of each other's.
      const [toA, toB, toC] = s.create.mock.calls.map(([request]) => request.input[0].content[0].text);
      expect(toA).not.toMatch(/touching|individual people|repeated panels/i);
      expect(toB).not.toMatch(/held object|individual people|repeated panels/i);
      expect(toC).not.toMatch(/held object|touching/i);
    } finally { s.app.close(); }
  });

  it('generates one variant at a time, whichever templates they belong to', async () => {
    const s = await server();
    try {
      const started = await Promise.all((['template-a', 'template-b', 'template-c'] as const).map(async key => [key, ((await s.post(`/${key}/groups`, { fields: {} })).body as GenerationGroup).id] as const));
      for (const [key, id] of started) expect(statuses(await s.settled(key, id))).toEqual({ '1x1': 'done', '16x9': 'done', '4x5': 'done' });
      expect(s.openai.generate).toHaveBeenCalledTimes(9);
      expect(s.openai.mostAtOnce()).toBe(1);
    } finally { s.app.close(); }
  });

  it('never serves a creative through another template, even when its folder is in the wrong place', async () => {
    const s = await server();
    try {
      const b = await s.generate('template-b', { fields: {}, aspectRatios: ['1:1'] });
      // Template B's group, copied by hand into Template A's folder.
      mkdirSync(join(s.dirs['template-a'], b.id));
      writeFileSync(join(s.dirs['template-a'], b.id, 'group.json'), JSON.stringify(readGroup(s.dirs['template-b'], b.id)));
      writeFileSync(join(s.dirs['template-a'], b.id, '1x1.image.png'), await png(1024, 1024));
      expect((await s.get('/template-a/groups')).body).toEqual({ groups: [] });
      expect((await s.get(`/template-a/groups/${b.id}`)).status).toBe(404);
      expect((await s.post(`/template-a/groups/${b.id}/variants/1x1/decompose`, { separateHeldObject: true })).status).toBe(404);
      expect(s.create).not.toHaveBeenCalled();
    } finally { s.app.close(); }
  });

  it('13. still reads Template A groups stored before the templates shared these mechanics, and decomposes them as Template A', async () => {
    const s = await server();
    try {
      // A group.json exactly as the Template A generator wrote it before Templates B and C had generators.
      const id = '2026-09-30T08-12-45-120Z-a1b2c3', base = buildTemplateAPrompt(TEMPLATE_A_DEFAULTS), picture = await png(1216, 1520, '#446688');
      const variant = (variantId: string, aspectRatio: '1:1' | '16:9' | '4:5', size: { width: number; height: number }) => ({ id: variantId, aspectRatio, size, status: 'pending', framing: TEMPLATE_A_RATIO_FRAMING[aspectRatio],
        prompt: buildTemplateAVariantPrompt(base, aspectRatio), generator: { provider: 'openai', model: 'gpt-image-2' }, attempts: 0, decompositions: [] });
      const stored = { id, templateKey: 'template-a', version: 'template-a-generation-v3', createdAt: '2026-09-30T08:12:45.120Z', updatedAt: '2026-09-30T08:14:02.000Z', fields: TEMPLATE_A_DEFAULTS, builtPrompt: base, basePrompt: base, promptEdited: false,
        structure: { visibleBorder: true, heldObject: true }, aspectRatios: ['1:1', '16:9', '4:5'], variants: [variant('1x1', '1:1', { width: 1024, height: 1024 }), variant('16x9', '16:9', { width: 1536, height: 864 }),
          { ...variant('4x5', '4:5', { width: 1216, height: 1520 }), status: 'done', attempts: 1, generator: { provider: 'openai', model: 'gpt-image-2', requestId: 'req_old' }, requestFile: '4x5.openai-request.json', responseFile: '4x5.openai-response.json',
            startedAt: '2026-09-30T08:13:00.000Z', finishedAt: '2026-09-30T08:14:02.000Z', durationMs: 62000, image: { file: '4x5.image.png', mimeType: 'image/png', width: 1216, height: 1520, bytes: picture.length, sha256: sha(picture) },
            decompositions: [{ runId: 'earlier-run', createdAt: '2026-09-30T08:20:00.000Z', separateHeldObject: true, targetLayers: 6 }] }] };
      mkdirSync(join(s.dirs['template-a'], id));
      writeFileSync(join(s.dirs['template-a'], id, 'group.json'), JSON.stringify(stored));
      writeFileSync(join(s.dirs['template-a'], id, '4x5.image.png'), picture);
      // Served as it is: nothing added, nothing converted.
      expect((await s.get('/template-a/groups')).body).toEqual({ groups: [stored] });
      expect((await s.get(`/template-a/groups/${id}`)).body).toEqual(stored);
      expect(JSON.parse(JSON.stringify(readGroup(s.dirs['template-a'], id)))).toEqual(stored);
      // Decomposed with Template A's semantics, as before: held object combined → five layers.
      const run = await s.post(`/template-a/groups/${id}/variants/4x5/decompose`, { separateHeldObject: false });
      expect(run).toMatchObject({ status: 202, body: { templateKey: 'template-a', separateHeldObject: false, layerTarget: { templateKey: 'template-a', suggestedLayers: 5, targetLayers: 5 },
        origin: { kind: 'template-a-generation', generationId: id, variantId: '4x5', aspectRatio: '4:5' } } });
      expect(run.body).not.toHaveProperty('templateOptions');
      await s.idle();
      expect(sha(s.uploads[0])).toBe(sha(picture));
      expect(s.planned().instructions.startsWith(`${PLANNER_INSTRUCTION}\n\n`)).toBe(true);
      // The new run is linked next to the earlier one; a missing ratio can still be generated.
      expect(((await s.get(`/template-a/groups/${id}`)).body as GenerationGroup).variants[2].decompositions).toEqual([{ runId: 'earlier-run', createdAt: '2026-09-30T08:20:00.000Z', separateHeldObject: true, targetLayers: 6 },
        { runId: run.body.id, createdAt: run.body.createdAt, separateHeldObject: false, targetLayers: 5 }]);
      expect((await s.post(`/template-a/groups/${id}/variants/1x1/generate`)).status).toBe(202);
      expect(statuses(await s.settled('template-a', id))).toEqual({ '1x1': 'done', '16x9': 'pending', '4x5': 'done' });
      expect(s.openai.generate.mock.calls.map(([request]) => request.prompt)).toEqual([buildTemplateAVariantPrompt(base, '1:1')]);
    } finally { s.app.close(); }
  });
});
