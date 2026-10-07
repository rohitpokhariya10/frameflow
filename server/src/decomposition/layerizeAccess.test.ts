import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, readConfig } from '../app.js';
import { readDecompositionConfig } from './config.js';
import type { GenerationConfig, GenerationGroup } from './generationGroups.js';
import { createRun, type RunnerDeps } from './layerizeExperiment.js';
import { createLayerizeRouter, layerizeExperimentEnabled, type ExperimentAccess } from './layerizeRouter.js';
import { createDecompositionRouter } from './router.js';

// Where the Template A/B/C experiment is mounted and who may use it. Every provider is a fake, and any request that
// leaves this machine fails the test that made it: no OpenAI, gpt-image-2, fal or Seedream call is made here.
const realFetch = globalThis.fetch, outside: string[] = [];
beforeAll(() => {
  for (const key of ['OPENAI_API_KEY', 'FAL_KEY', 'CLOUDFLARE_API_TOKEN', 'GEMINI_API_KEY']) vi.stubEnv(key, '');
  vi.stubGlobal('fetch', (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('http://127.0.0.1:')) { outside.push(url); throw new Error(`A test tried to reach ${url}.`); }
    return realFetch(input, init);
  });
});
afterEach(() => { expect(outside).toEqual([]); });
afterAll(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const APP = 'https://frameflow-h7fa.onrender.com';
const PRODUCTION: ExperimentAccess = { production: true, clientOrigin: APP };
/** Providers that must never be reached by these tests. */
const providers = () => {
  const image = vi.fn(async (request: { size: string }) => {
    const [width, height] = request.size.split('x').map(Number), bytes = await sharp({ create: { width, height, channels: 3, background: '#446688' } }).png().toBuffer();
    return { created: 1, data: [{ b64_json: bytes.toString('base64') }] };
  });
  const planner = vi.fn(async () => { throw new Error('The planner must not be called by these tests.'); });
  const deps = (): RunnerDeps => ({ planner, transport: () => { throw new Error('fal must not be called by these tests.'); }, sleep: async () => undefined });
  const generation = (): GenerationConfig => ({ model: 'gpt-image-2', client: () => ({ images: { generate: image, edit: image } }) as unknown as ReturnType<GenerationConfig['client']> });
  return { image, planner, deps, generation };
};
/**
 * The app as server/src/index.ts builds it: the experiment is mounted only when its flag says so. `access` is who the
 * experiment answers (default: production, behind a proxy, for the deployed app's origin).
 */
async function app(env: Record<string, string | undefined>, access: ExperimentAccess = PRODUCTION, existingRoot?: string) {
  const fakes = providers(), root = existingRoot ?? mkdtempSync(join(tmpdir(), 'layerize-access-'));
  const dirs = { 'template-a': join(root, 'a'), 'template-b': join(root, 'b'), 'template-c': join(root, 'c') };
  const experiment = layerizeExperimentEnabled(env) ? createLayerizeRouter({ runsDir: join(root, 'runs'), deps: fakes.deps, generation: fakes.generation, generationsDir: dirs['template-a'], generationDirs: dirs, access,
    imageTemplatesDir: join(root, 'image-templates'), imagePrompt: () => ({ model: 'fake', describe: async () => { throw new Error('No prompt calls in access tests.'); } }) }) : undefined;
  // The earlier generic decomposition pipeline, configured as on Render: DECOMPOSITION_ENABLED is not set.
  const legacy = createDecompositionRouter(readDecompositionConfig({ NODE_ENV: 'production', CLIENT_ORIGIN: APP, DECOMP_DATA_DIR: join(root, 'legacy') }));
  const server = createApp(readConfig({ CLIENT_ORIGIN: APP, TRUST_PROXY_HOPS: '1' }), undefined, () => undefined, undefined, legacy, experiment).listen(0, '127.0.0.1');
  await new Promise(done => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json().catch(() => undefined) as Record<string, unknown> & { error?: { code?: string; message?: string } } | undefined };
  };
  return { server, base, call, fakes, root };
}
// What a browser sends from the deployed app, which is same-origin with its API.
const READ = { 'Sec-Fetch-Site': 'same-origin' }, WRITE = { Origin: APP, 'Sec-Fetch-Site': 'same-origin' };
// Render's proxy forwards every request with the visitor's address.
const PROXIED = { 'X-Forwarded-For': '203.0.113.7' };

