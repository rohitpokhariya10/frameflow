import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { ProductCreative } from '@frameflow/shared';
import { readRun } from '../../layerizeExperiment.js';
import { PRODUCT_OBJECTS, productPosterPng } from './productPoster.fixture.js';
import { savedTemplate, setup, sha } from './productServer.fixture.js';

/** A studio packshot: a blue speaker on a white backdrop (240×400). */
const packshot = () => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="400"><rect width="240" height="400" fill="#ffffff"/>
  <rect x="40" y="30" width="160" height="340" rx="20" fill="#1e40af"/><circle cx="120" cy="250" r="50" fill="#93c5fd"/></svg>`)).png().toBuffer();
/** A photo on a scene: a gradient backdrop (no plain colour to take out). */
const scenePhoto = () => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#16a34a"/><stop offset="1" stop-color="#facc15"/></linearGradient></defs>
  <rect width="300" height="300" fill="url(#g)"/><rect x="90" y="60" width="120" height="200" fill="#7c3aed"/></svg>`)).png().toBuffer();
const upload = (s: Awaited<ReturnType<typeof setup>>, path: string, file: Buffer, fields: Record<string, string>) => {
  const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); f.append('image', new Blob([new Uint8Array(file)], { type: 'image/png' }), 'speaker.png');
  return s.call<{ creative: ProductCreative; cutout: { background: string; note?: string } }>(path, { method: 'POST', body: f });
};

