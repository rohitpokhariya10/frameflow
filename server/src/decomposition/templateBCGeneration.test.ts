import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildTemplateAPrompt, buildTemplateAVariantPrompt, TEMPLATE_A_DEFAULTS, TEMPLATE_A_RATIO_FRAMING, templateBGenerationProfile, templateCGenerationProfile, type GenerationProfile, type GenerationTemplateKey } from '@frameflow/shared';
import type { FalTransport } from './providers/falClient.js';
import { DEFAULT_IMAGE_MODEL } from './aiModels.js';
import { createGenerationGroup, generationsDirFor, liveGenerationConfig, readGroup, type GenerationConfig, type GenerationGroup, type GenerationHandoff } from './generationGroups.js';
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
type ImageRequest = { model: string; prompt: string; size: string; n: number; output_format: string; image?: File };
type Method = 'generate' | 'edit';
/**
 * A fake OpenAI images client. `send` records every request of either kind (images.generate: from text; images.edit:
 * from an input image) and returns one PNG of the requested size, never two at a time unnoticed. What an edit was given
 * as its input image is kept by its SHA-256.
 */
function imageFake() {
  const sent: Buffer[] = [], inputs: (string | undefined)[] = [];
  let active = 0, mostAtOnce = 0;
  const send = vi.fn(async (request: ImageRequest, method: Method): Promise<unknown> => {
    // An edit carries its input image; a generation has none.
    if ((method === 'edit') !== Boolean(request.image)) throw new Error(`An images.${method} request ${request.image ? 'with' : 'without'} an input image.`);
    mostAtOnce = Math.max(mostAtOnce, ++active);
    inputs.push(request.image ? sha(Buffer.from(await request.image.arrayBuffer())) : undefined);
    await new Promise(done => setTimeout(done, 2));
    const [width, height] = request.size.split('x').map(Number), bytes = await png(width, height, ['#2f6b2f', '#6b2f2f', '#2f2f6b', '#6b6b2f'][sent.length % 4]);
    sent.push(bytes); active--;
    return Object.defineProperty({ created: 1, output_format: 'png', size: request.size, data: [{ b64_json: bytes.toString('base64') }] }, '_request_id', { value: `req_img_${sent.length}` });
  });
  const generate = vi.fn((request: ImageRequest) => send(request, 'generate')), edit = vi.fn((request: ImageRequest) => send(request, 'edit'));
  /** The kind of each request made so far, in order. */
  const methods = () => send.mock.calls.map(([, method]) => method);
  return { send, generate, edit, methods, sent, inputs, mostAtOnce: () => mostAtOnce, config: { model: DEFAULT_IMAGE_MODEL, client: () => ({ images: { generate, edit } }) as unknown as ReturnType<GenerationConfig['client']> } satisfies GenerationConfig };
}
/** What a variant was sent: its prompt, and when it was made from another ratio's image, the template's sentence about that image. */
const sentPrompt = (variant: GenerationGroup['variants'][number]) => variant.reference ? `${variant.prompt} ${variant.reference.instruction}` : variant.prompt;
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
  settings: [Record<string, boolean>, Record<string, boolean>, string][]; foreignOptions: string[];
  /** What a request has to give for a complete creative (nothing for a template whose required fields have defaults), and a changed one. */
  sample: Record<string, string>; changed: Record<string, string> };
/** Template B's two required inputs are the user's; Templates A and C fill in a default creative. */
const SAMPLE: Record<GenerationTemplateKey, Record<string, string>> = { 'template-a': {}, 'template-b': { mainProduct: 'Lavender smartphone', sceneStyle: 'Premium pastel studio with soft lavender and pale-gray spheres around the phone' }, 'template-c': {} };
const B: Case = { key: 'template-b', handoff: templateBHandoff, profile: templateBGenerationProfile, options: TEMPLATE_B_OPTIONS, instruction: PLANNER_INSTRUCTION_B, schema: PLAN_SCHEMA_B,
  settings: [
    [{}, { [SEPARATE_TOUCHING]: false }, 'Run setting: separate touching / overlapping independent objects: no.'],
    [{ [SEPARATE_TOUCHING]: true }, { [SEPARATE_TOUCHING]: true }, 'Run setting: separate touching / overlapping independent objects: yes.'],
  ], foreignOptions: [SEPARATE_PEOPLE, SEPARATE_MODULES, 'separateHeldObject'], sample: SAMPLE['template-b'], changed: { sceneStyle: 'dark slate wall with one spotlight' } };
const C: Case = { key: 'template-c', handoff: templateCHandoff, profile: templateCGenerationProfile, options: TEMPLATE_C_OPTIONS, instruction: PLANNER_INSTRUCTION_C, schema: PLAN_SCHEMA_C,
  settings: [
    [{}, { [SEPARATE_PEOPLE]: false, [SEPARATE_MODULES]: false }, 'separate individual people: no; separate repeated panels: no.'],
    [{ [SEPARATE_PEOPLE]: true }, { [SEPARATE_PEOPLE]: true, [SEPARATE_MODULES]: false }, 'separate individual people: yes; separate repeated panels: no.'],
    [{ [SEPARATE_MODULES]: true }, { [SEPARATE_PEOPLE]: false, [SEPARATE_MODULES]: true }, 'separate individual people: no; separate repeated panels: yes.'],
    [{ [SEPARATE_PEOPLE]: true, [SEPARATE_MODULES]: true }, { [SEPARATE_PEOPLE]: true, [SEPARATE_MODULES]: true }, 'separate individual people: yes; separate repeated panels: yes.'],
  ], foreignOptions: [SEPARATE_TOUCHING, 'separateHeldObject'], sample: SAMPLE['template-c'], changed: { background: 'deep navy curtain' } };

