import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { setup, savedTemplate } from './productServer.fixture.js';
import { productPosterPng } from './productPoster.fixture.js';
import type { VariationJob } from './variations.js';
import type { ArtworkGenerator } from './artwork.js';

type Job = VariationJob & { running: boolean; accounting?: { usageCostUsd: number; uncertainCostUsd: number; estimatedCostUsd: number } };
async function done(s: Awaited<ReturnType<typeof setup>>, id: string, jid: string) {
  for (let i = 0; i < 3000; i++) { const j = (await s.call<Job>(`/${id}/variations/${jid}`)).body; if (j.status !== 'running') return j; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('job did not terminate');
}
/** A fake image model (no network, no charges): distinct packshots, a short delay, and per-call behaviour (throw, or draw "text"). */
function provider(behaviour: (n: number) => 'text' | void = () => undefined, options: { delayMs?: number; costUsd?: number } = {}) {
  const seen = { calls: 0, active: 0, peak: 0 };
  const artwork: ArtworkGenerator = { model: 'fake product images (no network)', offline: false, async generate() {
    const n = ++seen.calls; seen.peak = Math.max(seen.peak, ++seen.active);
    try {
      await new Promise(r => setTimeout(r, options.delayMs ?? 10));
      const marker = behaviour(n) === 'text' ? '<rect x="40" y="250" width="120" height="40" fill="#ff00ff"/>' : '';
      const png = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="white"/><rect x="${30 + (n % 7)}" y="${20 + (n % 11)}" width="120" height="${190 + n}" fill="hsl(${(n * 37) % 360},60%,35%)"/>${marker}</svg>`)).png().toBuffer();
      return { png, costUsd: options.costUsd ?? .02, requestId: `req_fake_${n}` };
    } finally { seen.active--; }
  } };
  return { artwork, seen };
}
const productSlots = async (s: Awaited<ReturnType<typeof setup>>, id: string) => (await s.call<{ slots: { kind: string }[] }>(`/${id}/variation-options`)).body.slots.filter(x => x.kind === 'product').length;
const usd = (images: number) => Math.round(images * 6) / 100;

describe('one approved generation batch, honest pauses and safe continuation', { timeout: 180000 }, () => {
  it('runs a whole approved batch automatically with bounded concurrency, refuses defective sources and duplicate starts, and stops on request', async () => {
    const p = provider(undefined, { delayMs: 25 });
    const s = await setup({ artwork: p.artwork });
    try {
      const v = await savedTemplate(s, await productPosterPng()), id = v.template.id, slots = await productSlots(s, id), total = 3 * slots;
      const revisionFile = join(s.protectedDir, id, 'product-r1.json'), original = readFileSync(revisionFile), defective = JSON.parse(original.toString());
      defective.quality.issues.push({ id: 'fixture-residual', blocking: true, message: 'Product remains in background.' });
      writeFileSync(revisionFile, JSON.stringify(defective));
      expect(JSON.stringify((await s.call(`/${id}/variation-options`)).body)).toContain('Product remains in background.');
      expect(JSON.stringify((await s.send('POST', `/${id}/variations`, { count: 3, generateProducts: true, approveProductsUsd: usd(total) })).body)).toContain('SOURCE_NOT_READY'); expect(p.seen.calls).toBe(0);
      writeFileSync(revisionFile, original);
      // The cost must be approved, for exactly the workload shown.
      expect((await s.send('POST', `/${id}/variations`, { count: 3, generateProducts: true, approveProductsUsd: usd(total) - .06 })).status).toBe(400);
      expect((await s.send('POST', `/${id}/variations`, { count: 3, generateProducts: true, approveProductsUsd: usd(total), approveImages: total - 1 })).status).toBe(400); expect(p.seen.calls).toBe(0);
      const start = await s.send<Job>('POST', `/${id}/variations`, { count: 3, generateProducts: true, approveProductsUsd: usd(total), approveImages: total });
      expect(start.status).toBe(202); expect(start.body).toMatchObject({ status: 'running', state: 'generating', running: true });
      // A second start while it runs is refused: one job per template at a time.
      expect((await s.send('POST', `/${id}/variations`, { count: 3, generateProducts: true, approveProductsUsd: usd(total) })).status).toBe(409);
      const job = await done(s, id, start.body.id);
      expect(job).toMatchObject({ status: 'done', state: 'completed', running: false });
      expect(job.message).toBe(`All variations are ready. ${total} of ${total} product images saved.`);
      expect(p.seen.calls).toBe(total); expect(p.seen.peak).toBe(2);
      expect(job.results.map(r => r.status)).toEqual(['ready', 'ready', 'ready']);
      expect(job.results.every(r => r.creative?.objects.filter(o => o.kind === 'product').every(o => o.asset.file.startsWith('pvarproduct-')))).toBe(true);
      expect(job.authorizations).toEqual([expect.objectContaining({ kind: 'batch', images: total, maxUsd: usd(total), retry: false })]);
      expect(job.operations!.every(o => o.status === 'ready' && o.authorizationId === job.authorizations![0].id)).toBe(true);
      expect(job.progress).toMatchObject({ total, ready: total, waiting: 0, retry: 0 }); expect(job.continuation?.available).toBe(false);
      expect(job.productGeneration).toMatchObject({ requests: total }); expect(job.accounting?.usageCostUsd).toBeCloseTo(total * .02, 6);
      // Stop: requests already sent finish and are kept; nothing new is sent; the job can be continued with one approval.
      const second = await s.send<Job>('POST', `/${id}/variations`, { count: 3, generateProducts: true, approveProductsUsd: usd(total), approveImages: total });
      while ((await s.call<Job>(`/${id}/variations/${second.body.id}`)).body.progress!.ready < 2) await new Promise(r => setTimeout(r, 5));
      const stoppedAt = new Date().toISOString(), stopped = await s.send<Job>('POST', `/${id}/variations/${second.body.id}/cancel`, {});
      expect(stopped.status).toBe(200);
      const cancelled = await done(s, id, second.body.id);
      expect(cancelled).toMatchObject({ status: 'paused', state: 'cancelled' });
      expect(cancelled.message).toContain('Stopped by you.');
      expect(cancelled.operations!.filter(o => o.startedAt > stoppedAt)).toEqual([]);
      expect(cancelled.results.every(r => r.status !== 'failed')).toBe(true);
      const left = cancelled.continuation!;
      expect(left).toMatchObject({ available: true, retryImages: 0 }); expect(left.images).toBe(total - cancelled.progress!.ready);
      // A new batch on this revision would make the saved images again: it needs an explicit confirmation.
      const fresh = await s.send<{ error: { code: string } }>('POST', `/${id}/variations`, { count: 3, generateProducts: true, approveProductsUsd: usd(total) });
      expect(fresh.body.error.code).toBe('UNFINISHED_JOB');
      const before = p.seen.calls, resumed = await s.send<Job>('POST', `/${id}/variations/${second.body.id}/resume`, { approveImages: left.images, approveProductsUsd: left.estimateUsd });
      expect(resumed.status).toBe(202);
      const finished = await done(s, id, second.body.id);
      expect(finished).toMatchObject({ status: 'done', state: 'completed' }); expect(p.seen.calls - before).toBe(left.images);
      expect(finished.authorizations!.map(a => a.kind)).toEqual(['batch', 'continuation']);
    } finally { await s.close(); }
  });

  it('a smoke test pauses honestly (never "failed"), and one continuation approval finishes every variation reusing the saved image', async () => {
    const p = provider();
    const s = await setup({ artwork: p.artwork });
    try {
      const v = await savedTemplate(s, await productPosterPng()), id = v.template.id, slots = await productSlots(s, id), total = 3 * slots;
      const probe = await s.send<Job>('POST', `/${id}/variations`, { count: 3, generateProducts: true, maxNewImages: 1, approveProductsUsd: .06, approveImages: 1 });
      expect(probe.status).toBe(202);
      let job = await done(s, id, probe.body.id);
      expect(p.seen.calls).toBe(1);
      expect(job).toMatchObject({ status: 'paused', state: 'paused-smoke-test', running: false });
      expect(job.message).toBe(`Smoke test completed. 1 product image saved. Approve the remaining generation batch (${total - 1} images) to continue.`);
      expect(job.results.map(r => r.status)).toEqual(['pending', 'pending', 'pending']);
      expect(JSON.stringify(job.results)).not.toMatch(/earlier image failure|Not started/);
      expect(job.results[0].note).toBe(`1 of ${slots} product images ready. Waiting: the smoke test is finished. Approve the remaining batch to make this variation.`);
      expect(job.continuation).toMatchObject({ available: true, images: total - 1, estimateUsd: usd(total - 1), retryImages: 0, reused: 1 });
      const first = job.operations![0], firstBytes = readFileSync(join(s.protectedDir, id, first.asset!.file));
      // The jobs written before states were recorded read the same: the user's paused smoke test, as the old code stored it.
      const file = join(s.protectedDir, id, `pvar-${job.id.slice(3)}.json`), current = readFileSync(file);
      const legacy = JSON.parse(current.toString()); delete legacy.state; delete legacy.authorizations; delete legacy.detail;
      Object.assign(legacy, { status: 'failed', error: 'Paused after the approved image attempt limit. Saved images are retained. Approve another attempt to continue.',
        results: [0, 1, 2].map(index => ({ index, status: 'failed', plan: legacy.plans[index], error: index ? 'Not started after an earlier image failure. No image request was sent for this variation.' : 'Paused after the approved image attempt limit. Saved images are retained. Approve another attempt to continue.' })) });
      writeFileSync(file, JSON.stringify(legacy)); const legacyBytes = readFileSync(file);
      const read = (await s.call<Job>(`/${id}/variations/${job.id}`)).body;
      expect(read).toMatchObject({ status: 'paused', state: 'paused-smoke-test', message: job.message }); expect(read.results.map(r => r.status)).toEqual(['pending', 'pending', 'pending']);
      expect(readFileSync(file)).toEqual(legacyBytes);
      // Continuing needs one approval for exactly the remaining images; viewing or a wrong approval sends nothing.
      const route = `/${id}/variations/${job.id}/resume`;
      expect((await s.send('POST', route, {})).status).toBe(400);
      expect((await s.send('POST', route, { approveImages: total - 2, approveProductsUsd: usd(total - 1) })).status).toBe(400);
      expect((await s.send('POST', route, { approveImages: total - 1, approveProductsUsd: usd(total - 1) - .06 })).status).toBe(400);
      expect(p.seen.calls).toBe(1);
      expect((await s.send('POST', route, { approveImages: total - 1, approveProductsUsd: usd(total - 1) })).status).toBe(202);
      job = await done(s, id, job.id);
      expect(job).toMatchObject({ status: 'done', state: 'completed' }); expect(p.seen.calls).toBe(total);
      expect(job.results.map(r => r.status)).toEqual(['ready', 'ready', 'ready']);
      expect(job.operations!.filter(o => o.index === first.index && o.slotId === first.slotId)).toEqual([first]);
      expect(readFileSync(join(s.protectedDir, id, first.asset!.file))).toEqual(firstBytes);
      expect(job.authorizations!.map(a => [a.kind, a.images])).toEqual([['continuation', total - 1]]);
      // Asking again sends nothing.
      await s.send('POST', route, { approveImages: 0, approveProductsUsd: 0 }); expect(p.seen.calls).toBe(total);
    } finally { await s.close(); }
  });

  it('a connection reset leaves an uncertain attempt that is retried only with explicit approval; orphaned jobs read as interrupted without writes', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const p = provider(n => { if (n === 2) throw new TypeError('terminated', { cause: Object.assign(new Error(), { code: 'UND_ERR_SOCKET' }) }); });
    const s = await setup({ artwork: p.artwork });
    try {
      const v = await savedTemplate(s, await productPosterPng()), id = v.template.id, slots = await productSlots(s, id), total = 3 * slots;
      let job = await done(s, id, (await s.send<Job>('POST', `/${id}/variations`, { count: 3, generateProducts: true, approveProductsUsd: usd(total) })).body.id);
      expect(p.seen.calls).toBe(2);
      expect(job).toMatchObject({ status: 'failed', state: 'connection-interrupted' });
      expect(job.message).toContain('The connection to the image provider was interrupted'); expect(job.message).toContain('Provider completion and billing are unknown');
      expect(job.operations!.map(o => o.status).sort()).toEqual(['ready', 'unknown']);
      expect(job.results[0]).toMatchObject({ status: 'failed' }); expect(job.results[0].error).toContain('need');
      expect(job.results.slice(1).map(r => [r.status, r.note?.includes('interrupted connection')])).toEqual([['pending', true], ['pending', true]]);
      expect(job.continuation).toMatchObject({ available: true, images: total - 2, retryImages: 1 });
      const route = `/${id}/variations/${job.id}/resume`;
      // Without the retry approval, only never-attempted slots are sent; the uncertain one is left for an explicit decision.
      await s.send('POST', route, { approveImages: total - 2, approveProductsUsd: usd(total - 2) });
      job = await done(s, id, job.id);
      expect(p.seen.calls).toBe(total);
      expect(job).toMatchObject({ status: 'paused', state: 'paused-approval' });
      expect(job.message).toContain('1 image from earlier attempts failed or had an unknown outcome');
      expect(job.results.map(r => r.status)).toEqual(['failed', 'ready', 'ready']);
      expect(job.continuation).toMatchObject({ available: true, images: 0, retryImages: 1 });
      expect((await s.send('POST', route, { approveImages: 0, approveProductsUsd: 0 })).status).toBe(202);
      job = await done(s, id, job.id); expect(p.seen.calls).toBe(total); expect(job.results[0].status).toBe('failed');
      await s.send('POST', route, { approveImages: 1, approveProductsUsd: .06, retry: true });
      job = await done(s, id, job.id);
      expect(p.seen.calls).toBe(total + 1); expect(job).toMatchObject({ status: 'done', state: 'completed' });
      // Simulate a process exit only in this temporary store. GET reports it but preserves the persisted record.
      const file = join(s.protectedDir, id, `pvar-${job.id.slice(3)}.json`), stale = JSON.parse(readFileSync(file, 'utf8'));
      stale.status = 'running'; stale.state = 'generating'; stale.ownerPid = 2147483647; stale.operations.push({ ...stale.operations[0], id: 'op-in-flight', status: 'running', asset: undefined, index: 0, slotId: 'not-a-slot' });
      writeFileSync(file, JSON.stringify(stale)); const bytes = readFileSync(file);
      const orphan = (await s.call<Job>(`/${id}/variations/${job.id}`)).body;
      expect(orphan).toMatchObject({ status: 'failed', state: 'interrupted', interrupted: true, running: false });
      expect(orphan.message).toContain('The server stopped while generating'); expect(orphan.operations!.at(-1)!.status).toBe('unknown');
      expect(readFileSync(file)).toEqual(bytes);
      expect((await s.call<{ jobs: { status: string; state: string }[] }>(`/${id}/variations`)).body.jobs[0]).toMatchObject({ status: 'failed', state: 'interrupted' });
    } finally { spy.mockRestore(); await s.close(); }
  });

  it('credit exhaustion in variation two keeps variation one, sends nothing after it, and defective sources block continuation and regeneration', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let slots = 0;
    const p = provider(n => { if (n === slots + 1) throw Object.assign(new Error('You have no credits remaining'), { status: 429, code: 'insufficient_quota', request_id: 'req_credit_fixture' }); });
    const s = await setup({ artwork: p.artwork });
    try {
      const v = await savedTemplate(s, await productPosterPng()), id = v.template.id; slots = await productSlots(s, id);
      const job = await done(s, id, (await s.send<Job>('POST', `/${id}/variations`, { count: 3, generateProducts: true, approveProductsUsd: usd(3 * slots) })).body.id);
      expect(job).toMatchObject({ status: 'failed', state: 'insufficient-credits' });
      expect(job.message).toBe(`OpenAI API credits exhausted. Completed images are preserved (${job.progress!.ready} of ${3 * slots} product images saved). No further requests were submitted.`);
      expect(job.results[0].status).toBe('ready'); expect(job.results[0].creative?.variation?.checks?.status).not.toBe('failed');
      const rejected = job.operations!.find(o => o.failure)!;
      expect(rejected.failure).toMatchObject({ code: 'OPENAI_HTTP_429', outcome: 'rejected' });
      // At most the one request already in flight when the 429 arrived; none started after it.
      expect(p.seen.calls).toBeLessThanOrEqual(slots + 2); expect(job.operations!.filter(o => o.startedAt > rejected.finishedAt!)).toEqual([]);
      expect(job.results[2]).toMatchObject({ status: 'pending' }); expect(job.results[2].note).toContain('OpenAI credits ran out');
      const calls = p.seen.calls, file = join(s.protectedDir, id, 'product-r1.json'), snapshot = JSON.parse(readFileSync(file, 'utf8'));
      snapshot.quality.issues.push({ id: 'residual', blocking: true, message: 'Water purifier remains in background.' }); writeFileSync(file, JSON.stringify(snapshot));
      const blocked = (await s.call<Job>(`/${id}/variations/${job.id}`)).body;
      expect(blocked.continuation).toMatchObject({ available: false }); expect(blocked.continuation!.reason).toContain('Water purifier remains in background.');
      const recovery = await s.send('POST', `/${id}/variations/${job.id}/resume`, { approveImages: blocked.continuation!.images, approveProductsUsd: 9, retry: true });
      expect(JSON.stringify(recovery.body)).toContain('SOURCE_NOT_READY');
      const regenerate = await s.send('POST', `/${id}/variations/${job.id}/results/0/regenerate`, { approveProductsUsd: 9 });
      expect(JSON.stringify(regenerate.body)).toContain('SOURCE_NOT_READY'); expect(p.seen.calls).toBe(calls);
    } finally { spy.mockRestore(); await s.close(); }
  });

  it('enforces the approved spend with measured costs, and one rejected image blocks only its own slot', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const before = process.env.FRAMEFLOW_PRODUCT_IMAGE_CONCURRENCY;
    process.env.FRAMEFLOW_PRODUCT_IMAGE_CONCURRENCY = '1';
    const costly = provider(undefined, { costUsd: .1 }), s = await setup({ artwork: costly.artwork });
    try {
      const v = await savedTemplate(s, await productPosterPng()), id = v.template.id, total = 3 * await productSlots(s, id);
      const job = await done(s, id, (await s.send<Job>('POST', `/${id}/variations`, { count: 3, generateProducts: true, approveProductsUsd: usd(total) })).body.id);
      // Each image measured $0.10 against a $0.06 estimate: sending stops before the approved amount would be exceeded.
      expect(job).toMatchObject({ status: 'paused', state: 'paused-approval' });
      expect(costly.seen.calls).toBe(Math.floor(usd(total) / .1 + 1e-9));
      expect(job.accounting!.usageCostUsd).toBeLessThanOrEqual(usd(total));
    } finally { await s.close(); }
    process.env.FRAMEFLOW_PRODUCT_IMAGE_CONCURRENCY = before ?? '';
    if (before === undefined) delete process.env.FRAMEFLOW_PRODUCT_IMAGE_CONCURRENCY;
    const marked = provider(n => (n === 2 ? 'text' : undefined)), t = await setup({ artwork: marked.artwork });
    try {
      const v = await savedTemplate(t, await productPosterPng()), id = v.template.id, total = 3 * await productSlots(t, id);
      const job = await done(t, id, (await t.send<Job>('POST', `/${id}/variations`, { count: 3, generateProducts: true, approveProductsUsd: usd(total) })).body.id);
      expect(marked.seen.calls).toBe(total);
      expect(job).toMatchObject({ status: 'paused', state: 'paused-approval' });
      expect(job.operations!.filter(o => o.status === 'failed').map(o => o.failure?.code)).toEqual(['IMAGE_VALIDATION_FAILED']);
      expect(job.results.filter(r => r.status === 'ready')).toHaveLength(2);
      expect(job.continuation).toMatchObject({ images: 0, retryImages: 1, retryEstimateUsd: .06 });
    } finally { spy.mockRestore(); await t.close(); }
  });
});

it('maps legacy completed images only with unique serial timing and matching hashes, without writes', async () => {
  const { mkdtempSync, utimesSync } = await import('node:fs'), { tmpdir } = await import('node:os');
  const { fileProtectedStore } = await import('../store.js'), { legacyProductOperations } = await import('./generationRecovery.js');
  const { productMix, productFamily, productReusePrompt } = await import('./reuse.js'), { sha256 } = await import('../pixels.js');
  const store = fileProtectedStore(mkdtempSync(join(tmpdir(), 'legacy-product-audit-'))), id = 'pt-000000000001';
  const slots = [{ slotId: 'slot-a', label: 'refrigerator', box: { width: 100, height: 200 } }, { slotId: 'slot-b', label: 'microwave oven', box: { width: 200, height: 100 } }];
  const plans = [{ kind: 'premium' }] as import('./variations.js').VariationPlan[], mix = productMix(slots, 0);
  const job = { id: 'pv-12345678', results: [] } as unknown as VariationJob;
  const write = (file: string, bytes: Buffer, seconds: number) => { store.write(id, file, bytes); utimesSync(store.path(id, file), seconds, seconds); };
  for (const k of [0, 1]) write(`pvar-12345678-product-0-${k}-attempt-abc123-artwork-openai-request.json`, Buffer.from(JSON.stringify({ model: 'test', prompt: productReusePrompt(mix[k], productFamily(slots.map(s => s.label)), 'premium', 0) })), 100 + k * 10);
  const response = 'pvar-12345678-product-0-0-attempt-abc123-artwork-openai-response.json';
  write(response, Buffer.from(JSON.stringify({ images: 1, requestId: 'req_legacy', usage: { input_tokens: 1, output_tokens: 1 } })), 102);
  const png = await sharp({ create: { width: 20, height: 30, channels: 4, background: '#087f5b' } }).png().toBuffer(), file = `pvarproduct-12345678-0-${sha256(png).slice(0, 12)}.png`;
  write(file, png, 103); const before = store.files(id, '').map(f => [f, sha256(store.read(id, f))]);
  const ops = legacyProductOperations(store, id, job, slots, plans);
  expect(ops.map(o => o.status)).toEqual(['ready', 'unknown']); expect(ops[0].asset).toMatchObject({ file, width: 20, height: 30 });
  expect(store.files(id, '').map(f => [f, sha256(store.read(id, f))])).toEqual(before);
  // Ambiguity cannot silently turn into a paid replacement.
  const second = await sharp(png).negate().png().toBuffer(); write(`pvarproduct-12345678-0-${sha256(second).slice(0, 12)}.png`, second, 104);
  expect(legacyProductOperations(store, id, job, slots, plans)[0].failure?.code).toBe('LEGACY_OUTPUT_UNMAPPED');
});
