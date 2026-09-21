import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, readConfig, type ServerConfig } from './app.js';
import * as gemini from './providers/geminiProvider.js';
import * as cloudflare from './providers/cloudflareImageProvider.js';
import { AiError, type GenerateImage, type ProviderImage } from './services/aiService.js';
import { mockPng, mockRequest } from './testSupport.js';

const servers: Server[] = [];
const image: ProviderImage = { data: mockPng().toString('base64'), mimeType: 'image/png' };
const baseConfig: ServerConfig = { provider: 'gemini', apiKey: 'test-only-credential', model: 'mock-provider', timeoutMs: 1000, trustProxyHops: 0 };
async function start(config: Partial<ServerConfig> = {}, provider: GenerateImage | null = async () => image) {
  const log = vi.fn();
  const server = createServer(createApp({ ...baseConfig, ...config }, provider ?? undefined, log));
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const generate = (body: unknown = mockRequest) => fetch(`${url}/api/ai/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { url, generate, log };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).filter((server) => server.listening).map((server) => new Promise<void>((resolve, reject) => {
    server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve());
  })));
  vi.restoreAllMocks();
});

describe('server environment configuration', () => {
  it('keeps a server-only key, documented model/timeout defaults and exact production origin', () => {
    expect(readConfig({})).toEqual({ provider: 'gemini', apiKey: undefined, model: 'gemini-3.1-flash-image', timeoutMs: 120000, clientOrigin: undefined, trustProxyHops: 0 });
    expect(readConfig({ GEMINI_API_KEY: ' test-only-credential ', GEMINI_IMAGE_MODEL: ' configured-model ', CLIENT_ORIGIN: 'https://editor.example', TRUST_PROXY_HOPS: '1', AI_TIMEOUT_MS: '150000' })).toEqual({
      provider: 'gemini', apiKey: 'test-only-credential', model: 'configured-model', clientOrigin: 'https://editor.example', trustProxyHops: 1, timeoutMs: 150000,
    });
    expect(readConfig({ GEMINI_API_KEY: '  ' }).apiKey).toBe('');
  });
  it('rejects invalid timeout and proxy values instead of weakening request limits', () => {
    for (const timeout of ['NaN', '999', '180001', 'Infinity']) expect(() => readConfig({ AI_TIMEOUT_MS: timeout })).toThrow('AI_TIMEOUT_MS');
    for (const hops of ['NaN', '-1', '3', '1.5']) expect(() => readConfig({ TRUST_PROXY_HOPS: hops })).toThrow('TRUST_PROXY_HOPS');
  });
});

describe('AI HTTP API (provider mocked; no live calls)', () => {
  it.each([false, true])('reports aiConfigured=%s without credentials or provider details', async (configured) => {
    const { url } = await start({ apiKey: configured ? 'test-only-credential' : undefined });
    const response = await fetch(`${url}/api/health`);
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ status: 'ok', aiConfigured: configured });
    expect(JSON.stringify(body)).not.toContain('test-only-credential');
    expect(response.headers.get('x-powered-by')).toBeNull();
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('normalizes valid image output and logs only request ID, elapsed time and outcome', async () => {
    const provider = vi.fn().mockResolvedValue(image);
    const { generate, log } = await start({}, provider);
    const response = await generate();
    const body: unknown = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ requestId: response.headers.get('x-request-id'), image: { mimeType: 'image/png', width: 4, height: 5 }, generation: { mode: 'live', model: 'mock-provider', requestedAspectRatio: '4:5' } });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledExactlyOnceWith({ requestId: response.headers.get('x-request-id'), durationMs: expect.any(Number), outcome: 'success' });
  });
  it.each([
    { ...mockRequest, prompt: '  ' }, { ...mockRequest, prompt: 'a'.repeat(2001) },
    { ...mockRequest, target: { width: 1080.5, height: 1350 } },
    { ...mockRequest, quietRegion: { x: 0.9, y: 0, width: 0.2, height: 0.5 } },
    { ...mockRequest, styleBrief: { ...mockRequest.styleBrief, mood: 'a'.repeat(201) } },
  ])('authoritatively rejects invalid request %# before provider invocation', async (input) => {
    const provider = vi.fn(); const { generate } = await start({}, provider);
    const response = await generate(input);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST', retryable: false, requestId: response.headers.get('x-request-id') } });
    expect(provider).not.toHaveBeenCalled();
  });
  it('rejects missing AI credentials with a useful normalized error', async () => {
    const provider = vi.fn(); const { generate } = await start({ apiKey: undefined }, provider);
    const response = await generate();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_CONFIGURED', message: 'AI generation is not configured for this environment.' } });
    expect(provider).not.toHaveBeenCalled();
  });
  it('bounds request bodies and safely rejects malformed JSON', async () => {
    const provider = vi.fn(); const { url, generate } = await start({}, provider);
    const large = await generate({ ...mockRequest, prompt: 'x'.repeat(40_000) });
    expect(large.status).toBe(413);
    expect(await large.json()).toMatchObject({ error: { code: 'TOO_LARGE' } });
    const malformed = await fetch(`${url}/api/ai/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"prompt":' });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(provider).not.toHaveBeenCalled();
  });
  it('allows exact local/configured origins and rejects another origin without wildcard CORS', async () => {
    const { url } = await start({ clientOrigin: 'https://editor.example/' });
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3001', 'http://127.0.0.1:3001', 'https://editor.example']) {
      const response = await fetch(`${url}/api/health`, { headers: { Origin: origin } });
      expect(response.status).toBe(200); expect(response.headers.get('access-control-allow-origin')).toBe(origin);
      expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    }
    const denied = await fetch(`${url}/api/health`, { headers: { Origin: 'https://editor.example.attacker.test' } });
    expect(denied.status).toBe(403); expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    expect(await denied.json()).toMatchObject({ error: { code: 'ORIGIN_DENIED' } });
    const preflight = await fetch(`${url}/api/ai/generate`, { method: 'OPTIONS', headers: { Origin: 'https://editor.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
    expect(preflight.status).toBe(204); expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
  });
  it('permits three generation attempts per minute and gives a retry hint for the fourth', async () => {
    const provider = vi.fn().mockResolvedValue(image); const { generate } = await start({}, provider);
    for (let count = 0; count < 3; count++) expect((await generate()).status).toBe(200);
    const limited = await generate();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: 'RATE_LIMIT', retryable: true } });
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(provider).toHaveBeenCalledTimes(3);
  });
  it('admits only two simultaneous provider calls', async () => {
    let release: (value: ProviderImage) => void = () => {};
    const pending = new Promise<ProviderImage>((resolve) => { release = resolve; });
    const provider = vi.fn(() => pending); const { generate } = await start({}, provider);
    const first = generate(), second = generate();
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(2));
    const busy = await generate();
    expect(busy.status).toBe(429); expect(await busy.json()).toMatchObject({ error: { code: 'BUSY', retryable: true } });
    release(image);
    expect((await first).status).toBe(200); expect((await second).status).toBe(200);
    expect(provider).toHaveBeenCalledTimes(2);
  });
  it('returns a timeout without leaking or repeatedly calling the provider', async () => {
    const provider = vi.fn(() => new Promise<ProviderImage>(() => {}));
    const { generate, log } = await start({ timeoutMs: 10 }, provider);
    const response = await generate();
    expect(response.status).toBe(504); expect(await response.json()).toMatchObject({ error: { code: 'TIMEOUT', retryable: true } });
    expect(log).toHaveBeenCalledExactlyOnceWith({ requestId: response.headers.get('x-request-id'), durationMs: expect.any(Number), outcome: 'TIMEOUT' });
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it.each([
    [new Error('private provider response'), 'PROVIDER_FAILURE', 502],
    [new AiError('NO_IMAGE', 'The image service returned no artwork.'), 'NO_IMAGE', 502],
  ])('normalizes failed requests and omits raw provider details from logs %#', async (error, code, status) => {
    const { generate, log } = await start({}, vi.fn().mockRejectedValue(error));
    const response = await generate();
    expect(response.status).toBe(status);
    const body: unknown = await response.json(); expect(body).toMatchObject({ error: { code, requestId: response.headers.get('x-request-id') } });
    expect(JSON.stringify(body)).not.toContain('private provider response');
    expect(log).toHaveBeenCalledExactlyOnceWith({ requestId: response.headers.get('x-request-id'), durationMs: expect.any(Number), outcome: code });
  });
});