describe('the layerize experiment is mounted only when LAYERIZE_EXPERIMENT=1', () => {
  it('follows the flag alone: on in production and in development when set to 1, off otherwise', () => {
    expect(layerizeExperimentEnabled({ LAYERIZE_EXPERIMENT: '1', NODE_ENV: 'production' })).toBe(true);
    expect(layerizeExperimentEnabled({ LAYERIZE_EXPERIMENT: '1', NODE_ENV: 'development' })).toBe(true);
    expect(layerizeExperimentEnabled({ LAYERIZE_EXPERIMENT: '1' })).toBe(true);
    for (const off of [undefined, '', '0', 'true', 'on', 'yes', ' 1']) expect(layerizeExperimentEnabled({ LAYERIZE_EXPERIMENT: off, NODE_ENV: 'production' })).toBe(false);
  });

  it('production with the flag: /runs and /templates answer the app; the rest of the app is as it was', async () => {
    const s = await app({ NODE_ENV: 'production', LAYERIZE_EXPERIMENT: '1' });
    try {
      // A fresh server has no stored runs or creatives: empty lists, not errors.
      expect(await s.call('GET', '/api/layerize-experiment/runs', READ)).toEqual({ status: 200, body: { active: null, runs: [] } });
      const templates = await s.call('GET', '/api/layerize-experiment/templates', READ);
      expect(templates.status).toBe(200);
      expect((templates.body!.templates as { key: string }[]).map(template => template.key)).toEqual(['template-a', 'template-b', 'template-c']);
      for (const key of ['template-a', 'template-b', 'template-c']) {
        expect(await s.call('GET', `/api/layerize-experiment/${key}/generator`, READ)).toMatchObject({ status: 200, body: { templateKey: key, generator: { provider: 'openai', model: 'gpt-image-2' } } });
        expect(await s.call('GET', `/api/layerize-experiment/${key}/groups`, READ)).toEqual({ status: 200, body: { groups: [] } });
      }
      expect(await s.call('GET', '/api/health')).toMatchObject({ status: 200, body: { status: 'ok' } });
      expect(s.fakes.image).not.toHaveBeenCalled();
      expect(s.fakes.planner).not.toHaveBeenCalled();
    } finally { s.server.close(); }
  });

  it('image-derived templates inherit production origin checks for reads, uploads, PATCH edits and every paid action', async () => {
    const s = await app({ NODE_ENV: 'production', LAYERIZE_EXPERIMENT: '1' });
    try {
      const base = '/api/layerize-experiment/image-templates';
      expect(await s.call('GET', base, READ)).toMatchObject({ status: 200, body: { templates: [] } });
      expect((await s.call('GET', `${base}/info`, READ)).status).toBe(200);
      for (const [method, path] of [['GET', base], ['POST', base], ['PATCH', `${base}/draft`], ['POST', `${base}/draft/prompt`],
        ['POST', `${base}/draft/generate`], ['POST', `${base}/draft/variants/1x1/decompose`], ['POST', `${base}/draft/variants/1x1/resume`]]) {
        expect(await s.call(method, path, PROXIED)).toMatchObject({ status: 403, body: { error: { code: 'ORIGIN_DENIED' } } });
      }
      expect(s.fakes.image).not.toHaveBeenCalled();
      expect(s.fakes.planner).not.toHaveBeenCalled();
    } finally { s.server.close(); }
  });

  it('flag missing or off: both routes are unavailable, and the app still serves', async () => {
    for (const env of [{ NODE_ENV: 'production' }, { NODE_ENV: 'production', LAYERIZE_EXPERIMENT: '0' }, { NODE_ENV: 'production', LAYERIZE_EXPERIMENT: '' }, { NODE_ENV: 'development' }]) {
      const s = await app(env);
      try {
        for (const path of ['/runs', '/templates', '/template-b/generator']) expect((await s.call('GET', `/api/layerize-experiment${path}`, READ)).status).toBe(404);
        expect((await s.call('POST', '/api/layerize-experiment/template-b/groups', WRITE, { fields: {} })).status).toBe(404);
        expect(await s.call('GET', '/api/health')).toMatchObject({ status: 200, body: { status: 'ok' } });
      } finally { s.server.close(); }
    }
  });

  it('never turns the earlier generic decomposition pipeline on: it stays disabled beside it', async () => {
    const s = await app({ NODE_ENV: 'production', LAYERIZE_EXPERIMENT: '1' });
    try {
      expect(await s.call('GET', '/api/decomposition/capabilities', READ)).toMatchObject({ status: 200, body: { enabled: false, authenticated: false } });
      expect(await s.call('POST', '/api/decomposition/session', { ...WRITE, 'X-FrameFlow-CSRF': '1' }, { password: 'anything' })).toMatchObject({ body: { error: { code: 'DISABLED' } } });
    } finally { s.server.close(); }
  });
});

