import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { reuseCanvasFor, type ProductCreative, type ReuseAspectRatio, type ReuseDraft } from '@frameflow/shared';
import { setup, savedTemplate } from './productServer.fixture.js';
import { productPosterPng } from './productPoster.fixture.js';
import { frameBackground, planFrame } from './reuseLayout.js';
import { checkPlacement, geometryPlacement, shapeMismatch, type PlacementInput, type ReusePlacementPlanner } from './reusePlacement.js';
import { cleanStage } from './stageCleanup.js';
import { refineCluster } from './reuseCluster.js';
type ReusePreview = { ratio: ReuseAspectRatio; creative: ProductCreative; checks: { status: string } };

const inter = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

describe('Reuse Template frames (never stretched)', () => {
  const source = { width: 4096, height: 4096 };
  const badge = { id: 'po-badge', label: 'Promotional badge', box: { x: 3264, y: 2101, width: 665, height: 735 } }, flowers = { id: 'po-flowers', label: 'Flower ornaments', box: { x: 1775, y: 229, width: 538, height: 179 } };
  it('slices narrower formats at the artwork’s own size with every decoration whole, and mirrors only clean side strips for wider ones', async () => {
    expect(planFrame(source, 'original', [badge, flowers]).method).toBe('template');
    for (const [ratio, width] of [['4:9', 1820], ['3:9', 1365]] as const) {
      const f = planFrame(source, ratio, [badge, flowers]);
      expect(f).toMatchObject({ method: 'slice', scale: 1, canvas: { width, height: 4096 } });
      // Flowers wholly inside, the badge wholly outside (reported): never cut in two.
      expect(f.x0).toBeLessThanOrEqual(flowers.box.x); expect(f.x0 + width).toBeGreaterThanOrEqual(flowers.box.x + flowers.box.width);
      expect(f.excluded).toEqual(['Promotional badge']);
    }
    const wide = planFrame(source, '16:9', [badge, flowers]);
    expect(wide).toMatchObject({ method: 'mirror-extend', canvas: { width: 4096, height: 2304 } });
    expect(wide.scale).toBeCloseTo(2304 / 4096, 6); expect(wide.filledPercent).toBeGreaterThan(0);
    // The right strip that is mirrored stays right of the badge (a badge is never mirrored).
    expect(source.width - wide.stripRight / wide.scale).toBeGreaterThanOrEqual(badge.box.x + badge.box.width);
    expect(reuseCanvasFor({ width: 1080, height: 1080 }, '4:9')).toEqual({ width: 480, height: 1080 });
    // The pixels: a slice is an exact crop; a wider frame keeps the scaled artwork untouched in its middle.
    const art = await sharp({ create: { width: 400, height: 400, channels: 4, background: '#22aa55' } }).composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect x="180" y="40" width="40" height="300" fill="#ff0000"/><rect x="0" y="0" width="20" height="400" fill="#0000ff"/></svg>'), left: 0, top: 0 }]).png().toBuffer();
    const slice = planFrame({ width: 400, height: 400 }, '4:9'), sliced = await frameBackground(art, slice);
    expect(await sharp(sliced).metadata()).toMatchObject({ width: slice.canvas.width, height: 400 });
    expect(await sharp(sliced).raw().toBuffer()).toEqual(await sharp(art).extract({ left: slice.x0, top: 0, width: slice.canvas.width, height: 400 }).raw().toBuffer());
    const extend = planFrame({ width: 400, height: 400 }, '16:9'), extended = await frameBackground(art, extend);
    expect(await sharp(extended).metadata()).toMatchObject(extend.canvas);
    const middle = await sharp(extended).extract({ left: extend.pad + 10, top: 10, width: 200, height: 200 }).removeAlpha().raw().toBuffer(), want = await sharp(art).resize(Math.round(400 * extend.scale), extend.canvas.height).extract({ left: 10, top: 10, width: 200, height: 200 }).removeAlpha().raw().toBuffer();
    expect(middle).toEqual(want);
  });
});

