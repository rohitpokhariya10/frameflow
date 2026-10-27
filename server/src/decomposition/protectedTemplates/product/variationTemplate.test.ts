import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProductDecompositionPlan, ProductGenerationBrief, ProductSnapshot } from '@frameflow/shared';
import { fakeArtworkGenerator, productPosterPng } from './productPoster.fixture.js';
import { savedTemplate, setup, type View } from './productServer.fixture.js';
import { standInProductLayerizer } from './aiDecompose.js';
import type { VariationJob } from './variations.js';

type Job = VariationJob & { running: boolean };
const finished = async (s: Awaited<ReturnType<typeof setup>>, id: string, jid: string) => { for (let i = 0; i < 1200; i++) { const j = (await s.call<Job>(`/${id}/variations/${jid}`)).body; if (j.status !== 'running') return j; await new Promise(r => setTimeout(r, 50)); } throw new Error('not finished'); };
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('Generate with AI → Decompose & Edit: a variation through the same decomposition pipeline', { timeout: 300_000 }, () => {
  it('generates without a prompt from the saved instructions, then decomposes a variation as a template of its own, with its own layers', async () => {
    const artwork = fakeArtworkGenerator(), layerizer = standInProductLayerizer(), s = await setup({ artwork, layerizer });
    try {
      const v = await savedTemplate(s, await productPosterPng()), id = v.template.id;
      // The generation instructions (derived from the template, marked so) and the decomposition plan, apart; saved with the version.
      const brief = (await s.call<{ generation: ProductGenerationBrief; decomposition: ProductDecompositionPlan; saved: boolean }>(`/${id}/brief`)).body;
      expect(brief.generation.source).toBe('derived');
      expect(brief.saved).toBe(true);
      expect(brief.generation.products.map(p => p.label).sort()).toEqual(['Refrigerator', 'Television', 'Washing machine']);
      expect(brief.generation.prompt).toMatch(/No text, letters, numbers/);
      expect(brief.decomposition.instructions).toMatch(/^Cut out as layers of their own: /);
      const revisionFile = join(s.protectedDir, id, 'product-r1.json'), revisionBytes = readFileSync(revisionFile);
      const snapshot = JSON.parse(revisionBytes.toString('utf8')) as ProductSnapshot;
      expect(snapshot.generation?.prompt).toBe(brief.generation.prompt);
      expect(snapshot.decomposition?.elements.filter(e => e.decompose).map(e => e.label).sort()).toEqual(['Mascot', 'Refrigerator', 'Television', 'Washing machine']);

      // One click, nothing typed: 3 designs, each in 2 sizes = 6 creatives, the artwork asked for from the saved instructions.
      const job = await finished(s, id, (await s.send<VariationJob>('POST', `/${id}/variations`, { count: 3, aspectRatios: ['1:1', '9:16'], sizes: 'each', artwork: 'ai' })).body.id);
      expect(job.status, job.error).toBe('done');
      expect(job.results.map(r => r.creative?.variation?.aspectRatio)).toEqual(['1:1', '9:16', '1:1', '9:16', '1:1', '9:16']);
      expect(job.request).toMatchObject({ briefSource: 'template', sizes: 'each' });
      expect(artwork.calls).toHaveLength(6);
      for (const call of artwork.calls) expect(call.prompt).toContain(brief.generation.background.slice(0, 40));

      // Decompose & Edit: a template of its own, from the variation's composition — no AI request, nothing spent.
      const r0 = job.results[0], made = (await s.call<{ templateId: string }>(`/${id}/variations/${job.id}/results/0/template`, { method: 'POST' })), t = made.body.templateId;
      expect(made.status).toBe(201);
      let d = await s.detected(t);
      expect(d.stage).toBe('review');
      expect(d.product.detection?.ai, JSON.stringify(d.product.detection)).toMatchObject({ status: 'done', model: 'variation composition (exact, from its own layers)' });
      expect(d.product.activity).toMatchObject({ aiCalls: 0, costUsd: 0 });
      expect(d.product.variation).toMatchObject({ templateId: id, revision: 1, jobId: job.id, index: 0 });
      // The same elements (the master's names and kinds) at their places in the variation, every word and logo.
      const placed = r0.creative!.objects.filter(o => !o.hidden && (o.kind === 'product' || o.kind === 'character'));
      expect(d.product.objects.filter(o => o.kind === 'product' || o.kind === 'character').map(o => o.label).sort()).toEqual(placed.map(o => o.label).sort());
      expect(d.counts.words).toBe(r0.creative!.texts.filter(x => x.text.trim() && !x.hidden).length);
      expect(d.counts.logos).toBe(r0.creative!.images.filter(i => !i.hidden).length);
      // Asked again: the same template (made once).
      expect((await s.call<{ templateId: string }>(`/${id}/variations/${job.id}/results/0/template`, { method: 'POST' })).body.templateId).toBe(t);
      // Each variation is its own: distinct artwork asked for each, distinct outputs, and another variation sent to
      // Decompose & Edit is another template, made from that variation's own picture and layers.
      expect(new Set(job.results.map(r => r.previewSha256)).size).toBe(job.results.length);
      expect(new Set(job.results.map(r => r.creative!.background!.sha256)).size).toBe(job.results.length);
      const t2 = (await s.call<{ templateId: string }>(`/${id}/variations/${job.id}/results/2/template`, { method: 'POST' })).body.templateId;
      expect(t2).not.toBe(t);
      const d2 = await s.detected(t2);
      expect(d2.product.variation).toMatchObject({ templateId: id, jobId: job.id, index: 2 });
      expect(d2.template.source.sha256).not.toBe(d.template.source.sha256);
      expect(d2.product.activity).toMatchObject({ aiCalls: 0, costUsd: 0 });

      // Review, choose, decompose: every element keeps its own layer; behind it, the variation's own background (no estimate).
      d = (await s.send('PUT', `/${t}/review`, { expectedRevision: d.template.revision, objects: d.product.objects.map(o => ({ ...o, accepted: true })), texts: [], logos: [], dismissMissingText: true })).body;
      d = (await s.send('PUT', `/${t}/selection`, { expectedRevision: d.template.revision, objects: d.product.objects.map(o => ({ id: o.id, decompose: o.kind === 'product' || o.kind === 'character' })), logos: [] })).body;
      expect(d.product.selection?.objectsRevision).toBe(d.product.objectsRevision);
      // Explicit AI never reuses the native-cutout shortcut; local preparation is refused on this handoff.
      expect((await s.call<{ ai: { elements: number; requests: number } }>(`/${t}/prepare-estimate`)).body.ai).toMatchObject({ elements: placed.length, requests: 2 });
      const local = await s.send('POST', `/${t}/prepare`, { expectedRevision: d.template.revision });
      expect(JSON.stringify(local.body)).toContain('AI_REQUIRED');
      expect(layerizer.calls).toHaveLength(0);
      await s.send('POST', `/${t}/prepare`, { expectedRevision: d.template.revision, engine: 'ai' });
      d = await s.prepared(t);
      const p = d.product.prepared!;
      expect(d.stage, d.product.preparing?.error).toBe('prepared');
      expect(layerizer.calls).toHaveLength(1);
      expect(p.separation).toMatchObject({ method: 'seedream', requests: 2 });
      // Seedream decomposed everything chosen (as approved); a product whose layer in the composition is what the picture
      // shows is then its complete layer (the whole picture used in the variation), the rest Seedream's cut-outs.
      expect(d.product.objects.filter(o => o.cutout && o.kind === 'product').every(o => o.cutout!.method === 'layer')).toBe(true);
      expect(d.product.objects.filter(o => o.cutout && o.kind !== 'product').every(o => o.cutout!.method !== 'layer')).toBe(true);
      expect(layerizer.calls[0].excluded.words).toBeGreaterThan(0);
      expect(layerizer.calls[0].excluded.logos.length).toBeGreaterThan(0);
      // Completed preparation is idempotent: opening/continuing cannot charge twice.
      expect((await s.send<{ started: boolean }>('POST', `/${t}/prepare`, { expectedRevision: d.template.revision, engine: 'ai' })).body.started).toBe(false);
      expect(layerizer.calls).toHaveLength(1);

      // Saved as its own master template (its instructions its master's), then a creative of it opened as a run.
      d = (await s.send('POST', `/${t}/approve`, { expectedRevision: d.template.revision, acknowledge: p.quality.issues.map(i => i.id), draft: p.quality.issues.some(i => i.blocking) })).body;
      const saved = await s.send<View>('POST', `/${t}/publish`, { expectedRevision: d.template.revision });
      expect(saved.status).toBe(201);
      const own2 = JSON.parse(readFileSync(join(s.protectedDir, t, 'product-r1.json'), 'utf8')) as ProductSnapshot;
      expect(own2.generation?.prompt).toBe(brief.generation.prompt);
      const creative = (await s.send<{ id: string }>('POST', `/${t}/creatives`, {})).body;
      const opened = (await s.send<{ runId: string }>('POST', `/${t}/creatives/${creative.id}/open`, {})).body;
      const run = JSON.parse(readFileSync(join(s.root, 'runs', opened.runId, 'run.json'), 'utf8'));
      expect(run.creative.provenance.preparation.method).toBe('seedream');
      expect(run.creative.layers.filter((l: { kind: string }) => l.kind === 'object')).toHaveLength(placed.length);
      // The other variation's template with an element renamed in its review: still its own layer (layers are matched by
      // kind and place, not by name — a long name came back from the scene parser changed, and two speakers were cut
      // out of the picture again).
      let e2 = (await s.send('PUT', `/${t2}/review`, { expectedRevision: d2.template.revision, objects: d2.product.objects.map(o => ({ ...o, accepted: true, label: o.kind === 'product' ? `${o.label} (renamed)` : o.label })), texts: [], logos: [], dismissMissingText: true })).body;
      e2 = (await s.send('PUT', `/${t2}/selection`, { expectedRevision: e2.template.revision, objects: e2.product.objects.map(o => ({ id: o.id, decompose: o.kind === 'product' || o.kind === 'character' })), logos: [] })).body;
      await s.send('POST', `/${t2}/prepare`, { expectedRevision: e2.template.revision, engine: 'ai' });
      e2 = await s.prepared(t2);
      expect(e2.stage, e2.product.preparing?.error).toBe('prepared');
      const cut2 = e2.product.objects.filter(o => o.cutout);
      expect(cut2.some(o => o.label.endsWith('(renamed)'))).toBe(true);
      expect(cut2.filter(o => o.kind === 'product').every(o => o.cutout!.method === 'layer')).toBe(true);
      expect(cut2.filter(o => o.kind !== 'product').every(o => o.cutout!.method !== 'layer')).toBe(true);
      expect(layerizer.calls).toHaveLength(2);
      // The master is unchanged (its saved version byte for byte).
      expect(hash(readFileSync(revisionFile))).toBe(hash(revisionBytes));
    } finally { await s.close(); }
  });
});