it('logs bounded provider classification for rejected configuration without exposing raw diagnostics', async () => {
  const error = { statusCode: 400, error: { code: 'invalid_request', message: 'Image delivery mode is not supported. test-only-credential' },
    headers: { authorization: 'private-header' }, body: 'private-image-payload', cause: { message: 'private-cause' } };
  const provider = vi.fn().mockRejectedValue(error);
  const { generate, log } = await start({}, provider);
  const response = await generate();
  const body: unknown = await response.json();
  expect(response.status).toBe(400);
  expect(body).toMatchObject({ error: { code: 'PROVIDER_REQUEST', retryable: false } });
  expect(log).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'PROVIDER_REQUEST', provider: expect.objectContaining({ providerStatus: 400 }) }));
  const exposed = JSON.stringify([body, log.mock.calls]);
  for (const secret of ['test-only-credential', 'private-header', 'private-image-payload', 'private-cause', 'Image delivery mode']) expect(exposed).not.toContain(secret);
  expect(provider).toHaveBeenCalledTimes(1);
});

it('selects only the configured provider credentials and model without fallback', async () => {
  const config = readConfig({ AI_PROVIDER: 'cloudflare', CLOUDFLARE_ACCOUNT_ID: 'test-account', CLOUDFLARE_API_TOKEN: 'test-cloud-token', GEMINI_API_KEY: 'unused-gemini-key' });
  expect(config).toMatchObject({ provider: 'cloudflare', accountId: 'test-account', apiKey: 'test-cloud-token', model: '@cf/black-forest-labs/flux-2-klein-4b' });
  expect(() => readConfig({ AI_PROVIDER: 'unknown' })).toThrow('AI_PROVIDER');
  expect(() => readConfig({ AI_PROVIDER: 'cloudflare', CLOUDFLARE_IMAGE_MODEL: '../../escape' })).toThrow('CLOUDFLARE_IMAGE_MODEL');
  for (const missing of [{ CLOUDFLARE_ACCOUNT_ID: 'test-account' }, { CLOUDFLARE_API_TOKEN: 'test-cloud-token' }, {}]) {
    const provider = vi.fn();
    const { url, generate } = await start(readConfig({ AI_PROVIDER: 'cloudflare', GEMINI_API_KEY: 'unused-gemini-key', ...missing }), provider);
    expect(await (await fetch(`${url}/api/health`)).json()).toEqual({ status: 'ok', aiConfigured: false, aiAvailable: false, provider: 'cloudflare' });
    expect((await generate()).status).toBe(503); expect(provider).not.toHaveBeenCalled();
  }
  const { url, generate } = await start(config);
  const health = await (await fetch(`${url}/api/health`)).json();
  expect(health).toEqual({ status: 'ok', aiConfigured: true, aiAvailable: true, provider: 'cloudflare' });
  const response = await generate();
  expect(await response.json()).toMatchObject({ generation: { provider: 'cloudflare', model: config.model } });
  expect(JSON.stringify(health)).not.toContain('test-cloud-token');
});

