import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import type { ProtectedElement, ProtectedTemplateView } from '@frameflow/shared';
import { createLayerizeRouter } from '../layerizeRouter.js';
import { ProviderError } from '../providers/adapters.js';
import type { FalTransport } from '../providers/falClient.js';
import { readRun, SEEDREAM_ENDPOINT, type RunnerDeps } from '../layerizeExperiment.js';
import { readRunDiagnostics } from '../runDiagnostics.js';
import { decodeRgba, flattenRgb } from './pixels.js';

const W = 900, H = 1200, sha = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest('hex');
const pixelsSha = async (png: Buffer) => sha(flattenRgb(await decodeRgba(png)));
const svg = (body: string, w = W, h = H) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`)).png().toBuffer();
const GRADIENT = '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b6e79"/><stop offset="1" stop-color="#14a3a8"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>';
const PHONE = '<rect x="520" y="420" width="260" height="520" rx="36" fill="#22252c"/><rect x="536" y="440" width="228" height="480" rx="26" fill="#9fb7d9"/>';
const LOGO_A = '<rect width="200" height="80" rx="10" fill="#f4f1e8"/><circle cx="40" cy="40" r="26" fill="#c8102e"/><rect x="80" y="26" width="100" height="28" fill="#1d2a6b"/>';
const LOGO_B = '<circle cx="50" cy="50" r="46" fill="#1b8a3a"/><rect x="30" y="40" width="40" height="20" fill="#ffffff"/>';
const HEADLINE = '<text x="60" y="380" font-family="Helvetica, Arial, sans-serif" font-size="72" font-weight="700" fill="#ffffff">Easy EMI</text>';
const FINE = '<text x="60" y="1150" font-family="Helvetica, Arial, sans-serif" font-size="18" fill="#e8f4f4">T&amp;C apply. EMI on select bank cards. Offer valid till 31 Oct 2026.</text>';
const sourcePng = () => svg(GRADIENT + PHONE + `<g transform="translate(60 60)">${LOGO_A}</g><g transform="translate(300 50)">${LOGO_B}</g>` + HEADLINE + FINE);
const cleanPng = () => svg(GRADIENT + PHONE);
const logoAPng = () => svg(LOGO_A, 200, 80);
const logoBPng = () => svg(LOGO_B, 100, 100);
const pe = (n: number) => `pe-${String(n).padStart(10, '0')}`;
const elementInputs = (over: Record<string, Partial<ProtectedElement>> = {}) => [
  { id: pe(1), kind: 'logo', label: 'Bank A logo', box: { x: 60, y: 60, width: 200, height: 80, rotation: 0 }, zIndex: 0, representation: 'raster', mask: { mode: 'difference', threshold: 24 }, review: { status: 'approved' } },
  { id: pe(2), kind: 'logo', label: 'Bank B logo', box: { x: 300, y: 50, width: 100, height: 100, rotation: 0 }, zIndex: 1, representation: 'raster', mask: { mode: 'difference', threshold: 24 }, review: { status: 'approved' } },
  { id: pe(3), kind: 'text', label: 'Headline', box: { x: 50, y: 310, width: 360, height: 90, rotation: 0 }, zIndex: 2, representation: 'native-text', mask: { mode: 'difference', threshold: 24 }, review: { status: 'approved' },
    text: { value: 'Easy EMI', fontFamily: 'Inter', fallbackFamily: 'Inter', fontSize: 72, fontWeight: 700, lineHeight: 1.1, letterSpacing: 0, align: 'left', verticalAlign: 'top', color: '#ffffff' } },
  { id: pe(4), kind: 'legal', label: 'Fine print', box: { x: 50, y: 1128, width: 720, height: 32, rotation: 0 }, zIndex: 3, representation: 'raster', mask: { mode: 'difference', threshold: 24 }, review: { status: 'approved' } },
].map(e => ({ ...e, ...over[e.id] }));

/** fal faked: Seedream returns the uploaded image as its base plus the phone cut out of it (full canvas), or refuses it. */
function fakeFal(mode: { refuse?: (bytes: Buffer) => boolean | Promise<boolean>; statusFailures?: number; gate?: Promise<void> } = {}) {
  const uploads = new Map<string, Buffer>(), results = new Map<string, unknown>(), files = new Map<string, Buffer>();
  const calls = { submits: [] as { endpoint: string; input: Record<string, unknown>; imageSha: string }[], status: 0 };
  let statusFailures = mode.statusFailures ?? 0;
  const transport: FalTransport = {
    upload: async bytes => { const url = `https://v3b.fal.media/files/test/${uploads.size}.png`; uploads.set(url, bytes); return url; },
    submit: async (endpoint, input) => {
      const bytes = uploads.get(String(input.image_url))!, id = `req-${calls.submits.length}`;
      calls.submits.push({ endpoint, input, imageSha: sha(bytes) });
      if (await mode.refuse?.(bytes)) { results.set(id, 'refuse'); return { requestId: id }; }
      const { width = W, height = H } = await sharp(bytes).metadata(), raw = await sharp(bytes).ensureAlpha().raw().toBuffer();
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (!(x >= 520 && x < 780 && y >= 420 && y < 940)) raw[(y * width + x) * 4 + 3] = 0;
      files.set(`${id}-0`, await sharp(bytes).png().toBuffer()); files.set(`${id}-1`, await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer());
      results.set(id, { layers: [{ image: { url: `https://v3b.fal.media/files/test/${id}-0.png` }, z_index: 0, name: 'Background' }, { image: { url: `https://v3b.fal.media/files/test/${id}-1.png` }, z_index: 1, name: 'Phone' }] });
      return { requestId: id };
    },
    status: async () => { calls.status++; await mode.gate; if (statusFailures > 0) { statusFailures--; throw new Error('fal status unreachable'); } return 'COMPLETED'; },
    result: async (_endpoint, id) => {
      if (results.get(id) !== 'refuse') return results.get(id);
      const detail = { msg: 'The content could not be processed because it contained material flagged by a content checker.', type: 'content_policy_violation', loc: 'body.image_url', reason: 'partner_validation_failed' };
      throw Object.assign(new ProviderError('PROVIDER_REJECTED', 'The provider rejected the image or request.', false, 422), { providerDetail: { status: 422, billableUnits: '0', requestId: id, messages: [detail] } });
    },
    cancel: async () => undefined,
    download: async url => { const key = url.split('/').pop()!.replace('.png', ''); const b = files.get(key) ?? uploads.get(url); if (!b) throw new Error(`unknown ${url}`); return b; },
  };
  return { transport, calls };
}

