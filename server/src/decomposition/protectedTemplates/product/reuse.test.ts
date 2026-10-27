import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { productCategory, productFamily, productMix, compatibleFamily } from './reuse.js';
import { savedTemplate, setup } from './productServer.fixture.js';
import { productPosterPng } from './productPoster.fixture.js';
import { standInProductLayerizer } from './aiDecompose.js';
import type { ArtworkGenerator } from './artwork.js';
import type { VariationJob } from './variations.js';
import type { ProductCreative } from '@frameflow/shared';

async function finished(s: Awaited<ReturnType<typeof setup>>, id: string, jid: string) {
  for (let i = 0; i < 1200; i++) {
    const j = (await s.call<VariationJob>(`/${id}/variations/${jid}`)).body;
    if (j.status !== 'running') return j;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('Variation timed out');
}

describe('structured template reuse', { timeout: 240000 }, () => {
  it('infers conservative categories; unrelated or unknown items cannot become interchangeable', () => {
    expect(productFamily(['OLED television', 'Refrigerator', 'Water purifier'])).toEqual(['electronics', 'home appliances']);
    expect(productCategory('LG OLED television')).toBe(productCategory('Television'));
    expect(productCategory('Refrigerator')).not.toBe(productCategory('Car'));
    expect(productCategory('Unknown packshot')).not.toBe(productCategory('Television'));
    expect(productFamily(['sedan', 'jacket', 'sofa'])).toEqual(['vehicles', 'fashion', 'furniture']);
    for (const label of ['refrigerator', 'sedan', 'jacket', 'sofa', 'television']) {
      const mixes = [0, 1, 2].map(index => productMix([{ label, box: { width: 100, height: 150 } }], index)[0]);
      expect(new Set(mixes).size, label).toBe(3);
      expect(mixes.every(m => compatibleFamily(label, m))).toBe(true);
    }
  });

  it('preserves fixed assets and layout, makes approved category-matched products, and sends the selected variant to AI preparation', async () => {
    const prompts: string[] = [];
    const generator: ArtworkGenerator = { model: 'test product generator', offline: false, async generate({ prompt }, save) {
      prompts.push(prompt); save('response.json', { requestId: `fake-${prompts.length}`, test: true });
      return { png: await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="white"/><rect x="40" y="30" width="120" height="240" rx="12" fill="hsl(${prompts.length * 27},60%,35%)"/></svg>`)).png().toBuffer(), costUsd: 0.02 };
    } };
    const layerizer = standInProductLayerizer(), s = await setup({ artwork: generator, layerizer });
    try {
      const v = await savedTemplate(s, await productPosterPng()), id = v.template.id;
      const masterBefore = readFileSync(join(s.protectedDir, id, 'product-r1.json'));
      const base = (await s.send<ProductCreative>('POST', `/${id}/creatives`, {})).body;
      const denied = await s.send('POST', `/${id}/variations`, { count: 3, generateProducts: true });
      expect(JSON.stringify(denied.body)).toContain('APPROVAL_REQUIRED'); expect(prompts).toHaveLength(0);
      const start = await s.send<VariationJob>('POST', `/${id}/variations`, { count: 3, kinds: ['premium', 'minimal', 'festive'], generateProducts: true, approveProductsUsd: 0.54, headline: 'Fresh home ideas', offer: '26% cashback', aspectRatios: ['16:9'], artwork: 'template' });
      expect(start.status, JSON.stringify(start.body)).toBe(202);
      const job = await finished(s, id, start.body.id);
      expect(job.request.mode).toBe('reuse'); expect(job.results).toHaveLength(3);
      expect(prompts).toHaveLength(9);
      expect(job.productGeneration).toMatchObject({ requests: 9, costUsd: 0.18 });
      for (const p of prompts) expect(p).toMatch(/Product category:/);
      expect(new Set(job.results.map(r => r.creative?.objects.filter(o => o.kind === 'product').map(o => o.label).sort().join('|'))).size).toBe(3);
      for (const r of job.results) {
        expect(r.status, r.error).toBe('ready');
        const c = r.creative!;
        expect(c.variation?.checks?.status, JSON.stringify(c.variation?.checks)).not.toBe('failed');
        expect(c.canvas).toEqual(base.canvas); expect(c.background).toEqual(base.background);
        const fixed = (x: ProductCreative) => x.objects.filter(o => o.kind !== 'product').map(o => [o.label, o.asset, o.box, o.hidden, o.z]);
        expect(fixed(c)).toEqual(fixed(base));
        expect(c.images.map(i => [i.asset, i.box])).toEqual(base.images.map(i => [i.asset, i.box]));
        expect(c.variation?.copy.map(w => w.text)).toEqual(['Fresh home ideas', '26% cashback']);
        expect(c.texts.map(t => t.text)).toEqual(expect.arrayContaining(['Fresh', 'home', 'ideas', 'T&Cs']));
        expect(c.objects.filter(o => o.kind === 'product').every(o => o.asset.file.startsWith('pvarproduct-'))).toBe(true);
      }
      const chosen = await s.send<{ templateId: string }>('POST', `/${id}/variations/${job.id}/results/1/decomposition`, {});
      expect(chosen.body.templateId).not.toBe(id);
      const t = await s.detected(chosen.body.templateId);
      expect(t.product.variation).toMatchObject({ templateId: id, jobId: job.id, index: 1, decompositionEngine: 'ai' });
      expect(layerizer.calls).toHaveLength(0); // Handoff itself is free; approval remains a separate action.
      expect((await s.call<{ ai: { elements: number } }>(`/${t.template.id}/prepare-estimate`)).body.ai.elements).toBeGreaterThan(0);
      expect((await s.send<{ templateId: string }>('POST', `/${id}/variations/${job.id}/results/1/decomposition`, {})).body.templateId).toBe(t.template.id);
      const saved = (await s.send<ProductCreative>('POST', `/${id}/variations/${job.id}/results/1/save`, {})).body;
      expect(saved.objects.filter(o => o.kind === 'product').every(o => o.asset.file.startsWith('pca-'))).toBe(true);
      expect((await s.send('POST', `/${id}/variations/${job.id}/results/1/regenerate`, {})).status).toBe(400);
      expect(prompts).toHaveLength(9);
      expect(readFileSync(join(s.protectedDir, id, 'product-r1.json'))).toEqual(masterBefore);
    } finally { await s.close(); }
  });

  it('rejects duplicate provider images instead of relabelling the same pixels as new products', async () => {
    let calls = 0;
    const png = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="white"/><rect x="40" y="30" width="120" height="240" fill="#087f5b"/></svg>')).png().toBuffer();
    const s = await setup({ artwork: { model: 'duplicate test double', offline: false, async generate() { calls++; return { png }; } } });
    try {
      const v = await savedTemplate(s, await productPosterPng()), id = v.template.id;
      const start = await s.send<VariationJob>('POST', `/${id}/variations`, { count: 1, generateProducts: true, approveProductsUsd: .18 });
      const job = await finished(s, id, start.body.id);
      expect(job.results[0].status).toBe('failed'); expect(job.results[0].error).toContain('repeated a product image');
      // A repeated image stops the batch; at most the requests already in flight (the concurrency) follow the first one.
      expect(job.state).toBe('images-rejected'); expect(calls).toBeGreaterThanOrEqual(2); expect(calls).toBeLessThanOrEqual(3);
      expect(job.productGeneration!.requests).toBe(calls); expect(job.productGeneration!.costUsd).toBeCloseTo(calls * .06, 6);
      expect((await s.send('POST', `/${id}/variations/${job.id}/results/0/decomposition`, {})).status).toBe(422);
    } finally { await s.close(); }
  });

  it('retains attempted image cost and fails visibly instead of silently keeping old products', async () => {
    let calls = 0;
    const s = await setup({ artwork: { model: 'failing test double', offline: false, async generate() { calls++; throw new Error('Provider failed'); } } });
    try {
      const v = await savedTemplate(s, await productPosterPng()), id = v.template.id;
      const start = await s.send<VariationJob>('POST', `/${id}/variations`, { count: 1, generateProducts: true, approveProductsUsd: 0.18 });
      const job = await finished(s, id, start.body.id);
      // Nothing is sent after the failure: only the requests already in flight (at most the concurrency, 2).
      expect(calls).toBeGreaterThanOrEqual(1); expect(calls).toBeLessThanOrEqual(2); expect(job.state).toBe('connection-interrupted');
      expect(job.results[0].status).toBe('failed'); expect(job.results[0].error).toContain('billing are unknown'); expect(job.operations?.every(o => o.failure?.code === 'IMAGE_TRANSPORT_INTERRUPTED')).toBe(true);
      expect(job.productGeneration!.requests).toBe(calls); expect(job.productGeneration!.costUsd).toBeCloseTo(calls * 0.06, 6);
      expect((await s.send('POST', `/${id}/variations/${job.id}/results/0/decomposition`, {})).status).toBe(422);
    } finally { await s.close(); }
  });
});
