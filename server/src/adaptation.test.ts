import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp, readConfig } from './app.js';
import { AiError, type AdaptImage } from './services/aiService.js';
import { mockPng, mockRequest } from './testSupport.js';
const servers: Server[] = [];
const reference = mockPng().toString('base64');
const request = { ...mockRequest, target: { width: 1600, height: 900 }, format: 'landscape',
  source: { projectId: 'project', variantId: 'original', revision: 1, assetId: 'source', width: 1080, height: 1350 },
  referenceImage: { mimeType: 'image/png', base64: reference, width: 4, height: 5 } };
async function start(adapt: AdaptImage | undefined, provider = 'cloudflare', configured = true) {
  const generate = vi.fn(), log = vi.fn();
  const config = readConfig({ AI_PROVIDER: provider, ...(configured ? { CLOUDFLARE_ACCOUNT_ID: 'mock-account', CLOUDFLARE_API_TOKEN: 'mock-token', GEMINI_API_KEY: 'mock-key' } : {}) });
  const server = createServer(createApp(config, generate, log, adapt)); servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { generate, log, post: (body: unknown = request, route = 'adapt') => fetch(`${url}/api/ai/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) };
}
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }))); });
describe('application adaptation endpoint with mocked provider', () => {
  it('returns normalized artwork and request ID while using only the adaptation capability', async () => {
    const adapt = vi.fn<AdaptImage>().mockResolvedValue({ data: reference, mimeType: 'image/png' });
    const app = await start(adapt), response = await app.post(), value = await response.json();
    expect(response.status).toBe(200); expect(value.requestId).toBe(response.headers.get('x-request-id'));
    expect(value.generation.provider).toBe('cloudflare'); expect(adapt).toHaveBeenCalledTimes(1); expect(app.generate).not.toHaveBeenCalled();
    expect(JSON.stringify([value.generation, app.log.mock.calls])).not.toMatch(/mock-token|mock-account|mock-key|base64/);
  });
  it('rejects bad references and invalid context before calling the provider', async () => {
    const adapt = vi.fn(), app = await start(adapt);
    expect((await app.post({ ...request, source: null })).status).toBe(400);
    const response = await app.post({ ...request, referenceImage: { ...request.referenceImage, base64: 'AAAA' } });
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: { code: 'INVALID_REFERENCE', requestId: expect.any(String) } });
    expect(adapt).not.toHaveBeenCalled();
  });
  it.each(['adapt/', 'ADAPT'])('retains reference adaptation for Express route alias %s', async (route) => {
    const adapt = vi.fn<AdaptImage>().mockResolvedValue({ data: reference, mimeType: 'image/png' });
    const app = await start(adapt);
    expect((await app.post(request, route)).status).toBe(200);
    expect(adapt).toHaveBeenCalledTimes(1); expect(app.generate).not.toHaveBeenCalled();
  });
  it('keeps missing configuration and unsupported Gemini adaptation truthful', async () => {
    const missing = await start(vi.fn(), 'cloudflare', false);
    expect(await (await missing.post()).json()).toMatchObject({ error: { code: 'NOT_CONFIGURED' } });
    const gemini = await start(undefined, 'gemini');
    expect(await (await gemini.post()).json()).toMatchObject({ error: { code: 'ADAPT_UNAVAILABLE' } });
    expect(gemini.generate).not.toHaveBeenCalled();
  });
  it('preserves the small generation body limit and bounds adaptation bodies', async () => {
    const adapt = vi.fn(), app = await start(adapt);
    expect((await app.post({ ...request, padding: 'a'.repeat(25_000) }, 'generate')).status).toBe(413);
    expect((await app.post({ ...request, padding: 'a'.repeat(3 * 1024 * 1024) })).status).toBe(413);
    expect(adapt).not.toHaveBeenCalled();
  });
  it('shares quota accounting across operations and returns safe provider failures without retrying', async () => {
    const adapt = vi.fn<AdaptImage>().mockRejectedValue(new AiError('RATE_LIMIT', 'Quota exhausted.', 429, true));
    const app = await start(adapt);
    for (let i = 0; i < 3; i++) expect((await app.post()).status).toBe(429);
    const fourth = await app.post(); expect(fourth.status).toBe(429); expect(adapt).toHaveBeenCalledTimes(3);
    expect(fourth.headers.get('retry-after')).not.toBeNull();
  });
});