describe('Reuse Template placement', () => {
  const base: Omit<PlacementInput, 'products'> = { canvas: { width: 4096, height: 4096 }, stage: { cx: 2200, cy: 2700, a: 1250, b: 120 }, lane: { x0: 1000, x1: 3400 }, ceiling: 1700, keepOut: [{ x: 1300, y: 1450, width: 1800, height: 200, label: 'the offer text' }] };
  const product = (id: string, category: string, aspect: number) => ({ id, label: category, category, aspect });
  it('makes one product the hero, centres the tallest of three, puts five in depth rows, all standing on the stage inside the lane without overlap', () => {
    const one = geometryPlacement({ ...base, products: [product('a', 'television', 1.6)] }).boxes;
    expect(one).toHaveLength(1);
    expect(Math.abs(one[0].x + one[0].width / 2 - base.stage.cx)).toBeLessThan(5);
    expect(one[0].width).toBeGreaterThan(base.stage.a * 0.9);
    const three = geometryPlacement({ ...base, products: [product('w', 'washing machine', 0.75), product('f', 'refrigerator', 0.5), product('d', 'dishwasher', 0.72)] }).boxes;
    const byX = [...three].sort((p, q) => p.x - q.x);
    expect(byX[1].id).toBe('f'); expect(byX[1].height).toBeGreaterThan(byX[0].height * 1.3);
    const five = geometryPlacement({ ...base, products: [product('t', 'television', 1.6), product('f', 'refrigerator', 0.5), product('w', 'washing machine', 0.75), product('m', 'microwave oven', 1.6), product('a', 'air conditioner', 3.2)] }).boxes;
    expect(new Set(five.map(b => Math.round((b.y + b.height) / 10))).size).toBe(2);
    for (const boxes of [one, three, five]) for (const [i, b] of boxes.entries()) {
      expect(b.x).toBeGreaterThanOrEqual(base.lane.x0 - 1); expect(b.x + b.width).toBeLessThanOrEqual(base.lane.x1 + 1);
      expect(b.y).toBeGreaterThanOrEqual(base.ceiling - 1);
      const bottom = b.y + b.height; expect(bottom).toBeGreaterThan(base.stage.cy - base.stage.b); expect(bottom).toBeLessThan(base.stage.cy + base.stage.b);
      for (const other of boxes.slice(i + 1)) if (Math.abs(other.y + other.height - bottom) < 2) expect(inter(b, other)).toBe(0);
    }
  });
  it('uses an AI box only after checking it, and replaces a refused one by the rule’s box with the reason', () => {
    const input = { ...base, lane: { x0: 1000, x1: 2900 }, keepOut: [...base.keepOut, { x: 3000, y: 2500, width: 250, height: 150, label: 'the badge words' }], products: [product('a', 'refrigerator', 0.5), product('b', 'washing machine', 0.75), product('c', 'dishwasher', 0.72), product('d', 'television', 1.6), product('e', 'microwave oven', 1.6)] };
    const rule = geometryPlacement(input).boxes, at = (id: string) => rule.find(b => b.id === id)!;
    const raw = { notes: ['test'], products: [
      { ...at('a'), x: at('a').x + 20, role: 'hero' },
      { ...at('b'), x: -400, role: 'supporting' },
      { ...at('c'), y: 400, role: 'supporting' },
      { ...at('d'), x: 3000, role: 'supporting' },
      // Stretched three times as wide about its own centre.
      { ...at('e'), x: at('e').x - at('e').width, width: at('e').width * 3, role: 'supporting' },
    ] };
    const checked = checkPlacement(raw, input, rule);
    expect(checked.rejected.map(r => r.id)).toEqual(['b', 'c', 'd']);
    expect(checked.rejected.map(r => r.reason)).toEqual(['It would leave the canvas.', 'It would not stand on the stage.', 'It would stand outside the product area.']);
    // Most of the AI's boxes failed: the rule's whole arrangement is used (never a mix that may overlap), and said so.
    expect(checked.usedRule).toBe(true); expect(checked.boxes).toEqual(rule); expect(checked.notes.at(-1)).toContain('automatic arrangement was used');
    // One failing box: the AI's other boxes are kept, the failing one replaced by the rule's; a stretched box keeps its proportions.
    const one = checkPlacement({ products: [raw.products[0], { ...at('b'), role: 'supporting' }, { ...at('c'), role: 'supporting' }, raw.products[3], raw.products[4]] }, input, rule);
    expect(one.usedRule).toBe(false); expect(one.rejected.map(r => r.id)).toEqual(['d']); expect(one.hero).toBe('a');
    expect(one.boxes.find(b => b.id === 'a')!.x).toBe(at('a').x + 20);
    const e = one.boxes.find(b => b.id === 'e')!; expect(e.width / e.height).toBeCloseTo(1.6, 1);
    expect(one.boxes.find(b => b.id === 'd')).toMatchObject({ x: at('d').x, y: at('d').y });
    // Hidden behind the character, or outside the product area: refused.
    const hidden = checkPlacement({ products: [{ ...at('a'), x: 3050 }] }, { ...input, products: [input.products[0]], character: { x: 3000, y: 1500, width: 600, height: 1400 } }, [at('a')]);
    expect(hidden.rejected[0].reason).toBe('It would stand outside the product area.');
    const tag = { x: 2800, y: 2300, width: 200, height: 200, label: 'the price tag' }, rule1 = [{ id: 'a', x: 1500, y: 1900, width: 400, height: 800, z: 0 }];
    const cover = checkPlacement({ products: [{ id: 'a', x: 2700, y: 1900, width: 400, height: 800 }] }, { ...base, keepOut: [tag], products: [product('a', 'refrigerator', 0.5)] }, rule1);
    expect(cover.rejected[0].reason).toBe('It would cover the price tag.');
    const behind = checkPlacement({ products: [{ id: 'a', x: 1500, y: 1900, width: 400, height: 800 }] }, { ...base, products: [product('a', 'refrigerator', 0.5)], character: { x: 1400, y: 1500, width: 600, height: 1400 } }, rule1);
    expect(behind.rejected[0].reason).toBe('The character would hide it.');
    // Larger than the rule's cramped size is fine when it fits the room; reaching into the text above or beyond the room is refused.
    const roomy = checkPlacement({ products: [{ id: 'a', x: 1500, y: 1900, width: 400, height: 800 }] }, { ...base, products: [product('a', 'refrigerator', 0.5)] }, [{ ...rule1[0], height: 300, y: 2400 }]);
    expect(roomy.rejected).toEqual([]);
    const tall = checkPlacement({ products: [{ id: 'a', x: 1500, y: 1500, width: 600, height: 1200 }] }, { ...base, products: [product('a', 'refrigerator', 0.5)] }, rule1);
    expect(tall.rejected[0].reason).toMatch(/does not fit the room on the stage|reach into the text above/);
    const intoText = checkPlacement({ products: [{ id: 'a', x: 1500, y: 1640, width: 410, height: 820 }] }, { ...base, ceiling: 1700, stage: { ...base.stage, b: 200 }, products: [product('a', 'refrigerator', 0.5)] }, rule1);
    expect(intoText.rejected[0].reason).toBe('It would reach into the text above it.');
    // A product hiding a third of the one behind it is refused.
    const two = [product('a', 'refrigerator', 0.5), product('b', 'washing machine', 0.75)], back = { id: 'a', x: 1500, y: 1900, width: 400, height: 800, z: 0 }, front = { id: 'b', x: 1520, y: 2100, width: 450, height: 600, z: 5 };
    expect(checkPlacement({ products: [back, front] }, { ...base, products: two }, [back, { ...front, x: 2200 }]).rejected[0].reason).toBe('It would hide another product.');
    // A tiny picture is never blown up: the AI's box is made smaller where it stands (not refused), with a note.
    const tiny = { ...product('s', 'speaker', 2), pixels: { width: 56, height: 28 } };
    const shrunk = checkPlacement({ products: [{ id: 's', x: 1800, y: 2540, width: 320, height: 160, role: 'supporting' }] }, { ...base, products: [tiny] }, [{ id: 's', x: 1800, y: 2620, width: 168, height: 84, z: 0 }]);
    expect(shrunk.rejected).toEqual([]); const sb = shrunk.boxes[0];
    expect(sb.height).toBe(84); expect(sb.y + sb.height).toBe(2700); expect(Math.abs(sb.x + sb.width / 2 - 1960)).toBeLessThanOrEqual(1);
    expect(shrunk.notes.at(-1)).toContain('made smaller to stay sharp');
    expect(geometryPlacement({ ...base, products: [tiny] }).boxes[0].height).toBeLessThanOrEqual(84);
  });
});

