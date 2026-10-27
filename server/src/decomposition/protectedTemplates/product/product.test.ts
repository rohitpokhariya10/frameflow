import sharp from 'sharp';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRODUCT_OBJECTS, PRODUCT_POSTER, productPosterPng } from './productPoster.fixture.js';
import { setup, sha } from './productServer.fixture.js';

describe('Product with Text templates: creation and detection', { timeout: 120_000 }, () => {
  it('finds the creatives on a reference sheet and makes a template of one, cropped exactly (the sheet is kept)', async () => {
    const s = await setup();
    try {
      const poster = await productPosterPng(), sheet = await sharp({ create: { width: 2200, height: 1400, channels: 3, background: '#f5f5f5' } })
        .composite([{ input: poster, left: 60, top: 100 }, { input: poster, left: 1140, top: 100 }]).png().toBuffer();
      const found = await s.form<{ sheet: boolean; boxes: { x: number; y: number; width: number; height: number }[] }>('/sheet', sheet);
      expect(found.status).toBe(200);
      expect(found.body.sheet).toBe(true);
      expect(found.body.boxes).toEqual([{ x: 60, y: 100, width: 1000, height: 1200 }, { x: 1140, y: 100, width: 1000, height: 1200 }]);
      // A single creative is not a sheet.
      expect((await s.form<{ sheet: boolean }>('/sheet', poster)).body.sheet).toBe(false);
      const made = await s.form('', sheet, { name: 'Festive offer', crop: JSON.stringify(found.body.boxes[1]) });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      const v = await s.detected(made.body.template.id);
      expect(v.template.source).toMatchObject({ width: 1000, height: 1200 });
      // The creative's own pixels, byte for byte the region of the sheet; the sheet itself stored as uploaded.
      const stored = await sharp(join(s.protectedDir, v.template.id, v.template.source.file)).raw().toBuffer(), region = await sharp(sheet).extract({ left: 1140, top: 100, width: 1000, height: 1200 }).raw().toBuffer();
      expect(stored.equals(region)).toBe(true);
      expect(v.product.sheet).toMatchObject({ width: 2200, height: 1400, crop: { x: 1140, y: 100, width: 1000, height: 1200 }, sha256: sha(sheet) });
      expect(v.product.history.map(h => h.action)).toEqual(['created', 'cropped', 'detected']);
      // Its own flow: not in the Text & Graphics masters, nor in the generic protected templates list.
      const lists = await Promise.all(['master-templates', 'protected-templates'].map(async p => (await fetch(`${s.base.replace(/product-templates$/, p)}`)).json()));
      expect(JSON.stringify(lists)).not.toContain(v.template.id);
      expect((await s.call<{ templates: { id: string }[] }>('')).body.templates.map(t => t.id)).toContain(v.template.id);
    } finally { await s.close(); }
  });

  it('finds every character, product, text block and logo; leaves printed text out; flags only what needs a look', async () => {
    const s = await setup();
    try {
      const made = await s.form('', await productPosterPng(), { name: 'Festive offer' });
      const v = await s.detected(made.body.template.id);
      expect(v.stage).toBe('review');
      expect(s.analyzer.calls).toBe(1);
      expect(v.product.detection).toMatchObject({ status: 'done', ai: { status: 'done', offline: true } });
      // One character, three separate products, the podium; the merchant's wordmark is the brand logo (a visual object).
      expect(v.counts).toMatchObject({ characters: 1, products: 3, background: 1 });
      const kinds = Object.fromEntries(v.product.objects.map(o => [o.label, o.kind]));
      expect(kinds).toMatchObject({ Mascot: 'character', Television: 'product', 'Washing machine': 'product', Refrigerator: 'product', Podium: 'podium' });
      expect(v.product.objects.filter(o => o.kind === 'brand-logo')).toHaveLength(0);
      expect(v.logos.filter(l => l.category === 'brand-logo')).toHaveLength(1);
      const fridge = v.product.objects.find(o => o.label === 'Refrigerator')!;
      expect(fridge.box).toEqual({ x: PRODUCT_OBJECTS.fridge.x, y: PRODUCT_OBJECTS.fridge.y, width: PRODUCT_OBJECTS.fridge.width, height: PRODUCT_OBJECTS.fridge.height });
      // Bank logos are editable logos (overlays); text comes in blocks with their roles; "LG" printed on the fridge is not text.
      expect(v.logos.filter(l => l.category === 'partner-logo' && !l.removed)).toHaveLength(3);
      const blocks = v.texts.filter(t => !t.removed);
      expect(blocks.map(b => [b.text, b.category])).toEqual(expect.arrayContaining([['Grand Savings', 'headline'], ['Get 26% cashback', 'offer'], ['T&Cs apply', 'legal']]));
      expect(blocks.some(b => b.text.includes('LG'))).toBe(false);
      // Needs attention: only the uncertain television, the uncertain "26%" and the text the reading missed.
      expect(v.attention.map(a => [a.type, a.label])).toEqual(expect.arrayContaining([['object', 'Television'], ['text', 'Get 26% cashback'], ['missing', 'Hurry']]));
      expect(v.attention).toHaveLength(3);
      // Back to front: the podium behind what stands on it, the brand logo on top.
      const podium = v.product.objects.find(o => o.kind === 'podium')!, washer = v.product.objects.find(o => o.label === 'Washing machine')!;
      expect(podium.z).toBeLessThan(washer.z);
      expect(washer.covers).toContain(podium.id);

      expect(v.template.source).toMatchObject(PRODUCT_POSTER);
    } finally { await s.close(); }
  });

  it('applies the review as one state: moves, kinds, removals, additions, retyped text and logos; refuses a stale one', async () => {
    const s = await setup();
    try {
      const made = await s.form('', await productPosterPng(), { name: 'Festive offer' });
      let v = await s.detected(made.body.template.id);
      const objects = v.product.objects.map(o => ({ id: o.id, kind: o.kind, label: o.label, box: o.box }));
      const tv = objects.find(o => o.label === 'Television')!; tv.box = { ...tv.box, x: tv.box.x - 4, width: tv.box.width + 8 };
      // The podium is called decoration; a fourth product drawn by hand; the brand logo becomes a bank logo (an overlay).
      objects.find(o => o.kind === 'podium')!.kind = 'decoration';
      const brand = v.logos.find(o => o.category === 'brand-logo')!;
      const next = objects.concat([{ id: undefined as unknown as string, kind: 'product', label: 'Speaker', box: { x: 860, y: 700, width: 60, height: 100 } }]);
      const legal = v.texts.find(t => t.category === 'legal')!, offer = v.texts.find(t => t.category === 'offer')!;
      const before = v.product.objectsRevision;
      const reviewed = await s.send('PUT', `/${v.template.id}/review`, { expectedRevision: v.template.revision, objects: next,
        texts: [{ groupId: legal.id, removed: true }, { groupId: offer.id, text: 'Get 30% cashback today', accepted: true }],
        logos: [{ slotId: brand.id, box: brand.box, category: 'partner-logo', label: 'ACME' }], dismissMissingText: true });
      expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
      v = reviewed.body;
      expect(v.product.objectsRevision).toBe(before + 1);
      expect(v.counts).toMatchObject({ products: 4, background: 1, characters: 1 });
      expect(v.product.objects.find(o => o.label === 'Television')!.review).toMatchObject({ status: 'accepted', by: 'user' });
      expect(v.product.objects.find(o => o.label === 'Speaker')).toMatchObject({ kind: 'product', origin: 'user', review: { status: 'accepted' } });
      expect(v.product.objects.some(o => o.kind === 'brand-logo')).toBe(false);
      expect(v.logos.filter(l => !l.removed && l.label === 'ACME')).toHaveLength(1);
      expect(v.texts.find(t => t.id === legal.id)!.removed).toBe(true);
      expect(v.texts.find(t => t.id === offer.id)!.text).toBe('Get 30% cashback today');
      expect(v.attention).toEqual([]);
      // A second tab's older state is refused.
      expect((await s.send('PUT', `/${v.template.id}/review`, { expectedRevision: v.template.revision - 1, objects: [], texts: [], logos: [] })).status).toBe(409);
    } finally { await s.close(); }
  });

  it('without a vision analysis finds the text, logos and brand mark locally, and adds no guessed objects', async () => {
    const s = await setup({ analyzer: false });
    try {
      const made = await s.form('', await productPosterPng(), { name: 'Local only' });
      const v = await s.detected(made.body.template.id);
      expect(v.product.detection).toMatchObject({ status: 'failed', ai: { status: 'skipped' } });
      expect(v.counts).toMatchObject({ characters: 0, products: 0 });
      expect(v.product.objects).toEqual([]);
      expect((await s.send('POST', `/${v.template.id}/prepare`, { expectedRevision: v.template.revision })).status).toBe(422);
      expect(v.texts.filter(t => !t.removed).length).toBeGreaterThanOrEqual(3);
      expect(v.logos.filter(l => l.category === 'partner-logo')).toHaveLength(3);
    } finally { await s.close(); }
  });

  it('prepares (locally, or with the approved cut-out service), approves with every check confirmed and saves revisions', async () => {
    const s = await setup({ segmenter: true });
    try {
      const made = await s.form('', await productPosterPng(), { name: 'Festive offer' });
      let v = await s.detected(made.body.template.id);
      const id = v.template.id;
      v = (await s.send('PUT', `/${id}/review`, { expectedRevision: v.template.revision, objects: v.product.objects.map(o => ({ ...o, accepted: true })), texts: [], logos: [] })).body;
      // Nothing to save before it is prepared and approved.
      expect((await s.send('POST', `/${id}/publish`, { expectedRevision: v.template.revision })).status).toBe(422);
      const estimate = (await s.call<{ objects: number; sam3: { configured: boolean; requests: number; usd: number } }>(`/${id}/prepare-estimate`)).body;
      expect(estimate).toMatchObject({ objects: 4, sam3: { configured: true, requests: 4, usd: 0.04 } });
      expect((await s.send('POST', `/${id}/prepare`, { expectedRevision: v.template.revision - 1 })).status).toBe(409);
      expect((await s.send<{ started: boolean }>('POST', `/${id}/prepare`, { expectedRevision: v.template.revision })).status).toBe(202);
      v = await s.prepared(id);
      expect(v.stage, JSON.stringify(v.product.preparing)).toBe('prepared');
      expect(s.segmenter.calls).toHaveLength(0);
      const p = v.product.prepared!;
      expect(p.separation).toMatchObject({ method: 'local', requests: 0, costUsd: 0 });
      expect(v.product.activity.costUsd).toBe(0);
      // Each character and product has its cut-out and slot (stands on its contact line); every file is stored.
      for (const o of v.product.objects.filter(o => o.kind === 'character' || o.kind === 'product')) {
        expect(o.cutout, o.label).toBeDefined();
        expect((await s.fetchFile(id, o.cutout!.file)).headers.get('content-type'), o.label).toBe('image/png');
        if (o.kind === 'character' || o.kind === 'product') expect(o.slot, o.label).toMatchObject({ contactY: expect.any(Number), targetHeight: expect.any(Number), z: o.z });
        else expect(o.slot).toBeUndefined();
      }
      const fridge = v.product.objects.find(o => o.label === 'Refrigerator')!;
      expect(Math.abs(fridge.slot!.contactY - (PRODUCT_OBJECTS.fridge.y + PRODUCT_OBJECTS.fridge.height - 1))).toBeLessThanOrEqual(2);
      // Approving needs every check confirmed.
      const checks = p.quality.issues.map(i => i.id);
      expect(checks.length).toBeGreaterThan(0);
      const unconfirmed = await s.send<{ code: string; details: { issues: string[] } }>('POST', `/${id}/approve`, { expectedRevision: v.template.revision, acknowledge: [] });
      expect(unconfirmed.status).toBe(422);
      const approved = await s.send('POST', `/${id}/approve`, { expectedRevision: v.template.revision, acknowledge: checks });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      const saved = await s.send('POST', `/${id}/publish`, { expectedRevision: approved.body.template.revision });
      expect(saved.status, JSON.stringify(saved.body)).toBe(201);
      v = saved.body;
      expect(v.stage).toBe('ready');
      expect(v.product.revisions.map(r => r.revision)).toEqual([1]);
      const r1 = (await s.call<{ revision: number; objects: { id: string }[]; words: unknown[]; logoSlots: unknown[]; base: { sha256: string } }>(`/${id}/revisions/1`)).body;
      expect(r1).toMatchObject({ revision: 1, base: { sha256: p.base.sha256 } });
      expect(r1.objects).toHaveLength(4);
      expect(r1.logoSlots).toHaveLength(4);
      // Prepared again with the cut-out service (approved): one request per object, only the clean picture; saved as
      // revision 2, revision 1 kept as it was.
      expect((await s.send('POST', `/${id}/prepare`, { expectedRevision: v.template.revision, paid: true })).status).toBe(202);
      v = await s.prepared(id);
      expect(v.stage).toBe('prepared');
      expect(s.segmenter.calls).toHaveLength(4);
      expect(sha(Buffer.from(s.segmenter.calls[0].image))).not.toBe(v.product.prepared!.clean.sha256);
      expect(v.product.prepared!.separation).toMatchObject({ method: 'sam3', requests: 4, costUsd: 0.04 });
      expect(v.product.activity).toMatchObject({ segmentRequests: 4, costUsd: 0.04 });
      v = (await s.send('POST', `/${id}/approve`, { expectedRevision: v.template.revision, acknowledge: v.product.prepared!.quality.issues.map(i => i.id) })).body;
      v = (await s.send('POST', `/${id}/publish`, { expectedRevision: v.template.revision })).body;
      expect(v.product.revisions.map(r => r.revision)).toEqual([1, 2]);
      const again = (await s.call<{ base: { sha256: string } }>(`/${id}/revisions/1`)).body;
      expect(again).toEqual(r1);
      expect(v.product.history.map(h => h.action)).toEqual(['created', 'detected', 'reviewed', 'prepared', 'approved', 'saved', 'prepared', 'approved', 'saved']);
    } finally { await s.close(); }
  });

  it('refuses the cut-out service when it is not configured', async () => {
    const s = await setup();
    try {
      const made = await s.form('', await productPosterPng(), { name: 'Festive offer' });
      const v = await s.detected(made.body.template.id);
      expect((await s.call<{ sam3: { configured: boolean } }>(`/${v.template.id}/prepare-estimate`)).body.sam3.configured).toBe(false);
      const reviewed = (await s.send('PUT', `/${v.template.id}/review`, { expectedRevision: v.template.revision, objects: v.product.objects.map(o => ({ ...o, accepted: true })), texts: [], logos: [] })).body;
      const refused = await s.send<{ code: string }>('POST', `/${v.template.id}/prepare`, { expectedRevision: reviewed.template.revision, paid: true });
      expect(refused.status).toBe(503);
    } finally { await s.close(); }
  });
});
