import { PROTECTION_CLAUSE, SEMANTIC_SCHEMA } from './semanticPlanner.js';
import { semanticFixture } from './semanticPlanner.fixture.js';
import { referenceCreativeFixture } from './referenceCreative.fixture.js';
import { airPodsAnalysisFixture, airPodsAnalysisResponseFixture } from './airPodsAnalysis.fixture.js';
import { verboseImageAnalysis } from './imageTemplateAnalysis.fixture.js';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import express from 'express';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createReferenceCreative, editReferenceChoices, IMAGE_TEMPLATE_LIMITS, IMAGE_TEMPLATE_REQUEST_LIMIT, buildImageTemplatePrompt, normalizeImageAnalysis, IMAGE_TEMPLATE_CONSISTENCY, IMAGE_TEMPLATE_FRAMING,
  imageTemplateVariantPrompt, type ReferenceCreativeDraft } from '@frameflow/shared';
import type { FalTransport } from './providers/falClient.js';
import { generateVariant, type GenerationConfig } from './generationGroups.js';
import { MAX_UPLOAD_BYTES, readRun, type RunnerDeps } from './layerizeExperiment.js';
import { createOpenAIPlanner } from './layerizePlanner.js';
import { createLayerizeRouter } from './layerizeRouter.js';
import { createImageTemplate, createOpenAIImagePromptWriter, imagePromptInstruction, referenceForPrompt, startImageTemplateGeneration, type ImagePromptWriter, type ImageTemplate } from './imageTemplates.js';

// Reference creatives with every provider faked: no OpenAI, fal or Seedream request is made by this file. Any request
// that leaves this machine fails the test that made it: fetch reaches this test's own local server and nothing else.
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
/** The lavender phone's visual evidence (the fixture at its natural length), as the fake prompt writer reads it. */
const ANALYSIS = normalizeImageAnalysis(verboseImageAnalysis(0).analysis);
const ALL_RATIOS = ['1:1', '4:5', '16:9'] as const;