describe('Reuse Template main product and layouts', () => {
  const base: Omit<PlacementInput, 'products'> = { canvas: { width: 4096, height: 4096 }, stage: { cx: 2200, cy: 2700, a: 1250, b: 120 }, lane: { x0: 1000, x1: 3400 }, ceiling: 1700, keepOut: [] };
  const product = (id: string, category: string, aspect: number) => ({ id, label: category, category, aspect });
  const products = [product('w', 'washing machine', 0.75), product('c', 'cooker', 1.4), product('t', 'television', 1.6), product('f', 'refrigerator', 0.5), product('m', 'microwave oven', 1.6)];
  const centre = (b: { x: number; width: number }) => b.x + b.width / 2;
  it('puts the main product in the middle and visibly dominant, keeps the front row beside it, and varies the layout on request', () => {
    // Chosen automatically: the most presence (its displayed area: the television here); chosen by the person: the cooker,
    // in the middle but still a cooker (never raised to a refrigerator's height).
    const auto = geometryPlacement({ ...base, products });
    expect(auto.hero).toBe('t');
    const chosen = geometryPlacement({ ...base, products }, { hero: 'c' }), cooker = chosen.boxes.find(b => b.id === 'c')!, fridge = chosen.boxes.find(b => b.id === 'f')!;
    expect(chosen.hero).toBe('c'); expect(cooker.height).toBeLessThan(fridge.height * 0.6);
    // A refrigerator photo labelled as a split air conditioner is not sized as one (its shape says otherwise), and is flagged.
    expect(shapeMismatch('Split air conditioner', 0.5)).toBe(true); expect(shapeMismatch('air conditioner', 3.4)).toBe(false); expect(shapeMismatch('speaker', 0.4)).toBe(false);
    const mislabelled = geometryPlacement({ ...base, products: [product('a', 'air conditioner', 0.5), product('w2', 'washing machine', 0.75)] }).boxes;
    expect(mislabelled.find(b => b.id === 'a')!.height).toBeGreaterThan(mislabelled.find(b => b.id === 'w2')!.height * 0.6);
    const tv = geometryPlacement({ ...base, products }, { hero: 't' }), main = tv.boxes.find(b => b.id === 't')!;
    expect(Math.abs(centre(main) - base.stage.cx)).toBeLessThan(base.stage.a * 0.25);
    // The shorter products in front stand beside the main product, not in front of it.
    for (const b of tv.boxes.filter(x => x.y + x.height > main.y + main.height + 5)) expect(inter(b, { ...main, x: main.x + main.width * 0.3, width: main.width * 0.4 })).toBe(0);
    // Two products: a balanced pair; another layout swaps the sides; a third makes another product the main one.
    const pair = [products[0], products[1]], one = geometryPlacement({ ...base, products: pair }).boxes, two = geometryPlacement({ ...base, products: pair }, { variant: 1 }).boxes;
    expect(Math.sign(centre(one[0]) - centre(one[1]))).not.toBe(0);
    const side = (bs: typeof one, id: string) => Math.sign(centre(bs.find(b => b.id === id)!) - base.stage.cx);
    expect(side(two, 'c')).toBe(-side(one, 'c'));
    expect(geometryPlacement({ ...base, products }, { variant: 1 }).hero).toBe(auto.hero); expect(geometryPlacement({ ...base, products }, { variant: 2 }).hero).not.toBe(auto.hero);
  });
});