it.each(['gemini', 'cloudflare'] as const)('constructs the selected %s adapter with only its own credentials', async (selected) => {
  const generateImage = vi.fn<GenerateImage>().mockResolvedValue(image);
  const geminiFactory = vi.spyOn(gemini, 'geminiProvider').mockReturnValue(generateImage);
  const cloudflareFactory = vi.spyOn(cloudflare, 'cloudflareImageProvider').mockReturnValue(generateImage);
  const config = readConfig({ AI_PROVIDER: selected,
    GEMINI_API_KEY: 'mock-gemini-token', GEMINI_IMAGE_MODEL: 'mock-gemini-model',
    CLOUDFLARE_ACCOUNT_ID: 'mock-cloudflare-account', CLOUDFLARE_API_TOKEN: 'mock-cloudflare-token',
    CLOUDFLARE_IMAGE_MODEL: '@cf/black-forest-labs/flux-2-klein-4b',
  });
  // Passing null omits the provider override, so createApp must choose the adapter.
  const { generate, log } = await start(config, null);
  if (selected === 'gemini') {
    expect(geminiFactory).toHaveBeenCalledExactlyOnceWith('mock-gemini-token', 'mock-gemini-model');
    expect(cloudflareFactory).not.toHaveBeenCalled();
  } else {
    expect(cloudflareFactory).toHaveBeenCalledExactlyOnceWith('mock-cloudflare-account', 'mock-cloudflare-token', '@cf/black-forest-labs/flux-2-klein-4b');
    expect(geminiFactory).not.toHaveBeenCalled();
  }
  const response = await generate();
  const body: unknown = await response.json();
  expect(response.status).toBe(200);
  expect(body).toMatchObject({ generation: { provider: selected, model: config.model } });
  expect(generateImage).toHaveBeenCalledExactlyOnceWith(expect.any(String), '4:5', expect.any(AbortSignal), mockRequest.target);
  expect(JSON.stringify([body, log.mock.calls])).not.toMatch(/mock-gemini-token|mock-cloudflare-token|mock-cloudflare-account/);
});

it.each([
  { AI_PROVIDER: 'gemini', CLOUDFLARE_ACCOUNT_ID: 'mock-account', CLOUDFLARE_API_TOKEN: 'mock-cloudflare-token' },
  { AI_PROVIDER: 'cloudflare', GEMINI_API_KEY: 'mock-gemini-token', CLOUDFLARE_ACCOUNT_ID: 'mock-account' },
  { AI_PROVIDER: 'cloudflare', GEMINI_API_KEY: 'mock-gemini-token', CLOUDFLARE_API_TOKEN: 'mock-cloudflare-token' },
])('constructs neither adapter when the selected provider is missing required configuration %#', async (env) => {
  const generateImage = vi.fn<GenerateImage>().mockResolvedValue(image);
  const geminiFactory = vi.spyOn(gemini, 'geminiProvider').mockReturnValue(generateImage);
  const cloudflareFactory = vi.spyOn(cloudflare, 'cloudflareImageProvider').mockReturnValue(generateImage);
  const { url, generate } = await start(readConfig(env), null);
  const health = await (await fetch(`${url}/api/health`)).json();
  expect(health).toEqual({ status: 'ok', aiConfigured: false, aiAvailable: false, provider: env.AI_PROVIDER });
  const response = await generate();
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: 'NOT_CONFIGURED' } });
  expect(geminiFactory).not.toHaveBeenCalled();
  expect(cloudflareFactory).not.toHaveBeenCalled();
  expect(generateImage).not.toHaveBeenCalled();
});
