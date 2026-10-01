import { verboseImageAnalysis } from './imageTemplateAnalysis.fixture.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import express from 'express';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { IMAGE_TEMPLATE_LIMITS, IMAGE_TEMPLATE_REQUEST_LIMIT, buildImageTemplatePrompt, normalizeImageAnalysis, IMAGE_TEMPLATE_CONSISTENCY, IMAGE_TEMPLATE_FRAMING, IMAGE_TEMPLATE_REFERENCE_INSTRUCTION, templateBGenerationProfile } from '@frameflow/shared';
import type { FalTransport } from './providers/falClient.js';
import { generateVariant, type GenerationConfig, type GenerationGroup } from './generationGroups.js';
import { MAX_UPLOAD_BYTES, readRun, type RunnerDeps } from './layerizeExperiment.js';
import { createOpenAIPlanner } from './layerizePlanner.js';
import { createLayerizeRouter } from './layerizeRouter.js';
import { PLAN_SCHEMA_B } from './layerizeTemplateB.js';
import { PLAN_SCHEMA_C } from './layerizeTemplateC.js';
import { TEMPLATES } from './layerizeTemplates.js';
import { createImageTemplate, createOpenAIImagePromptWriter, imagePromptInstruction, referenceForPrompt, startImageTemplateGeneration, type ImagePromptWriter, type ImageTemplate } from './imageTemplates.js';

// "Create Template from Image" with every provider faked: no OpenAI, fal or Seedream request is made by this file. Any
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
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const PROMPT = 'A premium product advertisement in a soft 3D render style: a lavender smartphone stands upright in the centre on a white round platform, with pale spheres floating around it, on a pastel lilac studio background with soft daylight.';

type ImageRequest = { model: string; prompt: string; size: string; n: number; output_format: string; image?: File };
/** A fake OpenAI images client: one PNG of the requested size per request, recording each request and its method. */
function imageFake() {
  const sent: Buffer[] = [], inputs: (string | undefined)[] = [], requests: (ImageRequest & { method: string })[] = [];
  let fail: ((request: ImageRequest) => boolean) | undefined, gate = Promise.resolve();
  const send = vi.fn(async (request: ImageRequest, method: 'generate' | 'edit') => {
    requests.push({ ...request, method });
    inputs.push(request.image ? sha(Buffer.from(await request.image.arrayBuffer())) : undefined);
    await gate;
    if (fail?.(request)) throw Object.assign(new Error('The server had an error.'), { status: 500, code: 'server_error', requestID: 'req_img_err', error: { message: 'The server had an error.' } });
    const [width, height] = request.size.split('x').map(Number), bytes = await png(width, height, ['#2f6b2f', '#6b2f2f', '#2f2f6b'][sent.length % 3]);
    sent.push(bytes);
    return Object.defineProperty({ created: 1, data: [{ b64_json: bytes.toString('base64') }] }, '_request_id', { value: `req_img_${sent.length}` });
  });
  const generate = vi.fn((request: ImageRequest) => send(request, 'generate')), edit = vi.fn((request: ImageRequest) => send(request, 'edit'));
  return { send, sent, inputs, requests, failWhen: (rule: typeof fail) => { fail = rule; }, hold: () => { let release!: () => void; gate = new Promise<void>(done => { release = done; }); return release; },
    config: { model: 'gpt-image-2', client: () => ({ images: { generate, edit } }) as unknown as ReturnType<GenerationConfig['client']> } satisfies GenerationConfig };
}
/** A fake prompt writer: answers with a prompt, a name and a layer style, and keeps what it was sent. */
function writerFake(answer: Partial<{ prompt: string; suggestedName: string; templateKey: 'template-a' | 'template-b' | 'template-c' }> = {}) {
  const seen: { image: Buffer; mime: string }[] = [];
  let gate: Promise<void> = Promise.resolve(), failure: Error | undefined;
  const writer: ImagePromptWriter = { model: 'gpt-5-mini', describe: vi.fn(async (image, mime) => {
    seen.push({ image, mime });
    await gate;
    if (failure) throw failure;
    return { prompt: answer.prompt ?? PROMPT, suggestedName: answer.suggestedName ?? 'Lavender phone studio', templateKey: answer.templateKey ?? 'template-b', reason: 'One product is the clear hero.',
      model: 'gpt-5-mini', responseId: 'resp_1', usage: { input_tokens: 900, output_tokens: 300 }, request: { model: 'gpt-5-mini', image: '<elided>' }, raw: { id: 'resp_1', status: 'completed' } };
  }) };
  return { writer, seen, hold: () => { let open!: () => void; gate = new Promise(done => { open = done; }); return () => open(); }, failWith: (error: Error | undefined) => { failure = error; } };
}

