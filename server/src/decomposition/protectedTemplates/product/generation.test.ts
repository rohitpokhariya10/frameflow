import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { masterCreativeIssues, type CreativeInstance, type ProductCreative } from '@frameflow/shared';
import { fakeArtworkGenerator, productPosterPng } from './productPoster.fixture.js';
import { savedTemplate, setup } from './productServer.fixture.js';
import { fontMeasure } from './ratioLayout.js';
import type { VariationJob } from './variations.js';

type Job = VariationJob & { running: boolean };
const finished = async (s: Awaited<ReturnType<typeof setup>>, id: string, jid: string) => { for (let i = 0; i < 1200; i++) { const j = (await s.call<Job>(`/${id}/variations/${jid}`)).body; if (j.status !== 'running') return j; await new Promise(r => setTimeout(r, 25)); } throw new Error('variations did not finish'); };
const inside = (b: { x: number; y: number; width: number; height: number }, c: { width: number; height: number }) => b.x >= 0 && b.y >= 0 && b.x + b.width <= c.width + 0.5 && b.y + b.height <= c.height + 0.5;
const asInstance = (c: ProductCreative) => ({ ...c, schemaVersion: 1, masterId: c.templateId, masterRevision: c.templateRevision, origin: { kind: 'master' }, editor: null, exports: [], history: [] }) as unknown as CreativeInstance;