type ImageRequest = { model: string; prompt: string; size: string; n: number; output_format: string; image?: File | File[] };
/** A fake OpenAI images client: one PNG of the requested size per request, recording each request and its method. */
function imageFake() {
  const sent: Buffer[] = [], inputs: (string | undefined)[] = [], requests: (ImageRequest & { method: string })[] = [];
  let fail: ((request: ImageRequest) => boolean) | undefined, gate = Promise.resolve();
  const send = vi.fn(async (request: ImageRequest, method: 'generate' | 'edit') => {
    requests.push({ ...request, method });
    const primary = Array.isArray(request.image) ? request.image[0] : request.image;
    inputs.push(primary ? sha(Buffer.from(await primary.arrayBuffer())) : undefined);
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
/** A fake prompt writer: answers with the lavender phone's analysis, a prompt and a name, and keeps what it was sent. */
function writerFake() {
  const seen: { image: Buffer; mime: string }[] = [];
  let gate: Promise<void> = Promise.resolve(), failure: Error | undefined;
  const writer: ImagePromptWriter = { model: 'gpt-5-mini', describe: vi.fn(async (image, mime) => {
    seen.push({ image, mime });
    await gate;
    if (failure) throw failure;
    return { analysis: structuredClone(ANALYSIS), prompt: PROMPT, suggestedName: 'Lavender phone studio',
      model: 'gpt-5-mini', responseId: 'resp_1', usage: { input_tokens: 900, output_tokens: 300 }, request: { model: 'gpt-5-mini', image: '<elided>' }, raw: { id: 'resp_1', status: 'completed' } };
  }) };
  return { writer, seen, hold: () => { let open!: () => void; gate = new Promise(done => { open = done; }); return () => open(); }, failWith: (error: Error | undefined) => { failure = error; } };
}

/** The experiment router with every provider faked, and helpers to talk to it. */
async function server(options: { images?: ReturnType<typeof imageFake>; writer?: ReturnType<typeof writerFake>; config?: Partial<GenerationConfig>; slowResult?: () => Promise<void> } = {}) {
  const images = options.images ?? imageFake(), writer = options.writer ?? writerFake();
  const runsDir = tmp('layerize-'), dir = tmp('image-templates-');
  const uploads: Buffer[] = [], submitted: Record<string, unknown>[] = [];
  let active = 0, mostAtOnce = 0;
  // The decomposition planner: every run plans semantically, so any other request is a mistake.
  const create = vi.fn(async (request: { text: { format: { schema: unknown } } }) => {
    if (request.text.format.schema !== SEMANTIC_SCHEMA) throw new Error('Only the semantic planner is expected.');
    return { status: 'completed', output: [], output_text: JSON.stringify(semanticFixture) };
  });
  const planner = createOpenAIPlanner({ client: { responses: { create } } as never });
  // fal: the base layer is the uploaded image itself, so every run completes with a real layer at the image's size.
  const transport: FalTransport = {
    upload: async (image) => { uploads.push(image as Buffer); mostAtOnce = Math.max(mostAtOnce, ++active); return `https://v3b.fal.media/files/t/in-${uploads.length}.png`; },
    submit: async (_endpoint, input) => { submitted.push(input); return { requestId: `r${submitted.length}` }; }, status: async () => 'COMPLETED',
    result: async () => { await options.slowResult?.(); active--; return { layers: [{ image: { url: `https://v3b.fal.media/files/t/base-${uploads.length}.png` }, z_index: 0 }] }; },
    cancel: async () => undefined, download: async (url) => uploads[Number(/base-(\d+)/.exec(url)![1]) - 1],
  };
  const deps = (): RunnerDeps => ({ planner, transport: () => transport, sleep: async () => undefined });
  const app = express().use('/x', createLayerizeRouter({ runsDir, deps, generation: () => ({ ...images.config, ...options.config }), imageTemplatesDir: dir, imagePrompt: () => writer.writer,
    templatesDir: tmp('creative-templates-'), executionsDir: tmp('template-executions-') })).listen(0, '127.0.0.1');
  await new Promise(done => app.once('listening', done));
  const { port } = app.address() as AddressInfo;
  const url = (path: string) => `http://127.0.0.1:${port}/x${path}`;
  const send = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(url(path), { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json() };
  };
  const get = (path: string) => send('GET', path), post = (path: string, body: unknown = {}) => send('POST', path, body), patch = (path: string, body: unknown) => send('PATCH', path, body);
  const upload = async (image: Buffer | undefined, fields: Record<string, string> = {}, fileName = 'reference.png', mimeType = 'image/png', path = '/image-templates/draft') => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    if (image) form.append('image', new Blob([new Uint8Array(image)], { type: mimeType }), fileName);
    const r = await fetch(url(path), { method: 'POST', body: form });
    return { status: r.status, body: await r.json() };
  };
  const wait = async <T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> => {
    for (let i = 0; i < 600; i++) { const value = await read(); if (done(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error('Never settled.');
  };
  type Shown = Omit<ImageTemplate, 'variants'> & { variants: (ImageTemplate['variants'][number] & { decomposition?: { runId: string; state: string; layers?: number; resumable?: boolean; error?: { code: string } } })[] };
  const template = async (id: string) => (await get(`/image-templates/${id}`)).body as Shown;
  /** A new draft from an uploaded reference: nothing is sent anywhere. */
  const uploaded = async (fields: Record<string, string> = {}) => {
    const created = await upload(await png(1600, 1200, '#a58bd8'), fields);
    expect(created.status).toBe(201);
    return created.body as Shown;
  };
  /** A draft whose reference has been analyzed (one prompt request), with its generation settings. */
  const draft = async (fields: Record<string, string> = {}) => {
    const { id } = await uploaded(fields);
    expect((await post(`/image-templates/${id}/prompt`)).status).toBe(202);
    return wait(() => template(id), t => t.promptGeneration?.status !== 'generating');
  };
  /** Generates every size of an analyzed draft, as the screen sends it: the name, the settings and their prompt, all three sizes. */
  const generate = (t: Shown, settings: ReferenceCreativeDraft = t.referenceCreative!, name = t.name) =>
    post(`/image-templates/${t.id}/generate`, { name, prompt: settings.prompt, aspectRatios: [...ALL_RATIOS], referenceCreative: settings });
  const settled = (id: string) => wait(() => template(id), t => !t.variants.some(v => v.status === 'queued' || v.status === 'generating'));
  /** An analyzed creative with its three sizes generated. */
  const generated = async () => {
    const t = await draft();
    expect((await generate(t)).status).toBe(202);
    return settled(t.id);
  };
  const decomposed = (id: string) => wait(() => template(id), t => !t.variants.some(v => v.decomposition && ['waiting', 'running'].includes(v.decomposition.state)));
  return { app, url, get, post, patch, upload, uploaded, draft, generate, generated, template, settled, decomposed, wait, images, writer, create, runsDir, dir, uploads, submitted, mostAtOnce: () => mostAtOnce };
}

describe('Reference creatives', () => {
  it.each([3344, 4002])('%i-character structured response persists a usable prompt after exactly one analysis; regenerate is explicit', async length => {
    const fake = writerFake(), response = verboseImageAnalysis(length);
    const create = vi.fn(async () => ({ status: 'completed', output: [], output_text: JSON.stringify(response) }));
    fake.writer = createOpenAIImagePromptWriter({ model: 'gpt-5-mini', client: { responses: { create } } as never });
    const s = await server({ writer: fake });
    try {
      const t = await s.draft({ name: 'Keep this name' });
      expect(t.promptGeneration?.status).toBe('done');
      expect(t.prompt.length).toBeLessThanOrEqual(IMAGE_TEMPLATE_LIMITS.prompt);
      expect(t.analysis?.hero.identity).toBe('one lavender smartphone');
      expect(t.prompt).toContain('4 lavender/white spheres');
      expect(t.referenceCreative).toEqual(createReferenceCreative(t.analysis!));
      expect(create).toHaveBeenCalledTimes(1);
      expect(s.images.send).not.toHaveBeenCalled(); expect(s.create).not.toHaveBeenCalled();
      // Analyzing again is explicit: it keeps the name and the reference, and its settings replace the edited ones.
      const settings = editReferenceChoices(t.referenceCreative!, t.analysis!, { changes: { mood: 'Warm afternoon lighting' } });
      expect((await s.patch(`/image-templates/${t.id}`, { referenceCreative: settings })).body.referenceCreative).toEqual(settings);
      await s.post(`/image-templates/${t.id}/prompt`);
      const again = await s.wait(() => s.template(t.id), t => t.promptGeneration?.status === 'done' && t.promptGeneration.attempts === 2);
      expect(again).toMatchObject({ name: 'Keep this name', reference: t.reference, aspectRatios: [...ALL_RATIOS], analysis: t.analysis, referenceCreative: t.referenceCreative });
      expect(create).toHaveBeenCalledTimes(2);
      expect(s.images.send).not.toHaveBeenCalled(); expect(s.create).not.toHaveBeenCalled();
      expect((await s.generate(again, settings)).status).toBe(202);
      const done = await s.settled(t.id);
      expect(done.variants.map(v => v.status)).toEqual(['done', 'done', 'done']);
      expect(s.images.requests.map(r => r.method)).toEqual(['edit', 'edit', 'edit']);
      for (const request of s.images.requests) {
        expect(request.prompt.startsWith(settings.prompt)).toBe(true);
        expect(request.prompt).toContain('Warm afternoon lighting');
        expect(request.prompt.length).toBeLessThanOrEqual(IMAGE_TEMPLATE_REQUEST_LIMIT);
        expect(sha(Buffer.from(await (request.image as File).arrayBuffer()))).toBe(t.reference.sha256);
      }
      expect(create).toHaveBeenCalledTimes(2);
    } finally { s.app.close(); }
  });

  it('rejects over-limit custom prompts without any image request, then accepts the exact inclusive editable boundary', async () => {
    const s = await server();
    try {
      const t = await s.draft({ name: 'Boundary' }), exact = 'a'.repeat(IMAGE_TEMPLATE_LIMITS.prompt);
      const custom = (prompt: string): ReferenceCreativeDraft => ({ ...t.referenceCreative!, mode: 'custom', prompt });
      for (const invalid of [exact + 'b', exact + ' ']) {
        expect(await s.generate(t, custom(invalid))).toMatchObject({ status: 400, body: { error: { code: 'INVALID_PROMPT' } } });
        expect(await s.patch(`/image-templates/${t.id}`, { referenceCreative: custom(invalid) })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_REQUEST' } } });
        expect(await s.patch(`/image-templates/${t.id}`, { prompt: invalid })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_REQUEST' } } });
      }
      expect(s.images.send).not.toHaveBeenCalled();
      expect((await s.generate(t, custom(exact))).status).toBe(202);
      await s.settled(t.id);
      expect(s.images.requests).toHaveLength(3);
      for (const request of s.images.requests) expect(request.prompt.startsWith(exact)).toBe(true);
    } finally { s.app.close(); }
  });

  it('checks the FULL edit request including appended reference text before instantiating the provider', async () => {
    const s = await server();
    try {
      const t = await s.draft({ name: 'Full boundary' });
      const referenceCreative: ReferenceCreativeDraft = { ...t.referenceCreative!, mode: 'custom', prompt: 'a'.repeat(IMAGE_TEMPLATE_LIMITS.prompt) };
      const { template } = startImageTemplateGeneration(s.dir, t.id, { referenceCreative }, s.images.config, false);
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

  it('1–4. saves the uploaded reference as a draft with nothing sent, and analyzes it only when asked: one prompt request, nothing else', async () => {
    const s = await server();
    try {
      const reference = await png(1600, 1200, '#a58bd8');
      const created = await s.upload(reference, { name: '' }, 'lavender.png');
      expect(created).toMatchObject({ status: 201, body: { kind: 'image-template', workflow: 'offer-reference', name: '', prompt: '', aspectRatios: [...ALL_RATIOS], variants: [],
        reference: { file: 'reference.png', originalName: 'lavender.png', mimeType: 'image/png', width: 1600, height: 1200, bytes: reference.length, sha256: sha(reference) } } });
      expect(created.body).not.toHaveProperty('promptGeneration');
      expect(s.writer.writer.describe).not.toHaveBeenCalled();
      expect(await s.post(`/image-templates/${created.body.id}/prompt`)).toMatchObject({ status: 202, body: { promptGeneration: { status: 'generating', attempts: 1 } } });
      const done = await s.wait(() => s.template(created.body.id), t => t.promptGeneration?.status === 'done');
      // The analysis is kept and its prompt becomes the working prompt; the generation settings start from the analysis;
      // an unnamed draft takes the suggested name.
      expect(done).toMatchObject({ analysis: ANALYSIS, generatedPrompt: PROMPT, prompt: PROMPT, promptEdited: false, name: 'Lavender phone studio', referenceCreative: createReferenceCreative(ANALYSIS),
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
      expect((await s.uploaded({ name: '  Diwali   offer  ' })).name).toBe('Diwali offer');
      expect((await s.draft({ name: 'Diwali offer' })).name).toBe('Diwali offer');
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

  it.each([['png', 'png'], ['jpeg', 'jpg'], ['webp', 'webp']] as const)('accepts fully decodable %s bytes whose MIME type and extension match, and refuses a mismatching extension', async (format, extension) => {
    const s = await server();
    try {
      const image = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#999' } }).toFormat(format).toBuffer();
      expect(await s.upload(image, { name: 'Valid source' }, 'untrusted.gif', `image/${format}`)).toMatchObject({ status: 400, body: { error: { code: 'UNSUPPORTED_IMAGE' } } });
      expect(readdirSync(s.dir)).toEqual([]);
      const reply = await s.upload(image, { name: 'Valid source' }, `source.${extension}`, `image/${format}`);
      expect(reply).toMatchObject({ status: 201, body: { reference: { file: `reference.${extension}`, mimeType: `image/${format}`, sha256: sha(image), width: 32, height: 24 } } });
      expect(s.writer.writer.describe).not.toHaveBeenCalled();
      await s.post(`/image-templates/${reply.body.id}/prompt`);
      const t = await s.wait(() => s.template(reply.body.id), t => t.promptGeneration?.status !== 'generating');
      expect(t.promptGeneration?.status).toBe('done');
      expect(s.writer.writer.describe).toHaveBeenCalledTimes(1);
      expect(s.images.send).not.toHaveBeenCalled();
    } finally { s.app.close(); }
  });

  it('an interrupted multipart upload leaves no group and calls no provider', async () => {
    const s = await server();
    try {
      await new Promise<void>(resolve => {
        const request = httpRequest(s.url('/image-templates/draft'), { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=interrupted', 'Content-Length': '10000' } });
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

  it('preserves sizes chosen before upload, rejects invalid sizes before anything is saved, and generates only all three sizes', async () => {
    const s = await server();
    try {
      const image = await png(64, 64);
      for (const aspectRatios of ['null', 'invalid', '["9:16"]']) {
        expect(await s.upload(image, { name: 'Draft', aspectRatios })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_ASPECT_RATIO' } } });
      }
      expect(readdirSync(s.dir)).toEqual([]);
      const created = await s.upload(image, { name: 'Draft', aspectRatios: '["16:9"]' });
      expect(created).toMatchObject({ status: 201, body: { aspectRatios: ['16:9'] } });
      expect(s.writer.writer.describe).not.toHaveBeenCalled();
      await s.post(`/image-templates/${created.body.id}/prompt`);
      const t = await s.wait(() => s.template(created.body.id), t => t.promptGeneration?.status === 'done');
      expect(t.aspectRatios).toEqual(['16:9']);
      // A campaign is the three sizes together: the chosen one alone is refused, nothing is sent.
      expect(await s.post(`/image-templates/${t.id}/generate`, { referenceCreative: t.referenceCreative })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_ASPECT_RATIO' } } });
      expect(await s.post(`/image-templates/${t.id}/generate`, { referenceCreative: t.referenceCreative, aspectRatios: ['1:1', '16:9'] })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_ASPECT_RATIO' } } });
      expect(s.images.send).not.toHaveBeenCalled();
      expect((await s.generate(t)).body.aspectRatios).toEqual([...ALL_RATIOS]);
      expect((await s.settled(t.id)).variants.map(v => v.status)).toEqual(['done', 'done', 'done']);
    } finally { s.app.close(); }
  });

  it('keeps a failed prompt request on the draft, and asks again only when told; a new analysis replaces the edits', async () => {
    const writer = writerFake(), s = await server({ writer });
    try {
      writer.failWith(Object.assign(new Error('OpenAI gpt-5-mini request failed (HTTP 429): Rate limit.'), { code: 'PROMPT_API_ERROR' }));
      const failed = await s.draft();
      expect(failed).toMatchObject({ prompt: '', name: '', promptGeneration: { status: 'failed', attempts: 1, error: { code: 'PROMPT_FAILED', message: expect.stringContaining('HTTP 429') } } });
      expect(failed).not.toHaveProperty('analysis');
      expect(failed).not.toHaveProperty('referenceCreative');
      // Nothing is generated from a reference that was not analyzed.
      expect(await s.post(`/image-templates/${failed.id}/generate`, { name: 'x' })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_REQUEST' } } });
      writer.failWith(undefined);
      // While it is being written it is "generating", and a second request is refused.
      const open = writer.hold();
      expect(await s.post(`/image-templates/${failed.id}/prompt`)).toMatchObject({ status: 202, body: { promptGeneration: { status: 'generating', attempts: 2 } } });
      expect(await s.post(`/image-templates/${failed.id}/prompt`)).toMatchObject({ status: 409, body: { error: { code: 'BUSY' } } });
      expect(await s.post(`/image-templates/${failed.id}/generate`, { name: 'x' })).toMatchObject({ status: 400, body: { error: { code: 'PROMPT_IN_PROGRESS' } } });
      expect(await s.patch(`/image-templates/${failed.id}`, { prompt: 'Do not silently overwrite this edit.' })).toMatchObject({ status: 409, body: { error: { code: 'BUSY' } } });
      expect(await s.patch(`/image-templates/${failed.id}`, { referenceCreative: createReferenceCreative(ANALYSIS) })).toMatchObject({ status: 409, body: { error: { code: 'BUSY' } } });
      open();
      const written = await s.wait(() => s.template(failed.id), t => t.promptGeneration?.status === 'done');
      expect(written).toMatchObject({ prompt: PROMPT, promptEdited: false, name: 'Lavender phone studio', analysis: ANALYSIS, referenceCreative: createReferenceCreative(ANALYSIS), promptGeneration: { attempts: 2 } });
      expect(writer.writer.describe).toHaveBeenCalledTimes(2);
      // An edit is kept until a new analysis is asked for.
      const edited = editReferenceChoices(written.referenceCreative!, written.analysis!, { changes: { mood: 'Golden hour' } });
      expect((await s.patch(`/image-templates/${failed.id}`, { referenceCreative: edited })).body).toMatchObject({ referenceCreative: edited, prompt: edited.prompt });
      await s.post(`/image-templates/${failed.id}/prompt`);
      expect(await s.wait(() => s.template(failed.id), t => t.promptGeneration?.status === 'done' && t.promptGeneration.attempts === 3)).toMatchObject({ prompt: PROMPT, promptEdited: false, referenceCreative: createReferenceCreative(ANALYSIS) });
      expect(s.images.send).not.toHaveBeenCalled();
      expect(s.create).not.toHaveBeenCalled();
      expect(new Set(writer.seen.map(input => sha(input.image))).size).toBe(1);
    } finally { s.app.close(); }
  });

  it('5. the name, the sizes, the generation settings and the template link can be changed on a draft, within their limits', async () => {
    const s = await server();
    try {
      // The generation settings come from the analysis: none can be set before it.
      const fresh = await s.uploaded();
      expect(await s.patch(`/image-templates/${fresh.id}`, { referenceCreative: createReferenceCreative(ANALYSIS) })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_REQUEST' } } });
      const t = await s.draft();
      expect((await s.patch(`/image-templates/${t.id}`, { name: 'Spring sale', aspectRatios: ['16:9', '1:1'], originTemplate: { id: 'tpl-1', name: 'Merchant template' } })).body)
        .toMatchObject({ name: 'Spring sale', aspectRatios: ['1:1', '16:9'], originTemplate: { id: 'tpl-1', name: 'Merchant template' } });
      expect((await s.patch(`/image-templates/${t.id}`, { aspectRatios: [] })).body.aspectRatios).toEqual([]);
      expect((await s.patch(`/image-templates/${t.id}`, { name: '' })).body.name).toBe('');
      const custom: ReferenceCreativeDraft = { ...t.referenceCreative!, mode: 'custom', prompt: `${PROMPT} Golden hour.` };
      expect((await s.patch(`/image-templates/${t.id}`, { referenceCreative: custom })).body).toMatchObject({ referenceCreative: custom, prompt: custom.prompt, promptEdited: true });
      expect(await s.patch(`/image-templates/${t.id}`, { prompt: 'x'.repeat(IMAGE_TEMPLATE_LIMITS.prompt + 1) })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_REQUEST' } } });
      expect(await s.patch(`/image-templates/${t.id}`, { aspectRatios: ['9:16'] })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_ASPECT_RATIO' } } });
      for (const referenceCreative of [{ ...custom, prompt: `<b>${PROMPT}</b>` }, { ...custom, changes: { ...custom.changes, product: 'x'.repeat(141) } }, { ...custom, templateKey: 'template-b' }]) {
        expect(await s.patch(`/image-templates/${t.id}`, { referenceCreative })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_REQUEST' } } });
      }
      expect(await s.patch(`/image-templates/${t.id}`, { originTemplate: { id: '../other', name: 'Elsewhere' } })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_REQUEST' } } });
      // Settings this workflow does not have are refused.
      for (const body of [{ decomposeWith: 'template-b' }, { fields: {} }]) expect(await s.patch(`/image-templates/${t.id}`, body)).toMatchObject({ status: 400, body: { error: { code: 'INVALID_REQUEST' } } });
      expect((await s.template(t.id)).referenceCreative).toEqual(custom);
      expect(s.images.send).not.toHaveBeenCalled();
      expect(s.writer.writer.describe).toHaveBeenCalledTimes(1);
    } finally { s.app.close(); }
  });

  it('6. edits the original upload for every size with the exact settings prompt without chaining outputs, then fixes the settings', async () => {
    const s = await server();
    try {
      const t = await s.draft();
      const settings = editReferenceChoices(t.referenceCreative!, t.analysis!, { changes: { mood: 'Golden hour light' } });
      // What generating needs: a name, settings whose prompt matches them, all three sizes, and nothing else.
      expect(await s.generate(t, settings, ' ')).toMatchObject({ status: 400, body: { error: { code: 'INVALID_NAME' } } });
      expect(await s.post(`/image-templates/${t.id}/generate`, { name: 'Lavender', referenceCreative: settings, prompt: `${settings.prompt} Extra.` })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_PROMPT' } } });
      expect(await s.post(`/image-templates/${t.id}/generate`, { name: 'Lavender', referenceCreative: { ...settings, prompt: `${settings.prompt} Extra.` } })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_PROMPT' } } });
      expect(await s.post(`/image-templates/${t.id}/generate`, { name: 'Lavender', referenceCreative: settings, basePrompt: 'x' })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_REQUEST' } } });
      expect(s.images.send).not.toHaveBeenCalled();

      const started = await s.generate(t, settings, 'Lavender launch');
      expect(started).toMatchObject({ status: 202, body: { name: 'Lavender launch', prompt: settings.prompt, referenceCreative: settings, generatedPrompt: PROMPT, aspectRatios: [...ALL_RATIOS], ratioStrategy: 'uploaded-reference' } });
      expect(started.body.variants.map((v: { id: string; status: string }) => [v.id, v.status])).toEqual([['1x1', 'queued'], ['4x5', 'queued'], ['16x9', 'queued']]);
      const done = await s.settled(t.id);
      expect(done.variants.map(v => [v.aspectRatio, v.status, v.size])).toEqual([['1:1', 'done', { width: 1024, height: 1024 }], ['4:5', 'done', { width: 1216, height: 1520 }], ['16:9', 'done', { width: 1536, height: 864 }]]);
      // Even the first size is an edit of the original upload, never text-only generation.
      expect(s.images.requests.map(r => [r.method, r.size])).toEqual([['edit', '1024x1024'], ['edit', '1216x1520'], ['edit', '1536x864']]);
      const instruction = done.generationSnapshot!.instruction;
      expect(instruction).toContain('Use original image 1 for every ratio, never generated outputs.');
      for (const [index, ratio] of ALL_RATIOS.entries()) expect(s.images.requests[index].prompt).toBe(`${settings.prompt} ${IMAGE_TEMPLATE_CONSISTENCY} ${IMAGE_TEMPLATE_FRAMING[ratio]} ${instruction}`);
      const originalSha = sha(readFileSync(join(s.dir, t.id, t.reference.file)));
      expect(s.images.inputs).toEqual([originalSha, originalSha, originalSha]);
      expect(sha(s.writer.seen[0].image)).not.toBe(originalSha); // Not the resized analysis JPEG, either.
      expect(s.images.sent.map(sha)).not.toContain(originalSha);
      const sourceReference = { file: t.reference.file, sha256: originalSha, instruction };
      for (const variant of done.variants) {
        expect(variant.sourceReference).toEqual(sourceReference);
        expect(variant).not.toHaveProperty('reference');
        const request = JSON.parse(readFileSync(join(s.dir, t.id, variant.requestFile!), 'utf8'));
        expect(request).toMatchObject({ method: 'images.edit', image: expect.stringContaining(`original uploaded reference: ${t.reference.file}, sha256 ${originalSha}`) });
      }
      expect(done.generationSnapshot).toMatchObject({ id: t.id, referenceSha256: originalSha, blueprintVersion: 1, settings, analysis: t.analysis, model: 'gpt-image-2', aspectRatios: [...ALL_RATIOS] });
      // Each image is served exactly as generated.
      const served = await fetch(s.url(`/image-templates/${t.id}/variants/16x9/image`));
      expect(sha(Buffer.from(await served.arrayBuffer()))).toBe(sha(s.images.sent[2]));
      // From now on the settings, the prompt and the sizes are fixed; the name can still change, but not to nothing.
      expect(await s.generate(t, settings, 'Again')).toMatchObject({ status: 400, body: { error: { code: 'ALREADY_GENERATED' } } });
      expect(await s.patch(`/image-templates/${t.id}`, { referenceCreative: settings })).toMatchObject({ status: 400, body: { error: { code: 'ALREADY_GENERATED' } } });
      expect(await s.patch(`/image-templates/${t.id}`, { prompt: PROMPT })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_REQUEST' } } });
      expect(await s.patch(`/image-templates/${t.id}`, { aspectRatios: ['1:1'] })).toMatchObject({ status: 400, body: { error: { code: 'ALREADY_GENERATED' } } });
      expect(await s.post(`/image-templates/${t.id}/prompt`)).toMatchObject({ status: 400, body: { error: { code: 'ALREADY_GENERATED' } } });
      expect(await s.patch(`/image-templates/${t.id}`, { name: '' })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_NAME' } } });
      expect((await s.patch(`/image-templates/${t.id}`, { name: 'Lavender launch v2' })).body.name).toBe('Lavender launch v2');
      // A finished size keeps its image: it is never generated again.
      expect(await s.post(`/image-templates/${t.id}/variants/4x5/generate`)).toMatchObject({ status: 400, body: { error: { code: 'ALREADY_GENERATED' } } });
      expect(s.images.requests).toHaveLength(3);
      expect(s.writer.writer.describe).toHaveBeenCalledTimes(1);
    } finally { s.app.close(); }
  });

  it('7. a failed size leaves the others; retry uses the same original and the saved settings, and takes no others', async () => {
    const images = imageFake(), s = await server({ images });
    try {
      const t = await s.draft();
      images.failWhen(request => request.size === '1216x1520' && images.requests.filter(r => r.size === '1216x1520').length === 1);
      expect((await s.generate(t)).status).toBe(202);
      const first = await s.settled(t.id);
      expect(first.variants.map(v => v.status)).toEqual(['done', 'failed', 'done']);
      expect(first.variants[1].error).toMatchObject({ code: 'PROVIDER_NETWORK', status: 500 });
      expect(await s.post(`/image-templates/${t.id}/variants/1x1/generate`)).toMatchObject({ status: 400, body: { error: { code: 'ALREADY_GENERATED' } } });
      for (const body of [{ independent: true }, { prompt: PROMPT }, { referenceCreative: { mode: 'custom' } }]) {
        expect(await s.post(`/image-templates/${t.id}/variants/4x5/generate`, body)).toMatchObject({ status: 400, body: { error: { code: 'INVALID_REQUEST' } } });
      }
      expect(images.requests).toHaveLength(3);
      expect((await s.template(t.id)).variants[1]).toMatchObject({ status: 'failed', attempts: 1 });
      expect((await s.post(`/image-templates/${t.id}/variants/4x5/generate`)).status).toBe(202);
      const again = await s.settled(t.id);
      expect(again.variants.map(v => v.status)).toEqual(['done', 'done', 'done']);
      expect(again.variants[1]).not.toHaveProperty('reference');
      expect(again.variants[1]).toMatchObject({ attempts: 2, sourceReference: { file: t.reference.file, sha256: t.reference.sha256 } });
      expect(again.variants[0].image).toEqual(first.variants[0].image); expect(again.variants[2].image).toEqual(first.variants[2].image);
      expect(images.requests.map(r => [r.method, r.size])).toEqual([['edit', '1024x1024'], ['edit', '1216x1520'], ['edit', '1536x864'], ['edit', '1216x1520']]);
      expect(images.requests[3].prompt).toBe(images.requests[1].prompt);
      expect(images.inputs).toEqual(Array(4).fill(t.reference.sha256));
      expect(images.sent.map(sha)).not.toContain(t.reference.sha256);
    } finally { s.app.close(); }
  });

  it.each(['reference', undefined] as const)('uses the original upload for a size added later to an older record with strategy %s', async (strategy) => {
    const images = imageFake(), s = await server({ images });
    try {
      const t = await s.draft();
      images.failWhen(request => request.size === '1536x864');
      await s.generate(t);
      // Rewritten as an older creative: generated before every size was required, without a snapshot, 16:9 never chosen.
      const record = await s.settled(t.id);
      if (strategy) record.ratioStrategy = strategy;
      else delete record.ratioStrategy;
      for (const variant of record.variants) delete variant.sourceReference;
      delete record.generationSnapshot; delete record.workflow; delete record.referenceCreative;
      record.aspectRatios = ['1:1', '4:5'];
      Object.assign(record.variants[2], { status: 'pending', attempts: 0, prompt: '' });
      delete record.variants[2].error;
      writeFileSync(join(s.dir, t.id, 'group.json'), JSON.stringify(record));
      images.failWhen(undefined);
      expect((await s.post(`/image-templates/${t.id}/variants/16x9/generate`)).body).toMatchObject({ aspectRatios: [...ALL_RATIOS], ratioStrategy: 'uploaded-reference' });
      const after = await s.settled(t.id);
      expect(after.variants[2]).toMatchObject({ status: 'done', attempts: 1, sourceReference: { file: t.reference.file, sha256: t.reference.sha256 } });
      expect(images.requests[3].prompt).toBe(`${imageTemplateVariantPrompt(record.prompt, '16:9')} ${after.variants[2].sourceReference!.instruction}`);
      expect(images.requests.map(r => r.method)).toEqual(['edit', 'edit', 'edit', 'edit']);
      expect(images.inputs).toEqual(Array(4).fill(t.reference.sha256));
      expect(images.inputs[3]).not.toBe(sha(images.sent[0]));
    } finally { s.app.close(); }
  });

  it('fails without any image request when the original file is missing, with no text-only fallback', async () => {
    const s = await server();
    try {
      const t = await s.draft();
      const referencePath = join(s.dir, t.id, t.reference.file), original = readFileSync(referencePath);
      unlinkSync(referencePath);
      expect((await s.generate(t, t.referenceCreative!, 'Missing reference')).status).toBe(202);
      const failed = await s.settled(t.id);
      for (const variant of failed.variants) {
        expect(variant).toMatchObject({ status: 'failed', attempts: 1, error: { code: 'GENERATION_FAILED', message: expect.stringContaining('ENOENT') }, sourceReference: { sha256: t.reference.sha256 } });
      }
      expect(s.images.send).not.toHaveBeenCalled();
      writeFileSync(referencePath, original);
      expect((await s.post(`/image-templates/${t.id}/variants/1x1/generate`)).status).toBe(202);
      expect((await s.settled(t.id)).variants.map(v => [v.status, v.attempts])).toEqual([['done', 2], ['failed', 1], ['failed', 1]]);
      expect(s.images.requests.map(r => r.method)).toEqual(['edit']);
      expect(s.images.inputs).toEqual([t.reference.sha256]);
    } finally { s.app.close(); }
  });

  it('rejects a changed canonical source before any provider request', async () => {
    const s = await server();
    try {
      const t = await s.draft();
      writeFileSync(join(s.dir, t.id, t.reference.file), await png(64, 64));
      await s.generate(t, t.referenceCreative!, 'Integrity');
      for (const variant of (await s.settled(t.id)).variants) expect(variant).toMatchObject({ status: 'failed', error: { code: 'REFERENCE_CHANGED' } });
      expect(s.images.send).not.toHaveBeenCalled();
    } finally { s.app.close(); }
  });

  it('concurrent initial generation and same-size requests submit only once', async () => {
    const images = imageFake(), release = images.hold(), s = await server({ images });
    try {
      const t = await s.draft({ name: 'One request' });
      const responses = await Promise.all([s.generate(t), s.generate(t)]);
      expect(responses.map(r => r.status).sort()).toEqual([202, 400]);
      const duplicates = await Promise.all([s.post(`/image-templates/${t.id}/variants/1x1/generate`), s.post(`/image-templates/${t.id}/variants/1x1/generate`), s.post(`/image-templates/${t.id}/variants/16x9/generate`)]);
      expect(duplicates.map(r => r.status)).toEqual([409, 409, 409]);
      await s.wait(async () => images.requests.length, count => count === 1);
      release();
      const done = await s.settled(t.id);
      expect(images.requests).toHaveLength(3);
      expect(done.variants.map(v => [v.status, v.attempts])).toEqual([['done', 1], ['done', 1], ['done', 1]]);
      expect(done.reference).toEqual(t.reference);
    } finally { release(); s.app.close(); }
  });

  it('source replacement requires a new group; a new analysis preserves the draft name and selected sizes', async () => {
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
      expect(other.body).toMatchObject({ prompt: '', variants: [] });
      expect(other.body).not.toHaveProperty('analysis');
      expect(other.body).not.toHaveProperty('referenceCreative');
      expect((await s.template(t.id)).reference).toEqual(t.reference);
    } finally { s.app.close(); }
  });

  it('8–9. decomposes one size as an ordinary semantic run with the recursive refinement, and records when it is opened in the editor', async () => {
    const images = imageFake(), s = await server({ images });
    try {
      const t = await s.draft();
      expect(await s.post(`/image-templates/${t.id}/variants/1x1/decompose`)).toMatchObject({ status: 404, body: { error: { code: 'NOT_FOUND' } } });
      images.failWhen(request => request.size === '1536x864');
      await s.generate(t);
      await s.settled(t.id);
      expect(await s.post(`/image-templates/${t.id}/variants/16x9/decompose`)).toMatchObject({ status: 400, body: { error: { code: 'NOT_DECOMPOSABLE' } } });
      expect(await s.post(`/image-templates/${t.id}/variants/4x5/decompose`, { templateKey: 'template-b' })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_REQUEST' } } });
      expect(s.create).not.toHaveBeenCalled(); expect(s.submitted).toEqual([]);
      const started = await s.post(`/image-templates/${t.id}/variants/4x5/decompose`);
      expect(started.status).toBe(202);
      const entry = started.body.variants[1].decompositions[0];
      expect(entry).toEqual({ runId: expect.any(String), createdAt: expect.any(String) });
      const done = await s.decomposed(t.id);
      expect(done.variants[1].decomposition).toMatchObject({ runId: entry.runId, state: 'done', layers: 1 });
      expect(done.variants[0]).not.toHaveProperty('decomposition');
      // An ordinary semantic run of exactly that image, refined, linked back to the creative and the size.
      const run = readRun(join(s.runsDir, entry.runId));
      expect(run).toMatchObject({ stage: 'done', promptSource: { mode: 'generated' }, semanticPlanning: true, refinement: expect.any(Object),
        origin: { kind: 'image-template', generationId: t.id, variantId: '4x5', aspectRatio: '4:5' }, original: { width: 1216, height: 1520 } });
      expect(run).not.toHaveProperty('templateKey');
      expect(run.finalPrompt).toBe(`${semanticFixture.downstream_decomposition_prompt} ${PROTECTION_CLAUSE}`);
      expect(run.planner?.semantic_analysis).toEqual(semanticFixture);
      expect(sha(s.uploads[0])).toBe(sha(images.sent[1]));
      expect(s.create).toHaveBeenCalledTimes(1);
      expect(s.create.mock.calls[0][0].text.format.schema).toBe(SEMANTIC_SCHEMA);
      expect(s.submitted).toHaveLength(1);
      // The run is served by the experiment's own run routes, as any run.
      expect((await s.get(`/runs/${entry.runId}`)).body).toMatchObject({ id: entry.runId, stage: 'done', origin: { kind: 'image-template' } });
      // Opening it in the editor is recorded on the size; only a finished decomposition of that size can be.
      expect(await s.post(`/image-templates/${t.id}/variants/1x1/opened`, { runId: entry.runId })).toMatchObject({ status: 400, body: { error: { code: 'NOT_DECOMPOSED' } } });
      expect(await s.post(`/image-templates/${t.id}/variants/4x5/opened`, { runId: entry.runId, version: 2 })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_REQUEST' } } });
      const opened = await s.post(`/image-templates/${t.id}/variants/4x5/opened`, { runId: entry.runId });
      expect(opened.body.variants[1].editor).toMatchObject({ runId: entry.runId, openedAt: expect.any(String) });
    } finally { s.app.close(); }
  });

  it('uses semantic planning, with the recursive refinement, for every size it decomposes', async () => {
    const s = await server();
    try {
      const t = await s.generated();
      const runIds: string[] = [];
      for (const [index, id] of ['1x1', '4x5', '16x9'].entries()) runIds.push((await s.post(`/image-templates/${t.id}/variants/${id}/decompose`)).body.variants[index].decompositions[0].runId);
      await s.decomposed(t.id);
      for (const [index, runId] of runIds.entries()) {
        const run = readRun(join(s.runsDir, runId));
        expect(run).toMatchObject({ stage: 'done', semanticPlanning: true, promptSource: { mode: 'generated' }, refinement: expect.any(Object), origin: { generationId: t.id, aspectRatio: ALL_RATIOS[index] } });
        expect(run.planner?.semantic_analysis).toEqual(semanticFixture);
      }
      expect(s.create.mock.calls.map(([request]) => request.text.format.schema)).toEqual([SEMANTIC_SCHEMA, SEMANTIC_SCHEMA, SEMANTIC_SCHEMA]);
    } finally { s.app.close(); }
  });

  it('decompositions asked for while a run is active wait their turn; one run at a time, and the existing upload route still refuses while one runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    const s = await server({ slowResult: () => gate });
    try {
      const t = await s.generated();
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
    } finally { release(); s.app.close(); }
  });

  it('shows what a stopped server left behind as failed, and offers resuming only a run fal has a request for', async () => {
    const s = await server();
    try {
      const t = await s.generated();
      const runId = (await s.post(`/image-templates/${t.id}/variants/1x1/decompose`)).body.variants[0].decompositions[0].runId;
      await s.decomposed(t.id);
      // Rewrite the records as a stopped server would have left them: a prompt being written, a size and a run in flight.
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

  it('reserves a size before asynchronous run creation: simultaneous decomposition requests spend only once', async () => {
    const s = await server();
    try {
      const t = await s.generated();
      const replies = await Promise.all(Array.from({ length: 4 }, () => s.post(`/image-templates/${t.id}/variants/1x1/decompose`)));
      expect(replies.map(r => r.status).sort()).toEqual([202, 409, 409, 409]);
      const done = await s.decomposed(t.id);
      expect(done.variants[0].decompositions).toHaveLength(1);
      expect(s.submitted).toHaveLength(1);
    } finally { s.app.close(); }
  });

  it('10. tells the screen its sizes, limits and models, and keeps its creatives in its own folder', async () => {
    const s = await server();
    try {
      const t = await s.uploaded();
      expect((await s.get('/image-templates/info')).body).toEqual({ ratios: [{ ratio: '1:1', name: 'Square', width: 1024, height: 1024 }, { ratio: '4:5', name: 'Portrait', width: 1216, height: 1520 }, { ratio: '16:9', name: 'Landscape', width: 1536, height: 864 }],
        limits: IMAGE_TEMPLATE_LIMITS, productReferenceSupported: true, imageModel: 'gpt-image-2', promptModel: 'gpt-5-mini', ratioReference: true });
      expect((await s.get('/image-templates')).body.templates.map((x: { id: string }) => x.id)).toEqual([t.id]);
      expect(readdirSync(s.dir)).toEqual([t.id]);
      expect(readdirSync(s.runsDir)).toEqual([]);
      expect((await s.get('/image-templates/not-a-creative')).status).toBe(404);
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
    const analysis = normalizeImageAnalysis(valid.analysis);
    expect(result).toMatchObject({ analysis, prompt: buildImageTemplatePrompt(analysis), suggestedName: 'Lavender phone studio', model: 'gpt-5-mini', responseId: 'resp_9' });
    // A layer style the answer still names is not read.
    expect(result).not.toHaveProperty('templateKey'); expect(result).not.toHaveProperty('reason');
    const request = (client.responses.create.mock.calls[0] as unknown as [unknown])[0] as { model: string; store: boolean; instructions: string; input: { content: { type: string; image_url?: string; detail?: string }[] }[]; text: { format: { strict: boolean; schema: { properties: Record<string, unknown> } } } };
    expect(request).toMatchObject({ model: 'gpt-5-mini', store: false, text: { format: { type: 'json_schema', strict: true } } });
    expect(Object.keys(request.text.format.schema.properties)).toEqual(['analysis', 'suggested_name']);
    expect(request.input[0].content[1]).toMatchObject({ type: 'input_image', detail: 'high' });
    expect(request.input[0].content[1].image_url!.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(request.instructions).toBe(imagePromptInstruction());
    for (const detail of ['structured visual evidence', 'camera module', 'visible counts', 'percentages', 'orientation/rotation', 'camera angle', 'framing/crop', 'shadow/reflection', 'material/texture', 'background treatment', 'text/logos/branding', 'uncertain']) expect(request.instructions).toContain(detail);
    // The saved request never carries the image itself.
    expect(JSON.stringify(result.request)).not.toContain('base64');
    expect(await sharp(image.bytes).metadata()).toMatchObject({ width: 1536, height: 1024 });
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


describe('integrated reference campaigns using the existing routes', () => {
  it.each([true, false])('replays the saved AirPods response through explicit analysis (SDK output_text: %s)', async includeOutputText => {
    const response = includeOutputText ? airPodsAnalysisResponseFixture : { status: airPodsAnalysisResponseFixture.status, output: airPodsAnalysisResponseFixture.output };
    const fake = writerFake(), create = vi.fn(async () => structuredClone(response));
    fake.writer = createOpenAIImagePromptWriter({ model: 'fake', client: { responses: { create } } as never });
    const s = await server({ writer: fake });
    try {
      const bytes = await png(600, 600), { body: uploaded } = await s.upload(bytes, {}, 'airpods.png', 'image/png', '/image-templates/draft');
      expect(create).not.toHaveBeenCalled();
      expect((await s.post(`/image-templates/${uploaded.id}/prompt`)).status).toBe(202);
      const result = await s.wait(() => s.template(uploaded.id), value => value.promptGeneration?.status !== 'generating');
      expect(result.promptGeneration).toMatchObject({ status: 'done', attempts: 1 });
      expect(result.analysis?.composition.visualHierarchy).toBe(airPodsAnalysisFixture.analysis.composition.visualHierarchy);
      expect(result.analysis?.visibleText.description).toBe(airPodsAnalysisFixture.analysis.visibleText.description);
      expect(result.referenceCreative?.prompt).toContain('hero headphone (dominant) > headline text');
      expect(result.reference).toEqual(uploaded.reference);
      expect(readFileSync(join(s.dir, uploaded.id, result.reference.file))).toEqual(bytes);
      expect((await s.template(uploaded.id)).promptGeneration?.status).toBe('done');
      expect(create).toHaveBeenCalledTimes(1); expect(s.images.send).not.toHaveBeenCalled(); expect(s.submitted).toEqual([]);
    } finally { s.app.close(); }
  });
  function offerWriter() {
    const fake = writerFake();
    const create = vi.fn(async () => ({ status: 'completed', output: [], output_text: JSON.stringify(referenceCreativeFixture) }));
    fake.writer = createOpenAIImagePromptWriter({ model: 'fake', client: { responses: { create } } as never });
    return { fake, create };
  }
  it('upload makes zero calls; explicit analysis once; fields and persistence zero calls; three frozen original-reference edits, duplicate blocked', async () => {
    const { fake, create } = offerWriter(), s = await server({ writer: fake });
    try {
      const bytes = await png(600, 600), upload = await s.upload(bytes, {}, 'ad.png', 'image/png', '/image-templates/draft'), id = upload.body.id;
      expect(upload.status).toBe(201); expect(create).toHaveBeenCalledTimes(0); expect(s.images.send).toHaveBeenCalledTimes(0);
      await s.post(`/image-templates/${id}/prompt`);
      const t = await s.wait(() => s.template(id), value => value.promptGeneration?.status === 'done');
      expect(create).toHaveBeenCalledTimes(1); expect(t.analysis?.design?.zones.cta).toBe('lower bar');
      const settings = editReferenceChoices(t.referenceCreative!, t.analysis!, { changes: { product: 'Samsung Galaxy phone', festival: 'Diwali', decorations: 'diyas and gold bokeh' } });
      await s.patch(`/image-templates/${id}`, { name: 'Phone campaign', referenceCreative: settings, originTemplate: { id: 'tpl-123', name: 'Merchant template' } });
      expect((await s.template(id)).referenceCreative).toEqual(settings); expect(create).toHaveBeenCalledTimes(1);
      const release = s.images.hold();
      const accepted = await s.post(`/image-templates/${id}/generate`, { referenceCreative: settings, aspectRatios: ['1:1','4:5','16:9'] });
      expect(accepted.status).toBe(202);
      expect((await s.post(`/image-templates/${id}/generate`)).status).toBe(400);
      expect((await s.patch(`/image-templates/${id}`, { referenceCreative: { ...settings, prompt: 'changed later' } })).status).toBe(400);
      release(); const done = await s.settled(id);
      expect(done.variants.map(v => v.status)).toEqual(['done','done','done']); expect(s.images.send).toHaveBeenCalledTimes(3);
      expect(s.images.inputs).toEqual([sha(bytes),sha(bytes),sha(bytes)]);
      expect(s.images.requests.every(r => r.method === 'edit' && r.prompt.includes(settings.prompt))).toBe(true);
      expect(done.generationSnapshot).toMatchObject({ id, referenceSha256: sha(bytes), blueprintVersion: 1, settings, analysis: t.analysis });
      expect(done.variants.every(v => !('reference' in v))).toBe(true); expect(s.submitted).toHaveLength(0); expect(create).toHaveBeenCalledTimes(1);
    } finally { s.app.close(); }
  });
  it('every ratio including one failed ratio retry uses both original source and the same product; successful images survive', async () => {
    const config = { model: 'gpt-image-2' };
    const { fake } = offerWriter(), s = await server({ writer: fake, config });
    try {
      const source = await png(600,600), product = await png(200,400,'#cc6600');
      const created = await s.upload(source, {}, 'ref.png', 'image/png', '/image-templates/draft'), id = created.body.id;
      await s.post(`/image-templates/${id}/prompt`);
      const t = await s.wait(() => s.template(id), v => v.promptGeneration?.status === 'done');
      const uploaded = await s.upload(product, {}, 'phone.png', 'image/png', `/image-templates/${id}/product-reference`);
      expect(uploaded.status).toBe(200); expect(uploaded.body.productReference.sha256).toBe(sha(product));
      s.images.failWhen(r => r.size === '1216x1520');
      const settings = { ...t.referenceCreative!, mode: 'custom', prompt: 'Replace the headphones with the silver Samsung product from the second image. Keep the rounded panels and lighting.'.padEnd(IMAGE_TEMPLATE_LIMITS.prompt, 'x') };
      expect((await s.post(`/image-templates/${id}/generate`, { name: 'Product reference', referenceCreative: settings })).status).toBe(202);
      const first = await s.settled(id);
      expect(first.variants.map(v => v.status)).toEqual(['done','failed','done']);
      config.model = 'a-different-model-after-generation';
      s.images.failWhen(undefined); await s.post(`/image-templates/${id}/variants/4x5/generate`);
      const done = await s.settled(id); expect(s.images.send).toHaveBeenCalledTimes(4);
      expect(done.variants[0].image).toEqual(first.variants[0].image); expect(done.variants[2].image).toEqual(first.variants[2].image);
      for (const request of s.images.requests) {
        expect(request.image).toHaveLength(2); const refs = request.image as File[];
        expect(await Promise.all(refs.map(async f => sha(Buffer.from(await f.arrayBuffer()))))).toEqual([sha(source),sha(product)]);
        expect(request.prompt).toContain(settings.prompt); expect(request.prompt).toContain('Image 2 is the replacement product');
        expect(request.prompt.length).toBeLessThanOrEqual(IMAGE_TEMPLATE_REQUEST_LIMIT);
        expect(request.model).toBe('gpt-image-2');
      }
      expect((await s.upload(product, {}, 'phone.png', 'image/png', `/image-templates/${id}/product-reference`)).status).toBe(400);
      expect(done.generationSnapshot?.productSha256).toBe(sha(product));
      expect(done.generationSnapshot?.aspectRatios).toEqual(['1:1', '4:5', '16:9']);
      expect(s.images.requests[3].prompt).toBe(s.images.requests[1].prompt);
    } finally { s.app.close(); }
  });
  it('a new source has no previous blueprint/results; stale queued generation writes only its own group', async () => {
    const { fake } = offerWriter(), s = await server({ writer: fake });
    try {
      const a = (await s.upload(await png(600,600), {}, 'a.png', 'image/png', '/image-templates/draft')).body.id;
      await s.post(`/image-templates/${a}/prompt`); await s.wait(() => s.template(a), t => t.promptGeneration?.status === 'done');
      const release = s.images.hold(); await s.post(`/image-templates/${a}/generate`, { name: 'Campaign A' });
      const b = (await s.upload(await png(600,600,'#acacac'), {}, 'b.png', 'image/png', '/image-templates/draft')).body.id;
      release(); await s.settled(a);
      const current = await s.template(b); expect(current.analysis).toBeUndefined(); expect(current.variants).toEqual([]); expect(current.referenceCreative).toBeUndefined();
    } finally { s.app.close(); }
  });
  it('failed analysis retains upload; only an explicit retry makes the next request', async () => {
    const fake = writerFake(); fake.failWith(new Error('fixture failure')); const s = await server({ writer: fake });
    try {
      const { id } = (await s.upload(await png(600,600), {}, 'a.png', 'image/png', '/image-templates/draft')).body;
      await s.post(`/image-templates/${id}/prompt`); const failed = await s.wait(() => s.template(id), t => t.promptGeneration?.status === 'failed');
      expect(failed.reference.file).toBe('reference.png'); expect(fake.seen).toHaveLength(1); expect(s.images.send).toHaveBeenCalledTimes(0);
      fake.failWith(undefined); await s.post(`/image-templates/${id}/prompt`); await s.wait(() => s.template(id), t => t.promptGeneration?.status === 'done');
      expect(fake.seen).toHaveLength(2);
    } finally { s.app.close(); }
  });
  it('rejects invalid guided snapshots and unsupported multi-reference models before image calls', async () => {
    const { fake } = offerWriter(), s = await server({ writer: fake, config: { model: 'dall-e-2' } });
    try {
      const { id } = (await s.upload(await png(600,600), {}, 'a.png', 'image/png', '/image-templates/draft')).body;
      expect((await s.get('/image-templates/info')).body.productReferenceSupported).toBe(false);
      expect((await s.upload(await png(200,300), {}, 'p.png', 'image/png', `/image-templates/${id}/product-reference`)).status).toBe(400);
      await s.post(`/image-templates/${id}/prompt`); const t = await s.wait(() => s.template(id), v => v.promptGeneration?.status === 'done');
      expect((await s.post(`/image-templates/${id}/generate`, { name: 'Invalid', aspectRatios: ['1:1'] })).status).toBe(400);
      expect((await s.post(`/image-templates/${id}/generate`, { name: 'Invalid', referenceCreative: { ...t.referenceCreative, prompt: 'unrelated long enough description for generation' } })).status).toBe(400);
      expect(s.images.send).toHaveBeenCalledTimes(0);
    } finally { s.app.close(); }
  });
  it('keeps alpha/orientation, warns on tiny input, and rejects extension mismatch without analysis', async () => {
    const s = await server();
    try {
      const alpha = await sharp({ create: { width: 32, height: 40, channels: 4, background: '#00000000' } }).png().toBuffer();
      const uploaded = await s.upload(alpha, {}, 'alpha.png', 'image/png', '/image-templates/draft');
      expect(uploaded.body.reference.hasAlpha).toBe(true); expect(uploaded.body.reference.warnings).toHaveLength(1);
      expect(readFileSync(join(s.dir, uploaded.body.id, uploaded.body.reference.file))).toEqual(alpha);
      expect((await s.upload(alpha, {}, 'wrong.jpg', 'image/png', '/image-templates/draft')).status).toBe(400); expect(s.writer.seen).toHaveLength(0);
      const path = `/image-templates/${uploaded.body.id}/product-reference`;
      const product = await s.upload(alpha, {}, 'product.png', 'image/png', path);
      expect(product.body.productReference.hasAlpha).toBe(true);
      const turned = await sharp({ create: { width: 40, height: 80, channels: 3, background: '#c6aabb' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
      const oriented = await s.upload(turned, {}, 'turned.jpg', 'image/jpeg', path);
      expect(oriented.body.productReference).toMatchObject({ width: 80, height: 40, sha256: sha(turned) });
      expect((await s.upload(turned, {}, 'mismatch.png', 'image/png', path)).status).toBe(400);
      expect((await s.upload(Buffer.from('corrupt'), {}, 'broken.png', 'image/png', path)).status).toBe(400);
      expect(s.writer.seen).toHaveLength(0); expect(s.images.send).toHaveBeenCalledTimes(0);
    } finally { s.app.close(); }
  });
});