describe('Product with Text templates: reusing a saved template', { timeout: 180_000 }, () => {
  it('makes creatives of a revision; replaces a product in its slot; edits; keeps every revision; opens in the editor', async () => {
    const s = await setup();
    try {
      const png = await productPosterPng(), v = await savedTemplate(s, png), id = v.template.id;
      const sourceBefore = readFileSync(join(s.protectedDir, id, v.template.source.file)), r1Before = readFileSync(join(s.protectedDir, id, 'product-r1.json'));
      const made = await s.send<ProductCreative>('POST', `/${id}/creatives`, { name: 'Diwali TV offer' });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      let c = made.body;
      expect(c).toMatchObject({ templateRevision: 1, revision: 1, name: 'Diwali TV offer' });
      // Every object its own cut-out; text as words in their groups; bank logos as pictures.
      expect(c.objects.map(o => o.label).sort()).toEqual(['Mascot', 'Refrigerator', 'Television', 'Washing machine']);
      expect(c.texts.map(t => t.text)).toEqual(expect.arrayContaining(['Grand', 'Savings', 'Get', '26%', 'cashback', 'T&Cs', 'apply']));
      expect(c.texts.some(t => t.text === 'LG' || t.text === 'ACME')).toBe(false);
      expect(c.images.filter(i => i.category === 'partner-logo')).toHaveLength(3);
      // The television replaced by a packshot: its white backdrop removed, as tall as the slot, standing on the podium.
      const tv = c.objects.find(o => o.label === 'Television')!, slot = v.product.objects.find(o => o.id === tv.objectId)!.slot!;
      const replaced = await upload(s, `/${id}/creatives/${c.id}/objects/${tv.id}/replace`, await packshot(), { expectedRevision: String(c.revision) });
      expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
      expect(replaced.body.cutout.background).toBe('removed');
      c = replaced.body.creative;
      const speaker = c.objects.find(o => o.id === tv.id)!;
      expect(speaker.asset).toMatchObject({ kind: 'upload', background: 'removed', width: 160, height: 340 });
      expect(speaker.box.y + speaker.box.height - 1).toBe(slot.contactY);
      expect(speaker.box.height).toBe(slot.targetHeight);
      expect(Math.abs(speaker.box.x + speaker.box.width / 2 - (slot.box.x + slot.box.width / 2))).toBeLessThanOrEqual(1);
      const cut = await sharp(join(s.protectedDir, id, (speaker.asset as { file: string }).file)).raw().toBuffer({ resolveWithObject: true });
      expect(cut.data[3]).toBeLessThan(40); // a corner: the backdrop's place, clear
      expect(cut.data[(170 * cut.info.width + 80) * 4 + 3]).toBe(255);
      // A photo on a scene cannot be cut out locally: kept whole, and said so.
      const washer = c.objects.find(o => o.label === 'Washing machine')!;
      const kept = await upload(s, `/${id}/creatives/${c.id}/objects/${washer.id}/replace`, await scenePhoto(), { expectedRevision: String(c.revision) });
      expect(kept.body.cutout).toMatchObject({ background: 'kept', note: expect.stringContaining('cut-out PNG') });
      c = kept.body.creative;
      // And back to the template's own washing machine.
      c = (await s.send<ProductCreative>('POST', `/${id}/creatives/${c.id}/objects/${washer.id}/restore`, { expectedRevision: c.revision })).body;
      expect(c.objects.find(o => o.id === washer.id)).toMatchObject({ asset: { kind: 'template' }, box: { x: expect.any(Number) } });
      // Text and position edits are a new revision; a stale one is refused.
      const edited: ProductCreative = { ...c, texts: c.texts.map(t => (t.text === '26%' ? { ...t, text: '30%' } : t)), objects: c.objects.map(o => (o.label === 'Mascot' ? { ...o, box: { ...o.box, x: o.box.x + 20 } } : o)) };
      const saved = await s.send<ProductCreative>('PUT', `/${id}/creatives/${c.id}`, { expectedRevision: c.revision, creative: edited });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(saved.body.revision).toBe(c.revision + 1);
      expect((await s.send('PUT', `/${id}/creatives/${c.id}`, { expectedRevision: c.revision, creative: edited })).status).toBe(409);
      // A picture can be placed only through "Replace" (never by naming a stored file).
      const sneaky = { ...saved.body, objects: saved.body.objects.map(o => (o.label === 'Mascot' ? { ...o, asset: { kind: 'upload', file: 'product-r1.json', sha256: 'x', width: 1, height: 1, background: 'kept' } } : o)) };
      expect((await s.send('PUT', `/${id}/creatives/${c.id}`, { expectedRevision: saved.body.revision, creative: sneaky })).status).toBe(400);
      c = saved.body;
      // Every revision kept, each readable as it was.
      const r2 = (await s.call<ProductCreative>(`/${id}/creatives/${c.id}?revision=2`)).body;
      expect(r2.objects.find(o => o.id === tv.id)!.asset.kind).toBe('upload');
      expect(r2.texts.find(t => t.text === '30%')).toBeUndefined();
      expect((await s.call<{ creatives: { id: string; revision: number; replaced: number }[] }>(`/${id}/creatives`)).body.creatives).toEqual([expect.objectContaining({ id: c.id, revision: c.revision, replaced: 1 })]);
      // Opened in the editor: an ordinary run with each element its own layer, made once per revision.
      const opened = await s.call<{ runId: string; created: boolean }>(`/${id}/creatives/${c.id}/open`, { method: 'POST' });
      expect(opened.status).toBe(201);
      expect((await s.call<{ runId: string; created: boolean }>(`/${id}/creatives/${c.id}/open`, { method: 'POST' })).body).toEqual({ runId: opened.body.runId, created: false });
      const run = readRun(join(s.root, 'runs', opened.body.runId));
      if (process.env.PRODUCT_LOOK) (await import('node:fs')).copyFileSync(join(s.root, 'runs', run.id, 'original.png'), process.env.PRODUCT_LOOK);
      expect(run.creative).toMatchObject({ product: true, masterId: id, creativeId: c.id, creativeRevision: c.revision });
      const kinds = run.creative!.layers.map(l => l.kind);
      expect(kinds[0]).toBe('background');
      expect(kinds.filter(k => k === 'object')).toHaveLength(4);
      expect(kinds.filter(k => k === 'artwork')).toHaveLength(0);
      expect(kinds.filter(k => k === 'image')).toHaveLength(4);
      expect(kinds.filter(k => k === 'text').length).toBeGreaterThanOrEqual(3);
      // Text and logos above every object in the editor too.
      const top = Math.max(...run.creative!.layers.filter(l => l.kind === 'object' || l.kind === 'artwork').map(l => l.z));
      expect(Math.min(...run.creative!.texts.map(t => t.z), ...run.creative!.layers.filter(l => l.kind === 'image').map(l => l.z))).toBeGreaterThan(top);
      // The run's picture shows the fridge exactly as in the template (its own pixels, untouched).
      const composite = await sharp(join(s.root, 'runs', run.id, 'original.png')).removeAlpha().raw().toBuffer(), source = await sharp(png).removeAlpha().raw().toBuffer();
      let differ = 0; const f = PRODUCT_OBJECTS.fridge;
      for (let y = f.y + 60; y < f.y + f.height - 4; y++) for (let x = f.x + 4; x < f.x + f.width - 4; x++) { const i = (y * 1000 + x) * 3; if (Math.abs(composite[i] - source[i]) + Math.abs(composite[i + 1] - source[i + 1]) + Math.abs(composite[i + 2] - source[i + 2]) > 12) differ++; }
      expect(differ).toBeLessThan(20);
      // A copy; the template, its source and its saved revision untouched.
      const copy = await s.send<ProductCreative>('POST', `/${id}/creatives/${c.id}/duplicate`, {});
      expect(copy.status).toBe(201);
      expect(copy.body).toMatchObject({ revision: 1, origin: { kind: 'duplicate', creativeId: c.id } });
      expect(copy.body.objects.find(o => o.id === tv.id)!.asset.kind).toBe('upload');
      expect(sha(readFileSync(join(s.protectedDir, id, v.template.source.file)))).toBe(sha(sourceBefore));
      expect(readFileSync(join(s.protectedDir, id, 'product-r1.json')).equals(r1Before)).toBe(true);
    } finally { await s.close(); }
  });
});