/** The experiment router with every provider faked, and helpers to talk to it. */
async function server(options: { images?: ReturnType<typeof imageFake>; writer?: ReturnType<typeof writerFake>; config?: Partial<GenerationConfig>; slowResult?: () => Promise<void> } = {}) {
  const images = options.images ?? imageFake(), writer = options.writer ?? writerFake();
  const runsDir = tmp('layerize-'), dir = tmp('image-templates-'), dirs = { 'template-a': tmp('a-'), 'template-b': tmp('b-'), 'template-c': tmp('c-') };
  const uploads: Buffer[] = [], submitted: Record<string, unknown>[] = [];
  let active = 0, mostAtOnce = 0;
  const create = vi.fn(async (request: { text: { format: { schema: unknown } } }) => ({ status: 'completed', output: [], output_text: JSON.stringify(
    request.text.format.schema === PLAN_SCHEMA_C ? { prompt: 'draft', planned_layers: [], warnings: [], people: [], repeated_modules: null, elements: [] }
      : { prompt: request.text.format.schema === PLAN_SCHEMA_B ? 'Extract the hero object as one layer.' : 'Keep the main subject whole. Separate each held object into its own layer.', planned_layers: [], warnings: [] }) }));
  const planner = createOpenAIPlanner({ client: { responses: { create } } as never });
  // fal: the base layer is the uploaded image itself, so every run completes with a real layer at the image's size.
  const transport: FalTransport = {
    upload: async (image) => { uploads.push(image as Buffer); mostAtOnce = Math.max(mostAtOnce, ++active); return `https://v3b.fal.media/files/t/in-${uploads.length}.png`; },
    submit: async (_endpoint, input) => { submitted.push(input); return { requestId: `r${submitted.length}` }; }, status: async () => 'COMPLETED',
    result: async () => { await options.slowResult?.(); active--; return { layers: [{ image: { url: `https://v3b.fal.media/files/t/base-${uploads.length}.png` }, z_index: 0 }] }; },
    cancel: async () => undefined, download: async (url) => uploads[Number(/base-(\d+)/.exec(url)![1]) - 1],
  };
  const deps = (): RunnerDeps => ({ planner, transport: () => transport, sleep: async () => undefined });
  const app = express().use('/x', createLayerizeRouter({ runsDir, deps, generationsDir: dirs['template-a'], generationDirs: { 'template-b': dirs['template-b'], 'template-c': dirs['template-c'] },
    generation: () => ({ ...images.config, ...options.config }), imageTemplatesDir: dir, imagePrompt: () => writer.writer })).listen(0, '127.0.0.1');
  await new Promise(done => app.once('listening', done));
  const { port } = app.address() as AddressInfo;
  const url = (path: string) => `http://127.0.0.1:${port}/x${path}`;
  const send = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(url(path), { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json() };
  };
  const get = (path: string) => send('GET', path), post = (path: string, body: unknown = {}) => send('POST', path, body), patch = (path: string, body: unknown) => send('PATCH', path, body);
  const upload = async (image: Buffer | undefined, fields: Record<string, string> = {}, fileName = 'reference.png', mimeType = 'image/png') => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    if (image) form.append('image', new Blob([new Uint8Array(image)], { type: mimeType }), fileName);
    const r = await fetch(url('/image-templates'), { method: 'POST', body: form });
    return { status: r.status, body: await r.json() };
  };
  const wait = async <T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> => {
    for (let i = 0; i < 600; i++) { const value = await read(); if (done(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error('Never settled.');
  };
  type Shown = Omit<ImageTemplate, 'variants'> & { variants: (ImageTemplate['variants'][number] & { decomposition?: { runId: string; state: string; layers?: number; resumable?: boolean; error?: { code: string } } })[] };
  const template = async (id: string) => (await get(`/image-templates/${id}`)).body as Shown;
  /** A draft whose prompt has been written. */
  const draft = async (fields: Record<string, string> = {}) => {
    const created = await upload(await png(1600, 1200, '#a58bd8'), fields);
    expect(created.status).toBe(202);
    return wait(() => template(created.body.id), t => t.promptGeneration?.status !== 'generating');
  };
  const settled = (id: string) => wait(() => template(id), t => !t.variants.some(v => v.status === 'queued' || v.status === 'generating'));
  const decomposed = (id: string) => wait(() => template(id), t => !t.variants.some(v => v.decomposition && ['waiting', 'running'].includes(v.decomposition.state)));
  return { app, url, get, post, patch, upload, draft, template, settled, decomposed, wait, images, writer, create, runsDir, dir, dirs, uploads, submitted, mostAtOnce: () => mostAtOnce };
}

describe('Create Template from Image', () => {
  it.each([3344, 4002])('%i-character structured response persists a usable prompt after exactly one analysis; regenerate is explicit', async length => {
    const fake = writerFake(), response = verboseImageAnalysis(length);
    const create = vi.fn(async () => ({ status: 'completed', output: [], output_text: JSON.stringify(response) }));
    fake.writer = createOpenAIImagePromptWriter({ model: 'gpt-5-mini', client: { responses: { create } } as never });
    const s = await server({ writer: fake });
    try {
      const t = await s.draft({ name: 'Keep this name', aspectRatios: JSON.stringify(['1:1', '4:5']) });
      expect(t.promptGeneration?.status).toBe('done');
      expect(t.prompt.length).toBeLessThanOrEqual(IMAGE_TEMPLATE_LIMITS.prompt);
      expect(t.analysis?.hero.identity).toBe('one lavender smartphone');
      expect(t.prompt).toContain('4 lavender/white spheres');
      expect(create).toHaveBeenCalledTimes(1);
      expect(s.images.send).not.toHaveBeenCalled(); expect(s.create).not.toHaveBeenCalled();
      await s.patch(`/image-templates/${t.id}`, { decomposeWith: 'template-c' });
      await s.post(`/image-templates/${t.id}/prompt`);
      const again = await s.wait(() => s.template(t.id), t => t.promptGeneration?.status === 'done');
      expect(again).toMatchObject({ name: t.name, reference: t.reference, aspectRatios: ['1:1', '4:5'], decomposeWith: 'template-c', analysis: t.analysis });
      expect(create).toHaveBeenCalledTimes(2);
      expect(s.images.send).not.toHaveBeenCalled(); expect(s.create).not.toHaveBeenCalled();
      const edited = `${again.prompt} Warm afternoon lighting.`;
      await s.post(`/image-templates/${t.id}/generate`, { prompt: edited, aspectRatios: ['1:1', '4:5'] });
      const done = await s.settled(t.id);
      expect(done.variants.filter(v => v.status === 'done')).toHaveLength(2);
      expect(s.images.requests.map(r => r.method)).toEqual(['edit', 'edit']);
      expect(s.images.requests).toHaveLength(2);
      for (const request of s.images.requests) {
        expect(request.prompt.startsWith(edited)).toBe(true);
        expect(request.prompt.length).toBeLessThanOrEqual(IMAGE_TEMPLATE_REQUEST_LIMIT);
        expect(sha(Buffer.from(await request.image!.arrayBuffer()))).toBe(t.reference.sha256);
      }
      expect(create).toHaveBeenCalledTimes(2);
    } finally { s.app.close(); }
  });

  it('rejects raw over-limit edits without any image request, then accepts the exact inclusive editable boundary', async () => {
    const s = await server();
    try {
      const t = await s.draft({ name: 'Boundary' }), exact = 'a'.repeat(IMAGE_TEMPLATE_LIMITS.prompt);
      for (const invalid of [exact + 'b', exact + ' ']) {
        expect((await s.post(`/image-templates/${t.id}/generate`, { prompt: invalid, aspectRatios: ['1:1'] })).status).toBe(400);
        expect((await s.patch(`/image-templates/${t.id}`, { prompt: invalid })).status).toBe(400);
      }
      expect(s.images.send).not.toHaveBeenCalled();
      expect((await s.post(`/image-templates/${t.id}/generate`, { prompt: exact, aspectRatios: ['1:1'] })).status).toBe(202);
      await s.settled(t.id);
      expect(s.images.requests).toHaveLength(1);
      expect(s.images.requests[0].prompt.startsWith(exact)).toBe(true);
    } finally { s.app.close(); }
  });

  it('checks the FULL edit request including appended reference text before instantiating the provider', async () => {
    const s = await server();
    try {
      const t = await s.draft({ name: 'Full boundary' });
      const { template } = startImageTemplateGeneration(s.dir, t.id, { prompt: 'a'.repeat(IMAGE_TEMPLATE_LIMITS.prompt), aspectRatios: ['1:1'] }, s.images.config, false);
      const prefixLength = template.variants[0].prompt.length + 1;
      const instruction = 'r'.repeat(IMAGE_TEMPLATE_REQUEST_LIMIT - prefixLength);
      const sourceReference = { file: t.reference.file, sha256: t.reference.sha256, instruction: instruction + 'x' };
      const failed = await generateVariant(s.dir, t.id, '1x1', s.images.config, { sourceReference });
      expect(failed.variants[0]).toMatchObject({ status: 'failed', error: { message: expect.stringContaining('complete image prompt') } });
      expect(s.images.send).not.toHaveBeenCalled();
      const done = await generateVariant(s.dir, t.id, '1x1', s.images.config, { sourceReference: { ...sourceReference, instruction } });
      expect(done.variants[0].status).toBe('done');
      expect(s.images.requests).toHaveLength(1);
      expect(s.images.requests[0].prompt).toHaveLength(IMAGE_TEMPLATE_REQUEST_LIMIT);
    } finally { s.app.close(); }
  });

  it('1–4. saves the uploaded reference as a draft and writes its prompt from the image: one prompt request, nothing else', async () => {
    const s = await server();
    try {
      const reference = await png(1600, 1200, '#a58bd8');
      const created = await s.upload(reference, { name: '' }, 'lavender.png');
      expect(created).toMatchObject({ status: 202, body: { kind: 'image-template', name: '', prompt: '', aspectRatios: ['1:1', '4:5', '16:9'], variants: [],
        reference: { file: 'reference.png', originalName: 'lavender.png', mimeType: 'image/png', width: 1600, height: 1200, bytes: reference.length, sha256: sha(reference) } } });
      const done = await s.wait(() => s.template(created.body.id), t => t.promptGeneration?.status === 'done');
      // The prompt is shown as written and becomes the working prompt; the layer style is the one detected; an unnamed draft takes the suggested name.
      expect(done).toMatchObject({ generatedPrompt: PROMPT, prompt: PROMPT, promptEdited: false, name: 'Lavender phone studio', detected: { templateKey: 'template-b', reason: 'One product is the clear hero.' }, decomposeWith: 'template-b',
        promptGeneration: { status: 'done', model: 'gpt-5-mini', attempts: 1, responseId: 'resp_1', requestFile: 'prompt.openai-request.json', responseFile: 'prompt.openai-response.json' } });
      // Kept untouched on disk, with the request and response of the prompt.
      expect(sha(readFileSync(join(s.dir, done.id, 'reference.png')))).toBe(sha(reference));
      expect(readdirSync(join(s.dir, done.id)).sort()).toEqual(['group.json', 'prompt.openai-request.json', 'prompt.openai-response.json', 'reference.png']);
      // OpenAI was sent the reference upright as a JPEG of at most 1536 px.
      expect(s.writer.seen).toHaveLength(1);
      expect(s.writer.seen[0].mime).toBe('image/jpeg');
      expect(await sharp(s.writer.seen[0].image).metadata()).toMatchObject({ format: 'jpeg', width: 1536, height: 1152 });
      // The reference is served back; nothing else was called.
      const served = await fetch(s.url(`/image-templates/${done.id}/reference`));
      expect(sha(Buffer.from(await served.arrayBuffer()))).toBe(sha(reference));
      expect(s.images.send).not.toHaveBeenCalled();
      expect(s.create).not.toHaveBeenCalled();
      // A name given at upload is kept.
      expect((await s.draft({ name: '  Diwali   offer  ' })).name).toBe('Diwali offer');
    } finally { s.app.close(); }
  });

  it('refuses what is not one image, and a name that is too long, before anything is saved or sent', async () => {
    const s = await server();
    try {
      expect(await s.upload(undefined)).toMatchObject({ status: 400, body: { error: { code: 'INVALID_UPLOAD' } } });
      expect(await s.upload(Buffer.alloc(0))).toMatchObject({ status: 400, body: { error: { code: 'INVALID_UPLOAD' } } });
      expect(await s.upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'))).toMatchObject({ status: 400, body: { error: { code: 'UNSUPPORTED_IMAGE' } } });
      expect(await s.upload(Buffer.from('not an image'))).toMatchObject({ status: 400, body: { error: { code: 'UNSUPPORTED_IMAGE' } } });
      await expect(createImageTemplate(s.dir, Buffer.alloc(MAX_UPLOAD_BYTES + 1))).rejects.toMatchObject({ code: 'UPLOAD_TOO_LARGE' });
      // Sharp's existing input-pixel limit rejects huge dimensions without allocating the decoded image.
      const huge = await png(10, 10);
      huge.writeUInt32BE(100000, 16); huge.writeUInt32BE(100000, 20);
      expect(await s.upload(huge)).toMatchObject({ status: 400, body: { error: { code: 'UNSUPPORTED_IMAGE' } } });
      expect(await s.upload(await png(10, 10), { name: 'x'.repeat(81) })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_NAME' } } });
      const valid = await png(100, 100);
      expect(await s.upload(valid, {}, 'phone.png', 'image/jpeg')).toMatchObject({ status: 400 });
      expect(await s.upload(valid, {}, 'phone.png', 'application/octet-stream')).toMatchObject({ status: 400 });
      expect(await s.upload(valid.subarray(0, valid.length - 25))).toMatchObject({ status: 400 });
      expect(readdirSync(s.dir)).toEqual([]);
      expect(s.writer.writer.describe).not.toHaveBeenCalled();
      expect((await s.get('/image-templates')).body).toEqual({ templates: [] });
    } finally { s.app.close(); }
  });

  it.each(['png', 'jpeg', 'webp'] as const)('accepts fully decodable %s bytes with matching MIME regardless of filename extension', async format => {
    const s = await server();
    try {
      const image = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#999' } }).toFormat(format).toBuffer();
      const reply = await s.upload(image, { name: 'Valid source' }, 'untrusted.extension', `image/${format}`);
      expect(reply.status).toBe(202);
      const t = await s.wait(() => s.template(reply.body.id), t => t.promptGeneration?.status !== 'generating');
      expect(t.promptGeneration?.status).toBe('done');
      expect(t.reference).toMatchObject({ mimeType: `image/${format}`, sha256: sha(image), width: 32, height: 24 });
      expect(s.writer.writer.describe).toHaveBeenCalledTimes(1);
      expect(s.images.send).not.toHaveBeenCalled();
    } finally { s.app.close(); }
  });

  it('an interrupted multipart upload leaves no group and calls no provider', async () => {
    const s = await server();
    try {
      await new Promise<void>(resolve => {
        const request = httpRequest(s.url('/image-templates'), { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=interrupted', 'Content-Length': '10000' } });
        request.on('error', () => undefined);
        request.on('close', resolve);
        request.write('--interrupted\r\nContent-Disposition: form-data; name="image"; filename="partial.png"\r\nContent-Type: image/png\r\n\r\npartial');
        setTimeout(() => request.destroy(), 50);
      });
      expect((await s.get('/image-templates')).body).toEqual({ templates: [] });
      expect(s.writer.writer.describe).not.toHaveBeenCalled();
      expect(s.images.send).not.toHaveBeenCalled();
    } finally { s.app.close(); }
  });

  it('preserves sizes chosen before upload and rejects invalid sizes before asking for a prompt', async () => {
    const s = await server();
    try {
      const image = await png(64, 64);
      for (const aspectRatios of ['null', 'invalid', '["9:16"]']) {
        expect(await s.upload(image, { name: 'Draft', aspectRatios })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_ASPECT_RATIO' } } });
      }
      expect(s.writer.writer.describe).not.toHaveBeenCalled();
      const created = await s.upload(image, { name: 'Draft', aspectRatios: '["16:9"]' });
      expect(created).toMatchObject({ status: 202, body: { aspectRatios: ['16:9'] } });
      await s.wait(() => s.template(created.body.id), t => t.promptGeneration?.status === 'done');
    } finally { s.app.close(); }
  });

  it('keeps a failed prompt request on the draft, and asks again only when told; a new prompt replaces the edits', async () => {
    const writer = writerFake(), s = await server({ writer });
    try {
      writer.failWith(Object.assign(new Error('OpenAI gpt-5-mini request failed (HTTP 429): Rate limit.'), { code: 'PROMPT_API_ERROR' }));
      const failed = await s.draft();
      expect(failed).toMatchObject({ prompt: '', name: '', promptGeneration: { status: 'failed', attempts: 1, error: { code: 'PROMPT_FAILED', message: expect.stringContaining('HTTP 429') } } });
      expect(failed).not.toHaveProperty('decomposeWith');
      writer.failWith(undefined);
      // While it is being written it is "generating", and a second request is refused.
      const open = writer.hold();
      expect(await s.post(`/image-templates/${failed.id}/prompt`)).toMatchObject({ status: 202, body: { promptGeneration: { status: 'generating', attempts: 2 } } });
      expect(await s.post(`/image-templates/${failed.id}/prompt`)).toMatchObject({ status: 409, body: { error: { code: 'BUSY' } } });
      expect(await s.post(`/image-templates/${failed.id}/generate`, { name: 'x', prompt: PROMPT, aspectRatios: ['1:1'] })).toMatchObject({ status: 400, body: { error: { code: 'PROMPT_IN_PROGRESS' } } });
      expect(await s.patch(`/image-templates/${failed.id}`, { prompt: 'Do not silently overwrite this edit.' })).toMatchObject({ status: 409, body: { error: { code: 'BUSY' } } });
      open();
      const written = await s.wait(() => s.template(failed.id), t => t.promptGeneration?.status === 'done');
      expect(written).toMatchObject({ prompt: PROMPT, promptEdited: false, promptGeneration: { attempts: 2 } });
      expect(writer.writer.describe).toHaveBeenCalledTimes(2);
      // An edit is kept until a new prompt is asked for.
      expect((await s.patch(`/image-templates/${failed.id}`, { prompt: `${PROMPT} Golden hour.` })).body).toMatchObject({ prompt: `${PROMPT} Golden hour.`, promptEdited: true });
      await s.post(`/image-templates/${failed.id}/prompt`);
      expect(await s.wait(() => s.template(failed.id), t => t.promptGeneration?.status === 'done' && t.promptGeneration.attempts === 3)).toMatchObject({ prompt: PROMPT, promptEdited: false });
      expect(s.images.send).not.toHaveBeenCalled();
      expect(s.create).not.toHaveBeenCalled();
      expect(new Set(writer.seen.map(input => sha(input.image))).size).toBe(1);
    } finally { s.app.close(); }
  });

  it('5. the working prompt, the ratios, the name and the layer style can be changed on a draft, within their limits', async () => {
    const s = await server();
    try {
      const t = await s.draft();
      expect((await s.patch(`/image-templates/${t.id}`, { name: 'Spring sale', aspectRatios: ['16:9', '1:1'], decomposeWith: 'template-c' })).body).toMatchObject({ name: 'Spring sale', aspectRatios: ['1:1', '16:9'], decomposeWith: 'template-c', decomposeWithChosen: true });
      expect((await s.patch(`/image-templates/${t.id}`, { aspectRatios: [] })).body.aspectRatios).toEqual([]);
      expect((await s.patch(`/image-templates/${t.id}`, { name: '' })).body.name).toBe('');
      expect(await s.patch(`/image-templates/${t.id}`, { prompt: 'x'.repeat(2001) })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_PROMPT' } } });
      expect(await s.patch(`/image-templates/${t.id}`, { aspectRatios: ['9:16'] })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_ASPECT_RATIO' } } });
      expect(await s.patch(`/image-templates/${t.id}`, { decomposeWith: 'template-z' })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_LAYER_STYLE' } } });
      expect(await s.patch(`/image-templates/${t.id}`, { fields: {} })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_REQUEST' } } });
      // A chosen layer style is kept when the prompt is written again.
      await s.post(`/image-templates/${t.id}/prompt`);
      expect(await s.wait(() => s.template(t.id), x => x.promptGeneration?.attempts === 2 && x.promptGeneration.status === 'done')).toMatchObject({ decomposeWith: 'template-c', detected: { templateKey: 'template-b' } });
    } finally { s.app.close(); }
  });

  it('6. edits the original upload for only the chosen ratios, then added ratios, using the exact edited prompt without chaining outputs', async () => {
    const s = await server();
    try {
      const t = await s.draft();
      const edited = `${PROMPT} Golden hour light.`;
      // What generating needs: a name, a usable prompt, a ratio.
      expect(await s.post(`/image-templates/${t.id}/generate`, { name: ' ', prompt: edited, aspectRatios: ['1:1'] })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_NAME' } } });
      expect(await s.post(`/image-templates/${t.id}/generate`, { name: 'Lavender', prompt: 'too short', aspectRatios: ['1:1'] })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_PROMPT' } } });
      expect(await s.post(`/image-templates/${t.id}/generate`, { name: 'Lavender', prompt: edited, aspectRatios: [] })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_ASPECT_RATIO' } } });
      expect(await s.post(`/image-templates/${t.id}/generate`, { name: 'Lavender', prompt: edited, aspectRatios: ['1:1'], basePrompt: 'x' })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_REQUEST' } } });
      expect(s.images.send).not.toHaveBeenCalled();

      const started = await s.post(`/image-templates/${t.id}/generate`, { name: 'Lavender launch', prompt: edited, aspectRatios: ['16:9', '1:1'] });
      expect(started).toMatchObject({ status: 202, body: { name: 'Lavender launch', prompt: edited, promptEdited: true, generatedPrompt: PROMPT, aspectRatios: ['1:1', '16:9'], ratioStrategy: 'uploaded-reference', decomposeWith: 'template-b' } });
      expect(started.body.variants.map((v: { id: string; status: string }) => [v.id, v.status])).toEqual([['1x1', 'queued'], ['4x5', 'pending'], ['16x9', 'queued']]);
      const done = await s.settled(t.id);
      expect(done.variants.map(v => [v.aspectRatio, v.status, v.size])).toEqual([['1:1', 'done', { width: 1024, height: 1024 }], ['4:5', 'pending', { width: 1216, height: 1520 }], ['16:9', 'done', { width: 1536, height: 864 }]]);
      // Even the first ratio is an edit of the original upload, never text-only generation.
      expect(s.images.requests.map(r => [r.method, r.size])).toEqual([['edit', '1024x1024'], ['edit', '1536x864']]);
      expect(s.images.requests[0].prompt).toBe(`${edited} ${IMAGE_TEMPLATE_CONSISTENCY} ${IMAGE_TEMPLATE_FRAMING['1:1']} ${IMAGE_TEMPLATE_REFERENCE_INSTRUCTION}`);
      expect(s.images.requests[1].prompt).toBe(`${edited} ${IMAGE_TEMPLATE_CONSISTENCY} ${IMAGE_TEMPLATE_FRAMING['16:9']} ${IMAGE_TEMPLATE_REFERENCE_INSTRUCTION}`);
      const originalSha = sha(readFileSync(join(s.dir, t.id, t.reference.file)));
      expect(s.images.inputs).toEqual([originalSha, originalSha]);
      expect(sha(s.writer.seen[0].image)).not.toBe(originalSha); // Not the resized analysis JPEG, either.
      expect(s.images.sent.map(sha)).not.toContain(originalSha);
      const sourceReference = { file: t.reference.file, sha256: originalSha, instruction: IMAGE_TEMPLATE_REFERENCE_INSTRUCTION };
      for (const variant of [done.variants[0], done.variants[2]]) {
        expect(variant.sourceReference).toEqual(sourceReference);
        expect(variant).not.toHaveProperty('reference');
        const request = JSON.parse(readFileSync(join(s.dir, t.id, variant.requestFile!), 'utf8'));
        expect(request).toMatchObject({ method: 'images.edit', image: expect.stringContaining(`original uploaded reference: ${t.reference.file}, sha256 ${originalSha}`) });
      }
      expect(done.variants[1]).toMatchObject({ status: 'pending', attempts: 0 });
      // Each image is served exactly as generated.
      const served = await fetch(s.url(`/image-templates/${t.id}/variants/16x9/image`));
      expect(sha(Buffer.from(await served.arrayBuffer()))).toBe(sha(s.images.sent[1]));
      // From now on the prompt and the ratios are fixed; the name can still change, but not to nothing.
      expect(await s.post(`/image-templates/${t.id}/generate`, { name: 'Again', prompt: edited, aspectRatios: ['1:1'] })).toMatchObject({ status: 400, body: { error: { code: 'ALREADY_GENERATED' } } });
      expect(await s.patch(`/image-templates/${t.id}`, { prompt: PROMPT })).toMatchObject({ status: 400, body: { error: { code: 'ALREADY_GENERATED' } } });
      expect(await s.post(`/image-templates/${t.id}/prompt`)).toMatchObject({ status: 400, body: { error: { code: 'ALREADY_GENERATED' } } });
      expect(await s.patch(`/image-templates/${t.id}`, { name: '' })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_NAME' } } });
      expect((await s.patch(`/image-templates/${t.id}`, { name: 'Lavender launch v2' })).body.name).toBe('Lavender launch v2');
      // A ratio not chosen at first can be added later; it still uses the same original and saved edit.
      expect((await s.post(`/image-templates/${t.id}/variants/4x5/generate`)).body.aspectRatios).toEqual(['1:1', '4:5', '16:9']);
      expect((await s.settled(t.id)).variants[1]).toMatchObject({ status: 'done', sourceReference });
      expect(s.images.requests.map(r => [r.method, r.size])).toEqual([['edit', '1024x1024'], ['edit', '1536x864'], ['edit', '1216x1520']]);
      expect(s.images.requests[2].prompt).toBe(`${edited} ${IMAGE_TEMPLATE_CONSISTENCY} ${IMAGE_TEMPLATE_FRAMING['4:5']} ${IMAGE_TEMPLATE_REFERENCE_INSTRUCTION}`);
      expect(s.images.inputs).toEqual([originalSha, originalSha, originalSha]);
      expect(s.images.sent.map(sha)).not.toContain(originalSha);
      expect(await s.post(`/image-templates/${t.id}/variants/4x5/generate`)).toMatchObject({ status: 400, body: { error: { code: 'ALREADY_GENERATED' } } });
    } finally { s.app.close(); }
  });

  it('7. a failed ratio leaves the others; retry uses the same original and refuses a prompt-only escape', async () => {
    const images = imageFake(), s = await server({ images });
    try {
      const t = await s.draft();
      images.failWhen(request => request.size === '1216x1520' && images.requests.filter(r => r.size === '1216x1520').length === 1);
      await s.post(`/image-templates/${t.id}/generate`, { name: 'Lavender', aspectRatios: ['1:1', '4:5', '16:9'] });
      const first = await s.settled(t.id);
      expect(first.variants.map(v => v.status)).toEqual(['done', 'failed', 'done']);
      expect(first.variants[1].error).toMatchObject({ code: 'PROVIDER_NETWORK', status: 500 });
      // The template's prompt was the generated one, unedited.
      expect(first).toMatchObject({ prompt: PROMPT, promptEdited: false });
      expect(await s.post(`/image-templates/${t.id}/variants/1x1/generate`)).toMatchObject({ status: 400, body: { error: { code: 'ALREADY_GENERATED' } } });
      expect(await s.post(`/image-templates/${t.id}/variants/4x5/generate`, { independent: true })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_REQUEST' } } });
      expect(images.requests).toHaveLength(3);
      expect((await s.template(t.id)).variants[1]).toMatchObject({ status: 'failed', attempts: 1 });
      expect((await s.post(`/image-templates/${t.id}/variants/4x5/generate`, { independent: false })).status).toBe(202);
      const again = await s.settled(t.id);
      expect(again.variants.map(v => v.status)).toEqual(['done', 'done', 'done']);
      expect(again.variants[1]).not.toHaveProperty('reference');
      expect(again.variants[1]).toMatchObject({ attempts: 2, sourceReference: { file: t.reference.file, sha256: t.reference.sha256 } });
      expect(images.requests.map(r => [r.method, r.size])).toEqual([['edit', '1024x1024'], ['edit', '1216x1520'], ['edit', '1536x864'], ['edit', '1216x1520']]);
      expect(images.inputs).toEqual(Array(4).fill(t.reference.sha256));
      expect(images.sent.map(sha)).not.toContain(t.reference.sha256);
    } finally { s.app.close(); }
  });

  it('always uses the upload even when the other template generators have reference ratios switched off', async () => {
    const s = await server({ config: { referenceRatios: false } });
    try {
      const t = await s.draft();
      expect((await s.get('/image-templates/info')).body.ratioReference).toBe(true);
      expect((await s.post(`/image-templates/${t.id}/generate`, { name: 'Lavender', aspectRatios: ['4:5', '16:9'] })).body.ratioStrategy).toBe('uploaded-reference');
      await s.settled(t.id);
      expect(s.images.requests.map(r => [r.method, r.size])).toEqual([['edit', '1216x1520'], ['edit', '1536x864']]);
      expect(s.images.inputs).toEqual([t.reference.sha256, t.reference.sha256]);
      // A rejected independent request must not add an unselected ratio or queue a request.
      expect(await s.post(`/image-templates/${t.id}/variants/1x1/generate`, { independent: true })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_REQUEST' } } });
      expect((await s.template(t.id)).aspectRatios).toEqual(['4:5', '16:9']);
      expect(s.images.requests).toHaveLength(2);
    } finally { s.app.close(); }
  });

  it.each(['reference', undefined] as const)('uses the original upload for added ratios of an older record with strategy %s', async (strategy) => {
    const s = await server();
    try {
      const t = await s.draft();
      await s.post(`/image-templates/${t.id}/generate`, { name: 'Older template', aspectRatios: ['1:1'] });
      const record = await s.settled(t.id);
      if (strategy) record.ratioStrategy = strategy;
      else delete record.ratioStrategy;
      delete record.variants[0].sourceReference;
      writeFileSync(join(s.dir, t.id, 'group.json'), JSON.stringify(record));
      expect((await s.post(`/image-templates/${t.id}/variants/16x9/generate`)).status).toBe(202);
      expect((await s.settled(t.id)).variants[2]).toMatchObject({ status: 'done', sourceReference: { file: t.reference.file, sha256: t.reference.sha256 } });
      expect(s.images.requests.map(r => r.method)).toEqual(['edit', 'edit']);
      expect(s.images.inputs).toEqual([t.reference.sha256, t.reference.sha256]);
      expect(s.images.inputs[1]).not.toBe(sha(s.images.sent[0]));
    } finally { s.app.close(); }
  });

  it('fails without any image request when the original file is missing, with no text-only fallback', async () => {
    const s = await server();
    try {
      const t = await s.draft();
      const referencePath = join(s.dir, t.id, t.reference.file), original = readFileSync(referencePath);
      unlinkSync(referencePath);
      expect((await s.post(`/image-templates/${t.id}/generate`, { name: 'Missing reference', aspectRatios: ['1:1'] })).status).toBe(202);
      const failed = await s.settled(t.id);
      expect(failed.variants[0]).toMatchObject({ status: 'failed', error: { code: 'GENERATION_FAILED', message: expect.stringContaining('ENOENT') }, sourceReference: { sha256: t.reference.sha256 } });
      expect(s.images.send).not.toHaveBeenCalled();
      expect(failed.variants.slice(1).map(v => [v.status, v.attempts])).toEqual([['pending', 0], ['pending', 0]]);
      writeFileSync(referencePath, original);
      expect((await s.post(`/image-templates/${t.id}/variants/1x1/generate`)).status).toBe(202);
      expect((await s.settled(t.id)).variants[0]).toMatchObject({ status: 'done', attempts: 2 });
      expect(s.images.requests.map(r => r.method)).toEqual(['edit']);
      expect(s.images.inputs).toEqual([t.reference.sha256]);
    } finally { s.app.close(); }
  });

  it('rejects a changed canonical source before any provider request', async () => {
    const s = await server();
    try {
      const t = await s.draft();
      writeFileSync(join(s.dir, t.id, t.reference.file), await png(64, 64));
      await s.post(`/image-templates/${t.id}/generate`, { name: 'Integrity', aspectRatios: ['1:1'] });
      expect((await s.settled(t.id)).variants[0]).toMatchObject({ status: 'failed', error: { code: 'REFERENCE_CHANGED' } });
      expect(s.images.send).not.toHaveBeenCalled();
    } finally { s.app.close(); }
  });

  it.each(['template-a', 'template-b', 'template-c'] as const)('detection of %s cannot disable original-reference conditioning', async templateKey => {
    const s = await server({ writer: writerFake({ templateKey }) });
    try {
      const t = await s.draft({ name: 'Detected style', aspectRatios: '["1:1"]' });
      expect(t).toMatchObject({ detected: { templateKey }, decomposeWith: templateKey });
      await s.post(`/image-templates/${t.id}/generate`, { prompt: `${PROMPT} Preserve the neutral gray background.` });
      const done = await s.settled(t.id);
      expect(s.images.requests).toHaveLength(1);
      expect(s.images.requests[0]).toMatchObject({ method: 'edit', size: '1024x1024', prompt: expect.stringContaining('Preserve the neutral gray background.') });
      expect(s.images.inputs).toEqual([t.reference.sha256]);
      expect(done.variants.slice(1).map(v => [v.status, v.attempts])).toEqual([['pending', 0], ['pending', 0]]);
      expect(s.create).not.toHaveBeenCalled(); expect(s.submitted).toEqual([]);
    } finally { s.app.close(); }
  });

  it('concurrent initial generation and same-variant requests submit only once', async () => {
    const images = imageFake(), release = images.hold(), s = await server({ images });
    try {
      const t = await s.draft({ name: 'One request', aspectRatios: '["1:1"]' });
      const responses = await Promise.all([s.post(`/image-templates/${t.id}/generate`), s.post(`/image-templates/${t.id}/generate`)]);
      expect(responses.map(r => r.status).sort()).toEqual([202, 400]);
      const duplicates = await Promise.all([s.post(`/image-templates/${t.id}/variants/1x1/generate`), s.post(`/image-templates/${t.id}/variants/1x1/generate`)]);
      expect(duplicates.map(r => r.status)).toEqual([409, 409]);
      await s.wait(async () => images.requests.length, count => count === 1);
      release();
      const done = await s.settled(t.id);
      expect(images.requests).toHaveLength(1);
      expect(done.variants[0].attempts).toBe(1);
      expect(done.reference).toEqual(t.reference);
    } finally { release(); s.app.close(); }
  });

  it('source replacement requires a new group; regeneration preserves draft name and selected ratios', async () => {
    const s = await server();
    try {
      const t = await s.draft({ name: 'Keep my name', aspectRatios: '["16:9"]' });
      expect(await s.patch(`/image-templates/${t.id}`, { reference: { file: 'other.png' } })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_REQUEST' } } });
      await s.post(`/image-templates/${t.id}/prompt`);
      const rewritten = await s.wait(() => s.template(t.id), value => value.promptGeneration?.attempts === 2 && value.promptGeneration.status === 'done');
      expect(rewritten).toMatchObject({ name: t.name, aspectRatios: ['16:9'], reference: t.reference, variants: [] });
      expect(s.images.send).not.toHaveBeenCalled();
      const other = await s.upload(await png(200, 100, '#888888'), { name: 'New source' });
      expect(other.body.id).not.toBe(t.id);
      expect(other.body.prompt).toBe('');
      expect((await s.template(t.id)).reference).toEqual(t.reference);
    } finally { s.app.close(); }
  });

  it('8–9. decomposes one ratio as an ordinary run of its layer style with that style\'s defaults, and records when it is opened in the editor', async () => {
    const s = await server();
    try {
      const t = await s.draft();
      await s.post(`/image-templates/${t.id}/generate`, { name: 'Lavender', aspectRatios: ['1:1', '4:5'] });
      await s.settled(t.id);
      expect(await s.post(`/image-templates/${t.id}/variants/16x9/decompose`)).toMatchObject({ status: 400, body: { error: { code: 'NOT_DECOMPOSABLE' } } });
      expect(await s.post(`/image-templates/${t.id}/variants/4x5/decompose`, { templateOptions: {} })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_REQUEST' } } });
      const started = await s.post(`/image-templates/${t.id}/variants/4x5/decompose`);
      expect(started.status).toBe(202);
      const entry = started.body.variants[1].decompositions[0];
      expect(entry).toMatchObject({ templateKey: 'template-b', templateOptions: { separateTouchingIndependentObjects: false } });
      expect(entry).not.toHaveProperty('separateHeldObject');
      const done = await s.decomposed(t.id);
      expect(done.variants[1].decomposition).toMatchObject({ runId: entry.runId, state: 'done', layers: 1 });
      expect(done.variants[0]).not.toHaveProperty('decomposition');
      // An ordinary Template B run of exactly that image, linked back to the template and the ratio.
      const run = readRun(join(s.runsDir, entry.runId));
      expect(run).toMatchObject({ stage: 'done', templateKey: 'template-b', templateOptions: { separateTouchingIndependentObjects: false }, promptSource: { mode: 'generated' }, layerTarget: { templateKey: 'template-b' },
        origin: { kind: 'image-template', generationId: t.id, variantId: '4x5', aspectRatio: '4:5' }, original: { width: 1216, height: 1520 } });
      expect(run.layerTarget).not.toHaveProperty('targetLayers');
      expect(sha(s.uploads[0])).toBe(sha(s.images.sent[1]));
      expect(s.create.mock.calls[0][0].text.format.schema).toBe(PLAN_SCHEMA_B);
      expect(s.submitted).toHaveLength(1);
      // The run is served by the experiment's own run routes, as any run.
      expect((await s.get(`/runs/${entry.runId}`)).body).toMatchObject({ id: entry.runId, stage: 'done', origin: { kind: 'image-template' } });
      // Opening it in the editor is recorded on the ratio; only a finished decomposition of that ratio can be.
      expect(await s.post(`/image-templates/${t.id}/variants/1x1/opened`, { runId: entry.runId })).toMatchObject({ status: 400, body: { error: { code: 'NOT_DECOMPOSED' } } });
      const opened = await s.post(`/image-templates/${t.id}/variants/4x5/opened`, { runId: entry.runId });
      expect(opened.body.variants[1].editor).toMatchObject({ runId: entry.runId, openedAt: expect.any(String) });
    } finally { s.app.close(); }
  });

  it('decomposes with the layer style the user chose: Template A with its held object separate and its suggested count, Template C with its options off', async () => {
    const s = await server();
    try {
      for (const [style, expected] of [['template-a', { separateHeldObject: true, layerTarget: { templateKey: 'template-a', suggestedLayers: 6, targetLayers: 6 } }],
        ['template-c', { templateOptions: { separateHumanSubjects: false, separateRepeatedModules: false }, layerTarget: { templateKey: 'template-c' } }]] as const) {
        const t = await s.draft();
        await s.patch(`/image-templates/${t.id}`, { decomposeWith: style });
        await s.post(`/image-templates/${t.id}/generate`, { name: style, aspectRatios: ['1:1'] });
        await s.settled(t.id);
        const runId = (await s.post(`/image-templates/${t.id}/variants/1x1/decompose`)).body.variants[0].decompositions[0].runId;
        await s.decomposed(t.id);
        expect(readRun(join(s.runsDir, runId))).toMatchObject({ templateKey: style, stage: 'done', ...expected });
      }
    } finally { s.app.close(); }
  });

  it('decompositions asked for while a run is active wait their turn; one run at a time, and the existing upload route still refuses while one runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    const s = await server({ slowResult: () => gate });
    try {
      const t = await s.draft();
      await s.post(`/image-templates/${t.id}/generate`, { name: 'Lavender', aspectRatios: ['1:1', '4:5', '16:9'] });
      await s.settled(t.id);
      for (const id of ['1x1', '4x5', '16x9']) expect((await s.post(`/image-templates/${t.id}/variants/${id}/decompose`)).status).toBe(202);
      const during = await s.wait(() => s.template(t.id), x => x.variants[0].decomposition?.state === 'running');
      expect(during.variants.map(v => v.decomposition?.state)).toEqual(['running', 'waiting', 'waiting']);
      // A second decomposition of an image already in line is refused; the panel's own routes keep their one-run rule.
      expect(await s.post(`/image-templates/${t.id}/variants/4x5/decompose`)).toMatchObject({ status: 409, body: { error: { code: 'BUSY' } } });
      const form = new FormData();
      form.append('image', new Blob([new Uint8Array(await png(64, 64))], { type: 'image/png' }), 'x.png');
      const refused = await fetch(s.url('/runs'), { method: 'POST', body: form });
      expect([refused.status, (await refused.json()).error.code]).toEqual([409, 'BUSY']);
      release();
      const done = await s.decomposed(t.id);
      expect(done.variants.map(v => v.decomposition?.state)).toEqual(['done', 'done', 'done']);
      expect(s.mostAtOnce()).toBe(1);
      expect(s.submitted).toHaveLength(3);
    } finally { s.app.close(); }
  });

  it('shows what a stopped server left behind as failed, and offers resuming only a run fal has a request for', async () => {
    const s = await server();
    try {
      const t = await s.draft();
      await s.post(`/image-templates/${t.id}/generate`, { name: 'Lavender', aspectRatios: ['1:1'] });
      await s.settled(t.id);
      const runId = (await s.post(`/image-templates/${t.id}/variants/1x1/decompose`)).body.variants[0].decompositions[0].runId;
      await s.decomposed(t.id);
      // Rewrite the records as a stopped server would have left them: a prompt being written, a ratio and a run in flight.
      const record = JSON.parse(readFileSync(join(s.dir, t.id, 'group.json'), 'utf8')) as ImageTemplate;
      record.promptGeneration!.status = 'generating';
      record.variants[1].status = 'generating';
      writeFileSync(join(s.dir, t.id, 'group.json'), JSON.stringify(record));
      const run = JSON.parse(readFileSync(join(s.runsDir, runId, 'run.json'), 'utf8'));
      writeFileSync(join(s.runsDir, runId, 'run.json'), JSON.stringify({ ...run, stage: 'in_progress' }));
      const shown = await s.template(t.id);
      expect(shown.promptGeneration).toMatchObject({ status: 'failed', error: { code: 'INTERRUPTED' } });
      expect(shown.variants[1]).toMatchObject({ status: 'failed', error: { code: 'INTERRUPTED' } });
      expect(shown.variants[0].decomposition).toMatchObject({ state: 'failed', error: { code: 'INTERRUPTED' }, resumable: true });
      // Resuming reads fal's saved request: no new submission.
      expect((await s.post(`/image-templates/${t.id}/variants/1x1/resume`)).status).toBe(202);
      expect((await s.decomposed(t.id)).variants[0].decomposition).toMatchObject({ state: 'done' });
      expect(s.submitted).toHaveLength(1);
      expect(await s.post(`/image-templates/${t.id}/variants/1x1/resume`)).toMatchObject({ status: 400, body: { error: { code: 'NOT_RESUMABLE' } } });
    } finally { s.app.close(); }
  });

  it('reserves a ratio before asynchronous run creation: simultaneous decomposition requests spend only once', async () => {
    const s = await server();
    try {
      const t = await s.draft();
      await s.post(`/image-templates/${t.id}/generate`, { name: 'Duplicate clicks', aspectRatios: ['1:1'] });
      await s.settled(t.id);
      const replies = await Promise.all(Array.from({ length: 4 }, () => s.post(`/image-templates/${t.id}/variants/1x1/decompose`)));
      expect(replies.map(r => r.status).sort()).toEqual([202, 409, 409, 409]);
      const done = await s.decomposed(t.id);
      expect(done.variants[0].decompositions).toHaveLength(1);
      expect(s.submitted).toHaveLength(1);
    } finally { s.app.close(); }
  });

  it('10. lives beside Templates A, B and C without touching them: its own folder, its own routes, the shared image queue', async () => {
    const s = await server();
    try {
      const t = await s.draft();
      const b = await s.post('/template-b/groups', { fields: { mainProduct: 'Lavender smartphone', sceneStyle: 'Premium pastel studio with soft lavender spheres' }, aspectRatios: ['1:1'] });
      expect(b.status).toBe(202);
      await s.post(`/image-templates/${t.id}/generate`, { name: 'Lavender', aspectRatios: ['1:1'] });
      await s.settled(t.id);
      const group = await s.wait(async () => (await s.get(`/template-b/groups/${b.body.id}`)).body as GenerationGroup, g => g.variants[0].status === 'done');
      // Template B's creative is generated with Template B's own prompt, the image template with its own.
      expect(s.images.requests.map(r => r.prompt.startsWith(templateBGenerationProfile.buildBasePrompt(group.fields)) ? 'template-b' : r.prompt.startsWith(PROMPT) ? 'image-template' : 'other')).toEqual(['template-b', 'image-template']);
      // Neither is listed or served by the other's routes.
      expect((await s.get('/template-b/groups')).body.groups.map((g: { id: string }) => g.id)).toEqual([b.body.id]);
      expect((await s.get(`/template-b/groups/${t.id}`)).status).toBe(404);
      expect((await s.get(`/image-templates/${b.body.id}`)).status).toBe(404);
      expect((await s.get('/image-templates')).body.templates.map((x: { id: string }) => x.id)).toEqual([t.id]);
      expect(readdirSync(s.dirs['template-b'])).toEqual([b.body.id]);
      expect(existsSync(join(s.dir, b.body.id))).toBe(false);
      // The info the screen reads.
      expect((await s.get('/image-templates/info')).body).toMatchObject({ ratios: [{ ratio: '1:1', name: 'Square', width: 1024, height: 1024 }, { ratio: '4:5', name: 'Portrait', width: 1216, height: 1520 }, { ratio: '16:9', name: 'Landscape', width: 1536, height: 864 }],
        limits: { name: 80, prompt: 2000 }, imageModel: 'gpt-image-2', promptModel: 'gpt-5-mini', ratioReference: true, layerStyles: [{ key: 'template-a' }, { key: 'template-b' }, { key: 'template-c' }] });
    } finally { s.app.close(); }
  });
});

describe('the prompt request to OpenAI', () => {
  const answer = (body: unknown, extra: Record<string, unknown> = {}) => ({ responses: { create: vi.fn(async () => ({ id: 'resp_9', status: 'completed', output: [], output_text: JSON.stringify(body), usage: { input_tokens: 1, output_tokens: 2 }, ...extra })) } });
  const valid = verboseImageAnalysis(3344);

  it('sends the image with the instruction and a strict schema, on the planner\'s model, and reads the answer', async () => {
    const client = answer(valid), writer = createOpenAIImagePromptWriter({ model: 'gpt-5-mini', client: client as never });
    const image = await referenceForPrompt(await png(3000, 2000));
    const result = await writer.describe(image.bytes, image.mime);
    expect(result).toMatchObject({ prompt: buildImageTemplatePrompt(normalizeImageAnalysis(valid.analysis)), suggestedName: 'Lavender phone studio', templateKey: 'template-b', reason: 'One product is the hero', model: 'gpt-5-mini', responseId: 'resp_9' });
    const request = (client.responses.create.mock.calls[0] as unknown as [unknown])[0] as { model: string; store: boolean; instructions: string; input: { content: { type: string; image_url?: string; detail?: string }[] }[]; text: { format: { strict: boolean; schema: { properties: { decomposition_template: { enum: string[] } } } } } };
    expect(request).toMatchObject({ model: 'gpt-5-mini', store: false, text: { format: { type: 'json_schema', strict: true } } });
    expect(request.text.format.schema.properties.decomposition_template.enum).toEqual(['template-a', 'template-b', 'template-c']);
    expect(request.input[0].content[1]).toMatchObject({ type: 'input_image', detail: 'high' });
    expect(request.input[0].content[1].image_url!.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(request.instructions).toBe(imagePromptInstruction());
    // The layer styles are described exactly as the decomposition templates describe what fits them.
    for (const template of TEMPLATES) expect(request.instructions).toContain(`- ${template.key} (${template.name}): ${template.fit}`);
    for (const detail of ['structured visual evidence', 'camera module', 'visible counts', 'percentages', 'orientation/rotation', 'camera angle', 'framing/crop', 'shadow/reflection', 'material/texture', 'background treatment', 'text/logos/branding', 'uncertain']) expect(request.instructions).toContain(detail);
    // The saved request never carries the image itself.
    expect(JSON.stringify(result.request)).not.toContain('base64');
    expect(await sharp(image.bytes).metadata()).toMatchObject({ width: 1536, height: 1024 });
  });

  it.each(['template-a', 'template-b', 'template-c'])('retains %s detection in the same single structured response', async templateKey => {
    const client = answer({ ...valid, decomposition_template: templateKey });
    const result = await createOpenAIImagePromptWriter({ model: 'm', client: client as never }).describe(Buffer.from('x'), 'image/jpeg');
    expect(result.templateKey).toBe(templateKey);
    expect(client.responses.create).toHaveBeenCalledTimes(1);
  });

  it('refuses an answer it cannot use, and needs a key before sending anything', async () => {
    const cases: [unknown, Record<string, unknown>, string][] = [
      [null, {}, 'PROMPT_INVALID_JSON'],
      [[], {}, 'PROMPT_INVALID_JSON'],
      [valid, { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }, 'PROMPT_REFUSED'],
      [valid, { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }, 'PROMPT_INCOMPLETE'],
      [{ ...valid, analysis: {} }, {}, 'PROMPT_INVALID'],
      [{ ...valid, analysis: { hero: 'a phone' } }, {}, 'PROMPT_INVALID'],
      [{ ...valid, decomposition_template: 'template-z' }, {}, 'PROMPT_INVALID'],
    ];
    for (const [body, extra, code] of cases) await expect(createOpenAIImagePromptWriter({ model: 'm', client: answer(body, extra) as never }).describe(Buffer.from('x'), 'image/jpeg')).rejects.toMatchObject({ code });
    for (const output of [null, [], { status: 'completed', output: {} }]) {
      const create = vi.fn(async () => output);
      await expect(createOpenAIImagePromptWriter({ model: 'm', client: { responses: { create } } as never }).describe(Buffer.from('x'), 'image/jpeg')).rejects.toMatchObject({ code: 'PROMPT_INVALID_JSON' });
      expect(create).toHaveBeenCalledTimes(1);
    }
    await expect(createOpenAIImagePromptWriter({ model: 'm', client: { responses: { create: async () => ({ status: 'completed', output: [], output_text: '{"prompt":' }) } } as never }).describe(Buffer.from('x'), 'image/jpeg')).rejects.toMatchObject({ code: 'PROMPT_INVALID_JSON' });
    await expect(createOpenAIImagePromptWriter({ model: 'm', client: { responses: { create: async () => { throw Object.assign(new Error('quota'), { status: 429 }); } } } as never }).describe(Buffer.from('x'), 'image/jpeg')).rejects.toMatchObject({ code: 'PROMPT_API_ERROR', status: 429 });
    await expect(createOpenAIImagePromptWriter({ model: 'm' }).describe(Buffer.from('x'), 'image/jpeg')).rejects.toMatchObject({ code: 'PROMPT_NOT_CONFIGURED' });
    // A suggested name that does not fit is left out; the rest is used.
    expect(await createOpenAIImagePromptWriter({ model: 'm', client: answer({ ...valid, suggested_name: 'x'.repeat(81) }) as never }).describe(Buffer.from('x'), 'image/jpeg')).not.toHaveProperty('suggestedName');
  });
});
