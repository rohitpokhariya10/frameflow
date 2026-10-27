import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProductSnapshot } from '@frameflow/shared';
import { productPosterPng } from './productPoster.fixture.js';
import { setup } from './productServer.fixture.js';

describe('Choose what to decompose, and saving with blocking warnings as a draft', { timeout: 240_000 }, () => {
  it('decomposes only what is chosen (the rest stays in the background), keeps the choice, and saves a draft only when asked', async () => {
    const s = await setup();
    try {
      const made = await s.form('', await productPosterPng(), { name: 'Choice' });
      let v = await s.detected(made.body.template.id); const id = v.template.id;
      v = (await s.send('PUT', `/${id}/review`, { expectedRevision: v.template.revision, objects: v.product.objects.map(o => ({ ...o, accepted: true })), texts: [], logos: [], dismissMissingText: true })).body;
      // Nothing chosen: refused. The washing machine left in the background; the mascot and two products cut out.
      expect((await s.send('PUT', `/${id}/selection`, { expectedRevision: v.template.revision, objects: v.product.objects.map(o => ({ id: o.id, decompose: false })), logos: [] })).status).toBe(400);
      v = (await s.send('PUT', `/${id}/selection`, { expectedRevision: v.template.revision, objects: v.product.objects.map(o => ({ id: o.id, decompose: o.kind === 'character' || (o.kind === 'product' && o.label !== 'Washing machine') })), logos: [] })).body;
      expect(v.product.objects.find(o => o.label === 'Washing machine')!.decompose).toBe(false);
      await s.send('POST', `/${id}/prepare`, { expectedRevision: v.template.revision });
      v = await s.prepared(id);
      expect(v.product.objects.filter(o => o.cutout).map(o => o.label).sort()).toEqual(['Mascot', 'Refrigerator', 'Television']);
      // A review that does not change the washing machine keeps the choice.
      v = (await s.send('PUT', `/${id}/review`, { expectedRevision: v.template.revision, objects: v.product.objects.map(o => ({ ...o, accepted: true })), texts: [], logos: [], dismissMissingText: true })).body;
      expect(v.product.objects.find(o => o.label === 'Washing machine')!.decompose).toBe(false);
      await s.send('POST', `/${id}/prepare`, { expectedRevision: v.template.revision });
      v = await s.prepared(id);
      // A blocking problem (made up here: the prepared checks given one) refuses a plain save; a draft is saved when asked.
      const file = join(s.protectedDir, id, 'template.json'), t = JSON.parse(readFileSync(file, 'utf8'));
      t.product.prepared.quality.issues.push({ id: 'outline-test', area: { x: 0, y: 0, width: 10, height: 10 }, message: 'A test outline.', blocking: true });
      const { writeFileSync } = await import('node:fs'); writeFileSync(file, JSON.stringify(t));
      v = (await s.call<typeof v>(`/${id}`)).body;
      const ack = v.product.prepared!.quality.issues.map(i => i.id);
      expect((await s.send('POST', `/${id}/approve`, { expectedRevision: v.template.revision, acknowledge: ack })).status).toBe(422);
      v = (await s.send('POST', `/${id}/approve`, { expectedRevision: v.template.revision, acknowledge: ack, draft: true })).body;
      const saved = await s.send('POST', `/${id}/publish`, { expectedRevision: v.template.revision });
      expect(saved.status).toBe(201);
      expect(saved.body.product.revisions.at(-1)).toMatchObject({ revision: 1, draft: true });
      const snapshot = JSON.parse(readFileSync(join(s.protectedDir, id, 'product-r1.json'), 'utf8')) as ProductSnapshot;
      expect(snapshot.draft?.warnings.find(w => w.id === 'outline-test')).toMatchObject({ blocking: true });
      expect(snapshot.decomposition?.elements.find(e => e.label === 'Washing machine')).toMatchObject({ decompose: false });
      expect((await s.call<{ templates: { id: string; draft?: boolean }[] }>('')).body.templates.find(x => x.id === id)).toMatchObject({ draft: true });
    } finally { await s.close(); }
  });

  it('a product the detection missed, drawn in the review, is decomposed as its own layer', async () => {
    const s = await setup();
    try {
      const made = await s.form('', await productPosterPng(), { name: 'Missed' });
      let v = await s.detected(made.body.template.id); const id = v.template.id;
      // As if the detection had missed the refrigerator: the review removes it, then the reviewer draws it again.
      const fridge = v.product.objects.find(o => o.label === 'Refrigerator')!;
      v = (await s.send('PUT', `/${id}/review`, { expectedRevision: v.template.revision, objects: v.product.objects.filter(o => o.id !== fridge.id).map(o => ({ ...o, accepted: true })), texts: [], logos: [], dismissMissingText: true })).body;
      expect(v.product.objects.some(o => o.label === 'Refrigerator')).toBe(false);
      v = (await s.send('PUT', `/${id}/review`, { expectedRevision: v.template.revision, objects: [...v.product.objects.map(o => ({ ...o, accepted: true })), { kind: 'product', label: 'Fridge (drawn)', box: fridge.box, accepted: true }], texts: [], logos: [], dismissMissingText: true })).body;
      const drawn = v.product.objects.find(o => o.label === 'Fridge (drawn)')!;
      expect(drawn).toMatchObject({ origin: 'user', kind: 'product' });
      await s.send('POST', `/${id}/prepare`, { expectedRevision: v.template.revision });
      v = await s.prepared(id);
      const cut = v.product.objects.find(o => o.id === drawn.id)!.cutout!;
      expect(cut).toBeDefined();
      expect(cut.coverage).toBeGreaterThan(0.5);
      expect(v.product.prepared!.quality.issues.filter(i => i.blocking)).toEqual([]);
    } finally { await s.close(); }
  });
});
