import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { accessGate, readAccessConfig, type AccessConfig } from './access.js';

// The shared access password and the fail-safe for paid keys, over real HTTP on this machine (no provider is involved).
let server: Server | undefined;
afterEach(() => { server?.close(); server = undefined; });

async function start(access: AccessConfig) {
  const app = express();
  app.use(accessGate(access));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.all('/{*path}', (req, res) => res.json({ reached: `${req.method} ${req.path}` }));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server!.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return (path: string, init: RequestInit & { login?: string } = {}) => fetch(`${base}${path}`, {
    ...init, headers: { ...(init.login ? { authorization: `Basic ${Buffer.from(init.login).toString('base64')}` } : {}) },
  });
}

describe('reading the access settings', () => {
  it('locks API changes only on a production server holding a paid key without a password', () => {
    expect(readAccessConfig({ NODE_ENV: 'production', OPENAI_API_KEY: 'k' })).toEqual({ user: 'frameflow', password: undefined, lockChanges: true });
    expect(readAccessConfig({ NODE_ENV: 'production', FAL_KEY: 'k', FRAMEFLOW_ACCESS_PASSWORD: ' s3cret ', FRAMEFLOW_ACCESS_USER: 'team' })).toEqual({ user: 'team', password: 's3cret', lockChanges: false });
    expect(readAccessConfig({ NODE_ENV: 'production' }).lockChanges).toBe(false);
    expect(readAccessConfig({ OPENAI_API_KEY: 'k' }).lockChanges).toBe(false);
  });
});

describe('the access password', () => {
  const access: AccessConfig = { user: 'frameflow', password: 'correct horse', lockChanges: false };

  it('asks for it on pages and API calls alike, and lets the right one through', async () => {
    const call = await start(access);
    const page = await call('/');
    expect(page.status).toBe(401);
    expect(page.headers.get('www-authenticate')).toMatch(/^Basic realm="FrameFlow"/);
    expect((await call('/api/layerize-experiment/product-templates', { method: 'POST' })).status).toBe(401);
    expect((await call('/', { login: 'frameflow:wrong' })).status).toBe(401);
    expect((await call('/', { login: 'someone:correct horse' })).status).toBe(401);
    const ok = await call('/api/layerize-experiment/product-templates', { method: 'POST', login: 'frameflow:correct horse' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ reached: 'POST /api/layerize-experiment/product-templates' });
  });

  it('keeps the health check open', async () => {
    const call = await start(access);
    expect((await call('/api/health')).status).toBe(200);
  });

  it('refuses an address after 20 failed attempts, even with the right password', async () => {
    const call = await start(access);
    for (let i = 0; i < 20; i++) expect((await call('/', { login: `frameflow:guess-${i}` })).status).toBe(401);
    const blocked = await call('/', { login: 'frameflow:correct horse' });
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error.code).toBe('RATE_LIMIT');
  });
});

describe('the fail-safe without a password', () => {
  it('refuses every API change but still serves pages, reads and the health check', async () => {
    const call = await start({ user: 'frameflow', lockChanges: true });
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const refused = await call('/api/template-studio/jobs', { method });
      expect(refused.status).toBe(403);
      expect((await refused.json()).error.code).toBe('ACCESS_PASSWORD_REQUIRED');
    }
    expect((await call('/')).status).toBe(200);
    expect((await call('/api/layerize-experiment/product-templates')).status).toBe(200);
    expect((await call('/api/health')).status).toBe(200);
  });

  it('changes nothing when there is no paid key', async () => {
    const call = await start({ user: 'frameflow', lockChanges: false });
    expect((await call('/api/layerize-experiment/protected-templates', { method: 'POST' })).status).toBe(200);
  });
});