describe('Reuse Template studio (HTTP, temporary store, fake planner)', { timeout: 180000 }, () => {
  it('Create a New Creative: every template product left out, only the uploads drawn as uploaded, the main product in the middle', async () => {
    const s = await setup();
    try {
      const v = await savedTemplate(s, await productPosterPng()), id = v.template.id;
      let d = (await s.send<ReuseDraft>('POST', `/${id}/reuse`, { simple: true })).body;
      expect(d.simple).toBe(true); expect(d.placement.mode).toBe('geometry');
      expect(d.items.filter(i => i.objectId && i.kind === 'product').every(i => !i.included)).toBe(true);
      expect(d.items.filter(i => i.kind === 'character').every(i => i.included)).toBe(true);
      const shapes = { 'washing machine': '<rect x="20" y="20" width="260" height="360" rx="20" fill="#e5e7eb"/><circle cx="150" cy="220" r="90" fill="#1e3a8a"/>', cooker: '<rect x="20" y="120" width="360" height="200" rx="26" fill="#9ca3af"/>' };
      const uploads: Record<string, Buffer> = {};
      for (const [label, body] of Object.entries(shapes)) {
        uploads[label] = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">${body}</svg>`)).png().toBuffer();
        const form = new FormData(); form.set('kind', 'product'); form.set('label', label); form.set('expectedRevision', String(d.revision)); form.append('image', new Blob([new Uint8Array(uploads[label])], { type: 'image/png' }), `${label}.png`);
        d = ((await (await fetch(`${s.base}/${id}/reuse/${d.id}/uploads`, { method: 'POST', body: form })).json()) as { draft: ReuseDraft }).draft;
      }
      // A manual correction belongs to its arrangement: choosing another main product (a new arrangement) drops it.
      const washer = d.items.find(i => i.label === 'washing machine')!;
      d = (await s.send<ReuseDraft>('PUT', `/${id}/reuse/${d.id}`, { expectedRevision: d.revision, overrides: { original: { [`o:${washer.id}`]: { x: 10, y: 10, width: 50, height: 50 } } } })).body;
      expect(d.overrides.original?.[`o:${washer.id}`]).toBeTruthy();
      const cooker = d.items.find(i => i.label === 'cooker')!;
      expect(cooker.category).toBe('cooker');
      d = (await s.send<ReuseDraft>('PUT', `/${id}/reuse/${d.id}`, { expectedRevision: d.revision, placement: { hero: cooker.id } })).body;
      expect(d.placement.hero).toBe(cooker.id); expect(d.overrides.original?.[`o:${washer.id}`]).toBeUndefined();
      const p = (await s.call<ReusePreview>(`/${id}/reuse/${d.id}/preview?ratio=original`)).body;
      const shown = p.creative.objects.filter(o => o.kind === 'product');
      expect(shown.map(o => o.label).sort()).toEqual(['cooker', 'washing machine']);
      // Each is the person's own picture, its pixels kept (its empty transparent margin trimmed).
      for (const o of shown) {
        const used = await sharp(readFileSync(join(s.protectedDir, id, o.asset.file))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const original = await sharp(uploads[o.label]).trim().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        expect([used.info.width, used.info.height]).toEqual([original.info.width, original.info.height]);
        expect(Buffer.compare(used.data, original.data)).toBe(0);
      }
      const main = shown.find(o => o.label === 'cooker')!, other = shown.find(o => o.label === 'washing machine')!;
      // The main product keeps its true size relative to the other (a cooker beside a washing machine), a little enlarged.
      expect(main.box.height).toBeLessThan(other.box.height); expect(main.box.height).toBeGreaterThanOrEqual(other.box.height * 0.45);
      expect(p.checks.status).not.toBe('failed');
    } finally { await s.close(); }
  });

  it('reuses a saved revision with the person’s product set, formats and approved AI placement; saves creatives and reopens; the revision never changes', async () => {
    const calls: string[] = [];
    const placement: ReusePlacementPlanner = { model: 'fake placement planner (no network)', offline: false, async place(input) { calls.push(input.format); return { responseId: `fake-${calls.length}`, raw: { notes: ['fake'], products: input.proposal.map(b => ({ ...b, role: 'supporting' })) } }; } };
    const s = await setup({ placement });
    try {
      const v = await savedTemplate(s, await productPosterPng()), id = v.template.id, revisionFile = join(s.protectedDir, id, 'product-r1.json'), revision = readFileSync(revisionFile);
      const canvas = JSON.parse(revision.toString()).canvas;
      let d = (await s.send<ReuseDraft>('POST', `/${id}/reuse`, {})).body;
      const products = d.items.filter(i => i.kind === 'product');
      expect(products.length).toBeGreaterThanOrEqual(2); expect(products.every(i => i.included && !i.removed && i.asset.kind === 'template')).toBe(true);
      expect((await s.send('PUT', `/${id}/reuse/${d.id}`, { expectedRevision: d.revision + 5, ratios: ['3:9'] })).status).toBe(409);
      d = (await s.send<ReuseDraft>('PUT', `/${id}/reuse/${d.id}`, { expectedRevision: d.revision, ratios: ['original', '3:9', '4:9', '16:9'], items: products.map((p, i) => ({ id: p.id, included: i === 0, removed: i === 1 })) })).body;
      expect(d.items.find(i => i.id === products[1].id)).toMatchObject({ removed: true, included: false });
      // The person's own product (a transparent PNG): its pixels kept as they are.
      const mine = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect x="20" y="20" width="260" height="360" rx="12" fill="#1d4ed8"/></svg>')).png().toBuffer();
      const form = new FormData(); form.set('kind', 'product'); form.set('label', 'Dishwasher'); form.set('expectedRevision', String(d.revision)); form.append('image', new Blob([new Uint8Array(mine)], { type: 'image/png' }), 'my-dishwasher.png');
      const up = await (await fetch(`${s.base}/${id}/reuse/${d.id}/uploads`, { method: 'POST', body: form })).json() as { draft: ReuseDraft };
      d = up.draft;
      const added = d.items.find(i => !i.objectId)!;
      expect(added).toMatchObject({ kind: 'product', label: 'Dishwasher', category: 'dishwasher', included: true });
      expect(d.placement.mode).toBe('geometry');
      for (const r of ['original', '3x9', '4x9', '16x9']) {
        const p = (await s.call<ReusePreview>(`/${id}/reuse/${d.id}/preview?ratio=${r}`)).body;
        expect(p.creative.canvas).toEqual(reuseCanvasFor(canvas, p.ratio));
        expect(p.creative.objects.filter(o => o.kind === 'product').map(o => o.id).sort()).toEqual([products[0].id, added.id].sort());
        for (const o of p.creative.objects.filter(x => x.kind === 'product')) expect(inter(o.box, { x: 0, y: 0, ...p.creative.canvas })).toBeCloseTo(o.box.width * o.box.height, -2);
        expect(p.checks.status).not.toBe('failed');
      }
      // AI placement: the cost must be approved; one request per format; never retried. In the template's own format the
      // dishwasher takes the removed product's place (slot-anchored), so that format is not sent.
      expect((await s.send('POST', `/${id}/reuse/${d.id}/placement`, {})).status).toBe(400); expect(calls).toEqual([]);
      d = (await s.send<ReuseDraft>('POST', `/${id}/reuse/${d.id}/placement`, { approveUsd: 0.32 })).body;
      expect(calls).toEqual(['3:9', '4:9', '16:9']); expect(d.placement.mode).toBe('ai'); expect(d.ai).toMatchObject({ requests: 3, costUsd: 0.24 });
      // Text: the person's own headline, set where the template's was.
      const headline = (await s.call<{ texts: { groupId: string; category: string }[] }>(`/${id}/reuse/${d.id}`)).body.texts.find(t => t.category === 'headline');
      if (headline) d = (await s.send<ReuseDraft>('PUT', `/${id}/reuse/${d.id}`, { expectedRevision: d.revision, texts: { [headline.groupId]: { text: 'Golden days call for golden deals' } } })).body;
      d = (await s.send<ReuseDraft>('POST', `/${id}/reuse/${d.id}/generate`, {})).body;
      expect(Object.keys(d.outputs).sort()).toEqual(['16:9', '3:9', '4:9', 'original']);
      d = (await s.send<ReuseDraft>('POST', `/${id}/reuse/${d.id}/save`, {})).body;
      const saved = Object.values(d.outputs).map(o => o!.creativeId!);
      expect(saved.every(Boolean)).toBe(true);
      for (const cid of saved) {
        const c = (await s.call<ProductCreative>(`/${id}/creatives/${cid}`)).body;
        expect(c.origin).toMatchObject({ kind: 'reuse', draftId: d.id });
        expect(c.objects.filter(o => o.asset.kind === 'upload').every(o => o.asset.file.startsWith(`pca-${cid.slice(3)}-`))).toBe(true);
        if (headline) expect(c.texts.some(t => t.text === 'Golden')).toBe(true);
      }
      // Saved again: a new revision of the same creatives.
      d = (await s.send<ReuseDraft>('POST', `/${id}/reuse/${d.id}/save`, {})).body;
      expect(Object.values(d.outputs).map(o => o!.creativeId)).toEqual(saved); expect(Object.values(d.outputs).every(o => o!.creativeRevision === 2)).toBe(true);
      // Reopened: the same draft, every choice kept.
      const again = (await s.call<{ draft: ReuseDraft }>(`/${id}/reuse/${d.id}`)).body.draft;
      expect(again).toEqual(d);
      expect((await s.call<{ drafts: { id: string }[] }>(`/${id}/reuse`)).body.drafts.map(x => x.id)).toEqual([d.id]);
      // The editor's run and the decomposition handoff take the saved creative.
      expect((await s.send<{ runId: string }>('POST', `/${id}/reuse/${d.id}/outputs/16x9/open`, {})).body.runId).toBeTruthy();
      expect(readFileSync(revisionFile)).toEqual(revision);
    } finally { await s.close(); }
  });
});

describe('Reuse Template empty stage', () => {
  it('never passes a stage it could not rebuild off as clean: the base comes back unchanged, with the reason', async () => {
    const base = await sharp({ create: { width: 400, height: 400, channels: 4, background: '#d9e7c4' } }).png().toBuffer();
    const r = await cleanStage(base, { podium: { x: 60, y: 260, width: 280, height: 90 }, products: [{ x: 150, y: 150, width: 80, height: 120, contactY: 270 }], avoid: [] });
    expect(r.reliable).toBe(false); expect(r.reason).toBeTruthy(); expect(r.png).toBe(base);
    expect((await cleanStage(base, { podium: { x: 60, y: 260, width: 280, height: 90 }, products: [], avoid: [] })).reliable).toBe(false);
  });
});

describe('Reuse Template composition pass (one showcase group)', () => {
  const input: PlacementInput = { canvas: { width: 4096, height: 4096 }, stage: { cx: 2215, cy: 2678, a: 1246, b: 115 }, lane: { x0: 1100, x1: 3250 }, ceiling: 1755, keepOut: [],
    products: [{ id: 'f', label: 'Refrigerator', category: 'refrigerator', aspect: 0.51 }, { id: 'c', label: 'Espresso machine', category: 'coffee machine', aspect: 0.77 }, { id: 'w', label: 'Washing machine', category: 'washing machine', aspect: 0.74 }] };
  it('draws a spread-out proposal (the live answer that left a third of the stage empty) into one centred group of believable sizes', () => {
    const two = { ...input, products: input.products.slice(0, 2) };
    // Fridge far left and small, espresso far right and as tall (as the live planner answered).
    const r = refineCluster(two, [{ id: 'f', x: 1450, y: 2294, width: 264, height: 520, z: 0 }, { id: 'c', x: 2500, y: 2490, width: 300, height: 390, z: 50 }], 'c');
    const [f, c] = ['f', 'c'].map(k => r.boxes.find(b => b.id === k)!);
    expect(r.report.gapBefore).toBeGreaterThan(0.2); expect(r.report.gapAfter).toBeLessThanOrEqual(0.03);
    expect(f.height).toBeGreaterThan(c.height * 1.8);
    expect(Math.abs((Math.min(f.x, c.x) + Math.max(f.x + f.width, c.x + c.width)) / 2 - input.stage.cx)).toBeLessThan(40);
    for (const b of r.boxes) { expect(b.y + b.height).toBeGreaterThanOrEqual(input.stage.cy - input.stage.b * 0.75); expect(b.y + b.height).toBeLessThanOrEqual(input.stage.cy + input.stage.b * 0.85); expect(b.y).toBeGreaterThanOrEqual(input.ceiling - 1); }
  });
  it('uses the room for a timid group, and moves a nearer product aside when it hides much of the one behind', () => {
    const small = refineCluster(input, [{ id: 'f', x: 2000, y: 2200, width: 230, height: 450, z: 0 }, { id: 'w', x: 1700, y: 2420, width: 170, height: 230, z: 0 }, { id: 'c', x: 2300, y: 2470, width: 140, height: 180, z: 5 }], 'f');
    const fridge = small.boxes.find(b => b.id === 'f')!;
    expect(fridge.height).toBeGreaterThan((fridge.y + fridge.height - input.ceiling) * 0.8);
    const hidden = refineCluster(input, [{ id: 'f', x: 2000, y: 1800, width: 440, height: 860, z: 0 }, { id: 'w', x: 2020, y: 2100, width: 420, height: 560, z: 9 }], 'f');
    const [back, front] = ['f', 'w'].map(k => hidden.boxes.find(b => b.id === k)!);
    expect(inter(front, back) / (back.width * back.height)).toBeLessThanOrEqual(0.41);
  });
});
