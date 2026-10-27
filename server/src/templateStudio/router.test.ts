// The Template Studio HTTP routes end to end on a local port, with the in-process worker and a MOCKED provider.
import express from 'express';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTemplateStudioRouter } from './router.js';
import { parseStudioEnv } from './config.js';
import { FakeProvider } from './testing/fakeProvider.js';
import { productPhotoPng, referencePosterPng } from './testing/fixtures.js';

const provider = new FakeProvider();
let base = '', close = () => {};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'template-studio-routes-'));
  const app = express();
  app.use('/api/template-studio', createTemplateStudioRouter({ env: parseStudioEnv({ OPENAI_API_KEY: 'test-key-not-used' }, dir), provider, runsDir: join(dir, 'runs'), segmenter: () => undefined, log: () => {} }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(done => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/template-studio`;
  close = () => server.close();
});
afterAll(() => close());

// Response bodies are inspected loosely: the assertions themselves state the shapes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (path: string, init?: RequestInit) => { const res = await fetch(`${base}${path}`, init); return { status: res.status, body: await res.json() as Record<string, any> }; };
const post = (path: string, body: unknown) => json(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function upload(bytes: Buffer, role: string, label: string) {
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), `${label}.png`);
  form.set('role', role); form.set('label', label);
  return json('/assets', { method: 'POST', body: form });
}
async function settle(jobId: string) {
  for (let i = 0; i < 200; i++) {
    const { body } = await json(`/jobs/${jobId}`);
    if (body.job.terminal) return body.job;
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error('job did not finish');
}

describe('template studio routes', () => {
  it('serves the formats, modes and defaults, with Match Reference first and default', async () => {
    const { body } = await json('/meta');
    expect(body.defaults).toMatchObject({ fidelityMode: 'match', formatId: 'portrait-4-5' });
    expect(body.fidelityModes.map((m: { id: string }) => m.id)).toEqual(['match', 'adapt', 'explore']);
    expect(body.formats.map((f: { ratio: string }) => f.ratio)).toEqual(['4:5', '1:1', '9:16', '2:3', 'A4', '16:9', '3:2']);
    expect(body.fx).toMatchObject({ source: 'configured' });
  });

  it('creates a template from an upload, generates a poster, and serves the scene for decomposition', async () => {
    const ref = await upload(await referencePosterPng(), 'reference', 'Blue studio ad');
    expect(ref.status).toBe(201);
    expect(ref.body.asset).toMatchObject({ role: 'reference', width: 1080, height: 1350 });
    expect((await post('/templates', { idempotencyKey: 'tpl-key-1', name: '', referenceAssetIds: [ref.body.asset.id] })).body.error.message).toMatch(/name/);

    const created = await post('/templates', { idempotencyKey: 'tpl-key-1', name: 'Blue studio', referenceAssetIds: [ref.body.asset.id] });
    expect(created.status).toBe(201);
    // A double click returns the same template and job.
    expect((await post('/templates', { idempotencyKey: 'tpl-key-1', name: 'Blue studio', referenceAssetIds: [ref.body.asset.id] })).body).toEqual(created.body);
    expect((await settle(created.body.jobId)).state).toBe('complete');
    const { body: { template } } = await json(`/templates/${created.body.templateId}`);
    expect(template).toMatchObject({ status: 'ready', name: 'Blue studio' });
    expect(template.profile.data.sharedInvariants).toContain('Blue studio backdrop');
    expect(template.analysisCost.calls).toBe(1);

    const product = await upload(await productPhotoPng(), 'subject', 'Mixer');
    const estimate = await post('/costs/estimate', { templateId: template.id, formatId: 'portrait-4-5', products: [{ assetId: product.body.asset.id, name: 'Mixer' }] });
    expect(estimate.body.lines.map((l: { stage: string }) => l.stage)).toEqual(['Reference / template analysis', 'Product analysis', 'AI composition planning', 'Image generation (high, 1024x1280)', 'Image review', 'Structure repair (only if needed)']);
    expect(estimate.body.lines[0]).toMatchObject({ cached: true });
    expect(estimate.body.withinCap).toBe(true);

    const started = await post('/campaigns', { idempotencyKey: 'poster-key-1', templateId: template.id, subjects: [{ assetId: product.body.asset.id, name: 'Mixer' }], copy: { headline: 'Mix it up', offer: 'Flat ₹500 off' }, formatId: 'portrait-4-5' });
    expect(started.status).toBe(202);
    const job = await settle(started.body.jobId);
    expect(job.state).toBe('complete');
    expect(job.stages.map((s: { label: string }) => s.label)).toEqual(['Looking at your products', 'Art direction', 'Generating the image', 'Adding text and logo', 'Quality review']);
    const posterId = job.result.posterId as string;
    const { body: { poster } } = await json(`/posters/${posterId}`);
    expect(poster).toMatchObject({ fidelityMode: 'match', reviewStatus: 'ok', copy: { headline: 'Mix it up', offer: 'Flat ₹500 off' } });
    expect(poster.checks.find((c: { id: string }) => c.id === 'reference').status).toBe('pass');
    expect(poster.cost.calls).toBe(4);

    // The estimate now says the product analysis is cached.
    const again = await post('/costs/estimate', { templateId: template.id, formatId: 'portrait-4-5', products: [{ assetId: product.body.asset.id, name: 'Mixer' }] });
    expect(again.body.lines[1]).toMatchObject({ stage: 'Product analysis', cached: true });

    const image = await fetch(`${base}/posters/${posterId}/image?format=png`);
    expect((await sharp(Buffer.from(await image.arrayBuffer())).metadata()).width).toBe(1080);
    const scene = await fetch(`${base}/posters/${posterId}/decomposition-scene.png`);
    expect(scene.headers.get('content-type')).toBe('image/png');
    const sceneBytes = Buffer.from(await scene.arrayBuffer());
    expect((await sharp(sceneBytes).metadata()).width).toBe(1024);
    expect(scene.headers.get('x-studio-scene-sha256')).toMatch(/^[a-f0-9]{64}$/);

    const history = await json('/posters');
    expect(history.body.items.map((i: { kind: string }) => i.kind)).toEqual(['generate_poster', 'analyse_template']);
    expect((await json('/decompositions/2026-10-12T00-00-00-000Z-abcdef')).body).toEqual({ link: null });
    expect((await post(`/posters/${posterId}/decompositions`, { runId: '2026-10-12T00-00-00-000Z-abcdef' })).status).toBe(404);
  });

  it('answers errors as JSON without starting anything paid', async () => {
    const calls = provider.calls.length;
    expect((await json('/posters/pst_00000000000000000000')).status).toBe(404);
    expect((await json('/assets/..%2F..%2Fetc%2Fpasswd')).status).toBe(404);
    expect((await post('/campaigns', { idempotencyKey: 'x' })).status).toBe(400);
    const bad = await fetch(`${base}/campaigns`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
    expect(bad.status).toBe(400);
    expect((await post('/assets/ast_00000000000000000000/cutout', { idempotencyKey: 'cutout-key-1', label: 'x' })).status).toBe(404);
    expect(provider.calls.length).toBe(calls);
  });
});
