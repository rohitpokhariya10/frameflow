import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import type { CreativeInstance, MasterSnapshot } from '@frameflow/shared';
import { createLayerizeRouter } from '../../layerizeRouter.js';
import type { FalTransport } from '../../providers/falClient.js';
import type { RunnerDeps } from '../../layerizeExperiment.js';
import { fakeRecognizer } from '../../../textRecognition/recognizer.js';
import { MASTER_TILES, MASTER_WORDS, masterPosterPng, newLogoPng } from './masterPoster.fixture.js';
import type { MasterRescanResult, MasterView } from './service.js';

const sha = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest('hex');
/** fal faked: Seedream returns the uploaded image as one background layer and counts every submit. */
function fakeFal() {
  const uploads = new Map<string, Buffer>(), files = new Map<string, Buffer>(), calls = { submits: 0 };
  const transport: FalTransport = {
    upload: async bytes => { const url = `https://v3b.fal.media/files/m/${uploads.size}.png`; uploads.set(url, bytes); return url; },
    submit: async (_endpoint, input) => { const id = `req-${++calls.submits}`; files.set(id, await sharp(uploads.get(String(input.image_url))!).png().toBuffer()); return { requestId: id }; },
    status: async () => 'COMPLETED',
    result: async (_endpoint, id) => ({ layers: [{ image: { url: `https://v3b.fal.media/files/m/${id}.png` }, z_index: 0, name: 'Background' }] }),
    cancel: async () => undefined,
    download: async url => files.get(url.split('/').pop()!.replace('.png', ''))!,
  };
  return { transport, calls };
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'master-templates-')), fal = fakeFal(), recognizer = fakeRecognizer(MASTER_WORDS);
  const planner = vi.fn(async () => { throw new Error('never'); });
  const deps = (): RunnerDeps => ({ planner, transport: () => fal.transport, sleep: async () => undefined, pollIntervalMs: 1 });
  const runsDir = join(root, 'runs'), protectedDir = join(root, 'protected');
  const server = express().use('/x', createLayerizeRouter({ runsDir, protectedDir, deps, templatesDir: join(root, 'tpl'), executionsDir: join(root, 'exe'), imageTemplatesDir: join(root, 'img'), masterRecognizer: () => recognizer })).listen(0, '127.0.0.1');
  await new Promise(done => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`;
  const call = async <T = Record<string, unknown>>(path: string, init?: RequestInit) => { const r = await fetch(`${base}${path}`, init); return { status: r.status, body: await r.json().catch(() => ({})) as T }; };
  const send = <T = MasterView>(method: string, path: string, body: unknown) => call<T>(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const form = <T = MasterView>(path: string, file: Buffer, fields: Record<string, string> = {}, name = 'poster.png') => {
    const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); f.append('image', new Blob([new Uint8Array(file)], { type: 'image/png' }), name);
    return call<T>(path, { method: 'POST', body: f });
  };
  const view = async (id: string) => (await call<MasterView>(`/master-templates/${id}`)).body;
  const scanned = async (id: string) => { for (let i = 0; i < 400; i++) { const v = await view(id); if (v.stage !== 'scanning') return v; await new Promise(r => setTimeout(r, 25)); } throw new Error('scan did not finish'); };
  return { root, protectedDir, fal, recognizer, planner, call, send, form, view, scanned, close: () => new Promise(done => server.close(done)) };
}

describe('Text & Graphics master templates', { timeout: 120_000 }, () => {
  it('scans once, reviews, prepares a clean background, publishes, and makes creatives with no OCR, decomposition or AI call', async () => {
    const s = await setup();
    try {
      const created = await s.form('/master-templates', await masterPosterPng(), { name: 'Super SALE' });
      expect(created.status).toBe(201);
      const id = created.body.template.id;
      let v = await s.scanned(id);
      expect(v.stage).toBe('review');
      const a = v.template.textAnalysis!;
      // Every word on its own; the headline's three words in one group; tiles, the brand mark and the pill found.
      const word = (t: string) => a.words.find(w => w.text === t)!;
      for (const t of ['Super', 'SALE', 'today.', 'Up', 'to', '50%', 'off', 'On', 'selected', 'cards.', 'T&Cs', 'apply']) expect(word(t), t).toBeTruthy();
      expect(new Set(['Super', 'SALE', 'today.'].map(t => word(t).id)).size).toBe(3);
      expect(word('Super').groupId).toBe(word('SALE').groupId);
      expect(a.groups.find(g => g.id === word('SALE').groupId)!.category).toBe('headline');
      expect(a.groups.find(g => g.id === word('T&Cs').groupId)!.category).toBe('legal');
      expect(a.logoSlots.filter(l => l.category === 'partner-logo')).toHaveLength(MASTER_TILES.length);
      expect(a.logoSlots.filter(l => l.category === 'brand-logo').map(l => l.label)).toEqual([expect.stringContaining('ACME')]);
      expect(a.words.some(w => w.text === 'ACME')).toBe(false); // the brand mark is a logo, not text
      expect(a.plates).toHaveLength(1);
      expect(a.plates![0].groupId).toBe(word('Up').groupId);
      // Coordinates: source pixels, tight around the ink inside the recognizer's box.
      const sale = word('SALE'), given = MASTER_WORDS.find(w => w.text === 'SALE')!.box;
      expect(sale.box.x).toBeGreaterThanOrEqual(given.x); expect(sale.box.x + sale.box.width).toBeLessThanOrEqual(given.x + given.width + 0.5);
      expect(sale.style.originDx).toBeDefined(); expect(sale.style.baseline).toBeGreaterThan(0);
      // Fonts by the letters' own weight and slant: the italic serif stays italic, the bold copy bold, the T&C line regular.
      expect(word('Super').style).toMatchObject({ fontFamily: 'Lora', fontStyle: 'italic' });
      expect(sale.style.fontWeight).toBeGreaterThanOrEqual(600); expect(word('cards.').style.fontWeight).toBeGreaterThanOrEqual(600);
      expect(word('T&Cs').style).toMatchObject({ fontWeight: 400, fontStyle: 'normal' });
      const scans = v.master.scan!.recognizerCalls;
      expect(scans).toBe(s.recognizer.calls.length);

      // The scan is saved per source: asking again reads nothing.
      const again = await s.send<{ started: boolean }>('POST', `/master-templates/${id}/scan`, {});
      expect(again.status).toBe(200); expect(again.body.started).toBe(false);
      expect(s.recognizer.calls.length).toBe(scans);

      // Review: a correction, a word added by hand, a logo drawn by hand, the uncertain word left for a bulk approval.
      const words = a.words.map(w => w.text === 'cards.' ? { ...w, text: 'cards!' } : w);
      const added = { ...word('On'), id: 'pw-aaaaaaaaaa', text: 'Hello', box: { x: 600, y: 600, width: 120, height: 50, rotation: 0 }, groupId: 'pg-aaaaaaaaaa', lineId: 'pn-aaaaaaaaaa', elementId: 'new', origin: 'admin' as const, review: { status: 'approved' as const } };
      const groups = [...a.groups, { id: 'pg-aaaaaaaaaa', elementId: 'new', label: 'Hello', lines: [{ id: 'pn-aaaaaaaaaa', wordIds: [added.id] }], align: 'left' as const, category: 'cta' as const }];
      const slot = { ...a.logoSlots[0], id: 'pl-aaaaaaaaaa', label: 'Added badge', elementId: 'new', box: { x: 760, y: 700, width: 120, height: 80, rotation: 0 }, category: 'badge' as const, review: { status: 'approved' as const } };
      const reviewed = await s.send('PUT', `/master-templates/${id}/review`, { expectedRevision: v.template.revision, expectedAnalysisRevision: a.revision, words: [...words, added], groups, logoSlots: [...a.logoSlots, slot], plates: a.plates });
      expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
      v = reviewed.body;
      expect(v.template.textAnalysis!.words.find(w => w.text === 'cards!')).toBeTruthy();
      expect(v.template.textAnalysis!.logoSlots.find(l => l.id === 'pl-aaaaaaaaaa')!.original.file).toMatch(/^logo-pl-aaaaaaaaaa-/);
      expect(v.template.textAnalysis!.groups.find(g => g.id === 'pg-aaaaaaaaaa')!.category).toBe('cta');
      // Prepare is refused until everything is reviewed; "approve all confident" leaves the uncertain word.
      expect((await s.send('POST', `/master-templates/${id}/prepare`, { expectedRevision: v.template.revision })).status).toBe(409);
      v = (await s.send('POST', `/master-templates/${id}/review/approve-all`, { expectedRevision: v.template.revision, includeUncertain: false })).body;
      expect(v.review.pending).toBe(1); expect(v.review.uncertain).toBe(1);
      v = (await s.send('POST', `/master-templates/${id}/review/approve-all`, { expectedRevision: v.template.revision, includeUncertain: true })).body;
      expect(v.review.pending).toBe(0);

      // The clean background: no word's ink left, the pattern continued, an estimate that must be acknowledged.
      const prepared = await s.send('POST', `/master-templates/${id}/prepare`, { expectedRevision: v.template.revision });
      expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
      v = prepared.body;
      expect(v.template.base!.method).toBe('local-fill');
      expect(v.master.cleanup!.areas.length).toBeGreaterThan(0);
      const clean = await sharp(readFileSync(join(s.protectedDir, id, v.template.base!.file))).raw().toBuffer({ resolveWithObject: true });
      let teal = 0, n = 0;
      for (let y = sale.box.y; y < sale.box.y + sale.box.height; y += 3) for (let x = sale.box.x; x < sale.box.x + sale.box.width; x += 3) {
        const i = (Math.round(y) * clean.info.width + Math.round(x)) * clean.info.channels; n++;
        if (Math.abs(clean.data[i] - 3) < 40 && Math.abs(clean.data[i + 1] - 89) < 40 && Math.abs(clean.data[i + 2] - 90) < 40) teal++;
      }
      expect(teal / n).toBeLessThan(0.005);
      expect((await s.send('POST', `/master-templates/${id}/background/approve`, { expectedRevision: v.template.revision })).status).toBe(422);
      v = (await s.send('POST', `/master-templates/${id}/background/approve`, { expectedRevision: v.template.revision, acknowledgeEstimate: true })).body;
      expect(v.background.approved).toBe(true);
      v = (await s.send('POST', `/master-templates/${id}/publish`, { expectedRevision: v.template.revision })).body;
      expect(v.stage).toBe('ready'); expect(v.latestRevision!.revision).toBe(1);
      const snapshot = (await s.call<MasterSnapshot>(`/master-templates/${id}/revisions/1`)).body;
      expect(snapshot.words.length).toBeGreaterThanOrEqual(13); expect(snapshot.layers).toEqual([]);
      const masterJson = readFileSync(join(s.protectedDir, id, 'template.json')), snapshotFile = readFileSync(join(s.protectedDir, id, 'master-r1.json'));

      // Reuse: a creative from the saved files only.
      const ocrBefore = s.recognizer.calls.length, falBefore = s.fal.calls.submits;
      const made = await s.send<CreativeInstance>('POST', `/master-templates/${id}/creatives`, { name: 'Black text' });
      expect(made.status).toBe(201);
      let c = made.body;
      expect(c.texts.filter(t => t.wordId).length).toBe(snapshot.words.filter(w => w.review.status !== 'rejected').length);
      expect(new Set(c.texts.map(t => t.id)).size).toBe(c.texts.length);
      expect(c.images).toHaveLength(snapshot.logoSlots.length); expect(c.shapes).toHaveLength(1);
      const saleText = c.texts.find(t => t.text === 'SALE')!;
      expect(saleText.x).toBeCloseTo(sale.box.x + (sale.style.originDx ?? 0), 5); expect(saleText.baselineY).toBeCloseTo(sale.box.y + sale.style.baseline, 5);
      // Teal text to black, a bank logo replaced, a word moved: saved to the creative only.
      const upload = await s.form<{ asset: CreativeInstance['images'][number]['asset'] }>(`/master-templates/${id}/creatives/${c.id}/assets`, await newLogoPng(), {}, 'new-bank.png');
      expect(upload.status).toBe(201);
      const tile = c.images.find(i => i.category === 'partner-logo')!, others = c.images.filter(i => i.id !== tile.id);
      const edited = { ...c, texts: c.texts.map(t => t.style.color === '#03595a' || t.style.color.startsWith('#03') ? { ...t, style: { ...t.style, color: '#000000' } } : t).map(t => t.text === 'today.' ? { ...t, x: t.x + 40 } : t),
        images: c.images.map(i => i.id === tile.id ? { ...i, asset: upload.body.asset } : i) };
      const saved = await s.send<CreativeInstance>('PUT', `/master-templates/${id}/creatives/${c.id}`, { expectedRevision: c.revision, creative: edited });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      c = saved.body;
      expect(c.revision).toBe(2);
      expect(c.texts.find(t => t.text === 'SALE')!.style.color).toBe('#000000');
      expect(c.images.find(i => i.id === tile.id)!.asset.kind).toBe('creative');
      expect(c.images.filter(i => i.id !== tile.id)).toEqual(others);
      // A stale write and a font without a file are refused.
      expect((await s.send('PUT', `/master-templates/${id}/creatives/${c.id}`, { expectedRevision: 1, creative: edited })).status).toBe(409);
      const badFont = { ...edited, texts: edited.texts.map((t, k) => k ? t : { ...t, style: { ...t.style, fontFamily: 'Comic Neue' } }) };
      expect((await s.send('PUT', `/master-templates/${id}/creatives/${c.id}`, { expectedRevision: c.revision, creative: badFont })).status).toBe(400);
      // Reopen: the same state; a second creative and a copy are independent.
      expect((await s.call<CreativeInstance>(`/master-templates/${id}/creatives/${c.id}`)).body).toEqual(c);
      const second = (await s.send<CreativeInstance>('POST', `/master-templates/${id}/creatives`, {})).body;
      expect(second.texts.find(t => t.text === 'SALE')!.style.color).not.toBe('#000000');
      const copy = (await s.send<CreativeInstance>('POST', `/master-templates/${id}/creatives/${c.id}/duplicate`, {})).body;
      expect(copy.images.find(i => i.id === tile.id)!.asset.file).not.toBe(c.images.find(i => i.id === tile.id)!.asset.file);
      expect((await s.call<{ creatives: unknown[] }>(`/master-templates/${id}/creatives`)).body.creatives).toHaveLength(3);
      // None of this read the poster, decomposed anything or touched the master.
      expect(s.recognizer.calls.length).toBe(ocrBefore);
      expect(s.fal.calls.submits).toBe(falBefore);
      expect(s.planner).not.toHaveBeenCalled();
      expect(sha(readFileSync(join(s.protectedDir, id, 'template.json')))).toBe(sha(masterJson));
      expect(sha(readFileSync(join(s.protectedDir, id, 'master-r1.json')))).toBe(sha(snapshotFile));

      // The optional decomposition: one Seedream request of the clean background, its layers in revision 2. Creatives of
      // revision 1 keep reading revision 1.
      v = await s.view(id);
      const run = await s.send<{ run: { id: string } }>('POST', `/protected-templates/${id}/decompose`, { expectedRevision: v.template.revision, idempotencyKey: 'master-test-key-1' });
      expect(run.status, JSON.stringify(run.body)).toBe(202);
      for (let i = 0; i < 400 && !(await s.view(id)).template.latestRun?.usable; i++) await new Promise(r => setTimeout(r, 25));
      expect(s.fal.calls.submits).toBe(falBefore + 1);
      v = await s.view(id);
      v = (await s.send('POST', `/master-templates/${id}/artwork`, { expectedRevision: v.template.revision, mode: 'seedream', runId: run.body.run.id })).body;
      expect(v.stage).toBe('changed');
      v = (await s.send('POST', `/master-templates/${id}/publish`, { expectedRevision: v.template.revision })).body;
      expect(v.latestRevision!.revision).toBe(2);
      const r2 = (await s.call<MasterSnapshot>(`/master-templates/${id}/revisions/2`)).body;
      expect(r2.layers).toHaveLength(1); expect(r2.decomposition!.runId).toBe(run.body.run.id);
      expect((await s.call<CreativeInstance>(`/master-templates/${id}/creatives/${c.id}`)).body.masterRevision).toBe(1);
      expect(s.recognizer.calls.length).toBe(ocrBefore);
    } finally { await s.close(); }
  });

  it('scans again into suggestions: nothing changes until chosen fonts are applied; creatives and saved versions never change', async () => {
    const s = await setup();
    try {
      const id = (await s.form('/master-templates', await masterPosterPng(), { name: 'Rescan' })).body.template.id;
      let v = await s.scanned(id);
      v = (await s.send('POST', `/master-templates/${id}/review/approve-all`, { expectedRevision: v.template.revision, includeUncertain: true })).body;
      v = (await s.send('POST', `/master-templates/${id}/prepare`, { expectedRevision: v.template.revision })).body;
      v = (await s.send('POST', `/master-templates/${id}/background/approve`, { expectedRevision: v.template.revision, acknowledgeEstimate: true })).body;
      v = (await s.send('POST', `/master-templates/${id}/publish`, { expectedRevision: v.template.revision })).body;
      const creative = (await s.send<CreativeInstance>('POST', `/master-templates/${id}/creatives`, {})).body;
      // The administrator's own choices: a font picked by hand, a word corrected by hand.
      let a = v.template.textAnalysis!;
      const words = a.words.map(w => w.text === 'SALE' ? { ...w, style: { ...w.style, fontFamily: 'Anton', fontWeight: 400 as const, fontMatch: 'admin' as const } } : w.text === 'cards.' ? { ...w, text: 'cards!' } : w);
      v = (await s.send('PUT', `/master-templates/${id}/review`, { expectedRevision: v.template.revision, expectedAnalysisRevision: a.revision, words, groups: a.groups, logoSlots: a.logoSlots, plates: a.plates })).body;
      a = v.template.textAnalysis!;
      const dir = join(s.protectedDir, id), bytes = (f: string) => readFileSync(join(dir, f));
      const creativeBytes = bytes(`creative-${creative.id}.json`), r1 = bytes('master-r1.json'), r1Logos = (JSON.parse(r1.toString('utf8')) as MasterSnapshot).logoSlots.map(l => l.original.file!);
      const rescanned = async () => { for (let i = 0; i < 400; i++) { const x = await s.view(id); if (x.master.rescan?.status !== 'running') return x; await new Promise(r => setTimeout(r, 25)); } throw new Error('rescan did not finish'); };
      const ocrBefore = s.recognizer.calls.length;

      // 1. Scan again: suggestions only; the analysis is untouched.
      const startedRescan = await s.send<{ started: boolean; master: MasterView }>('POST', `/master-templates/${id}/rescan`, {});
      expect(startedRescan.status).toBe(202);
      // Shown as running at once, so the page knows to wait for it.
      expect(startedRescan.body.master.master.rescan?.status).toBe('running');
      v = await rescanned();
      expect(v.master.rescan).toMatchObject({ status: 'done', basedOn: a.revision });
      expect(s.recognizer.calls.length).toBeGreaterThan(ocrBefore);
      expect(v.template.textAnalysis).toEqual(a);
      // 2. The suggestions: the hand-picked font is offered (marked as such); the corrected word's text is kept.
      const result = (await s.call<MasterRescanResult>(`/master-templates/${id}/rescan`)).body, sale = a.words.find(w => w.text === 'SALE')!;
      expect(result.changes.fonts.find(f => f.wordId === sale.id)).toMatchObject({ chosen: true, from: { fontFamily: 'Anton' } });
      expect(result.changes.text).toEqual([expect.objectContaining({ from: 'cards!', to: 'cards.' })]);
      // A stale view is refused; then 3. only SALE's font is applied.
      expect((await s.send('POST', `/master-templates/${id}/rescan/apply`, { expectedRevision: v.template.revision, expectedAnalysisRevision: a.revision - 1, mode: 'fonts', wordIds: [sale.id] })).status).toBe(409);
      const applied = await s.send('POST', `/master-templates/${id}/rescan/apply`, { expectedRevision: v.template.revision, expectedAnalysisRevision: a.revision, mode: 'fonts', wordIds: [sale.id] });
      expect(applied.status, JSON.stringify(applied.body)).toBe(200);
      v = applied.body;
      const after = v.template.textAnalysis!;
      expect(after.words.find(w => w.id === sale.id)!.style.fontFamily).not.toBe('Anton');
      expect(after.words.find(w => w.id === sale.id)!.style.fontWeight).toBeGreaterThanOrEqual(600);
      expect(after.words.find(w => w.text === 'cards!')).toBeTruthy();
      expect(after.words.filter(w => w.id !== sale.id)).toEqual(a.words.filter(w => w.id !== sale.id));
      expect(after.logoSlots).toEqual(a.logoSlots);
      expect(v.master.rescan).toBeUndefined(); expect(v.stage).toBe('changed');
      expect(readdirSync(dir).filter(f => f.startsWith('rescan-'))).toEqual([]);
      // Creatives and the saved version: byte for byte as they were.
      expect(bytes(`creative-${creative.id}.json`).equals(creativeBytes)).toBe(true);
      expect(bytes('master-r1.json').equals(r1)).toBe(true);

      // Cancel: the suggestions go, nothing else changes.
      await s.send('POST', `/master-templates/${id}/rescan`, {});
      v = await rescanned();
      const discarded = await s.call<MasterView>(`/master-templates/${id}/rescan?expectedRevision=${v.template.revision}`, { method: 'DELETE' });
      expect(discarded.status).toBe(200);
      expect(discarded.body.template.textAnalysis).toEqual(after); expect(discarded.body.master.rescan).toBeUndefined();
      expect(readdirSync(dir).filter(f => f.startsWith('rescan-'))).toEqual([]);

      // Start over with the new scan: the elements are reviewed again; every crop a saved version or creative uses stays.
      await s.send('POST', `/master-templates/${id}/rescan`, {});
      v = await rescanned();
      v = (await s.send('POST', `/master-templates/${id}/rescan/apply`, { expectedRevision: v.template.revision, expectedAnalysisRevision: after.revision, mode: 'replace' })).body;
      expect(v.stage).toBe('review'); expect(v.template.textAnalysis!.words.find(w => w.text === 'cards.')).toBeTruthy();
      for (const f of r1Logos) expect(existsSync(join(dir, f)), f).toBe(true);
      expect(bytes(`creative-${creative.id}.json`).equals(creativeBytes)).toBe(true);
      expect((await s.call<CreativeInstance>(`/master-templates/${id}/creatives/${creative.id}`)).status).toBe(200);
      expect(s.fal.calls.submits).toBe(0); expect(s.planner).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it('scans again to find what the template misses (a word, the shape behind it) and adds only what is chosen', async () => {
    const s = await setup();
    try {
      const id = (await s.form('/master-templates', await masterPosterPng(), { name: 'Missed' })).body.template.id;
      let v = await s.scanned(id);
      v = (await s.send('POST', `/master-templates/${id}/review/approve-all`, { expectedRevision: v.template.revision, includeUncertain: true })).body;
      // As if the first scan had missed "off" and the pill behind "Up to 50% off": the background is made without them.
      let a = v.template.textAnalysis!;
      const off = a.words.find(w => w.text === 'off')!;
      const groups = a.groups.map(g => ({ ...g, lines: g.lines.map(l => ({ ...l, wordIds: l.wordIds.filter(x => x !== off.id) })) }));
      v = (await s.send('PUT', `/master-templates/${id}/review`, { expectedRevision: v.template.revision, expectedAnalysisRevision: a.revision, words: a.words.filter(w => w.id !== off.id), groups, logoSlots: a.logoSlots, plates: [] })).body;
      a = v.template.textAnalysis!;
      expect(a.words.some(w => w.text === 'off')).toBe(false); expect(a.plates).toEqual([]);
      // Before cleaning: what would be removed, as a picture.
      const preview = await s.call(`/master-templates/${id}/removal-preview`);
      expect(preview.status).toBe(200);
      v = (await s.send('POST', `/master-templates/${id}/prepare`, { expectedRevision: v.template.revision })).body;
      v = (await s.send('POST', `/master-templates/${id}/background/approve`, { expectedRevision: v.template.revision, acknowledgeEstimate: true })).body;
      v = (await s.send('POST', `/master-templates/${id}/publish`, { expectedRevision: v.template.revision })).body;
      expect(v.stage).toBe('ready');
      const creative = (await s.send<CreativeInstance>('POST', `/master-templates/${id}/creatives`, {})).body;
      const dir = join(s.protectedDir, id), creativeBytes = readFileSync(join(dir, `creative-${creative.id}.json`));
      await s.send('POST', `/master-templates/${id}/rescan`, {});
      for (let i = 0; i < 400 && (await s.view(id)).master.rescan?.status === 'running'; i++) await new Promise(r => setTimeout(r, 25));
      v = await s.view(id);
      const result = (await s.call<MasterRescanResult>(`/master-templates/${id}/rescan`)).body;
      const found = result.changes.added.find(x => x.text === 'off')!, line = a.words.find(w => w.text === 'Up')!.lineId;
      expect(found.lineId).toBe(line);
      expect(result.changes.plates).toHaveLength(1); expect(result.changes.plates[0].groupId).toBe(a.words.find(w => w.text === 'Up')!.groupId);
      const applied = await s.send('POST', `/master-templates/${id}/rescan/apply`, { expectedRevision: v.template.revision, expectedAnalysisRevision: a.revision, mode: 'selected', addWordIds: [found.wordId], addPlateIds: [result.changes.plates[0].plateId] });
      expect(applied.status, JSON.stringify(applied.body)).toBe(200);
      v = applied.body;
      const after = v.template.textAnalysis!, group = after.groups.find(g => g.lines.some(l => l.id === line))!;
      expect(group.lines.find(l => l.id === line)!.wordIds.map(x => after.words.find(w => w.id === x)!.text)).toEqual(['Up', 'to', '50%', 'off']);
      expect(after.words.find(w => w.text === 'off')!.review.status).toBe('approved');
      expect(after.plates).toHaveLength(1);
      // The added text must leave the background too: the clean background is made again before saving.
      expect(v.background.stale || !v.background.approved).toBe(true);
      expect(v.stage).not.toBe('ready');
      expect(readFileSync(join(dir, `creative-${creative.id}.json`)).equals(creativeBytes)).toBe(true);
      expect(s.fal.calls.submits).toBe(0);
    } finally { await s.close(); }
  });
});