/** The experiment router with every provider faked: the three generators, and decomposition up to a finished run. */
async function server(openai = imageFake(), config: Partial<GenerationConfig> = {}) {
  const runsDir = mkdtempSync(join(tmpdir(), 'layerize-')), dirs: Record<GenerationTemplateKey, string> = { 'template-a': root(), 'template-b': root(), 'template-c': root() };
  const base = await png(64, 64, '#010203'), uploads: Buffer[] = [], submitted: Record<string, unknown>[] = [];
  const create = vi.fn(async (request: PlannerRequest) => ({ status: 'completed', output: [], output_text: JSON.stringify(planFor(request)) }));
  const planner = createOpenAIPlanner({ client: { responses: { create } } as never });
  const transport: FalTransport = { upload: async (image) => { uploads.push(image as Buffer); return 'https://v3b.fal.media/files/t/in.png'; }, submit: async (_endpoint, input) => { submitted.push(input); return { requestId: 'r' }; }, status: async () => 'COMPLETED',
    result: async () => ({ layers: [{ image: { url: 'https://v3b.fal.media/files/t/b.png' }, z_index: 0 }] }), cancel: async () => undefined, download: async () => base };
  const deps = (): RunnerDeps => ({ planner, transport: () => transport, sleep: async () => undefined });
  const app = express().use('/x', createLayerizeRouter({ runsDir, deps, generationsDir: dirs['template-a'], generationDirs: { 'template-b': dirs['template-b'], 'template-c': dirs['template-c'] }, generation: () => ({ ...openai.config, ...config }) })).listen(0, '127.0.0.1');
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
  const generate = async (key: GenerationTemplateKey, body: Record<string, unknown> = { fields: SAMPLE[key] }) => settled(key, ((await post(`/${key}/groups`, body)).body as GenerationGroup).id);
  /** The last request the decomposition planner was sent. */
  const planned = () => create.mock.calls.at(-1)![0];
  return { app, url, get, post, idle, settled, generate, planned, create, runsDir, dirs, uploads, submitted, openai };
}

