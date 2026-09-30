import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { buildTemplateAPrompt, buildTemplateAVariantPrompt, TEMPLATE_A_ASPECT_RATIOS, TEMPLATE_A_CONSISTENCY, TEMPLATE_A_DEFAULTS, TEMPLATE_A_IMAGE_SIZES, TEMPLATE_A_RATIO_FRAMING } from '@frameflow/shared';
import type { FalTransport } from './providers/falClient.js';
import { buildProviderInput } from './providers/adapters.js';
import { DEFAULT_IMAGE_MODEL, DEFAULT_PLANNER_MODEL, imageModel, plannerModel } from './aiModels.js';
import { readRun, type RunnerDeps } from './layerizeExperiment.js';
import { applyHeldObjectGrouping, composeSeedreamPrompt, type Planner } from './layerizePlanner.js';
import { createLayerizeRouter } from './layerizeRouter.js';
import { createGroup, generateVariant, liveGenerationConfig, queueVariant, readGroup, recordDecomposition, variantImage, type GenerationConfig, type GenerationGroup } from './templateAGeneration.js';

// Every provider here is a fake: no OpenAI, fal or Seedream request is made by this file.
const MODEL = DEFAULT_IMAGE_MODEL;
const BASE = buildTemplateAPrompt(TEMPLATE_A_DEFAULTS);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const png = (width: number, height: number, color = '#2f6b2f') => sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
type ImageRequest = { model: string; prompt: string; size: string; n: number; output_format: string };
/** A fake OpenAI images client: records each request and returns one PNG of the requested size as base64, as the GPT image models do. */
function imageFake() {
  const sent: Buffer[] = [];
  const generate = vi.fn(async (request: ImageRequest): Promise<unknown> => {
    const [width, height] = request.size.split('x').map(Number), bytes = await png(width, height, ['#2f6b2f', '#6b2f2f', '#2f2f6b'][sent.length % 3]);
    sent.push(bytes);
    return Object.defineProperty({ created: 1, output_format: 'png', size: request.size, data: [{ b64_json: bytes.toString('base64') }] }, '_request_id', { value: `req_img_${sent.length}` });
  });
  return { generate, sent, config: { model: MODEL, client: () => ({ images: { generate } }) as unknown as ReturnType<GenerationConfig['client']> } satisfies GenerationConfig };
}
/** An OpenAI API error as the SDK throws it. */
const apiError = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code, requestID: 'req_img_err', error: { message, code, type: 'invalid_request_error' } });
const fields = (overrides: Partial<typeof TEMPLATE_A_DEFAULTS> = {}) => ({ ...TEMPLATE_A_DEFAULTS, ...overrides });
const root = () => mkdtempSync(join(tmpdir(), 'generations-'));
const statuses = (group: GenerationGroup) => Object.fromEntries(group.variants.map(variant => [variant.id, variant.status]));
/** Generates the given variants one after the other, as the router's queue does. */
async function generateAll(dir: string, groupId: string, variantIds: string[], config: GenerationConfig) {
  for (const variantId of variantIds) { queueVariant(dir, groupId, variantId); await generateVariant(dir, groupId, variantId, config); }
  return readGroup(dir, groupId);
}