describe('Product with Text templates: recomposed variations on new artwork', { timeout: 300_000 }, () => {
  it('lays every element out again for each ratio on new artwork (AI test double / local preset), checks it, and sends it to decomposition', async () => {
    const artwork = fakeArtworkGenerator();
    const s = await setup({ artwork });
    try {
      const v = await savedTemplate(s, await productPosterPng()), id = v.template.id;
      expect((await s.call<{ artwork: { ai: boolean; model: string; offline: boolean } }>(`/${id}/variation-options`)).body.artwork).toMatchObject({ ai: true, model: 'offline-image-model', offline: true });
      const job = await finished(s, id, (await s.send<VariationJob>('POST', `/${id}/variations`, { mode: 'redesign', count: 4, kinds: ['festive', 'sale', 'premium', 'minimal'], aspectRatios: ['16:9', '9:16', '1:1', '4:5'], artwork: 'ai', direction: 'Diwali lights over a marble terrace', headline: 'Big Festive Deals' })).body.id);
      expect(job.status, job.error).toBe('done');
      expect(job.artwork).toMatchObject({ mode: 'ai', model: 'offline-image-model', offline: true, requests: 4, costUsd: 0 });
      expect(artwork.calls).toHaveLength(4);
      // The prompt asks for artwork only, with the direction, and room for the layout.
      for (const call of artwork.calls) { expect(call.prompt).toMatch(/no text, no letters, no numbers/); expect(call.prompt).toContain('Diwali lights over a marble terrace'); expect(call.prompt).not.toContain('Big Festive Deals'); }
      expect(artwork.calls.map(c => `${c.size.width}x${c.size.height}`)).toEqual(['1536x864', '864x1536', '1024x1024', '1216x1520']);
      const compositions = new Set<string>();
      for (const r of job.results) {
        const c = r.creative!, ratio = c.variation!.aspectRatio!;
        expect(r.status, r.error).toBe('ready');
        expect(c.background).toMatchObject({ method: 'ai-artwork', width: c.canvas.width, height: c.canvas.height, artwork: { model: 'offline-image-model', offline: true, textFound: [] } });
        compositions.add(c.layout!.composition!);
        expect(c.layout!.composition, ratio).toMatch(ratio === '16:9' ? /^split-/ : /^stage-/);
        // Every element inside the canvas; no text running into other text or a logo; products where they were placed, not stretched.
        for (const o of c.objects.filter(x => !x.hidden)) expect(inside(o.box, c.canvas), `${ratio} ${o.label}`).toBe(true);
        for (const i of c.images.filter(x => !x.hidden)) expect(inside(i.box, c.canvas), `${ratio} ${i.label}`).toBe(true);
        expect(masterCreativeIssues(asInstance(c), fontMeasure).filter(i => i.severity === 'error').map(i => i.message), ratio).toEqual([]);
        const tv = c.objects.find(o => o.label === 'Television')!, own = v.product.objects.find(o => o.label === 'Television')!.cutout!.placement;
        expect(tv.box.width / tv.box.height).toBeCloseTo(own.width / own.height, 1);
        // The typed headline is drawn, as editable words; the AI artwork is flagged for a person to look at (not "passed").
        expect(c.texts.filter(t => t.groupId === c.groups.find(g => g.category === 'headline')!.id).map(t => t.text).join(' ')).toBe('Big Festive Deals');
        expect(c.variation!.checks!.status).toBe('needs-review');
        expect(c.variation!.checks!.issues.map(i => i.code)).toContain('AI_CONTENT');
        // The preview is the creative drawn from its own layers at the canvas's proportions.
        const meta = await sharp(Buffer.from(await (await s.fetchFile(id, r.preview!)).arrayBuffer())).metadata();
        expect(meta.width! / meta.height!).toBeCloseTo(c.canvas.width / c.canvas.height, 2);
      }
      expect(compositions.size).toBeGreaterThanOrEqual(2);
      // Sent to decomposition: the run's background is the new artwork, every element its own layer.
      const sent = (await s.call<{ runId: string }>(`/${id}/variations/${job.id}/results/0/open-layers`, { method: 'POST' })).body;
      const run = JSON.parse(readFileSync(join(s.root, 'runs', sent.runId, 'run.json'), 'utf8'));
      expect(run.canvas).toEqual({ width: 2133, height: 1200 });
      expect(run.creative.provenance.inputs.find((i: { role: string }) => i.role === 'background')).toMatchObject({ source: 'creative-background' });
      expect(run.creative.provenance.layout).toMatchObject({ composition: expect.stringMatching(/^split-/) });

      // The local preset backdrop: free, no image request, labelled as a preset.
      const local = await finished(s, id, (await s.send<VariationJob>('POST', `/${id}/variations`, { mode: 'redesign', count: 3, kinds: ['premium'], aspectRatios: ['16:9'], artwork: 'local' })).body.id);
      expect(local.artwork).toMatchObject({ mode: 'local', offline: true, requests: 0, costUsd: 0 });
      expect(artwork.calls).toHaveLength(4);
      for (const r of local.results) {
        expect(r.creative!.background).toMatchObject({ method: 'local-backdrop', artwork: { model: 'local preset backdrop (no AI)' } });
        expect(r.creative!.variation!.checks!.issues.map(i => i.code)).not.toContain('AI_CONTENT');
      }

      // Text drawn into the artwork by the model: the variation fails its checks and cannot be sent on.
      const drill = await finished(s, id, (await s.send<VariationJob>('POST', `/${id}/variations`, { mode: 'redesign', count: 3, kinds: ['sale'], aspectRatios: ['1:1'], artwork: 'ai', direction: 'text drill' })).body.id);
      for (const r of drill.results) {
        expect(r.creative!.background!.artwork!.textFound.length).toBeGreaterThan(0);
        expect(r.creative!.variation!.checks).toMatchObject({ status: 'failed', issues: expect.arrayContaining([expect.objectContaining({ code: 'AI_TEXT', blocking: true })]) });
      }
      expect((await s.call(`/${id}/variations/${drill.id}/results/0/open-layers`, { method: 'POST' })).status).toBe(422);
    } finally { await s.close(); }
  });

  it('never makes a paid image request without the approved amount', async () => {
    const paid = fakeArtworkGenerator({ offline: false });
    const s = await setup({ artwork: paid });
    try {
      const v = await savedTemplate(s, await productPosterPng()), id = v.template.id;
      const refused = await s.send<{ error: { code: string; estimateUsd: number; requests: number } }>('POST', `/${id}/variations`, { mode: 'redesign', count: 3, kinds: ['festive'], artwork: 'ai' });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatchObject({ code: 'APPROVAL_REQUIRED', requests: 3, estimateUsd: 0.18 });
      expect((await s.send('POST', `/${id}/variations`, { mode: 'redesign', count: 3, kinds: ['festive'], artwork: 'ai', approveArtworkUsd: 0.1 })).status).toBe(400);
      expect(paid.calls).toHaveLength(0);
      const job = await finished(s, id, (await s.send<VariationJob>('POST', `/${id}/variations`, { mode: 'redesign', count: 3, kinds: ['festive'], artwork: 'ai', approveArtworkUsd: 0.18 })).body.id);
      expect(job.status, job.error).toBe('done');
      expect(paid.calls).toHaveLength(3);
      expect(job.artwork).toMatchObject({ mode: 'ai', offline: false, requests: 3, costUsd: 0.15 });
      // Making one again is one more image: refused without approval, nothing sent.
      expect((await s.send('POST', `/${id}/variations/${job.id}/results/0/regenerate`, {})).status).toBe(400);
      expect(paid.calls).toHaveLength(3);
    } finally { await s.close(); }
  });
});