describe.each([B, C])('$profile.name test generator (one creative → three aspect-ratio variants → its own decomposition)', (t) => {
  const { key, profile } = t, FIELDS = profile.resolveFields(t.sample).values, BASE = profile.buildBasePrompt(FIELDS);

  it('creates a group without sending anything: its own creative definition once, and a pending variant per ratio', () => {
    const dir = root(), openai = imageFake();
    const { group, requested } = createGenerationGroup(dir, t.handoff, { fields: t.sample }, openai.config);
    expect(openai.send).not.toHaveBeenCalled();
    expect(requested).toEqual(['1x1', '16x9', '4x5']);
    expect(group).toMatchObject({ templateKey: key, version: profile.version, fields: FIELDS, builtPrompt: BASE, basePrompt: BASE, promptEdited: false, aspectRatios: ['1:1', '16:9', '4:5'] });
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
        expect(await s.post(`/${key}/groups`, { fields: other.profile.resolveFields(SAMPLE[other.profile.templateKey]).values })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_FIELDS' } } });
      expect(await s.post(`/${key}/groups`, { fields: t.sample, prompt: 'anything' })).toMatchObject({ status: 400, body: { error: { code: 'PROMPT_NOT_ACCEPTED' } } });
      expect(await s.post(`/${key}/groups`, { fields: t.sample, aspectRatios: ['9:16'] })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_ASPECT_RATIO' } } });
      expect((await s.get(`/${key}/groups`)).body).toEqual({ groups: [] });
      expect(s.openai.send).not.toHaveBeenCalled();
    } finally { s.app.close(); }
  });

  it('6–8. generates the three ratios as one group; one failing leaves the others, and only the failed one is generated again', async () => {
    const s = await server();
    try {
      // The 16:9 request fails; the two others succeed.
      s.openai.send.mockImplementationOnce(s.openai.send.getMockImplementation()!).mockRejectedValueOnce(apiError(500, 'server_error', 'The server had an error.'));
      const started = await s.post(`/${key}/groups`, { fields: t.sample });
      expect(started.status).toBe(202);
      const group = await s.settled(key, (started.body as GenerationGroup).id);
      expect(statuses(group)).toEqual({ '1x1': 'done', '16x9': 'failed', '4x5': 'done' });
      expect(group.variants[1]).toMatchObject({ attempts: 1, error: { status: 500 } });
      expect(group.variants[1].image).toBeUndefined();
      // Exactly the template's own prompts were sent, each at its own size; a failed request is never resent by itself.
      expect(s.openai.send.mock.calls.map(([request]) => [request.size, request.prompt, request.model])).toEqual(group.variants.map(variant => [`${variant.size.width}x${variant.size.height}`, sentPrompt(variant), DEFAULT_IMAGE_MODEL]));
      const images = [group.variants[0].image, group.variants[2].image];
      // 10. Generate only the failed ratio again: one request; its siblings and the shared definition are untouched.
      expect((await s.post(`/${key}/groups/${group.id}/variants/16x9/generate`)).status).toBe(202);
      const again = await s.settled(key, group.id);
      expect(statuses(again)).toEqual({ '1x1': 'done', '16x9': 'done', '4x5': 'done' });
      expect(again.variants[1]).toMatchObject({ attempts: 2, image: { width: 1536, height: 864 } });
      expect(again.variants[1].error).toBeUndefined();
      expect([again.variants[0].image, again.variants[2].image]).toEqual(images);
      expect({ fields: again.fields, basePrompt: again.basePrompt, createdAt: again.createdAt }).toEqual({ fields: group.fields, basePrompt: group.basePrompt, createdAt: group.createdAt });
      expect(s.openai.send).toHaveBeenCalledTimes(4);
      // A finished variant is never generated again.
      expect(await s.post(`/${key}/groups/${group.id}/variants/1x1/generate`)).toMatchObject({ status: 400, body: { error: { code: 'ALREADY_GENERATED' } } });
      expect(s.openai.send).toHaveBeenCalledTimes(4);
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
      expect(s.openai.send).toHaveBeenCalledTimes(3);
      // A ratio without an image has nothing to decompose.
      const partial = await s.generate(key, { fields: { ...t.sample, ...t.changed }, aspectRatios: ['4:5'] });
      expect(await s.post(`/${key}/groups/${partial.id}/variants/1x1/decompose`)).toMatchObject({ status: 400, body: { error: { code: 'NOT_DECOMPOSABLE' } } });
      expect(await s.post(`/${key}/groups/${partial.id}/variants/9x16/decompose`)).toMatchObject({ status: 404 });
    } finally { s.app.close(); }
  });

  it('10–11. takes only its own decomposition options: another template\'s option or mode is refused and starts nothing', async () => {
    const s = await server();
    try {
      const group = await s.generate(key, { fields: t.sample, aspectRatios: ['1:1'] });
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
      const first = await s.generate(key, { fields: t.sample, aspectRatios: ['1:1'] });
      const changed = await s.generate(key, { fields: { ...t.sample, ...t.changed }, aspectRatios: ['1:1'] });
      const edited = await s.generate(key, { fields: t.sample, basePrompt: `${BASE} Shot on a rainy evening.`, aspectRatios: ['1:1'] });
      expect(new Set([first.id, changed.id, edited.id]).size).toBe(3);
      expect(changed.basePrompt).toContain(Object.values(t.changed)[0]);
      // The edit is the shared base of every ratio of the new group, including the ones not generated yet.
      expect(edited).toMatchObject({ builtPrompt: BASE, basePrompt: `${BASE} Shot on a rainy evening.`, promptEdited: true });
      for (const variant of edited.variants) expect(variant.prompt).toBe(`${BASE} Shot on a rainy evening. ${profile.consistency} ${profile.framing[variant.aspectRatio as keyof typeof profile.framing]}`);
      expect(await s.post(`/${key}/groups`, { fields: t.sample, basePrompt: 'Too short' })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_PROMPT' } } });
      expect((await s.get(`/${key}/groups/${first.id}`)).body).toEqual(first);
      expect(((await s.get(`/${key}/groups`)).body.groups as GenerationGroup[]).map(group => group.id).sort()).toEqual([first.id, changed.id, edited.id].sort());
      expect(s.openai.send).toHaveBeenCalledTimes(3);
    } finally { s.app.close(); }
  });
});

describe('Template B creatives: three inputs in, the Template B structure sent (with fakes)', () => {
  const b = templateBGenerationProfile;
  const STRUCTURE = 'The hero\'s own parts, contents and markings stay with it; anything the scene places around or under it (objects, a platform, graphic shapes) is a separate element, complete and clearly distinguishable from the hero.';
  const CASES: [string, Record<string, string>][] = [
    ['CASE 1, smartphone', { mainProduct: 'Lavender smartphone', sceneStyle: 'Premium pastel studio with soft lavender and pale-gray spheres around the phone', extraDetails: 'Back facing viewer, no text' }],
    ['CASE 2, food', { mainProduct: 'Roasted broccoli dish', sceneStyle: 'Bright lime advertising backdrop with a white geometric platform and a soft pink starburst graphic', extraDetails: 'Show the complete dish' }],
    ['CASE 3, hanging lamp', { mainProduct: 'Orange and blue hanging pendant lamp', sceneStyle: 'Warm cream graphic backdrop with an orange rectangular panel and thin grid lines', extraDetails: 'Show the full lamp' }],
    ['CASE 4, table lamp', { mainProduct: 'Glossy orange table lamp', sceneStyle: 'Minimal cream editorial poster with orange geometric accents', extraDetails: 'Keep the entire lamp visible' }],
    ['only the two required inputs', { mainProduct: 'Lavender smartphone', sceneStyle: 'Premium pastel studio with soft lavender spheres' }],
  ];

  it('builds a concise, complete Template B prompt for creatives that look nothing alike, and sends exactly that', async () => {
    const s = await server();
    try {
      for (const [, fields] of CASES) {
        const group = await s.generate('template-b', { fields, aspectRatios: ['1:1'] });
        expect(group).toMatchObject({ templateKey: 'template-b', version: 'template-b-generation-v3', promptEdited: false, fields: { ...fields, productAngle: 'auto', imageText: 'avoid' } });
        expect(Object.keys(group.fields)).toEqual(['mainProduct', 'sceneStyle', 'extraDetails', 'productAngle', 'imageText']);
        // The user's intent, as typed, then the structure they never had to type.
        expect(group.basePrompt.startsWith(`Create a premium product advertising image featuring one ${fields.mainProduct} as the single, clearly dominant hero. Scene and visual style: ${fields.sceneStyle}. `)).toBe(true);
        expect(group.basePrompt.includes(`Requested details: ${fields.extraDetails}.`)).toBe(Boolean(fields.extraDetails));
        for (const rule of [STRUCTURE, 'Show the hero whole and intact, large in the frame; unless described otherwise, use soft professional advertising lighting with gentle shadows and a balanced composition.',
          'the hero, the elements around it and the designed background are visually distinct', 'No people or hands, no extra copies of the hero, no unrelated props, no clutter, and no text or logos except what is on the hero itself.']) expect(group.basePrompt).toContain(rule);
        expect(group.basePrompt.length).toBeLessThan(1100);
        expect(group.variants.every(variant => variant.prompt.length < 1800)).toBe(true);
        expect(s.openai.send.mock.calls.at(-1)![0].prompt).toBe(`${group.basePrompt} ${b.consistency} ${b.framing['1:1']}`);
      }
      // Both required inputs are required; the extra details and the advanced choices are not.
      expect(await s.post('/template-b/groups', { fields: {} })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_FIELDS', message: 'Main product is required: it is part of the Template B structure. Scene / visual style is required: it is part of the Template B structure.' } } });
      expect(await s.post('/template-b/groups', { fields: { mainProduct: 'Lavender smartphone' } })).toMatchObject({ status: 400, body: { error: { message: 'Scene / visual style is required: it is part of the Template B structure.' } } });
      // Too much text is refused with a message, never cut; a person is not a Template B hero; the earlier forms' fields are gone.
      expect(await s.post('/template-b/groups', { fields: { ...SAMPLE['template-b'], sceneStyle: 'x'.repeat(501) } })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_FIELDS', message: 'Scene / visual style is 501 characters; at most 500.' } } });
      expect(await s.post('/template-b/groups', { fields: { ...SAMPLE['template-b'], mainProduct: 'smiling woman' } })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_FIELDS', message: expect.stringContaining('not a person') } } });
      expect(await s.post('/template-b/groups', { fields: { ...SAMPLE['template-b'], heroProduct: 'kettle', lighting: 'soft', extras: 'two cups' } })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_FIELDS', message: 'Unknown field "heroProduct". Unknown field "lighting". Unknown field "extras".' } } });
      // The advanced choices reach the prompt only when set.
      const angled = await s.generate('template-b', { fields: { ...SAMPLE['template-b'], productAngle: 'three-quarter', imageText: 'allow' }, aspectRatios: ['1:1'] });
      expect(angled.basePrompt).toContain('large in the frame, in a three-quarter view;');
      expect(angled.basePrompt).toContain('no clutter. Show only the text the description asks for, short and legible.');
      expect(await s.post('/template-b/groups', { fields: { ...SAMPLE['template-b'], productAngle: 'diagonal' } })).toMatchObject({ status: 400, body: { error: { message: 'Product angle must be one of auto, front, three-quarter, side.' } } });
      // The generator serves the three inputs, then the two advanced choices.
      const info = (await s.get('/template-b/generator')).body;
      expect((info.fields as { key: string; label: string; required: boolean; advanced?: boolean }[]).map(field => [field.key, field.label, field.required, field.advanced === true])).toEqual([['mainProduct', 'Main product', true, false],
        ['sceneStyle', 'Scene / visual style', true, false], ['extraDetails', 'Extra details', false, false], ['productAngle', 'Product angle', false, true], ['imageText', 'Text in the image', false, true]]);
    } finally { s.app.close(); }
  });

  it('keeps the three ratios together by image: the first from the prompt, the others from that image', async () => {
    const s = await server();
    try {
      expect((await s.get('/template-b/generator')).body.ratioReference).toBe(true);
      const group = await s.generate('template-b', { fields: CASES[0][1] });
      expect(statuses(group)).toEqual({ '1x1': 'done', '16x9': 'done', '4x5': 'done' });
      expect(group.ratioStrategy).toBe('reference');
      // One request per ratio, in order: text-to-image, then two edits of the first image.
      expect(s.openai.methods()).toEqual(['generate', 'edit', 'edit']);
      expect(s.openai.send.mock.calls.map(([request]) => request.size)).toEqual(['1024x1024', '1536x864', '1216x1520']);
      const first = sha(s.openai.sent[0]);
      expect(group.variants[0].image!.sha256).toBe(first);
      // The input image of both edits is the saved 1:1 image, byte for byte; the first request had none.
      expect(s.openai.inputs).toEqual([undefined, first, first]);
      // Only parameters the OpenAI SDK lists for an image edit, with the same model as the generation.
      for (const [request] of s.openai.send.mock.calls.slice(1)) {
        expect(Object.keys(request).sort()).toEqual(['image', 'model', 'n', 'output_format', 'prompt', 'size']);
        expect(request).toMatchObject({ model: DEFAULT_IMAGE_MODEL, n: 1, output_format: 'png' });
      }
      // Each later ratio was sent its own prompt (same base, its own framing) plus Template B's sentence about the attached image.
      expect(group.variants[0].reference).toBeUndefined();
      for (const [index, variant] of group.variants.entries()) {
        expect(variant.prompt).toBe(`${group.basePrompt} ${b.consistency} ${b.framing[variant.aspectRatio as keyof typeof b.framing]}`);
        if (index === 0) { expect(s.openai.send.mock.calls[0][0].prompt).toBe(variant.prompt); continue; }
        expect(variant.reference).toEqual({ variantId: '1x1', aspectRatio: '1:1', file: '1x1.image.png', sha256: first, instruction: b.referenceInstruction });
        expect(s.openai.send.mock.calls[index][0].prompt).toBe(`${variant.prompt} ${b.referenceInstruction}`);
        expect(variant).toMatchObject({ status: 'done', attempts: 1, generator: { provider: 'openai', model: DEFAULT_IMAGE_MODEL, requestId: `req_img_${index + 1}` }, image: { width: variant.size.width, height: variant.size.height } });
      }
      // What was sent is on disk: the edit request names its input image instead of holding it.
      const wide = JSON.parse(readFileSync(join(s.dirs['template-b'], group.id, '16x9.openai-request.json'), 'utf8'));
      expect(wide).toEqual({ method: 'images.edit', model: DEFAULT_IMAGE_MODEL, prompt: `${group.variants[1].prompt} ${b.referenceInstruction}`, size: '1536x864', n: 1, output_format: 'png', image: `<the 1:1 variant's image: 1x1.image.png, sha256 ${first}>` });
      expect(JSON.parse(readFileSync(join(s.dirs['template-b'], group.id, '1x1.openai-request.json'), 'utf8'))).toEqual({ model: DEFAULT_IMAGE_MODEL, prompt: group.variants[0].prompt, size: '1024x1024', n: 1, output_format: 'png' });
      // Generating is OpenAI images only: no planner request, nothing to fal.
      expect(s.create).not.toHaveBeenCalled();
      expect(s.submitted).toEqual([]);
      // A ratio generated later is made from the finished one too, whichever ratio that is.
      const later = await s.generate('template-b', { fields: SAMPLE['template-b'], aspectRatios: ['4:5'] });
      expect([statuses(later), s.openai.methods().at(-1)]).toEqual([{ '1x1': 'pending', '16x9': 'pending', '4x5': 'done' }, 'generate']);
      expect((await s.post(`/template-b/groups/${later.id}/variants/1x1/generate`)).status).toBe(202);
      expect((await s.settled('template-b', later.id)).variants[0]).toMatchObject({ status: 'done', reference: { variantId: '4x5', aspectRatio: '4:5' } });
      expect([s.openai.methods().at(-1), s.openai.inputs.at(-1)]).toEqual(['edit', later.variants[2].image!.sha256]);
    } finally { s.app.close(); }
  });

  it('a failed ratio blocks nothing: the next one takes its place as the reference, and a failed reference ratio can be generated from the prompt only', async () => {
    const s = await server();
    try {
      // The first request (1:1, from the prompt) fails: 16:9 is then generated from the prompt and becomes the reference for 4:5.
      s.openai.send.mockRejectedValueOnce(apiError(500, 'server_error', 'The server had an error.'));
      const group = await s.generate('template-b');
      expect(statuses(group)).toEqual({ '1x1': 'failed', '16x9': 'done', '4x5': 'done' });
      expect(s.openai.methods()).toEqual(['generate', 'generate', 'edit']);
      expect(group.variants.map(variant => variant.reference?.variantId)).toEqual([undefined, undefined, '16x9']);
      expect(s.openai.inputs.at(-1)).toBe(group.variants[1].image!.sha256);
      // The failed 1:1 is generated again on its own: made from the original (16:9), not from a copy of it; its siblings are untouched.
      const images = [group.variants[1].image, group.variants[2].image];
      expect((await s.post(`/template-b/groups/${group.id}/variants/1x1/generate`)).status).toBe(202);
      const again = await s.settled('template-b', group.id);
      expect(again.variants[0]).toMatchObject({ status: 'done', attempts: 2, reference: { variantId: '16x9' } });
      expect([again.variants[1].image, again.variants[2].image]).toEqual(images);
      expect(s.openai.send).toHaveBeenCalledTimes(4);

      // A reference-based request fails: the variant says how it was attempted, nothing is resent by itself.
      const second = await s.generate('template-b', { fields: SAMPLE['template-b'], aspectRatios: ['1:1'] });
      s.openai.send.mockRejectedValueOnce(apiError(400, 'invalid_request_error', 'Image edits are not available for this model.'));
      expect((await s.post(`/template-b/groups/${second.id}/variants/16x9/generate`)).status).toBe(202);
      const failed = await s.settled('template-b', second.id);
      expect(failed.variants[1]).toMatchObject({ status: 'failed', attempts: 1, reference: { variantId: '1x1' }, error: { code: 'PROVIDER_REJECTED', status: 400, message: 'Image edits are not available for this model.' } });
      expect(failed.variants[0].status).toBe('done');
      expect(s.openai.send).toHaveBeenCalledTimes(6);
      // It can then be generated from its prompt alone: a plain generation request, with no image and no reference sentence.
      expect(await s.post(`/template-b/groups/${second.id}/variants/16x9/generate`, { independent: 'yes' })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_REQUEST' } } });
      expect((await s.post(`/template-b/groups/${second.id}/variants/16x9/generate`, { independent: true })).status).toBe(202);
      const independent = await s.settled('template-b', second.id);
      expect(independent.variants[1]).toMatchObject({ status: 'done', attempts: 2 });
      expect(independent.variants[1].reference).toBeUndefined();
      expect([s.openai.methods().at(-1), s.openai.inputs.at(-1), s.openai.send.mock.calls.at(-1)![0].prompt]).toEqual(['generate', undefined, independent.variants[1].prompt]);
    } finally { s.app.close(); }
  });

  it('generates every ratio from its prompt alone when reference generation is switched off, and always for Templates A and C', async () => {
    expect([liveGenerationConfig({}).referenceRatios, liveGenerationConfig({ TEMPLATE_RATIO_REFERENCE: 'off' }).referenceRatios, liveGenerationConfig({ TEMPLATE_RATIO_REFERENCE: '0' }).referenceRatios,
      liveGenerationConfig({ TEMPLATE_RATIO_REFERENCE: 'on' }).referenceRatios]).toEqual([true, false, false, true]);
    const off = await server(imageFake(), { referenceRatios: false });
    try {
      expect((await off.get('/template-b/generator')).body.ratioReference).toBe(false);
      const group = await off.generate('template-b');
      expect([statuses(group), group.ratioStrategy, off.openai.methods(), off.openai.edit.mock.calls.length]).toEqual([{ '1x1': 'done', '16x9': 'done', '4x5': 'done' }, undefined, ['generate', 'generate', 'generate'], 0]);
      expect(group.variants.every(variant => variant.reference === undefined)).toBe(true);
    } finally { off.app.close(); }
    // Templates A and C have no reference sentence: whatever the setting, their ratios are three independent generations.
    const s = await server();
    try {
      for (const key of ['template-a', 'template-c'] as const) {
        expect((await s.get(`/${key}/generator`)).body.ratioReference).toBe(false);
        const group = await s.generate(key, { fields: {} });
        expect([statuses(group), group.ratioStrategy]).toEqual([{ '1x1': 'done', '16x9': 'done', '4x5': 'done' }, undefined]);
        expect(group.variants.every(variant => variant.reference === undefined)).toBe(true);
        expect(await s.post(`/${key}/groups/${group.id}/variants/1x1/generate`, { independent: true })).toMatchObject({ status: 400, body: { error: { code: 'ALREADY_GENERATED' } } });
      }
      expect(s.openai.edit).not.toHaveBeenCalled();
      expect(s.openai.generate).toHaveBeenCalledTimes(6);
    } finally { s.app.close(); }
  });

  it('decomposes any ratio through Template B with its option exactly as declared, whichever way the image was made', async () => {
    const s = await server();
    try {
      expect(TEMPLATE_B_OPTIONS.map(option => [option.key, option.label, option.default])).toEqual([['separateTouchingIndependentObjects', 'Separate touching / overlapping independent objects', false]]);
      expect(listTemplates(s.runsDir).find(template => template.key === 'template-b')).toMatchObject({ name: 'Template B', options: TEMPLATE_B_OPTIONS, providerPrompt: 'planned', imageSpecificPrompt: true, dynamicLayerCount: true });
      const group = await s.generate('template-b', { fields: CASES[0][1] });
      // The 4:5 image was made from the 1:1 image; the 1:1 from the prompt. Each decomposes on its own, as exactly its own bytes.
      for (const [variantId, aspectRatio, index, separate] of [['4x5', '4:5', 2, true], ['1x1', '1:1', 0, false]] as const) {
        const run = await s.post(`/template-b/groups/${group.id}/variants/${variantId}/decompose`, { templateOptions: { [SEPARATE_TOUCHING]: separate } });
        expect(run).toMatchObject({ status: 202, body: { templateKey: 'template-b', templateOptions: { [SEPARATE_TOUCHING]: separate }, origin: { kind: 'template-b-generation', generationId: group.id, variantId, aspectRatio } } });
        expect(run.body).not.toHaveProperty('separateHeldObject');
        await s.idle();
        expect(sha(s.uploads.at(-1)!)).toBe(sha(s.openai.sent[index]));
        expect(s.planned().instructions).toBe(`${PLANNER_INSTRUCTION_B}\n\n${LENGTH_NOTE}`);
        expect(s.planned().text.format.schema).toBe(PLAN_SCHEMA_B);
        expect(s.planned().input[0].content[0].text.endsWith(`Run setting: separate touching / overlapping independent objects: ${separate ? 'yes' : 'no'}.`)).toBe(true);
        expect(readRun(join(s.runsDir, run.body.id))).toMatchObject({ templateKey: 'template-b', origin: { kind: 'template-b-generation', generationId: group.id, variantId, aspectRatio } });
      }
      const after = (await s.get(`/template-b/groups/${group.id}`)).body as GenerationGroup;
      expect(after.variants.map(variant => variant.decompositions.map(item => item.templateOptions))).toEqual([[{ [SEPARATE_TOUCHING]: false }], [], [{ [SEPARATE_TOUCHING]: true }]]);
      // Decomposing generated nothing: three image requests in all.
      expect(s.openai.send).toHaveBeenCalledTimes(3);
    } finally { s.app.close(); }
  });

  it('still reads, generates and decomposes creatives stored by the earlier forms, exactly as they were stored', async () => {
    const s = await server();
    try {
      // A group.json exactly as version 1 of the Template B generator wrote it: fourteen fields, version 1's prompt wording.
      const id = '2026-09-30T09-40-12-345Z-b1c2d3', picture = await png(1536, 864, '#665544');
      const base = 'Create a clean, editorial product advertising image with one ceramic table lamp as the single, clearly dominant hero object: matte cream body with a linen shade and a brass switch. The hero is shown upright, centred, three-quarter view. The hero rests on a low round stone pedestal, a separate element that is clearly distinguishable from the hero. No other objects accompany the hero. Background: soft warm-beige studio backdrop with a gentle gradient, a designed backdrop clearly separate from everything in front of it. Show the hero whole and intact, exactly once.';
      const variant = (variantId: string, aspectRatio: '1:1' | '16:9' | '4:5', size: { width: number; height: number }) => ({ id: variantId, aspectRatio, size, status: 'pending', framing: b.framing[aspectRatio],
        prompt: `${base} ${b.consistency} ${b.framing[aspectRatio]}`, generator: { provider: 'openai', model: 'gpt-image-2' }, attempts: 0, decompositions: [] });
      const stored = { id, templateKey: 'template-b', version: 'template-b-generation-v1', createdAt: '2026-09-30T09:40:12.345Z', updatedAt: '2026-09-30T09:41:30.000Z',
        fields: { heroProduct: 'ceramic table lamp', heroDescription: 'matte cream body with a linen shade and a brass switch', material: '', intrinsicDetails: '', placement: 'upright, centred, three-quarter view', support: 'low round stone pedestal', secondaryObjects: '',
          decoration: '', foregroundAccents: '', background: 'soft warm-beige studio backdrop with a gentle gradient', composition: '', lighting: '', palette: '', extraNotes: '' },
        builtPrompt: base, basePrompt: base, promptEdited: false, notes: ['No platform: the hero stands on its own, so the decomposition has no support layer to find.'], aspectRatios: ['1:1', '16:9', '4:5'],
        variants: [variant('1x1', '1:1', { width: 1024, height: 1024 }),
          { ...variant('16x9', '16:9', { width: 1536, height: 864 }), status: 'done', attempts: 1, generator: { provider: 'openai', model: 'gpt-image-2', requestId: 'req_old_b' }, image: { file: '16x9.image.png', mimeType: 'image/png', width: 1536, height: 864, bytes: picture.length, sha256: sha(picture) },
            decompositions: [{ runId: 'earlier-b-run', createdAt: '2026-09-30T09:50:00.000Z', templateOptions: { [SEPARATE_TOUCHING]: false } }] },
          variant('4x5', '4:5', { width: 1216, height: 1520 })] };
      mkdirSync(join(s.dirs['template-b'], id));
      writeFileSync(join(s.dirs['template-b'], id, 'group.json'), JSON.stringify(stored));
      writeFileSync(join(s.dirs['template-b'], id, '16x9.image.png'), picture);
      // And one as version 2 (the five-field form) stored it.
      const v2 = { id: '2026-09-30T12-05-00-000Z-c4d5e6', templateKey: 'template-b', version: 'template-b-generation-v2', createdAt: '2026-09-30T12:05:00.000Z', updatedAt: '2026-09-30T12:05:00.000Z',
        fields: { heroProduct: 'Lavender smartphone', productLook: 'Soft lavender matte case', scene: 'Clean soft-gray studio', extras: 'Several matte lavender spheres', extraInstructions: '' }, builtPrompt: 'A version 2 prompt.', basePrompt: 'A version 2 prompt.',
        promptEdited: false, aspectRatios: ['1:1', '16:9', '4:5'], variants: [variant('1x1', '1:1', { width: 1024, height: 1024 }), variant('16x9', '16:9', { width: 1536, height: 864 }), variant('4x5', '4:5', { width: 1216, height: 1520 })] };
      mkdirSync(join(s.dirs['template-b'], v2.id));
      writeFileSync(join(s.dirs['template-b'], v2.id, 'group.json'), JSON.stringify(v2));
      // Served as they are: their own fields, version and prompts, nothing converted; next to a creative of today's form.
      const today = await s.generate('template-b', { fields: SAMPLE['template-b'], aspectRatios: ['1:1'] });
      expect((await s.get(`/template-b/groups/${id}`)).body).toEqual(stored);
      expect((await s.get(`/template-b/groups/${v2.id}`)).body).toEqual(v2);
      expect(((await s.get('/template-b/groups')).body.groups as GenerationGroup[]).map(group => [group.id, group.version, Object.keys(group.fields).length, group.ratioStrategy])).toEqual([[today.id, 'template-b-generation-v3', 5, 'reference'],
        [v2.id, 'template-b-generation-v2', 5, undefined], [id, 'template-b-generation-v1', 14, undefined]]);
      expect((await fetch(s.url(`/template-b/groups/${id}/variants/16x9/image`))).status).toBe(200);
      // A ratio it never generated is generated the way it always was: from the prompt it stored, as it stored it, on its own.
      expect((await s.post(`/template-b/groups/${id}/variants/4x5/generate`)).status).toBe(202);
      const generated = await s.settled('template-b', id);
      expect(statuses(generated)).toEqual({ '1x1': 'pending', '16x9': 'done', '4x5': 'done' });
      expect(s.openai.send.mock.calls.at(-1)).toEqual([{ model: DEFAULT_IMAGE_MODEL, prompt: stored.variants[2].prompt, size: '1216x1520', n: 1, output_format: 'png' }, 'generate']);
      expect(generated.variants[2].reference).toBeUndefined();
      // Its image decomposes through Template B, with Template B's option, and the run is linked next to the earlier one.
      const run = await s.post(`/template-b/groups/${id}/variants/16x9/decompose`, { templateOptions: { [SEPARATE_TOUCHING]: true } });
      expect(run).toMatchObject({ status: 202, body: { templateKey: 'template-b', templateOptions: { [SEPARATE_TOUCHING]: true }, origin: { kind: 'template-b-generation', generationId: id, variantId: '16x9', aspectRatio: '16:9' } } });
      await s.idle();
      expect(sha(s.uploads.at(-1)!)).toBe(sha(picture));
      expect(s.planned().instructions).toBe(`${PLANNER_INSTRUCTION_B}\n\n${LENGTH_NOTE}`);
      const after = readGroup(s.dirs['template-b'], id);
      expect(after.variants[1].decompositions.map(item => item.runId)).toEqual(['earlier-b-run', run.body.id]);
      // The record keeps its own fields, version, prompts and image on disk.
      expect({ version: after.version, fields: after.fields, basePrompt: after.basePrompt, notes: after.notes, prompts: after.variants.map(item => item.prompt), image: after.variants[1].image })
        .toEqual({ version: stored.version, fields: stored.fields, basePrompt: stored.basePrompt, notes: stored.notes, prompts: stored.variants.map(item => item.prompt), image: (stored.variants[1] as { image?: unknown }).image });
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
        expect(s.openai.send.mock.calls.at(-1)![0].prompt).toBe(group.variants[0].prompt);
        expect((group.notes ?? []).map(note => notes.find(start => note.startsWith(start)))).toEqual(notes);
      }
    } finally { s.app.close(); }
  });
});

describe('isolation: three templates on one set of mechanics', () => {
  it('keeps each template\'s creatives under its own routes, folder and decomposition, even side by side', async () => {
    const s = await server();
    try {
      const a = await s.generate('template-a', { fields: {}, aspectRatios: ['1:1'] }), b = await s.generate('template-b', { fields: SAMPLE['template-b'], aspectRatios: ['1:1'] }), c = await s.generate('template-c', { fields: {}, aspectRatios: ['1:1'] });
      const groups = { 'template-a': a, 'template-b': b, 'template-c': c };
      expect([a.templateKey, b.templateKey, c.templateKey]).toEqual(['template-a', 'template-b', 'template-c']);
      // Each used its own profile: its own version, fields and prompt wording.
      expect([a.version, b.version, c.version]).toEqual(['template-a-generation-v3', 'template-b-generation-v3', 'template-c-generation-v1']);
      expect(a.basePrompt).toBe(buildTemplateAPrompt(TEMPLATE_A_DEFAULTS));
      expect(a.variants[0].prompt).toBe(buildTemplateAVariantPrompt(a.basePrompt, '1:1'));
      expect(b.basePrompt).toBe(templateBGenerationProfile.buildBasePrompt(templateBGenerationProfile.resolveFields(SAMPLE['template-b']).values));
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
      const started = await Promise.all((['template-a', 'template-b', 'template-c'] as const).map(async key => [key, ((await s.post(`/${key}/groups`, { fields: SAMPLE[key] })).body as GenerationGroup).id] as const));
      for (const [key, id] of started) expect(statuses(await s.settled(key, id))).toEqual({ '1x1': 'done', '16x9': 'done', '4x5': 'done' });
      expect(s.openai.send).toHaveBeenCalledTimes(9);
      expect(s.openai.mostAtOnce()).toBe(1);
    } finally { s.app.close(); }
  });

  it('never serves a creative through another template, even when its folder is in the wrong place', async () => {
    const s = await server();
    try {
      const b = await s.generate('template-b', { fields: SAMPLE['template-b'], aspectRatios: ['1:1'] });
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
      expect(s.openai.send.mock.calls.map(([request]) => request.prompt)).toEqual([buildTemplateAVariantPrompt(base, '1:1')]);
    } finally { s.app.close(); }
  });
});
