import { describe, expect, it } from 'vitest';
import { appliancesAnalysis, holdingBallAnalysis, phoneOfferAnalysis } from '../../../server/src/decomposition/creativeTemplates/scene.fixture.js';
import { basePlan, cleanDraft, type SceneDraft } from './changePlan.js';
import { coverage, editStrategy, LOCAL_AREA_LIMIT } from './editStrategy.js';
import { parseSceneDescription, type SceneDescription } from './scene.js';

// Which edit a resolved plan gets: local where every change has its own region, the products cut out for a restyled
// background, a whole-image edit only when the changes cover most of the image, and no request when nothing changes.
const scene = (raw: unknown) => parseSceneDescription(raw);
const plan = (s: SceneDescription, edits: SceneDraft['edits']) => basePlan(s, cleanDraft(s, { edits }));
const inside = (outer: { x: number; y: number; w: number; h: number }, inner: { x: number; y: number; w: number; h: number }) =>
  outer.x <= inner.x + 1e-9 && outer.y <= inner.y + 1e-9 && outer.x + outer.w >= inner.x + inner.w - 1e-9 && outer.y + outer.h >= inner.y + inner.h - 1e-9;

describe('the edit strategy of a resolved plan', () => {
  it('nothing changes: no image request at all', () => {
    const s = scene(phoneOfferAnalysis());
    expect(editStrategy(s, plan(s, {}))).toMatchObject({ kind: 'none', regions: [] });
  });

  it('a replaced product, its own brand mark and its offer text: three local regions, each around its own item, and the rest kept', () => {
    const s = scene(phoneOfferAnalysis()), p = plan(s, { smartphone_1: { action: 'replace', value: 'Xiaomi phone' }, earbuds_1: { action: 'keep' } }), st = editStrategy(s, p);
    expect(st.kind).toBe('local');
    expect(st.regions.map(r => r.targetId).sort()).toEqual(['mark_2', 'smartphone_1', 'text_1']);
    for (const r of st.regions) { const t = s.objects.find(o => o.id === r.targetId) ?? s.marks.find(m => m.id === r.targetId) ?? s.overlays.find(o => o.id === r.targetId); expect(inside(r.box, t!.box), r.targetId).toBe(true); }
    // The earbuds, the merchant and bank logos and the bank's offer are outside every region.
    for (const box of [s.objects.find(o => o.id === 'earbuds_1')!.box, s.marks.find(m => m.kind === 'bank_logo')!.box]) expect(st.regions.some(r => coverage([r.box, box]) < coverage([r.box]) + coverage([box]) - 1e-6), JSON.stringify(box)).toBe(false);
    expect(st.areaPercent).toBeLessThan(LOCAL_AREA_LIMIT * 100);
    expect(st.reasons[0]).toMatch(/every other pixel stays your image's own/);
  });

  it('a new held object: the hand around it is editable, not the whole person', () => {
    const s = scene(holdingBallAnalysis()), st = editStrategy(s, plan(s, { football_1: { action: 'replace', value: 'green water bottle' } }));
    expect(st.kind).toBe('local');
    const man = s.objects.find(o => o.id === 'man_1')!.box, hand = st.regions.find(r => r.targetId === 'man_1')!.box;
    expect(hand.w * hand.h).toBeLessThan(man.w * man.h * 0.5);
  });

  it('a restyled background keeps every product that stays as its own pixels; a replaced product is not protected', () => {
    const s = scene(phoneOfferAnalysis());
    expect(editStrategy(s, plan(s, { background_1: { action: 'modify', value: 'warm sunset gradient' } }))).toMatchObject({ kind: 'background', protectIds: ['earbuds_1', 'smartphone_1'] });
    // Feature 2 keeps the layout: with a replaced phone the background pass keeps it in place too, then it is repainted in its own slot.
    expect(editStrategy(s, plan(s, { background_1: { action: 'modify', value: 'warm sunset gradient' }, smartphone_1: { action: 'replace', value: 'Xiaomi phone' }, earbuds_1: { action: 'keep' } }))).toMatchObject({ kind: 'layered', protectIds: ['earbuds_1', 'smartphone_1'] });
  });

  it('changes covering most of the image still edit only their own slots (Feature 2 never re-composes the template)', () => {
    const s = scene(appliancesAnalysis()), st = editStrategy(s, plan(s, { refrigerator_1: { action: 'replace', value: 'black refrigerator' }, washing_machine_1: { action: 'replace', value: 'grey dryer' } }));
    expect(st.kind).toBe('local');
    expect(st.areaPercent).toBeGreaterThan(LOCAL_AREA_LIMIT * 100);
  });
});
