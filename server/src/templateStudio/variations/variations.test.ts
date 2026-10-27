// Style variations of a protected template, end to end over HTTP with the in-process worker, a MOCKED image provider and a
// fake recognizer. Nothing here can reach OpenAI, fal or any other provider.
import express from 'express';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PRESET_IDS, STYLE_PRESETS, type ProtectedTemplateView, type StyleVariationView, type VariationEstimate } from '@frameflow/shared';
import { createTemplateStudioRouter } from '../router.js';
import { parseStudioEnv } from '../config.js';
import { FakeProvider } from '../testing/fakeProvider.js';
import { NO_TEXT_RULE } from '../compose/imagePrompt.js';
import { fakeRecognizer } from '../../textRecognition/recognizer.js';
import { VARIATION_WORDS } from '../../textRecognition/variationPoster.fixture.js';
import { readyVariationTemplate } from '../../textRecognition/variationTemplate.fixture.js';

const provider = new FakeProvider(), recognizer = fakeRecognizer(VARIATION_WORDS);
let base = '', close = () => {}, template: ProtectedTemplateView, fixture: Awaited<ReturnType<typeof readyVariationTemplate>>;

beforeAll(async () => {
  fixture = await readyVariationTemplate(undefined, recognizer);
  const app = express();
  app.use('/api/template-studio', createTemplateStudioRouter({ env: parseStudioEnv({ OPENAI_API_KEY: 'test-key-not-used', STUDIO_IMAGE_QUALITY: 'medium' }, join(fixture.root, 'studio')), provider,
    runsDir: join(fixture.root, 'runs'), segmenter: () => undefined, log: () => {}, protectedDir: join(fixture.root, 'protected'), recognizer: () => recognizer }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(done => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/template-studio`;
  close = () => server.close();
  template = fixture.template;
}, 60_000);
afterAll(() => close());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (path: string, init?: RequestInit) => { const res = await fetch(`${base}${path}`, init); return { status: res.status, body: await res.json() as Record<string, any> }; };
const send = (method: string, path: string, body: unknown) => json(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const request = (over: Record<string, unknown> = {}) => ({ slots: DEFAULT_PRESET_IDS.map(presetId => ({ presetId, source: 'ai' })), typographyMode: 'match', quality: 'medium', ...over });
const imageCalls = () => provider.calls.filter(c => c.kind === 'image');
async function settle(ids: string[]): Promise<StyleVariationView[]> {
  for (let i = 0; i < 300; i++) {
    const views = await Promise.all(ids.map(async id => (await json(`/variations/${id}`)).body.variation as StyleVariationView));
    if (views.every(v => ['ready', 'needs_review', 'failed', 'cancelled'].includes(v.status))) return views;
    await new Promise(done => setTimeout(done, 40));
  }
  throw new Error('variations did not finish');
}
/** Reviewed words (variations need every word and logo reviewed). */
async function reviewWords() {
  let v = await fixture.service.analyseText(template.id, template.revision);
  const a = v.textAnalysis!;
  v = await fixture.service.correctText(template.id, v.revision, { expectedAnalysisRevision: a.revision, groups: a.groups,
    words: a.words.map(w => ({ ...w, review: { status: 'approved' as const } })), logoSlots: a.logoSlots.map(l => ({ ...l, review: { status: 'approved' as const } })) });
  template = v;
}

describe('style variations', { timeout: 30_000 }, () => {
  it('is not offered before the words and logos are found and reviewed', async () => {
    const { body } = await json(`/protected/${template.id}/variations`);
    expect(body.readiness).toMatchObject({ ready: false, code: 'no_text_analysis' });
    const est = await send('POST', `/protected/${template.id}/variations/estimate`, { request: request() });
    expect(est.status).toBe(422);
    await reviewWords();
    expect((await json(`/protected/${template.id}/variations`)).body.readiness).toEqual({ ready: true });
  });

  it('offers four distinct default presets and more, all with catalogue fonts', async () => {
    const { body } = await json('/variations/meta');
    expect(body.defaults).toEqual(['original-festive', 'premium-minimal', 'modern-fintech', 'creative-promo']);
    expect(body.presets.length).toBeGreaterThan(4);
    expect(new Set(STYLE_PRESETS.slice(0, 4).map(p => p.direction)).size).toBe(4);
  });

  it('estimates the paid requests separately from the free analysis and the unused Seedream, and refuses to start without confirmation', async () => {
    const est = (await send('POST', `/protected/${template.id}/variations/estimate`, { request: request() })).body as VariationEstimate;
    expect(est.paidRequests).toBe(4);
    expect(est.providerSize).toBe('1024x1360');
    expect(est.lines.map(l => l.stage)).toEqual(expect.arrayContaining(['Word and logo analysis', 'Seedream decomposition']));
    expect(est.lines.find(l => l.stage === 'Seedream decomposition')!.cost.microUsd).toBe(0);
    expect(est.total.microUsd).toBeGreaterThan(0);
    const before = imageCalls().length;
    const refused = await send('POST', `/protected/${template.id}/variations`, { idempotencyKey: 'variations-unconfirmed', request: request() });
    expect(refused).toMatchObject({ status: 400, body: { error: { code: 'confirmation_required' } } });
    const wrong = await send('POST', `/protected/${template.id}/variations`, { idempotencyKey: 'variations-wrong-amount', request: request(), confirm: { paid: true, estimateMicroUsd: est.confirmMicroUsd - 1 } });
    expect(wrong).toMatchObject({ status: 409, body: { error: { code: 'estimate_changed' } } });
    expect(imageCalls().length).toBe(before);
    expect((await json(`/protected/${template.id}/variations`)).body.variations).toHaveLength(0);
  });

  let first: StyleVariationView[] = [];
  it('generates four variations from the text-free base only, with the template\'s words and logos outside the AI pixels', async () => {
    const est = (await send('POST', `/protected/${template.id}/variations/estimate`, { request: request() })).body as VariationEstimate;
    const res = await send('POST', `/protected/${template.id}/variations`, { idempotencyKey: 'variations-first-batch', request: request(), confirm: { paid: true, estimateMicroUsd: est.confirmMicroUsd } });
    expect(res.status).toBe(202);
    first = await settle(res.body.batch.variationIds);
    expect(first.map(v => v.status)).toEqual(['ready', 'ready', 'ready', 'ready']);
    expect(first.map(v => v.provenance)).toEqual(['ai_generated', 'ai_generated', 'ai_generated', 'ai_generated']);
    const calls = imageCalls().slice(-4);
    expect(calls).toHaveLength(4);
    expect(new Set(calls.map(c => c.prompt)).size).toBe(4);
    for (const c of calls) {
      expect(c.imageNames).toEqual(['text-free-base.png', 'layout-guide.png']);
      expect(c.prompt).toContain(NO_TEXT_RULE);
      // No copy, partner name or logo label is ever written into the prompt.
      for (const word of ['Easy', 'EMI', 'available', 'months', 'T&C', 'Brand logo', 'Bank cards']) expect(c.prompt).not.toContain(word);
    }
    // The model saw the approved base, never the source with its text and logos.
    const a = template.textAnalysis!;
    for (const v of first) {
      expect(v.artwork).toMatchObject({ width: 900, height: 1200, model: 'gpt-image-2', providerSize: '1024x1360', cachedFrom: null });
      expect(v.artworkCheck?.status).toBe('clean');
      expect(v.validation.checks.collisions).not.toBe('not_checked');
      // Match original: every word in its original box, as its own placement; the original record untouched.
      expect(v.layout.words.map(w => w.wordId).sort()).toEqual(a.words.filter(w => w.review.status !== 'rejected').map(w => w.id).sort());
      for (const w of v.layout.words) expect(w.box).toEqual(a.words.find(o => o.id === w.wordId)!.box);
      expect(v.layout.logos).toHaveLength(a.logoSlots.length);
      expect(v.cost.actual).not.toBeNull();
    }
    expect(fixture.providers).toEqual({ planner: 0, transport: 0 });
  });

  it('returns the same variations for a repeated request, and reuses identical artwork instead of paying again', async () => {
    const calls = imageCalls().length;
    const est = (await send('POST', `/protected/${template.id}/variations/estimate`, { request: request() })).body as VariationEstimate;
    const again = await send('POST', `/protected/${template.id}/variations`, { idempotencyKey: 'variations-first-batch', request: request(), confirm: { paid: true, estimateMicroUsd: est.confirmMicroUsd } });
    expect(again.status).toBe(200);
    expect(again.body.batch.variationIds).toEqual(first.map(v => v.id));
    // A new request for the same four: every artwork is already there, so it costs nothing and needs no confirmation.
    expect(est.paidRequests).toBe(0);
    expect(est.lines.find(l => l.stage.startsWith('Artwork reused'))?.count).toBe(4);
    const reused = await send('POST', `/protected/${template.id}/variations`, { idempotencyKey: 'variations-second-batch', request: request() });
    const views = await settle(reused.body.batch.variationIds);
    expect(views.every(v => v.artwork?.cachedFrom && v.status === 'ready')).toBe(true);
    expect(views.map(v => v.artwork!.sha256)).toEqual(first.map(v => v.artwork!.sha256));
    expect(imageCalls().length).toBe(calls);
  });

  it('changes typography and layout without new artwork or any provider call, in variant coordinates only', async () => {
    const calls = provider.calls.length, v = first[0], a = template.textAnalysis!;
    const retyped = (await send('PATCH', `/variations/${v.id}/layout`, { typographyMode: 'suggested' })).body.variation as StyleVariationView;
    expect(retyped.layout.typographyMode).toBe('suggested');
    expect(retyped.layout.words.map(w => w.text)).toEqual(v.layout.words.map(w => w.text));
    expect(retyped.layout.words.some(w => w.style.fontFamily !== a.words.find(o => o.id === w.wordId)!.style.fontFamily)).toBe(true);
    expect(retyped.artwork!.sha256).toBe(v.artwork!.sha256);
    const emi = a.words.find(w => w.text === 'EMI')!;
    const moved = (await send('PATCH', `/variations/${v.id}/layout`, { words: [{ wordId: emi.id, box: { ...emi.box, y: emi.box.y + 30 } }] })).body.variation as StyleVariationView;
    expect(moved.layout.words.find(w => w.wordId === emi.id)!.box.y).toBe(emi.box.y + 30);
    // The template's original coordinates are not changed by a variation.
    expect(fixture.service.view(template.id).textAnalysis!.words.find(w => w.id === emi.id)!.box).toEqual(emi.box);
    expect(provider.calls.length).toBe(calls);
    expect(recognizer.calls.filter(c => c.purpose === 'artwork-check').length).toBeGreaterThan(0);
  });

  it('needs an administrator to confirm a change to protected text, and validates collisions before saving', async () => {
    const v = first[1], a = template.textAnalysis!, months = a.words.find(w => w.text === 'months')!, available = a.words.find(w => w.text === 'available.')!;
    let view = (await send('PATCH', `/variations/${v.id}/layout`, { words: [{ wordId: months.id, text: 'weeks' }] })).body.variation as StyleVariationView;
    expect(view.validation.issues.some(i => i.code === 'PROTECTED_CHANGED' && i.severity === 'error')).toBe(true);
    expect((await send('POST', `/variations/${v.id}/review`, { action: 'save' })).status).toBe(422);
    view = (await send('PATCH', `/variations/${v.id}/layout`, { confirmProtectedEdits: [months.id] })).body.variation as StyleVariationView;
    expect(view.validation.issues.find(i => i.code === 'PROTECTED_CHANGED')!.severity).toBe('warning');
    // Onto a word of another phrase: an error (within one phrase an overlap is only a warning).
    view = (await send('PATCH', `/variations/${v.id}/layout`, { words: [{ wordId: months.id, box: available.box }] })).body.variation as StyleVariationView;
    expect(view.validation.collisionFree).toBe(false);
    expect(view.validation.checks.collisions).toBe('fail');
    expect((await send('POST', `/variations/${v.id}/review`, { action: 'save' })).status).toBe(422);
    view = (await send('PATCH', `/variations/${v.id}/layout`, { words: [{ wordId: months.id, box: months.box }] })).body.variation as StyleVariationView;
    expect(view.validation.collisionFree).toBe(true);
    const saved = await send('POST', `/variations/${v.id}/review`, { action: 'save' });
    expect(saved.body.variation.review.status).toBe('saved');
    expect(saved.body.variation.review.history.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['created', 'generated', 'checked', 'layout-changed', 'protected-text-confirmed', 'saved']));
  });

  it('fails a refused request honestly, with no copy put in its place', async () => {
    const r = request({ slots: [{ presetId: 'custom', source: 'ai', customName: 'Refusal', customDirection: 'Fixture refusal: soft watercolour' }] });
    const est = (await send('POST', `/protected/${template.id}/variations/estimate`, { request: r })).body as VariationEstimate;
    const res = await send('POST', `/protected/${template.id}/variations`, { idempotencyKey: 'variations-refused', request: r, confirm: { paid: true, estimateMicroUsd: est.confirmMicroUsd } });
    const [v] = await settle(res.body.batch.variationIds);
    expect(v.status).toBe('failed');
    expect(v.error?.code).toBe('content_policy');
    expect(v.artwork).toBeNull();
  });

  it('flags text the image model drew into the artwork, and will not save it', async () => {
    const r = request({ slots: [{ presetId: 'custom', source: 'ai', customName: 'Drawn', customDirection: 'Fixture drawn text: bold neon' }] });
    const est = (await send('POST', `/protected/${template.id}/variations/estimate`, { request: r })).body as VariationEstimate;
    const res = await send('POST', `/protected/${template.id}/variations`, { idempotencyKey: 'variations-drawn-text', request: r, confirm: { paid: true, estimateMicroUsd: est.confirmMicroUsd } });
    const [v] = await settle(res.body.batch.variationIds);
    expect(v.status).toBe('needs_review');
    expect(v.artworkCheck?.status).toBe('text_found');
    expect(v.validation.issues.some(i => i.code === 'TEXT_IN_ARTWORK')).toBe(true);
    expect((await send('POST', `/variations/${v.id}/review`, { action: 'save' })).status).toBe(422);
  });

  it('makes local restyles and reuses without any call, labelled as such', async () => {
    const calls = provider.calls.length;
    const r = request({ slots: [{ presetId: 'premium-minimal', source: 'restyle' }, { presetId: 'original-festive', source: 'reuse' }] });
    const est = (await send('POST', `/protected/${template.id}/variations/estimate`, { request: r })).body as VariationEstimate;
    expect(est.paidRequests).toBe(0);
    const res = await send('POST', `/protected/${template.id}/variations`, { idempotencyKey: 'variations-local', request: r });
    const [restyle, reuse] = await settle(res.body.batch.variationIds);
    expect([restyle.provenance, reuse.provenance]).toEqual(['local_restyle', 'local_reuse']);
    expect(restyle.artwork!.sha256).not.toBe(reuse.artwork!.sha256);
    const baseStats = await sharp(fixture.store.read(template.id, template.base!.file)).stats();
    const reusedStats = await sharp(Buffer.from(await (await fetch(`http://${new URL(base).host}${reuse.artwork!.url}`)).arrayBuffer())).stats();
    expect(reusedStats.channels.map(c => Math.round(c.mean))).toEqual(baseStats.channels.slice(0, 3).map(c => Math.round(c.mean)));
    expect(provider.calls.length).toBe(calls);
  });

  it('coalesces concurrent submissions with one idempotency key into one paid job', async () => {
    const r = request({ slots: [{ presetId: 'modern-fintech', source: 'ai' }], customInstructions: 'Concurrent request regression: pale blue geometric waves.' });
    const est = (await send('POST', `/protected/${template.id}/variations/estimate`, { request: r })).body as VariationEstimate;
    const before = imageCalls().length;
    const body = { idempotencyKey: 'variations-concurrent', request: r, confirm: { paid: true, estimateMicroUsd: est.confirmMicroUsd } };
    const responses = await Promise.all(Array.from({ length: 3 }, () => send('POST', `/protected/${template.id}/variations`, body)));
    expect(responses.map(res => res.status).sort()).toEqual([200, 200, 202]);
    expect(new Set(responses.map(res => res.body.batch.id)).size).toBe(1);
    await settle(responses[0].body.batch.variationIds);
    expect(imageCalls().length - before).toBe(1);
  });

  it('refuses a request that would pass the per-variation limit before anything is sent', async () => {
    const dir = join(fixture.root, 'studio-capped'), app = express();
    app.use('/api/template-studio', createTemplateStudioRouter({ env: parseStudioEnv({ OPENAI_API_KEY: 'x', STUDIO_MAX_JOB_BUDGET_USD: '0.01' }, dir), provider, runsDir: join(fixture.root, 'runs'), segmenter: () => undefined, log: () => {}, worker: false,
      protectedDir: join(fixture.root, 'protected'), recognizer: () => recognizer }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(done => server.once('listening', done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/template-studio/protected/${template.id}/variations`;
    try {
      const est = await (await fetch(`${url}/estimate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request: request({ quality: 'high' }) }) })).json() as VariationEstimate;
      expect(est.blockedReason).toMatch(/per-job limit/);
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idempotencyKey: 'capped-request', request: request({ quality: 'high' }), confirm: { paid: true, estimateMicroUsd: est.confirmMicroUsd } }) });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('budget_exceeded');
    } finally { server.close(); }
  });
});