describe('Template A test generator (one creative → three aspect-ratio variants → Template A decomposition)', () => {
  describe('models', () => {
    it('names the planner and image models in one place, each with its environment override', () => {
      expect([DEFAULT_PLANNER_MODEL, DEFAULT_IMAGE_MODEL]).toEqual(['gpt-5-mini', 'gpt-image-2']);
      expect([plannerModel({}), imageModel({})]).toEqual(['gpt-5-mini', 'gpt-image-2']);
      expect(plannerModel({ OPENAI_DECOMPOSITION_MODEL: ' gpt-5.4-mini ' })).toBe('gpt-5.4-mini');
      expect(imageModel({ OPENAI_IMAGE_MODEL: ' gpt-image-2-2026-04-21 ' })).toBe('gpt-image-2-2026-04-21');
      expect(liveGenerationConfig({ OPENAI_IMAGE_MODEL: 'gpt-image-1.5' }).model).toBe('gpt-image-1.5');
      // A fal endpoint id left over from the text-to-image generator is refused, not sent to OpenAI.
      expect(() => imageModel({ OPENAI_IMAGE_MODEL: 'bytedance/seedream/v5/pro/text-to-image' })).toThrow('OPENAI_IMAGE_MODEL');
    });
  });

  describe('a group: one creative definition, one variant per aspect ratio', () => {
    it('creates the group without sending anything: the shared definition once, and a pending variant per ratio with its exact prompt', () => {
      const dir = root(), openai = imageFake();
      const { group, requested } = createGroup(dir, { fields: {} }, openai.config);
      expect(openai.generate).not.toHaveBeenCalled();
      expect(requested).toEqual(['1x1', '16x9', '4x5']);
      expect(group).toMatchObject({ templateKey: 'template-a', version: 'template-a-generation-v3', fields: TEMPLATE_A_DEFAULTS, builtPrompt: BASE, basePrompt: BASE, promptEdited: false,
        structure: { visibleBorder: true, heldObject: true }, aspectRatios: ['1:1', '16:9', '4:5'] });
      expect(group.variants.map(variant => [variant.id, variant.aspectRatio, variant.size, variant.status, variant.attempts])).toEqual([
        ['1x1', '1:1', { width: 1024, height: 1024 }, 'pending', 0], ['16x9', '16:9', { width: 1536, height: 864 }, 'pending', 0], ['4x5', '4:5', { width: 1216, height: 1520 }, 'pending', 0]]);
      // Every variant's prompt is the same base and the same consistency sentence; only the framing sentence differs.
      for (const variant of group.variants) {
        expect(variant.prompt).toBe(`${BASE} ${TEMPLATE_A_CONSISTENCY} ${variant.framing}`);
        expect(variant.framing).toBe(TEMPLATE_A_RATIO_FRAMING[variant.aspectRatio as keyof typeof TEMPLATE_A_RATIO_FRAMING]);
        expect(variant.prompt.replace(variant.framing, '')).toBe(group.variants[0].prompt.replace(group.variants[0].framing, ''));
      }
      expect(new Set(group.variants.map(variant => variant.framing)).size).toBe(3);
      expect(readGroup(dir, group.id)).toEqual(group);
      expect(readdirSync(join(dir, group.id))).toEqual(['group.json']);
    });

    it('requests sizes both OpenAI Image 2 and Seedream Layerize accept', () => {
      for (const ratio of TEMPLATE_A_ASPECT_RATIOS) {
        const { width, height } = TEMPLATE_A_IMAGE_SIZES[ratio], [w, h] = ratio.split(':').map(Number);
        // OpenAI Image 2: both sides divisible by 16, aspect ratio between 1:3 and 3:1; and exactly the named ratio.
        expect([width % 16, height % 16]).toEqual([0, 0]);
        expect(width * h).toBe(height * w);
        // Seedream Layerize: the adapter's local size check, which a decomposition runs before anything is sent.
        expect(() => buildProviderInput('seedream', { imageUrl: 'https://fal.media/validation-only', width, height })).not.toThrow();
      }
    });

    it('sends OpenAI exactly each variant\'s prompt at its size, and saves each variant\'s own files', async () => {
      const dir = root(), openai = imageFake();
      const { group: created, requested } = createGroup(dir, { fields: {} }, openai.config);
      const group = await generateAll(dir, created.id, requested, openai.config);
      expect(openai.generate.mock.calls.map(([request]) => request)).toEqual([
        { model: MODEL, prompt: buildTemplateAVariantPrompt(BASE, '1:1'), size: '1024x1024', n: 1, output_format: 'png' },
        { model: MODEL, prompt: buildTemplateAVariantPrompt(BASE, '16:9'), size: '1536x864', n: 1, output_format: 'png' },
        { model: MODEL, prompt: buildTemplateAVariantPrompt(BASE, '4:5'), size: '1216x1520', n: 1, output_format: 'png' }]);
      expect(group.variants.map(variant => [variant.status, variant.attempts, variant.generator, variant.image?.file, [variant.image?.width, variant.image?.height]])).toEqual([
        ['done', 1, { provider: 'openai', model: MODEL, requestId: 'req_img_1' }, '1x1.image.png', [1024, 1024]],
        ['done', 1, { provider: 'openai', model: MODEL, requestId: 'req_img_2' }, '16x9.image.png', [1536, 864]],
        ['done', 1, { provider: 'openai', model: MODEL, requestId: 'req_img_3' }, '4x5.image.png', [1216, 1520]]]);
      // Saved as OpenAI returned them, plus each request and response (the image bytes only in the image file).
      group.variants.forEach((variant, index) => {
        expect(readFileSync(join(dir, group.id, variant.image!.file)).equals(openai.sent[index])).toBe(true);
        expect(variant.image).toMatchObject({ mimeType: 'image/png', bytes: openai.sent[index].length, sha256: sha(openai.sent[index]) });
        expect(JSON.parse(readFileSync(join(dir, group.id, variant.requestFile!), 'utf8'))).toEqual(openai.generate.mock.calls[index][0]);
        const response = readFileSync(join(dir, group.id, variant.responseFile!), 'utf8');
        expect(JSON.parse(response)).toMatchObject({ output_format: 'png', data: [{ b64_json: expect.stringMatching(/^<\d+ base64 characters/) }] });
        expect(response).not.toContain(openai.sent[index].toString('base64').slice(0, 64));
      });
      expect(readdirSync(join(dir, group.id)).sort()).toEqual(['16x9.image.png', '16x9.openai-request.json', '16x9.openai-response.json', '1x1.image.png', '1x1.openai-request.json', '1x1.openai-response.json',
        '4x5.image.png', '4x5.openai-request.json', '4x5.openai-response.json', 'group.json']);
      // Ratio-specific data never reaches the shared definition.
      const { variants: _created, updatedAt: _a, ...before } = created, { variants: _generated, updatedAt: _b, ...after } = group; void _created; void _generated; void _a; void _b;
      expect(after).toEqual(before);
    });

    it('applies an edited base prompt to every ratio alike, and never accepts a final prompt', () => {
      const dir = root(), openai = imageFake();
      const edited = `${BASE} The subject wears a bright red scarf.`;
      const { group } = createGroup(dir, { fields: {}, basePrompt: `  ${edited.replace('. ', '.\n')}  ` }, openai.config);
      expect(group).toMatchObject({ promptEdited: true, builtPrompt: BASE, basePrompt: edited });
      expect(group.variants.map(variant => variant.prompt)).toEqual(TEMPLATE_A_ASPECT_RATIOS.map(ratio => `${edited} ${TEMPLATE_A_CONSISTENCY} ${TEMPLATE_A_RATIO_FRAMING[ratio]}`));
      // Sending the built prompt back unchanged is not an edit.
      expect(createGroup(dir, { fields: {}, basePrompt: BASE }, openai.config).group.promptEdited).toBe(false);
      for (const [input, code] of [[{ fields: {}, prompt: 'A photo of a lake.' }, 'PROMPT_NOT_ACCEPTED'], [{ fields: {}, basePrompt: 'Too short' }, 'INVALID_PROMPT'], [{ fields: {}, basePrompt: 42 }, 'INVALID_PROMPT'],
        [{ fields: {}, basePrompt: `A portrait. ${'x'.repeat(2000)}` }, 'INVALID_PROMPT'], [{ fields: { subject: '  ' } }, 'INVALID_FIELDS'], [{ fields: { outerBackground: '...' } }, 'INVALID_FIELDS'], [{ fields: { generator: 'gemini' } }, 'INVALID_FIELDS'],
        [{ fields: {}, aspectRatios: ['2:3'] }, 'INVALID_ASPECT_RATIO'], [{ fields: {}, aspectRatios: [] }, 'INVALID_ASPECT_RATIO'], [{ fields: {}, aspectRatios: ['1:1', '1:1'] }, 'INVALID_ASPECT_RATIO'], [{ fields: {}, aspectRatios: '1:1' }, 'INVALID_ASPECT_RATIO'],
        [{ fields: Object.fromEntries(Object.entries(TEMPLATE_A_DEFAULTS).map(([k]) => [k, 'x'.repeat(k === 'frameShape' || k === 'frameBorder' ? 80 : 120)])) }, 'INVALID_FIELDS']] as const) {
        expect(() => createGroup(dir, input, openai.config)).toThrow(expect.objectContaining({ code }));
      }
      // Refused requests create nothing and send nothing.
      expect(readdirSync(dir)).toHaveLength(2);
      expect(openai.generate).not.toHaveBeenCalled();
    });

    it('keeps the other variants when one fails, and generates only the failed one again', async () => {
      const dir = root(), openai = imageFake();
      const { group: created, requested } = createGroup(dir, { fields: fields({ subject: 'golden retriever dog', outfit: '' }) }, openai.config);
      // The second request (16:9) is refused by the provider; the first and third succeed.
      const real = openai.generate.getMockImplementation()!;
      openai.generate.mockImplementationOnce(real).mockRejectedValueOnce(apiError(400, 'moderation_blocked', 'Your request was rejected by the safety system.'));
      const group = await generateAll(dir, created.id, requested, openai.config);
      expect(statuses(group)).toEqual({ '1x1': 'done', '16x9': 'failed', '4x5': 'done' });
      const failed = group.variants[1];
      expect(failed).toMatchObject({ attempts: 1, generator: { requestId: 'req_img_err' }, error: { code: 'PROVIDER_SAFETY_REFUSAL', status: 400, messages: [{ msg: 'Your request was rejected by the safety system.', type: 'moderation_blocked' }], bodyFile: '16x9.provider-error.json' } });
      expect(failed).not.toHaveProperty('image');
      expect(JSON.parse(readFileSync(join(dir, group.id, '16x9.provider-error.json'), 'utf8'))).toMatchObject({ requestId: 'req_img_err', status: 400, body: { code: 'moderation_blocked' } });
      // The fields and prompt stay with the group whatever happened to a variant.
      expect(group).toMatchObject({ fields: created.fields, basePrompt: created.basePrompt });
      // Generating the failed ratio again sends one request, with the same prompt, and leaves the two finished ones untouched.
      const others = [group.variants[0], group.variants[2]];
      const again = await generateAll(dir, group.id, ['16x9'], openai.config);
      expect(openai.generate).toHaveBeenCalledTimes(4);
      expect(openai.generate.mock.calls[3][0]).toEqual({ model: MODEL, prompt: failed.prompt, size: '1536x864', n: 1, output_format: 'png' });
      expect(again.variants[1]).toMatchObject({ status: 'done', attempts: 2, image: { file: '16x9.image.png', width: 1536, height: 864 } });
      expect(again.variants[1]).not.toHaveProperty('error');
      expect([again.variants[0], again.variants[2]]).toEqual(others);
      // A variant that has its image is never generated again: a decomposition may point at it.
      expect(() => queueVariant(dir, group.id, '1x1')).toThrow(expect.objectContaining({ code: 'ALREADY_GENERATED' }));
      await expect(generateVariant(dir, group.id, '1x1', openai.config)).rejects.toMatchObject({ code: 'ALREADY_GENERATED' });
      expect(() => queueVariant(dir, group.id, '9x16')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
      expect(openai.generate).toHaveBeenCalledTimes(4);
    });

    it('records each kind of failure on the variant, with its own code, and never retries by itself', async () => {
      const dir = root(), openai = imageFake();
      for (const [error, code] of [[apiError(429, 'insufficient_quota', 'You exceeded your current quota.'), 'PROVIDER_CREDITS'], [apiError(401, 'invalid_api_key', 'Incorrect API key.'), 'PROVIDER_AUTH'],
        [apiError(429, 'rate_limit_exceeded', 'Rate limit reached.'), 'PROVIDER_RATE_LIMITED'], [apiError(503, 'server_error', 'Overloaded.'), 'PROVIDER_NETWORK'],
        [apiError(400, 'invalid_size', 'Invalid size.'), 'PROVIDER_REJECTED'], [new Error('Request timed out.'), 'GENERATION_FAILED']] as const) {
        const { group } = createGroup(dir, { fields: {}, aspectRatios: ['1:1'] }, openai.config), calls = openai.generate.mock.calls.length;
        openai.generate.mockRejectedValueOnce(error);
        expect((await generateAll(dir, group.id, ['1x1'], openai.config)).variants[0].error).toMatchObject({ code });
        expect(openai.generate).toHaveBeenCalledTimes(calls + 1);
      }
      // A response without an image, or with bytes that are not an image, is a failure too, never an image.
      const { group } = createGroup(dir, { fields: {} }, openai.config);
      openai.generate.mockResolvedValueOnce({ created: 1, data: [] });
      openai.generate.mockResolvedValueOnce({ created: 1, data: [{ b64_json: Buffer.from('not an image').toString('base64') }] });
      const result = await generateAll(dir, group.id, ['1x1', '16x9'], openai.config);
      expect(result.variants.map(variant => [variant.status, variant.error?.code])).toEqual([['failed', 'NO_IMAGE'], ['failed', 'INVALID_IMAGE'], ['pending', undefined]]);
      expect(() => variantImage(dir, group.id, '1x1')).toThrow(expect.objectContaining({ code: 'NOT_DECOMPOSABLE' }));
    });

    it('without OPENAI_API_KEY saves a failed variant and makes no request', async () => {
      const dir = root(), request = vi.fn();
      vi.stubGlobal('fetch', request);
      try {
        const config = liveGenerationConfig({});
        const { group } = createGroup(dir, { fields: {}, aspectRatios: ['1:1'] }, config);
        expect((await generateAll(dir, group.id, ['1x1'], config)).variants[0]).toMatchObject({ status: 'failed', generator: { provider: 'openai', model: MODEL }, error: { code: 'GENERATOR_NOT_CONFIGURED' } });
        expect(request).not.toHaveBeenCalled();
      } finally { vi.unstubAllGlobals(); }
    });

    it('makes a new group for every new or changed creative and never rewrites an earlier one', async () => {
      const dir = root(), openai = imageFake();
      const first = createGroup(dir, { fields: {} }, openai.config).group;
      await generateAll(dir, first.id, ['1x1'], openai.config);
      const saved = readFileSync(join(dir, first.id, 'group.json'), 'utf8');
      await new Promise(done => setTimeout(done, 5));
      const second = createGroup(dir, { fields: fields({ subject: 'older man', heldObject: 'acoustic guitar' }) }, openai.config).group;
      const third = createGroup(dir, { fields: {}, basePrompt: `${BASE} Warm evening light.` }, openai.config).group;
      expect(new Set([first.id, second.id, third.id]).size).toBe(3);
      expect(readFileSync(join(dir, first.id, 'group.json'), 'utf8')).toBe(saved);
      expect(second.variants.every(variant => variant.prompt.includes('older man') && variant.prompt.includes('an acoustic guitar'))).toBe(true);
      expect(readGroup(dir, first.id).variants[0].prompt).not.toContain('older man');
    });
  });

  describe('endpoints and the decomposition handoff', () => {
    const A_PROMPT = composeSeedreamPrompt('Keep the main subject whole. Separate each held object into its own layer.');
    async function server(openai: ReturnType<typeof imageFake>, gate: Promise<void> = Promise.resolve()) {
      const runsDir = mkdtempSync(join(tmpdir(), 'layerize-')), generationsDir = root();
      const base = await png(64, 64, '#010203');
      const contexts: unknown[] = [], uploads: Buffer[] = [], submitted: Record<string, unknown>[] = [];
      const planner: Planner = async (image, _mime, context) => { await gate; contexts.push(context); uploads.push(image); return { plan: { prompt: A_PROMPT, planned_layers: [], warnings: [] }, model: 'm', raw: {}, request: {} }; };
      const transport: FalTransport = { upload: async () => 'https://v3b.fal.media/files/t/in.png', submit: async (_e, input) => { submitted.push(input); return { requestId: 'r' }; }, status: async () => 'COMPLETED',
        result: async () => ({ layers: [{ image: { url: 'https://v3b.fal.media/files/t/b.png' }, z_index: 0 }] }), cancel: async () => undefined, download: async () => base };
      const deps = (): RunnerDeps => ({ planner, transport: () => transport, sleep: async () => undefined });
      const app = express().use('/x', createLayerizeRouter({ runsDir, deps, generationsDir, generation: () => openai.config })).listen(0, '127.0.0.1');
      await new Promise(done => app.once('listening', done));
      const { port } = app.address() as AddressInfo;
      const url = (path: string) => `http://127.0.0.1:${port}/x${path}`;
      const get = async (path: string) => (await fetch(url(path))).json();
      const post = async (path: string, body: unknown = {}) => { const r = await fetch(url(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
      const idle = async () => { for (let i = 0; i < 200 && (await get('/runs')).active; i++) await new Promise(done => setTimeout(done, 20)); };
      /** Waits until no variant of the group is queued or generating, and returns the group. */
      const settled = async (id: string): Promise<GenerationGroup> => {
        for (let i = 0; i < 300; i++) {
          const group = await get(`/template-a/groups/${id}`) as GenerationGroup;
          if (!group.variants.some(variant => variant.status === 'queued' || variant.status === 'generating')) return group;
          await new Promise(done => setTimeout(done, 10));
        }
        throw new Error('The group never settled.');
      };
      const generate = async (f: Partial<typeof TEMPLATE_A_DEFAULTS> = {}, aspectRatios?: string[]) => settled(((await post('/template-a/groups', { fields: fields(f), ...(aspectRatios ? { aspectRatios } : {}) })).body as GenerationGroup).id);
      return { app, url, get, post, idle, settled, generate, runsDir, generationsDir, contexts, uploads, submitted };
    }

    it('shows OpenAI, the three ratios and their framing; generates a group in the background; decomposes exactly one variant\'s bytes', async () => {
      const openai = imageFake(), s = await server(openai);
      try {
        const info = await s.get('/template-a/generator');
        expect(info).toMatchObject({ version: 'template-a-generation-v3', aspectRatios: ['1:1', '16:9', '4:5'], imageSizes: TEMPLATE_A_IMAGE_SIZES, framing: TEMPLATE_A_RATIO_FRAMING, consistency: TEMPLATE_A_CONSISTENCY });
        expect(info.generator).toEqual({ provider: 'openai', model: MODEL });
        expect(JSON.stringify(info)).not.toMatch(/cloudflare|gemini|seedream|text-to-image/i);
        expect(await s.post('/template-a/groups', { fields: {}, prompt: 'anything' })).toMatchObject({ status: 400, body: { error: { code: 'PROMPT_NOT_ACCEPTED' } } });
        // The answer comes at once, with the variants on their way; they finish in the background, one request each.
        const started = await s.post('/template-a/groups', { fields: fields() });
        expect(started.status).toBe(202);
        expect(Object.values(statuses(started.body as GenerationGroup)).every(status => status === 'queued' || status === 'generating')).toBe(true);
        const group = await s.settled((started.body as GenerationGroup).id);
        expect(statuses(group)).toEqual({ '1x1': 'done', '16x9': 'done', '4x5': 'done' });
        expect(openai.generate.mock.calls.map(([request]) => request.size)).toEqual(['1024x1024', '1536x864', '1216x1520']);
        // Generating is OpenAI only: nothing went to fal.
        expect(s.submitted).toEqual([]);
        expect(((await s.get('/template-a/groups')).groups as GenerationGroup[]).map(item => item.id)).toEqual([group.id]);
        for (const [index, variant] of group.variants.entries()) {
          const image = Buffer.from(await (await fetch(s.url(`/template-a/groups/${group.id}/variants/${variant.id}/image`))).arrayBuffer());
          expect(sha(image)).toBe(sha(openai.sent[index]));
        }
        // Decompose the 16:9 variant, and only it.
        const run = await s.post(`/template-a/groups/${group.id}/variants/16x9/decompose`, { separateHeldObject: false });
        expect(run).toMatchObject({ status: 202, body: { templateKey: 'template-a', separateHeldObject: false, layerTarget: { templateKey: 'template-a', suggestedLayers: 5, targetLayers: 5 },
          origin: { kind: 'template-a-generation', generationId: group.id, variantId: '16x9', aspectRatio: '16:9' } } });
        await s.idle();
        const saved = readRun(join(s.runsDir, run.body.id));
        expect(saved.stage).toBe('done');
        expect(saved.original).toMatchObject({ width: 1536, height: 864 });
        // Exactly the generated bytes of that variant: no re-encoding before the upload.
        expect(sha(readFileSync(join(s.runsDir, saved.id, saved.original.file)))).toBe(sha(openai.sent[1]));
        expect(sha(s.uploads[0])).toBe(sha(openai.sent[1]));
        // Decomposition is the planner then one fal Seedream Layerize call; the image model is not called again.
        expect(openai.generate).toHaveBeenCalledTimes(3);
        expect(s.submitted).toHaveLength(1);
        // The Template A pipeline itself is unchanged.
        expect(s.contexts).toEqual([{ separateHeldObject: false }]);
        expect(s.submitted[0].prompt).toBe(applyHeldObjectGrouping(A_PROMPT, false));
        // The run is linked on its own variant; the other two have none.
        const after = await s.get(`/template-a/groups/${group.id}`) as GenerationGroup;
        expect(after.variants.map(variant => variant.decompositions)).toEqual([[], [{ runId: saved.id, createdAt: saved.createdAt, separateHeldObject: false, targetLayers: 5 }], []]);
        // Another variant, with the object separate this time: its own run, its own link.
        const second = await s.post(`/template-a/groups/${group.id}/variants/4x5/decompose`, { separateHeldObject: true });
        expect(second.body).toMatchObject({ separateHeldObject: true, layerTarget: { targetLayers: 6 }, origin: { variantId: '4x5', aspectRatio: '4:5' } });
        await s.idle();
        expect(sha(s.uploads[1])).toBe(sha(openai.sent[2]));
        expect(((await s.get(`/template-a/groups/${group.id}`)) as GenerationGroup).variants.map(variant => variant.decompositions.length)).toEqual([0, 1, 1]);
      } finally { s.app.close(); }
    });

    it('generates only the ratios asked for, the rest later and one at a time; a missing image cannot be decomposed', async () => {
      const openai = imageFake(), s = await server(openai);
      try {
        const group = await s.generate({}, ['4:5']);
        expect(statuses(group)).toEqual({ '1x1': 'pending', '16x9': 'pending', '4x5': 'done' });
        expect(openai.generate).toHaveBeenCalledTimes(1);
        // Only the variant that has an image can be decomposed.
        expect(await s.post(`/template-a/groups/${group.id}/variants/1x1/decompose`)).toMatchObject({ status: 400, body: { error: { code: 'NOT_DECOMPOSABLE' } } });
        expect(await s.post(`/template-a/groups/${group.id}/variants/9x16/decompose`)).toMatchObject({ status: 404 });
        expect((await fetch(s.url(`/template-a/groups/${group.id}/variants/1x1/image`))).status).toBe(404);
        // One more ratio of the same creative, later: one request, the same shared definition.
        openai.generate.mockRejectedValueOnce(apiError(500, 'server_error', 'The server had an error.'));
        expect((await s.post(`/template-a/groups/${group.id}/variants/16x9/generate`)).status).toBe(202);
        expect(statuses(await s.settled(group.id))).toEqual({ '1x1': 'pending', '16x9': 'failed', '4x5': 'done' });
        expect((await s.post(`/template-a/groups/${group.id}/variants/16x9/generate`)).status).toBe(202);
        const later = await s.settled(group.id);
        expect(statuses(later)).toEqual({ '1x1': 'pending', '16x9': 'done', '4x5': 'done' });
        expect(later.variants[1]).toMatchObject({ attempts: 2 });
        expect(openai.generate).toHaveBeenCalledTimes(3);
        expect({ fields: later.fields, basePrompt: later.basePrompt, createdAt: later.createdAt }).toEqual({ fields: group.fields, basePrompt: group.basePrompt, createdAt: group.createdAt });
        // A finished variant is refused; nothing is sent.
        expect(await s.post(`/template-a/groups/${group.id}/variants/4x5/generate`)).toMatchObject({ status: 400, body: { error: { code: 'ALREADY_GENERATED' } } });
        expect(openai.generate).toHaveBeenCalledTimes(3);
        expect(s.submitted).toEqual([]);
      } finally { s.app.close(); }
    });

    it('takes the default target from the creative\'s structure: border or not, held object or not', async () => {
      const openai = imageFake(), s = await server(openai);
      try {
        const expectations: [Partial<typeof TEMPLATE_A_DEFAULTS>, boolean | undefined, boolean, number][] = [
          [{}, true, true, 6], [{}, false, false, 5],
          [{ frameBorder: 'no visible border' }, true, true, 5], [{ frameBorder: '' }, false, false, 4],
          // No held object: always combined (base, outer, inner, border, subject), minus the border when there is none.
          [{ heldObject: '' }, undefined, false, 5], [{ heldObject: '', frameBorder: 'none' }, undefined, false, 4],
        ];
        for (const [f, requested, separate, target] of expectations) {
          const group = await s.generate(f, ['1:1']);
          const started = await s.post(`/template-a/groups/${group.id}/variants/1x1/decompose`, requested === undefined ? {} : { separateHeldObject: requested });
          expect(started.body).toMatchObject({ separateHeldObject: separate, layerTarget: { suggestedLayers: target, targetLayers: target } });
          await s.idle();
        }
        // A creative without an object cannot be decomposed "separate"; an out-of-range target is refused.
        const bare = await s.generate({ heldObject: '' }, ['1:1']);
        expect(await s.post(`/template-a/groups/${bare.id}/variants/1x1/decompose`, { separateHeldObject: true })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_REQUEST' } } });
        expect(await s.post(`/template-a/groups/${bare.id}/variants/1x1/decompose`, { targetLayers: 6 })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_TARGET_LAYERS' } } });
      } finally { s.app.close(); }
    });

    it('reads records from before groups as one-image groups: listed, decomposable, never regenerated, left in their own format', async () => {
      const openai = imageFake();
      let release = () => undefined as void;
      const s = await server(openai, new Promise<void>(done => { release = done; }));
      try {
        const picture = await png(1024, 1536);
        // A v1 record (no structure stored, generator by id) and a v2 record (fal), as they are on disk.
        const v1 = '2026-09-29T12-01-18-637Z-20619e', v2 = '2026-09-29T13-15-39-591Z-641a54', failed = '2026-09-29T13-24-03-264Z-912e1a';
        mkdirSync(join(s.generationsDir, v1));
        writeFileSync(join(s.generationsDir, v1, 'image.jpg'), await sharp(picture).jpeg().toBuffer());
        const v1Record = { id: v1, templateKey: 'template-a', version: 'template-a-generation-v1', createdAt: '2026-09-29T12:01:18.637Z', status: 'done', fields: fields({ frameBorder: '', heldObject: 'a red frisbee' }),
          prompt: 'old', generator: { id: 'cloudflare', model: 'x' }, aspectRatio: '2:3', image: { file: 'image.jpg', mimeType: 'image/jpeg', width: 1024, height: 1536, bytes: 1 }, decompositions: [] };
        writeFileSync(join(s.generationsDir, v1, 'generation.json'), JSON.stringify(v1Record));
        mkdirSync(join(s.generationsDir, v2));
        writeFileSync(join(s.generationsDir, v2, 'image.png'), picture);
        writeFileSync(join(s.generationsDir, v2, 'generation.json'), JSON.stringify({ id: v2, templateKey: 'template-a', version: 'template-a-generation-v2', createdAt: '2026-09-29T13:15:39.591Z', updatedAt: '2026-09-29T13:16:00.000Z', status: 'done', fields: fields(),
          prompt: BASE, structure: { visibleBorder: true, heldObject: true }, generator: { provider: 'fal', model: 'bytedance/seedream/v5/pro/text-to-image', requestId: 'fal-1' }, aspectRatio: '2:3', size: { width: 1024, height: 1536 },
          image: { file: 'image.png', mimeType: 'image/png', width: 1024, height: 1536, bytes: picture.length, sha256: sha(picture) }, decompositions: [{ runId: 'earlier-run', createdAt: '2026-09-29T13:20:00.000Z', separateHeldObject: true, targetLayers: 6 }] }));
        mkdirSync(join(s.generationsDir, failed));
        writeFileSync(join(s.generationsDir, failed, 'generation.json'), JSON.stringify({ id: failed, templateKey: 'template-a', version: 'template-a-generation-v2', createdAt: '2026-09-29T13:24:03.264Z', status: 'failed', fields: fields(), prompt: BASE,
          generator: { provider: 'fal', model: 'not-a-real-endpoint' }, aspectRatio: '2:3', error: { code: 'PROVIDER_REJECTED', message: 'No such endpoint.' }, decompositions: [] }));
        const groups = (await s.get('/template-a/groups')).groups as GenerationGroup[];
        expect(groups.map(group => [group.id, group.legacy, group.aspectRatios, group.variants.map(variant => [variant.id, variant.aspectRatio, variant.status, variant.generator.provider])])).toEqual([
          [failed, true, ['2:3'], [['single', '2:3', 'failed', 'fal']]], [v2, true, ['2:3'], [['single', '2:3', 'done', 'fal']]], [v1, true, ['2:3'], [['single', '2:3', 'done', 'cloudflare']]]]);
        expect(groups[1]).toMatchObject({ basePrompt: BASE, promptEdited: false, variants: [{ prompt: BASE, decompositions: [{ runId: 'earlier-run' }] }] });
        expect(groups[0].variants[0].error).toMatchObject({ code: 'PROVIDER_REJECTED' });
        // The v1 record has no stored structure: it comes from its fields (no border, a held object → 4 layers combined).
        const old = await s.post(`/template-a/groups/${v1}/variants/single/decompose`, { separateHeldObject: false });
        expect(old.body).toMatchObject({ layerTarget: { targetLayers: 4 }, origin: { generationId: v1, variantId: 'single', aspectRatio: '2:3' } });
        // One run at a time, as for uploads.
        expect(await s.post(`/template-a/groups/${v2}/variants/single/decompose`)).toMatchObject({ status: 409, body: { error: { code: 'BUSY' } } });
        release();
        await s.idle();
        // The link is written into the old record in its own format; nothing else in it changes.
        const rewritten = JSON.parse(readFileSync(join(s.generationsDir, v1, 'generation.json'), 'utf8'));
        expect(rewritten).toMatchObject({ ...v1Record, decompositions: [{ runId: old.body.id, separateHeldObject: false, targetLayers: 4 }] });
        expect(readdirSync(join(s.generationsDir, v1)).sort()).toEqual(['generation.json', 'image.jpg']);
        // An old record is never regenerated, and a failed one has nothing to decompose.
        expect(await s.post(`/template-a/groups/${failed}/variants/single/generate`)).toMatchObject({ status: 400, body: { error: { code: 'LEGACY_RECORD' } } });
        expect(await s.post(`/template-a/groups/${failed}/variants/single/decompose`)).toMatchObject({ status: 400, body: { error: { code: 'NOT_DECOMPOSABLE' } } });
        expect(openai.generate).not.toHaveBeenCalled();
      } finally { s.app.close(); }
    });

    it('shows a variant a stopped server left unfinished as interrupted, and lets it be generated again', async () => {
      const openai = imageFake(), s = await server(openai);
      try {
        // A group whose 1:1 variant was being generated when the server stopped: nothing in this process is working on it.
        const { group } = createGroup(s.generationsDir, { fields: {} }, openai.config);
        queueVariant(s.generationsDir, group.id, '1x1');
        expect(readGroup(s.generationsDir, group.id).variants[0].status).toBe('queued');
        const shown = await s.get(`/template-a/groups/${group.id}`) as GenerationGroup;
        expect(shown.variants[0]).toMatchObject({ status: 'failed', error: { code: 'INTERRUPTED' } });
        expect(shown.variants[1].status).toBe('pending');
        // Looking at it did not change the file; generating it again does, with one request.
        expect(readGroup(s.generationsDir, group.id).variants[0].status).toBe('queued');
        expect((await s.post(`/template-a/groups/${group.id}/variants/1x1/generate`)).status).toBe(202);
        expect((await s.settled(group.id)).variants[0]).toMatchObject({ status: 'done', attempts: 1 });
        expect(openai.generate).toHaveBeenCalledTimes(1);
      } finally { s.app.close(); }
    });

    it('links decompositions made at the same time as a variant finishes without losing either', async () => {
      const dir = root(), openai = imageFake();
      const { group } = createGroup(dir, { fields: {} }, openai.config);
      await generateAll(dir, group.id, ['1x1'], openai.config);
      queueVariant(dir, group.id, '16x9');
      const generating = generateVariant(dir, group.id, '16x9', openai.config);
      // While 16:9 is being generated, a run of the finished 1:1 variant is linked.
      recordDecomposition(dir, group.id, '1x1', { runId: 'run-1', createdAt: '2026-09-30T00:00:00.000Z', separateHeldObject: true, targetLayers: 6 });
      await generating;
      const after = readGroup(dir, group.id);
      expect(after.variants[0].decompositions).toEqual([{ runId: 'run-1', createdAt: '2026-09-30T00:00:00.000Z', separateHeldObject: true, targetLayers: 6 }]);
      expect(after.variants[1].status).toBe('done');
    });
  });
});