async function setup(root = mkdtempSync(join(tmpdir(), 'protected-templates-')), fal = fakeFal()) {
  const planner = vi.fn(async () => { throw new Error('The planner must never be called by a protected run.'); });
  const reconstructor = { model: 'never', reconstruct: vi.fn(async () => { throw new Error('No image edit may be called by a protected run.'); }) };
  const deps = (): RunnerDeps => ({ planner, transport: () => fal.transport, backgroundReconstructor: reconstructor, sleep: async () => undefined, pollIntervalMs: 1 });
  const runsDir = join(root, 'runs'), protectedDir = join(root, 'protected');
  const server = express().use('/x', createLayerizeRouter({ runsDir, protectedDir, deps, templatesDir: join(root, 'tpl'), executionsDir: join(root, 'exe'), imageTemplatesDir: join(root, 'img') })).listen(0, '127.0.0.1');
  await new Promise(done => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`;
  const call = async (path: string, init?: RequestInit) => { const r = await fetch(`${base}${path}`, init); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const post = (path: string, body: unknown) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const form = (path: string, file: Buffer, fields: Record<string, string> = {}, name = 'image.png') => {
    const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); f.append('image', new Blob([new Uint8Array(file)], { type: 'image/png' }), name);
    return call(path, { method: 'POST', body: f });
  };
  const view = async (id: string) => (await call(`/protected-templates/${id}`)).body as ProtectedTemplateView;
  const settle = async (id: string) => { for (let i = 0; i < 400; i++) { const v = await view(id); if (v.latestRun && !v.latestRun.active && ['done', 'failed'].includes(v.latestRun.stage) && (v.latestRun.stage === 'failed' || v.reconstruction)) return v; await new Promise(r => setTimeout(r, 25)); } throw new Error('run did not settle'); };
  return { root, runsDir, protectedDir, server, base, call, post, form, view, settle, planner, reconstructor, fal, close: () => new Promise(done => server.close(done)) };
}
/** Source, elements, original logo files, confirmed regions, the clean base approved: ready for Seedream. */
async function prepared(s: Awaited<ReturnType<typeof setup>>) {
  const created = await s.form('/protected-templates', await sourcePng(), { name: 'Pine Labs EMI test' }, 'emi.png');
  expect(created.status).toBe(201);
  const id = created.body.id as string;
  let v = (await s.call(`/protected-templates/${id}/elements`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: created.body.revision, elements: elementInputs() }) })).body as ProtectedTemplateView;
  for (const [n, png, file] of [[1, await logoAPng(), 'bank-a.png'], [2, await logoBPng(), 'bank-b.png']] as const) v = (await s.form(`/protected-templates/${id}/elements/${pe(n)}/asset`, png, { expectedRevision: String(v.revision) }, file)).body;
  v = (await s.post(`/protected-templates/${id}/confirm-regions`, { expectedRevision: v.revision })).body;
  v = (await s.form(`/protected-templates/${id}/base`, await cleanPng(), { expectedRevision: String(v.revision), method: 'clean-upload' }, 'clean.png')).body;
  v = (await s.post(`/protected-templates/${id}/base/approve`, { expectedRevision: v.revision })).body;
  return { id, v };
}

describe('protected template, clean base + original logo files + native text (Seedream only)', () => {
  it('runs end to end: one Seedream request, no planner or image edit, layers restored, approved, and intact after a restart', async () => {
    const s = await setup();
    try {
      const { id, v } = await prepared(s);
      expect(v.status).toBe('ready');
      expect(v.coordinateSystem).toBe('source-pixels');
      // The original logo files are stored byte for byte; every element has its preserved pixels too.
      const logo = v.elements.find(e => e.id === pe(1))!;
      expect(logo).toMatchObject({ representation: 'source-asset', sourceAsset: { sha256: sha(await logoAPng()), width: 200, height: 80, originalName: 'bank-a.png' }, normalized: { x: 0.066667, y: 0.05, width: 0.222222, height: 0.066667 } });
      expect(readFileSync(join(s.protectedDir, id, logo.sourceAsset!.file)).equals(await logoAPng())).toBe(true);
      expect(v.elements.every(e => e.raster?.basisSha256 === v.base!.sha256)).toBe(true);
      expect(v.base).toMatchObject({ method: 'clean-upload', reliability: 'reliable', outsideMeanDiff: 0 });
      expect(v.base!.checks.every(c => c.differsFromSource)).toBe(true);
      const pre = (await s.call(`/protected-templates/${id}/preflight`)).body;
      expect(pre.ok).toBe(true);
      expect(pre.estimate).toMatchObject({ endpoint: SEEDREAM_ENDPOINT, maxLayers: 17, perLayerUsd: 0.03375 });

      const started = await s.post(`/protected-templates/${id}/decompose`, { expectedRevision: v.revision, idempotencyKey: 'decompose-key-0001' });
      expect(started.status).toBe(202);
      const done = await s.settle(id);
      expect(done.status).toBe('review');
      expect(done.latestRun).toMatchObject({ stage: 'done', usable: true, editorLayers: 2, current: true });
      // Seedream only, once, with the provider's safety checker on and no prompt (automatic mode): the planner and the
      // OpenAI image edit were never called.
      expect(s.fal.calls.submits.map(c => c.endpoint)).toEqual([SEEDREAM_ENDPOINT]);
      expect(s.fal.calls.submits[0].input).toMatchObject({ enable_safety_checker: true, image_size: 'auto' });
      expect(s.fal.calls.submits[0].input).not.toHaveProperty('prompt');
      expect(s.planner).not.toHaveBeenCalled(); expect(s.reconstructor.reconstruct).not.toHaveBeenCalled();
      // What Seedream got is the clean base's pixels: no logo, no text.
      const sent = [...readdirSync(s.runsDir)].map(r => readRun(join(s.runsDir, r)))[0];
      expect(sent).toMatchObject({ promptSource: { mode: 'protected', templateId: id, baseSha256: v.base!.sha256 }, origin: { kind: 'protected-template', generationId: id } });
      expect(await pixelsSha(readFileSync(join(s.runsDir, sent.id, sent.input.file)))).toBe(await pixelsSha(await cleanPng()));

      // A repeated request with the same key is the same run, and nothing is sent again.
      const again = await s.post(`/protected-templates/${id}/decompose`, { expectedRevision: done.revision, idempotencyKey: 'decompose-key-0001' });
      expect(again.status).toBe(200); expect(again.body.existing).toBe(true); expect(s.fal.calls.submits).toHaveLength(1);
      // A new decomposition of the same base is another paid request: it needs an explicit confirmation.
      expect((await s.post(`/protected-templates/${id}/decompose`, { expectedRevision: done.revision, idempotencyKey: 'decompose-key-0002' })).body.error.code).toBe('REPEAT_REQUIRES_CONFIRMATION');
      // No other model, ever: not Qwen, not the plan-based retry.
      expect((await s.post(`/runs/${sent.id}/qwen`, {})).status).toBe(409);
      expect((await s.post(`/runs/${sent.id}/retry`, {})).status).toBe(409);

      const recon = done.reconstruction!;
      expect(recon).toMatchObject({ runId: sent.id, width: W, height: H, layers: 2, blockers: [] });
      // The fake Seedream reproduced its base exactly, so the reconstruction differs from the source only inside the
      // protected regions, where the restored visuals are: raster pixels exact, logo files resampled into their boxes.
      expect(recon.metrics.outsideProtected.meanAbsDiff).toBeLessThan(0.5);
      expect(recon.metrics.protected.find(p => p.elementId === pe(4))!.opaqueExactPercent).toBe(100);
      expect(recon.duplicates.every(d => !d.suspected)).toBe(true);
      expect(recon.warnings.some(w => w.startsWith('Headline: shown here with its preserved pixels'))).toBe(true);

      const diagnostics = await readRunDiagnostics(join(s.runsDir, sent.id));
      expect(diagnostics.stages.find(st => st.id === 'planner')).toMatchObject({ status: 'Skipped', calls: [] });
      expect(diagnostics.stages.find(st => st.id === 'planner')!.result).toMatch(/^Not used: a protected template never calls the planner/);
      expect(diagnostics.stages.find(st => st.id === 'seedream')!.calls).toHaveLength(1);
      expect(diagnostics.stages.filter(st => st.calls.some(c => c.kind !== 'seedream')).map(st => st.id)).toEqual([]);

      expect((await s.post(`/protected-templates/${id}/approve`, { expectedRevision: done.revision, runId: sent.id })).body.error.code).toBe('ACKNOWLEDGEMENT_REQUIRED');
      const approved = (await s.post(`/protected-templates/${id}/approve`, { expectedRevision: done.revision, runId: sent.id, acknowledge: ['warnings'] })).body as ProtectedTemplateView;
      expect(approved.status).toBe('approved');
      expect(approved.approval).toMatchObject({ runId: sent.id, baseSha256: v.base!.sha256, reconstructionSha256: recon.sha256, acknowledged: ['warnings'] });
      await s.close();

      // A restarted server reads the same template: every coordinate, asset reference and approval as saved.
      const restarted = await setup(s.root);
      try {
        const reopened = await restarted.view(id);
        expect(reopened.status).toBe('approved');
        expect(reopened.elements).toEqual(approved.elements);
        expect(reopened.approval).toEqual(approved.approval);
        const file = await fetch(`${restarted.base}/protected-templates/${id}/files/${logo.sourceAsset!.file}`);
        expect(Buffer.from(await file.arrayBuffer()).equals(await logoAPng())).toBe(true);
        expect((await restarted.call(`/protected-templates/${id}/files/template.json`)).status).toBe(404);
        expect((await restarted.call(`/protected-templates/${id}/files/..%2Ftemplate.json`)).status).toBe(404);
      } finally { await restarted.close(); }
    } finally { await s.close().catch(() => undefined); }
  }, 60_000);

  it('records a provider refusal honestly, never sends the same base again, and accepts a changed base', async () => {
    // The provider's content check refuses the clean base (by its pixels, whatever its encoding), as on 2026-10-19.
    const clean = await pixelsSha(await cleanPng());
    const s = await setup(undefined, fakeFal({ refuse: async bytes => await pixelsSha(bytes) === clean }));
    try {
      const { id, v } = await prepared(s);
      expect((await s.post(`/protected-templates/${id}/decompose`, { expectedRevision: v.revision, idempotencyKey: 'refused-key-0001' })).status).toBe(202);
      const failed = await s.settle(id);
      expect(failed.status).toBe('failed');
      expect(failed.latestRun).toMatchObject({ stage: 'failed', usable: false, error: { code: 'PROVIDER_DECOMPOSITION_REJECTED', provider: { status: 422, billableUnits: '0' } }, rejection: { category: 'partner-content', reason: 'partner_validation_failed', billableUnits: '0' } });
      const blocked = await s.post(`/protected-templates/${id}/decompose`, { expectedRevision: failed.revision, idempotencyKey: 'refused-key-0002', confirmRepeat: true });
      expect(blocked.status).toBe(409); expect(blocked.body.error.code).toBe('REPEAT_REQUIRES_CHANGE');
      expect(s.fal.calls.submits).toHaveLength(1);
      // A different base (the regions filled locally) is a new image: it may be sent, once the administrator accepts the estimate.
      let next = (await s.post(`/protected-templates/${id}/base/local-fill`, { expectedRevision: failed.revision })).body as ProtectedTemplateView;
      expect(next.base).toMatchObject({ method: 'local-fill', reliability: 'uncertain' });
      expect((await s.post(`/protected-templates/${id}/base/approve`, { expectedRevision: next.revision })).body.error.code).toBe('ACKNOWLEDGEMENT_REQUIRED');
      next = (await s.post(`/protected-templates/${id}/base/approve`, { expectedRevision: next.revision, acknowledgeUncertain: true })).body;
      expect((await s.post(`/protected-templates/${id}/decompose`, { expectedRevision: next.revision, idempotencyKey: 'refused-key-0003' })).status).toBe(202);
      expect((await s.settle(id)).status).toBe('review');
      expect(s.fal.calls.submits.map(c => c.endpoint)).toEqual([SEEDREAM_ENDPOINT, SEEDREAM_ENDPOINT]);
      expect(s.planner).not.toHaveBeenCalled();
    } finally { await s.close(); }
  }, 60_000);

  it('queues a second template\'s decomposition behind the first, sends each once, and refuses a second confirmation while queued', async () => {
    let release!: () => void;
    const s = await setup(undefined, fakeFal({ gate: new Promise<void>(done => { release = done; }) }));
    try {
      const a = await prepared(s), b = await prepared(s);
      expect((await s.post(`/protected-templates/${a.id}/decompose`, { expectedRevision: a.v.revision, idempotencyKey: 'queue-key-a001' })).status).toBe(202);
      expect((await s.post(`/protected-templates/${b.id}/decompose`, { expectedRevision: b.v.revision, idempotencyKey: 'queue-key-b001' })).status).toBe(202);
      const waiting = await s.view(b.id);
      expect(waiting).toMatchObject({ status: 'decomposing', latestRun: { stage: 'uploaded', active: true } });
      const again = await s.post(`/protected-templates/${b.id}/decompose`, { expectedRevision: waiting.revision, idempotencyKey: 'queue-key-b002', confirmRepeat: true });
      expect(again.status).toBe(409); expect(again.body.error.code).toBe('BUSY');
      expect(s.fal.calls.submits).toHaveLength(1);
      release();
      expect((await s.settle(a.id)).status).toBe('review');
      expect((await s.settle(b.id)).status).toBe('review');
      expect(s.fal.calls.submits).toHaveLength(2);
      expect(new Set(s.fal.calls.submits.map(c => c.imageSha)).size).toBe(1); // the same clean base, sent once per template
    } finally { await s.close(); }
  }, 60_000);

  it('resumes an interrupted run from its saved request instead of sending the base again', async () => {
    const s = await setup(undefined, fakeFal({ statusFailures: 3 }));
    try {
      const { id, v } = await prepared(s);
      await s.post(`/protected-templates/${id}/decompose`, { expectedRevision: v.revision, idempotencyKey: 'resume-key-0001' });
      const stopped = await s.settle(id);
      expect(stopped.latestRun).toMatchObject({ stage: 'failed', error: { code: 'FAL_STATUS_FAILED' }, requestId: 'req-0' });
      expect((await s.post(`/protected-templates/${id}/decompose`, { expectedRevision: stopped.revision, idempotencyKey: 'resume-key-0002', confirmRepeat: true })).body.error.code).toBe('RESUME_AVAILABLE');
      expect((await s.post(`/protected-templates/${id}/runs/${stopped.latestRun!.runId}/resume`, {})).status).toBe(202);
      expect((await s.settle(id)).status).toBe('review');
      expect(s.fal.calls.submits).toHaveLength(1);
    } finally { await s.close(); }
  }, 60_000);

  it('refuses stale writes, malformed elements and steps out of order, without changing anything', async () => {
    const s = await setup();
    try {
      const created = (await s.form('/protected-templates', await sourcePng())).body as ProtectedTemplateView;
      const put = (revision: number, elements: unknown) => s.call(`/protected-templates/${created.id}/elements`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: revision, elements }) });
      expect((await put(created.revision, [{ ...elementInputs()[0], box: { x: 1, y: 1, width: -5, height: 3, rotation: 0 } }])).body.error.code).toBe('INVALID_ELEMENTS');
      expect((await put(created.revision, [{ ...elementInputs()[0], id: '../x' }])).body.error.code).toBe('INVALID_ELEMENTS');
      // A server-owned field in the request (a raster or asset reference) is ignored, never stored.
      const saved = (await put(created.revision, [{ ...elementInputs()[0], raster: { file: '../../etc/passwd' }, sourceAsset: { file: 'x.png' } }])).body as ProtectedTemplateView;
      expect(saved.elements[0].raster).toBeUndefined(); expect(saved.elements[0].sourceAsset).toBeUndefined();
      expect((await put(created.revision, elementInputs())).status).toBe(409);
      // The same original file uploaded again from a stale tab is refused, and the file the record uses is kept.
      const withFile = (await s.form(`/protected-templates/${created.id}/elements/${pe(1)}/asset`, await logoAPng(), { expectedRevision: String(saved.revision) })).body as ProtectedTemplateView;
      expect((await s.form(`/protected-templates/${created.id}/elements/${pe(1)}/asset`, await logoAPng(), { expectedRevision: String(saved.revision) })).status).toBe(409);
      expect(existsSync(join(s.protectedDir, created.id, withFile.elements[0].sourceAsset!.file))).toBe(true);
      const current = withFile;
      expect((await s.post(`/protected-templates/${created.id}/base/local-fill`, { expectedRevision: current.revision })).body.error.code).toBe('REGIONS_NOT_CONFIRMED');
      const unreviewed = (await put(current.revision, elementInputs({ [pe(1)]: { review: { status: 'needs-review' } } }))).body as ProtectedTemplateView;
      expect((await s.post(`/protected-templates/${created.id}/confirm-regions`, { expectedRevision: unreviewed.revision })).body.error.code).toBe('REVIEW_REQUIRED');
      const offCanvas = (await put(unreviewed.revision, elementInputs({ [pe(1)]: { box: { x: 880, y: 60, width: 200, height: 80, rotation: 0 } } }))).body as ProtectedTemplateView;
      expect(offCanvas.problems.some(p => p.code === 'OFF_CANVAS')).toBe(true);
      expect((await s.post(`/protected-templates/${created.id}/confirm-regions`, { expectedRevision: offCanvas.revision })).body.error.code).toBe('REGIONS_INVALID');
      expect((await s.form(`/protected-templates/${created.id}/base`, await svg(GRADIENT, 900, 900), { expectedRevision: String(offCanvas.revision) })).body.error.code).toBe('REGIONS_NOT_CONFIRMED');
      expect((await s.post(`/protected-templates/${created.id}/decompose`, { expectedRevision: offCanvas.revision, idempotencyKey: 'early-key-0001' })).body.error.code).toBe('PREFLIGHT_FAILED');
      expect(s.fal.calls.submits).toHaveLength(0);
      expect((await s.form('/protected-templates', Buffer.from('not an image'))).body.error.code).toBe('UNREADABLE_IMAGE');
    } finally { await s.close(); }
  }, 60_000);

  it('makes the base stale when a region moves, and refuses a clean base of another shape', async () => {
    const s = await setup();
    try {
      const { id, v } = await prepared(s);
      expect((await s.form(`/protected-templates/${id}/base`, await svg(GRADIENT, 900, 900), { expectedRevision: String(v.revision) })).body.error.code).toBe('BASE_ASPECT_MISMATCH');
      const moved = (await s.call(`/protected-templates/${id}/elements`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: v.revision, elements: elementInputs({ [pe(4)]: { box: { x: 50, y: 1120, width: 720, height: 40, rotation: 0 } } }) }) })).body as ProtectedTemplateView;
      expect(moved.status).toBe('annotating');
      expect(moved.stale.base).toBe(true);
      expect(moved.problems.map(p => p.code)).toEqual(expect.arrayContaining(['REGIONS_CHANGED', 'BASE_STALE']));
      expect((await s.call(`/protected-templates/${id}/preflight`)).body.ok).toBe(false);
      // A clean base that still shows a logo is caught before anything is sent.
      const confirmed = (await s.post(`/protected-templates/${id}/confirm-regions`, { expectedRevision: moved.revision })).body as ProtectedTemplateView;
      const withLogo = (await s.form(`/protected-templates/${id}/base`, await svg(GRADIENT + PHONE + `<g transform="translate(60 60)">${LOGO_A}</g>`), { expectedRevision: String(confirmed.revision) })).body as ProtectedTemplateView;
      expect(withLogo.base).toMatchObject({ reliability: 'uncertain' });
      expect(withLogo.base!.checks.find(c => c.elementId === pe(1))!.differsFromSource).toBe(false);
      expect(existsSync(join(s.protectedDir, id, v.base!.file))).toBe(false);
    } finally { await s.close(); }
  }, 60_000);
});