describe('who the experiment answers in production: its own frontend', () => {
  it('reads: a same-origin request from the app; not another site, and not a client that says nothing about itself', async () => {
    const s = await app({ NODE_ENV: 'production', LAYERIZE_EXPERIMENT: '1' });
    try {
      // The app's own fetches, images and downloads; and an address the user opened themselves.
      for (const site of ['same-origin', 'none']) expect((await s.call('GET', '/api/layerize-experiment/runs', { ...PROXIED, 'Sec-Fetch-Site': site })).status).toBe(200);
      // Another website embedding or fetching it, a sibling subdomain, or a client with no browser context at all.
      for (const headers of [{ 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, {}] as Record<string, string>[])
        expect(await s.call('GET', '/api/layerize-experiment/runs', { ...PROXIED, ...headers })).toMatchObject({ status: 403, body: { error: { code: 'ORIGIN_DENIED' } } });
      // A cross-origin read names its origin: only the app's own is answered (the app-wide check refuses the others first).
      expect((await s.call('GET', '/api/layerize-experiment/runs', { Origin: APP })).status).toBe(200);
      expect(await s.call('GET', '/api/layerize-experiment/runs', { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'same-origin' })).toMatchObject({ status: 403, body: { error: { code: 'ORIGIN_DENIED' } } });
    } finally { s.server.close(); }
  });

  it('writes: only with the app\'s own Origin; nothing is created, generated or planned for anyone else', async () => {
    const s = await app({ NODE_ENV: 'production', LAYERIZE_EXPERIMENT: '1' });
    try {
      const create = (headers: Record<string, string>) => s.call('POST', '/api/layerize-experiment/template-b/groups', { ...PROXIED, ...headers }, { fields: { mainProduct: 'Lavender smartphone', sceneStyle: 'Premium pastel studio' }, aspectRatios: ['1:1'] });
      // No Origin (a script, curl), another site, a local development origin, or only a same-origin claim without the Origin.
      for (const headers of [{}, { Origin: 'https://evil.example' }, { Origin: 'http://localhost:5173' }, { Origin: `${APP}.evil.example` }, { 'Sec-Fetch-Site': 'same-origin' }] as Record<string, string>[])
        expect(await create(headers)).toMatchObject({ status: 403, body: { error: { code: 'ORIGIN_DENIED' } } });
      for (const path of ['/template-a/groups', '/template-c/groups', '/template-b/groups/x/variants/1x1/generate', '/template-b/groups/x/variants/1x1/decompose', '/runs', '/runs/x/retry', '/templates/template-a'])
        expect((await s.call('POST', `/api/layerize-experiment${path}`, PROXIED, {})).status).toBe(403);
      expect(s.fakes.image).not.toHaveBeenCalled();
      expect((await s.call('GET', '/api/layerize-experiment/template-b/groups', READ)).body).toEqual({ groups: [] });

      // The deployed app itself: the request reaches the template's own handler, which validates it as always.
      expect(await s.call('POST', '/api/layerize-experiment/template-b/groups', { ...PROXIED, ...WRITE }, { fields: {} })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_FIELDS' } } });
      const started = await create(WRITE);
      expect(started).toMatchObject({ status: 202, body: { templateKey: 'template-b', version: 'template-b-generation-v3', ratioStrategy: 'reference' } });
      // The creative is generated by the (fake) image model and served back to the app, image included.
      const id = (started.body as unknown as GenerationGroup).id;
      let group: GenerationGroup | undefined;
      for (let i = 0; i < 300 && group?.variants[0].status !== 'done'; i++) { group = (await s.call('GET', `/api/layerize-experiment/template-b/groups/${id}`, READ)).body as unknown as GenerationGroup; await new Promise(done => setTimeout(done, 10)); }
      expect(group!.variants.map(variant => variant.status)).toEqual(['done', 'pending', 'pending']);
      expect(s.fakes.image).toHaveBeenCalledTimes(1);
      const picture = await fetch(`${s.base}/api/layerize-experiment/template-b/groups/${id}/variants/1x1/image`, { headers: READ });
      expect([picture.status, picture.headers.get('content-type')]).toEqual([200, 'image/png']);
      // A trailing slash on CLIENT_ORIGIN is the same origin.
      const slash = await app({ NODE_ENV: 'production', LAYERIZE_EXPERIMENT: '1' }, { production: true, clientOrigin: `${APP}/` });
      try { expect((await slash.call('POST', '/api/layerize-experiment/template-b/groups', WRITE, { fields: {} })).status).toBe(400); } finally { slash.server.close(); }
    } finally { s.server.close(); }
  });

  it('without CLIENT_ORIGIN nothing can be changed, and the message says what to set', async () => {
    vi.stubEnv('CLIENT_ORIGIN', '');
    const s = await app({ NODE_ENV: 'production', LAYERIZE_EXPERIMENT: '1' }, { production: true, clientOrigin: undefined });
    try {
      expect(await s.call('POST', '/api/layerize-experiment/template-b/groups', WRITE, { fields: {} })).toMatchObject({ status: 403, body: { error: { code: 'ORIGIN_DENIED', message: expect.stringContaining('Set CLIENT_ORIGIN') } } });
      expect((await s.call('POST', '/api/layerize-experiment/template-b/groups', {}, { fields: {} })).status).toBe(403);
    } finally { s.server.close(); }
  });

  it('is never treated as "this machine" in production, even though the proxy may connect from it', async () => {
    // These tests call from 127.0.0.1, with and without a forwarding header: in production neither is let through unchecked.
    const s = await app({ NODE_ENV: 'production', LAYERIZE_EXPERIMENT: '1' });
    try {
      for (const headers of [{}, PROXIED]) {
        expect((await s.call('GET', '/api/layerize-experiment/runs', headers)).status).toBe(403);
        expect((await s.call('POST', '/api/layerize-experiment/template-b/groups', headers, { fields: {} })).status).toBe(403);
      }
    } finally { s.server.close(); }
  });
});

describe('local development is as it was', () => {
  it('a direct request on this machine is answered without any header; a forwarded one has to come from the app', async () => {
    const s = await app({ NODE_ENV: 'development', LAYERIZE_EXPERIMENT: '1' }, { production: false, clientOrigin: 'http://localhost:5173' });
    try {
      // The Vite proxy and a local browser: no Origin, no fetch metadata needed.
      expect((await s.call('GET', '/api/layerize-experiment/runs')).status).toBe(200);
      expect((await s.call('GET', '/api/layerize-experiment/templates')).status).toBe(200);
      expect(await s.call('POST', '/api/layerize-experiment/template-b/groups', {}, { fields: {} })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_FIELDS' } } });
      expect(await s.call('POST', '/api/layerize-experiment/template-b/groups', { Origin: 'http://127.0.0.1:5173' }, { fields: {} })).toMatchObject({ status: 400 });
      // The same server reached through a proxy is no longer "this machine".
      expect((await s.call('GET', '/api/layerize-experiment/runs', PROXIED)).status).toBe(403);
      expect((await s.call('POST', '/api/layerize-experiment/template-b/groups', PROXIED, { fields: {} })).status).toBe(403);
      expect((await s.call('POST', '/api/layerize-experiment/template-b/groups', { ...PROXIED, Origin: 'http://localhost:5173' }, { fields: {} })).status).toBe(400);
    } finally { s.server.close(); }
  });
});


it('saved diagnostics inherit origin checks and survive a fresh server without provider activity', async () => {
  const env = { NODE_ENV: 'production', LAYERIZE_EXPERIMENT: '1' };
  const first = await app(env);
  const bytes = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const { dir, run } = await createRun(join(first.root, 'runs'), bytes);
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ ...run, stage: 'failed', error: { code: 'PLANNER_INVALID_JSON', stage: 'planning', message: 'Offline fixture' },
    calls: { planner: 1, fitCheck: 0, seedreamInitial: 0, seedreamResidual: 0, backgroundReconstruction: 0 } }));
  writeFileSync(join(dir, 'openai-response.json'), JSON.stringify({ model: 'gpt-5-mini', usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 100 } }));
  const path = `/api/layerize-experiment/runs/${run.id}/diagnostics`;
  let saved: unknown;
  try {
    expect(await first.call('GET', path, PROXIED)).toMatchObject({ status: 403, body: { error: { code: 'ORIGIN_DENIED' } } });
    const response = await first.call('GET', path, READ);
    expect(response).toMatchObject({ status: 200, body: { calls: 1, total: { confidence: 'Calculated', inr: 0.0405 } } });
    saved = response.body;
    expect(first.fakes.planner).not.toHaveBeenCalled(); expect(first.fakes.image).not.toHaveBeenCalled();
  } finally { await new Promise<void>(done => first.server.close(() => done())); }
  const second = await app(env, PRODUCTION, first.root);
  try {
    expect((await second.call('GET', path, READ)).body).toEqual(saved);
    expect(second.fakes.planner).not.toHaveBeenCalled(); expect(second.fakes.image).not.toHaveBeenCalled();
  } finally { await new Promise<void>(done => second.server.close(() => done())); }
});
