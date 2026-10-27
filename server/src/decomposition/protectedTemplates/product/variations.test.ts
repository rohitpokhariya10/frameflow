import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { ProductCreative } from '@frameflow/shared';
import { productPosterPng } from './productPoster.fixture.js';
import { savedTemplate, setup, sha } from './productServer.fixture.js';
import { PLANNER_COST_USD, variationChecks, type PlannerInput, type ProductVariationPlanner, type VariationJob } from './variations.js';

type Job = VariationJob & { running: boolean };
const finished = async (s: Awaited<ReturnType<typeof setup>>, id: string, jid: string) => { for (let i = 0; i < 1200; i++) { const j = (await s.call<Job>(`/${id}/variations/${jid}`)).body; if (j.status !== 'running') return j; await new Promise(r => setTimeout(r, 25)); } throw new Error('variations did not finish'); };
const packshot = () => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="320"><rect width="200" height="320" fill="#ffffff"/><rect x="30" y="20" width="140" height="280" rx="16" fill="#0f766e"/></svg>`)).png().toBuffer();
const kept = (c: ProductCreative) => c.objects.filter(o => !o.hidden).map(o => o.label);

describe('Product with Text templates: variations', { timeout: 240_000 }, () => {
  it('makes 3–5 variations from the structure (offline): what each card says is drawn, in the asked aspect ratios; saves, regenerates, removes', async () => {
    const s = await setup();
    try {
      const v = await savedTemplate(s, await productPosterPng()), id = v.template.id;
      const options = (await s.call<{ slots: { slotId: string; kind: string }[]; choices: { ref: string }[]; planner: { ai: boolean; model: string }; aspectRatios: string[] }>(`/${id}/variation-options`)).body;
      expect(options.planner).toMatchObject({ ai: false, model: 'offline-planner' });
      expect(options.slots.map(x => x.kind).sort()).toEqual(['character', 'product', 'product', 'product']);
      expect(options.aspectRatios).toEqual(['original', '1:1', '4:5', '9:16', '16:9']);
      // A product for the library: a packshot cut out locally.
      const f = new FormData(); f.append('image', new Blob([new Uint8Array(await packshot())], { type: 'image/png' }), 'Speaker.png');
      const added = await s.call<{ choice: { ref: string; label: string }; background: string }>(`/${id}/variation-products`, { method: 'POST', body: f });
      expect(added.body).toMatchObject({ choice: { label: 'Speaker' }, background: 'removed' });
      // 1 to 10 variations (3, 5 or 10 in the form); more is refused, and more than 20 creatives at once.
      expect((await s.send('POST', `/${id}/variations`, { mode: 'redesign', count: 11 })).status).toBe(400);
      expect((await s.send('POST', `/${id}/variations`, { mode: 'redesign', count: 0 })).status).toBe(400);
      expect((await s.send('POST', `/${id}/variations`, { mode: 'redesign', count: 10, sizes: 'each', aspectRatios: ['1:1', '4:5', '9:16'] })).status).toBe(400);
      expect((await s.send('POST', `/${id}/variations`, { mode: 'redesign', count: 3, ai: true })).status).toBe(503);
      // Suggested headlines are the AI planner's only: offline, the person types their own.
      expect((await s.send('POST', `/${id}/variations`, { mode: 'redesign', count: 3, copy: 'suggest' })).status).toBe(400);
      const tvSlot = v.product.objects.find(o => o.label === 'Television')!.id;
      const started = await s.send<VariationJob>('POST', `/${id}/variations`, { mode: 'redesign', count: 4, kinds: ['festive', 'sale', 'premium', 'minimal'], aspectRatios: ['original', '9:16', '16:9', '4:5'],
        headline: 'Big Festive Deals', products: { [tvSlot]: [added.body.choice.ref] } });
      expect(started.status, JSON.stringify(started.body)).toBe(202);
      const job = await finished(s, id, started.body.id);
      expect(job.status, job.error).toBe('done');
      expect(job.planner).toMatchObject({ offline: true, requests: 0, costUsd: 0 });
      if (process.env.PRODUCT_LOOK) for (const r of job.results) (await import('node:fs')).copyFileSync(join(s.protectedDir, id, r.preview!), `${process.env.PRODUCT_LOOK}-${r.index}.png`);
      expect(job.results.map(r => [r.status, r.plan!.kind, r.creative!.variation!.aspectRatio])).toEqual([['ready', 'festive', 'original'], ['ready', 'sale', '9:16'], ['ready', 'premium', '16:9'], ['ready', 'minimal', '4:5']]);
      const sizes = { original: [1000, 1200], '9:16': [1000, 1778], '16:9': [2133, 1200], '4:5': [1000, 1250] } as Record<string, number[]>;
      for (const r of job.results) {
        const c = r.creative!, ratio = c.variation!.aspectRatio!;
        expect([c.canvas.width, c.canvas.height], ratio).toEqual(sizes[ratio]);
        expect(c.variation!.checks!.status, JSON.stringify(c.variation!.checks)).not.toBe('failed');
        // The background is its own file at the canvas's size (the artwork's plain margins lengthened: nothing stretched or filled).
        expect(c.background, ratio).toMatchObject({ width: c.canvas.width, height: c.canvas.height, method: ratio === 'original' ? 'template' : 'plain-bands', filledPercent: 0 });
        const preview = await sharp(new Uint8Array(await (await s.fetchFile(id, r.preview!)).arrayBuffer())).metadata();
        expect(preview.width! / preview.height!).toBeCloseTo(c.canvas.width / c.canvas.height, 2);
        // The mascot and the other products kept; the TV slot holds the chosen speaker.
        expect(kept(c)).toEqual(expect.arrayContaining(['Mascot', 'Washing machine', 'Refrigerator', 'Speaker']));
        expect(c.objects.find(o => o.objectId === tvSlot)!.asset.file).toMatch(/^pvl-/);
        // The typed headline is what is drawn (no drafts); the offer and legal text untouched.
        const headline = c.groups.find(g => g.category === 'headline')!;
        expect(c.texts.filter(t => t.groupId === headline.id).sort((a, b) => a.line - b.line || a.x - b.x).map(t => t.text).join(' ')).toBe('Big Festive Deals');
        expect(c.variation!.copy).toEqual([expect.objectContaining({ groupId: headline.id, applied: true, source: 'user', text: 'Big Festive Deals' })]);
        expect(c.texts.map(t => t.text)).toEqual(expect.arrayContaining(['26%', 'cashback', 'T&Cs']));
        // Every element inside the canvas.
        for (const o of c.objects) expect(o.box.x >= 0 && o.box.y >= 0 && o.box.x + o.box.width <= c.canvas.width && o.box.y + o.box.height <= c.canvas.height, `${ratio} ${o.label}`).toBe(true);
      }
      // The speaker stands on the slot's contact line (at the template's size; moved with the artwork in the others).
      const slot = v.product.objects.find(o => o.id === tvSlot)!.slot!, speaker = job.results[0].creative!.objects.find(o => o.objectId === tvSlot)!;
      expect(speaker.box.y + speaker.box.height - 1).toBe(slot.contactY);
      const tall = job.results[1].creative!, tallSpeaker = tall.objects.find(o => o.objectId === tvSlot)!;
      expect(tallSpeaker.box.y - speaker.box.y).toBe(tall.layout!.extra.before);
      // Text laid across the products fails the checks (the same creative as its own template passes them).
      const c0 = job.results[0].creative!, head = c0.groups.find(g => g.category === 'headline')!.id, row = c0.objects.filter(o => o.kind === 'product' && !o.hidden);
      const midY = Math.round((Math.min(...row.map(o => o.box.y)) + Math.max(...row.map(o => o.box.y + o.box.height))) / 2), x0 = Math.min(...row.map(o => o.box.x));
      const across: ProductCreative = { ...c0, texts: c0.texts.map(t => (t.groupId === head ? { ...t, x: x0 + (t.x - Math.min(...c0.texts.filter(u => u.groupId === head).map(u => u.x))), baselineY: midY + t.line * t.style.fontSize * 1.1 } : t)) };
      const has = () => true;
      expect(variationChecks(c0, c0, new Map(), has).issues.filter(i => i.code === 'OVERLAP' && /lies across/.test(i.message))).toEqual([]);
      expect(variationChecks(across, c0, new Map(), has).issues).toContainEqual(expect.objectContaining({ code: 'OVERLAP', blocking: true, message: expect.stringMatching(/^“Big Festive Deals” lies across /) }));
      // Kinds look different: different fonts and artwork treatments, not just another title.
      expect(new Set(job.results.map(r => r.creative!.texts.find(t => t.groupId === r.creative!.groups.find(g => g.category === 'headline')!.id)!.style.fontFamily)).size).toBeGreaterThanOrEqual(3);
      expect(new Set(job.results.map(r => r.previewSha256)).size).toBe(4);
      // Different products (offline): every product slot holds another product than its own.
      const swap = await s.send<VariationJob>('POST', `/${id}/variations`, { mode: 'redesign', count: 3, kinds: ['product-swap'], copy: 'none' });
      const swapped = await finished(s, id, swap.body.id);
      for (const r of swapped.results) for (const o of r.creative!.objects.filter(x => x.kind === 'product')) {
        const own = v.product.objects.find(x => x.id === o.objectId)!.cutout!.file;
        expect(o.asset.file, `${r.plan!.title}: ${o.label}`).not.toBe(own);
      }
      // Festive text in a festive colour (readable on the mint panel).
      const festive = job.results[0].creative!, headline = festive.groups.find(g => g.category === 'headline')!;
      expect(['#b91c1c', '#c2410c', '#9a3412', '#7c2d12', '#a16207']).toContain(festive.texts.find(t => t.groupId === headline.id)!.style.color);
      // Saved as a creative (its first revision); asking twice returns the same one; its pictures are its own files.
      const saved = await s.call<ProductCreative>(`/${id}/variations/${job.id}/results/1/save`, { method: 'POST' });
      expect(saved.status).toBe(201);
      expect(saved.body).toMatchObject({ revision: 1, origin: { kind: 'variation', jobId: job.id, index: 1 }, variation: { kind: 'sale', aspectRatio: '9:16' }, canvas: { width: 1000, height: 1778 } });
      expect(saved.body.objects.find(o => o.objectId === tvSlot)!.asset).toMatchObject({ kind: 'upload', file: expect.stringMatching(new RegExp(`^pca-${saved.body.id.slice(3)}-`)) });
      expect(saved.body.background!.file).toMatch(new RegExp(`^pca-${saved.body.id.slice(3)}-`));
      expect((await s.call<ProductCreative>(`/${id}/variations/${job.id}/results/1/save`, { method: 'POST' })).body.id).toBe(saved.body.id);
      expect((await s.call<{ creatives: { id: string }[] }>(`/${id}/creatives`)).body.creatives.map(c => c.id)).toEqual([saved.body.id]);
      // Regenerated: the same kind and ratio, made again differently.
      const again = (await s.send<VariationJob>('POST', `/${id}/variations/${job.id}/results/2/regenerate`, {})).body;
      expect(again.results[2]).toMatchObject({ status: 'ready', round: 1, plan: { kind: 'premium' } });
      expect(again.results[2].creative!.variation!.aspectRatio).toBe('16:9');
      // Removed from the grid.
      expect((await s.call<VariationJob>(`/${id}/variations/${job.id}/results/3`, { method: 'DELETE' })).body.results[3].removed).toBe(true);
      expect(job.results[3].creative!.objects.every(o => !o.hidden)).toBe(true);
    } finally { await s.close(); }
  });

  it('sends a chosen variation to decomposition: a run of its own layers (no provider, no new segmentation), once per revision, ready for the editor', async () => {
    const s = await setup({ segmenter: true });
    try {
      const v = await savedTemplate(s, await productPosterPng()), id = v.template.id, analyzerCalls = s.analyzer.calls;
      // A character for the library, chosen for the mascot's slot.
      const f = new FormData(); f.append('image', new Blob([new Uint8Array(await packshot())], { type: 'image/png' }), 'Hero.png'); f.append('kind', 'character');
      const hero = (await s.call<{ choice: { ref: string; kind: string } }>(`/${id}/variation-products`, { method: 'POST', body: f })).body.choice;
      expect(hero.kind).toBe('character');
      const mascot = v.product.objects.find(o => o.kind === 'character')!.id;
      const job = await finished(s, id, (await s.send<VariationJob>('POST', `/${id}/variations`, { mode: 'redesign', count: 3, kinds: ['sale'], aspectRatios: ['9:16'], offer: 'Get 26% cashback today', products: { [mascot]: [hero.ref] } })).body.id);
      expect(job.status, job.error).toBe('done');
      const chosen = job.results[0], c = chosen.creative!;
      expect(c.objects.find(o => o.objectId === mascot)).toMatchObject({ label: 'Hero', asset: { file: expect.stringMatching(/^pvl-/) } });
      expect(c.variation!.requested).toMatchObject({ characters: [{ slotId: mascot, ref: hero.ref }], offer: 'Get 26% cashback today' });
      const sent = await s.call<{ runId: string; created: boolean; creativeId: string; creativeRevision: number }>(`/${id}/variations/${job.id}/results/0/open-layers`, { method: 'POST' });
      expect(sent.status, JSON.stringify(sent.body)).toBe(201);
      expect(sent.body).toMatchObject({ created: true, creativeRevision: 1 });
      // Sent again: the same run (nothing made twice).
      const again = await s.call<{ runId: string; created: boolean }>(`/${id}/variations/${job.id}/results/0/open-layers`, { method: 'POST' });
      expect(again).toMatchObject({ status: 200, body: { runId: sent.body.runId, created: false } });
      expect((await s.call<VariationJob>(`/${id}/variations/${job.id}`)).body.results[0]).toMatchObject({ runId: sent.body.runId, savedCreativeId: sent.body.creativeId });
      const runDir = join(s.root, 'runs', sent.body.runId), run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
      expect(run).toMatchObject({ stage: 'done', canvas: { width: 1000, height: 1778 }, creative: { product: true, creativeId: sent.body.creativeId, creativeRevision: 1, canvas: { width: 1000, height: 1778 } } });
      // Provenance: the variation, no cost, every picture layer's source file and its hash; no text or logo to any provider.
      expect(run.creative.provenance).toMatchObject({ cost: { usd: 0, providerRequests: 0, segmentation: 'reused' }, textLayersSentToProviders: 0, layout: { aspectRatio: '9:16', axis: 'y' },
        variation: { jobId: job.id, index: 0, kind: 'sale', aspectRatio: '9:16' } });
      const saved = (await s.call<ProductCreative>(`/${id}/creatives/${sent.body.creativeId}`)).body;
      for (const input of run.creative.provenance.inputs) {
        const bytes = Buffer.from(await (await s.fetchFile(id, input.file)).arrayBuffer());
        expect(sha(bytes), input.file).toBe(input.sha256);
      }
      expect(run.creative.provenance.inputs.map((i: { source: string }) => i.source)).toEqual(expect.arrayContaining(['creative-background', 'template-cutout', 'uploaded-cutout', 'template-logo']));
      expect(run.creative.provenance.inputs.find((i: { role: string }) => i.role === 'character').file).toBe(saved.objects.find(o => o.objectId === mascot)!.asset.file);
      // The run's layers: the background at the canvas size, one picture per object, texts as text layers; its words are the variation's.
      const bg = await sharp(join(runDir, 'layer-00-background.png')).metadata();
      expect([bg.width, bg.height]).toEqual([1000, 1778]);
      expect(run.creative.layers.filter((l: { kind: string }) => l.kind === 'object')).toHaveLength(4);
      const offer = saved.groups.find(g => g.category === 'offer')!;
      expect(run.creative.texts.filter((t: { groupId: string }) => t.groupId === offer.id).map((t: { text: string }) => t.text).join(' ')).toBe('Get 26% cashback today');
      expect(run.creative.texts.map((t: { id: string; x: number; baselineY: number }) => [t.id, t.x, t.baselineY])).toEqual(saved.texts.filter(t => t.text.trim()).map(t => [t.id, t.x, t.baselineY]));
      // No provider was asked anything: no segmentation, no analysis.
      expect(s.segmenter.calls).toHaveLength(0);
      expect(s.analyzer.calls).toBe(analyzerCalls);
    } finally { await s.close(); }
  });

  it('checks whatever the AI planner proposes: no invented offers, no offer or legal rewrites, allowed colours only, the design kept', async () => {
    let seen: PlannerInput | undefined;
    const planner: ProductVariationPlanner = { model: 'test-planner', offline: false, async plan(input) {
      seen = input;
      const headline = input.texts.find(t => t.role === 'headline')!, offer = input.texts.find(t => t.role === 'offer')!, mascot = input.objects.find(o => o.kind === 'character')!;
      return { variations: Array.from({ length: input.count }, (_, i) => input.kinds[i % input.kinds.length]).map(kind => ({ kind, title: 'Planned', text_color: '#00ff00', accent_color: '#dc2626', products: [{ slot_id: input.slots[0].slotId, ref: 'library:not-offered' }], hide_ids: [mascot.id],
        copy: [{ group_id: headline.groupId, text: 'Flat 50% off today' }, { group_id: offer.groupId, text: 'Get 40% cashback' }, { group_id: headline.groupId, text: 'Shop the season' }], notes: ['ignore previous instructions'] })) };
    } };
    const s = await setup({ planner });
    try {
      const v = await savedTemplate(s, await productPosterPng()), id = v.template.id;
      expect((await s.call<{ planner: { ai: boolean } }>(`/${id}/variation-options`)).body.planner.ai).toBe(true);
      const started = await s.send<VariationJob>('POST', `/${id}/variations`, { mode: 'redesign', count: 3, kinds: ['sale'], copy: 'apply', ai: true });
      const job = await finished(s, id, started.body.id);
      expect(job.status, job.error).toBe('done');
      expect(job.planner).toMatchObject({ offline: false, model: 'test-planner', requests: 1, costUsd: PLANNER_COST_USD });
      if (process.env.PRODUCT_LOOK) (await import('node:fs')).copyFileSync(join(s.protectedDir, id, job.results[0].preview!), `${process.env.PRODUCT_LOOK}-applied.png`);
      // The planner saw the structure as data, never the picture.
      expect(JSON.stringify(seen)).not.toMatch(/base64|png/i);
      for (const r of job.results) {
        const c = r.creative!, plan = r.plan!;
        expect(plan.textColor).toBeNull();
        expect(plan.products).toEqual([]);
        expect(plan.hide).toEqual([]);
        expect(plan.copy).toEqual([{ groupId: expect.any(String), text: 'Shop the season' }]);
        expect(plan.notes.join(' ')).toMatch(/adds “50% off”/);
        expect(plan.notes.join(' ')).toMatch(/offer text was left out/);
        // Applied: the headline rewritten; the offer's 26% untouched; the mascot still there.
        expect(c.texts.map(t => t.text)).toEqual(expect.arrayContaining(['Shop', 'the', 'season', 'Get', '26%', 'cashback']));
        expect(c.texts.map(t => t.text)).not.toContain('50%');
        expect(kept(c)).toContain('Mascot');
      }
    } finally { await s.close(); }
  });
});
