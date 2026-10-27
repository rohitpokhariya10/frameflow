/**
 * A new composition of a product creative for a new background (AI artwork or a local preset backdrop): every element
 * placed again for the canvas, nothing stretched, every element still its own layer.
 *
 *   archetypes   stage-top (text above the products), stage-bottom (products above the text), split-left / split-right
 *                (a text column beside the products, for wide canvases)
 *   products     moved as one group (their arrangement and overlaps kept), scaled to their zone, standing on its floor
 *   character    beside the products, as tall as its zone, on the same floor
 *   text         each block reflowed word by word into its zone (words keep their ids, order and style; lines are
 *                rebuilt to the zone's width, the size chosen to fit), headline largest
 *   logos        brand logos in the top band, partner logos in a centred grid in the footer, legal text at the bottom
 *
 * Only positions, sizes and line breaks change; no text is written here.
 */
import type { CreativeText, MeasureText, ProductCreative, SourceSize } from '@frameflow/shared';
import { fontMeasure } from './ratioLayout.js';

export const PRODUCT_COMPOSITIONS = ['stage-top', 'stage-bottom', 'split-left', 'split-right'] as const;
export type ProductComposition = typeof PRODUCT_COMPOSITIONS[number];
type Zone = { x: number; y: number; width: number; height: number };
/** The archetypes that suit a canvas: text columns only on wide ones. */
export const compositionsFor = (canvas: SourceSize): ProductComposition[] => (canvas.width / canvas.height > 1.25 ? ['split-left', 'split-right'] : ['stage-top', 'stage-bottom']);

/** The zones of an archetype on a canvas (fractions turned into pixels, inside a safe margin). */
export function zonesOf(composition: ProductComposition, canvas: SourceSize) {
  const { width: W, height: H } = canvas, m = Math.round(Math.min(W, H) * 0.04);
  const z = (x0: number, y0: number, x1: number, y1: number): Zone => ({ x: Math.round(x0 * W), y: Math.round(y0 * H), width: Math.round((x1 - x0) * W), height: Math.round((y1 - y0) * H) });
  const top = { x: m, y: m, width: W - 2 * m, height: Math.round(H * (W > H * 1.25 ? 0.11 : 0.08)) };
  if (composition === 'split-left' || composition === 'split-right') {
    const left = composition === 'split-left', text = left ? 0.04 : 0.54, art = left ? 0.47 : 0.03;
    // Partner logos and legal lines under the text in its column: the stage and what stands on it keep the other side.
    return { top, headline: z(text, 0.16, text + 0.42, 0.44), offer: z(text, 0.45, text + 0.42, 0.57), other: z(text, 0.58, text + 0.42, 0.65),
      products: z(art + 0.13, 0.18, art + 0.5, 0.74), character: z(art, 0.22, art + 0.16, 0.76), partners: z(text, 0.67, text + 0.42, 0.87), legal: z(text, 0.88, text + 0.42, 0.965), floor: 0.74 };
  }
  const high = composition === 'stage-top';
  return high
    ? { top, headline: z(0.07, 0.1, 0.93, 0.25), offer: z(0.1, 0.255, 0.9, 0.34), products: z(0.3, 0.37, 0.96, 0.73), character: z(0.03, 0.36, 0.33, 0.76), other: z(0.06, 0.765, 0.94, 0.81),
      partners: z(0.06, 0.82, 0.94, 0.915), legal: z(0.06, 0.925, 0.94, 0.965), floor: 0.73 }
    : { top, products: z(0.3, 0.1, 0.96, 0.47), character: z(0.03, 0.1, 0.33, 0.5), headline: z(0.07, 0.52, 0.93, 0.66), offer: z(0.1, 0.665, 0.9, 0.75), other: z(0.06, 0.755, 0.94, 0.8),
      partners: z(0.06, 0.815, 0.94, 0.915), legal: z(0.06, 0.925, 0.94, 0.965), floor: 0.47 };
}

/** A group's words laid out again in a zone: wrapped to its width at the largest size (≤ maxScale) whose lines fit its height. */
export function fitGroup(c: ProductCreative, groupId: string, zone: Zone, align: 'left' | 'center', maxScale: number, measure: MeasureText = fontMeasure): ProductCreative {
  const words = c.texts.filter(t => t.groupId === groupId && !t.hidden && t.text.trim()).sort((a, b) => a.line - b.line || a.x - b.x);
  if (!words.length) return c;
  const layout = (scale: number) => {
    const rows: CreativeText[][] = [[]], widths = [0];
    for (const t of words) {
      const size = t.style.fontSize * scale, w = measure(t.text, { ...t.style, fontSize: size, letterSpacing: Math.max(0, t.style.letterSpacing) * scale }), gap = rows.at(-1)!.length ? measure(' ', { ...t.style, fontSize: size }) : 0;
      if (rows.at(-1)!.length && widths.at(-1)! + gap + w > zone.width) { rows.push([t]); widths.push(w); } else { rows.at(-1)!.push(t); widths[widths.length - 1] += gap + w; }
    }
    const lineHeights = rows.map(r => Math.max(...r.map(t => t.style.fontSize * scale)) * 1.18);
    return { rows, widths, lineHeights, height: lineHeights.reduce((a, b) => a + b, 0), wide: Math.max(...widths) };
  };
  let scale = maxScale, l = layout(scale);
  while (scale > 0.25 && (l.height > zone.height || l.wide > zone.width)) { scale *= 0.94; l = layout(scale); }
  const top = zone.y + Math.max(0, (zone.height - l.height) / 2), placed = new Map<string, CreativeText>();
  let y = top;
  l.rows.forEach((row, i) => {
    const size = Math.max(...row.map(t => t.style.fontSize * scale)), baseline = y + size * 0.92;
    let x = align === 'center' ? zone.x + (zone.width - l.widths[i]) / 2 : zone.x;
    for (const t of row) {
      // Letters closed up to match the old artwork's boxes have nothing to match here: normal spacing again.
      const style = { ...t.style, fontSize: t.style.fontSize * scale, letterSpacing: Math.max(0, t.style.letterSpacing) * scale };
      placed.set(t.id, { ...t, x, baselineY: baseline, line: i, rotation: 0, style });
      x += measure(t.text, style) + measure(' ', style);
    }
    y += l.lineHeights[i];
  });
  return { ...c, texts: c.texts.map(t => placed.get(t.id) ?? t) };
}

type Box = { x: number; y: number; width: number; height: number };
const contain = (w: number, h: number, zone: Zone) => { const s = Math.min(zone.width / Math.max(1, w), zone.height / Math.max(1, h)); return { s, width: w * s, height: h * s }; };

/** The creative composed for a canvas with an archetype (a new background is drawn separately). */
export function composeCreative(c: ProductCreative, composition: ProductComposition, canvas: SourceSize, measure: MeasureText = fontMeasure): ProductCreative {
  const Z = zonesOf(composition, canvas);
  let out: ProductCreative = { ...c, canvas: { ...canvas }, objects: c.objects.map(o => ({ ...o, box: { ...o.box } })), images: c.images.map(i => ({ ...i, box: { ...i.box } })), shapes: c.shapes.map(s => ({ ...s, hidden: true })) };
  // Products as one group, scaled to their zone, standing on its floor and centred in it.
  const products = out.objects.filter(o => o.kind === 'product' && !o.hidden);
  if (products.length) {
    const x0 = Math.min(...products.map(o => o.box.x)), y0 = Math.min(...products.map(o => o.box.y)), x1 = Math.max(...products.map(o => o.box.x + o.box.width)), y1 = Math.max(...products.map(o => o.box.y + o.box.height));
    const f = contain(x1 - x0, y1 - y0, Z.products), ox = Z.products.x + (Z.products.width - f.width) / 2, oy = Z.products.y + Z.products.height - f.height;
    for (const o of products) o.box = { x: Math.round(ox + (o.box.x - x0) * f.s), y: Math.round(oy + (o.box.y - y0) * f.s), width: Math.max(1, Math.round(o.box.width * f.s)), height: Math.max(1, Math.round(o.box.height * f.s)) };
  }
  // Characters beside them, on the same floor.
  for (const o of out.objects.filter(x => x.kind === 'character' && !x.hidden)) {
    const f = contain(o.box.width, o.box.height, Z.character);
    o.box = { x: Math.round(Z.character.x + (Z.character.width - f.width) / 2), y: Math.round(Z.character.y + Z.character.height - f.height), width: Math.max(1, Math.round(f.width)), height: Math.max(1, Math.round(f.height)) };
  }
  // Decorations of the old artwork do not belong to a new background.
  for (const o of out.objects) if (o.kind === 'decoration' || o.kind === 'frame' || o.kind === 'podium') o.hidden = true;
  // Text: the headline, the offer, other blocks, legal lines.
  const role = (gid: string) => out.groups.find(g => g.id === gid)?.category ?? 'supporting';
  const blocks = out.groups.filter(g => out.texts.some(t => t.groupId === g.id && !t.hidden && t.text.trim()));
  const headline = blocks.filter(g => role(g.id) === 'headline'), offer = blocks.filter(g => role(g.id) === 'offer' || role(g.id) === 'cta'), legal = blocks.filter(g => role(g.id) === 'legal'), other = blocks.filter(g => !headline.includes(g) && !offer.includes(g) && !legal.includes(g));
  const stack = (list: typeof blocks, zone: Zone, align: 'left' | 'center', maxScale: number) => {
    const share = zone.height / Math.max(1, list.length);
    list.forEach((g, i) => { out = fitGroup(out, g.id, { ...zone, y: zone.y + i * share, height: share }, align, maxScale, measure); });
  };
  const textAlign = composition.startsWith('split') ? 'left' : 'center';
  stack(headline, Z.headline, textAlign, 2.2); stack(offer, Z.offer, textAlign, 1.6); stack(other, Z.other, textAlign, 1.2); stack(legal, Z.legal, 'center', 1.1);
  // Logos: brand logos in the top band (first left, the rest right), partners in a centred grid in the footer.
  const brand = out.images.filter(i => !i.hidden && i.category === 'brand-logo'), partners = out.images.filter(i => !i.hidden && i.category !== 'brand-logo');
  const fitLogo = (b: Box, h: number) => { const s = h / Math.max(1, b.height); return { width: b.width * s, height: h }; };
  brand.forEach((img, i) => {
    const size = fitLogo(img.box, Z.top.height * 0.8), x = i === 0 ? Z.top.x : Z.top.x + Z.top.width - size.width - (i - 1) * (size.width + 12);
    img.box = { ...img.box, x: Math.round(x), y: Math.round(Z.top.y + (Z.top.height - size.height) / 2), width: Math.round(size.width), height: Math.round(size.height) };
  });
  if (partners.length) {
    let rows = 1, h = 0;
    for (; rows <= 4; rows++) {
      h = Math.min(Z.partners.height / rows * 0.78, canvas.height * 0.045);
      const perRow = Math.ceil(partners.length / rows), widest = Math.max(...Array.from({ length: rows }, (_, r) => partners.slice(r * perRow, (r + 1) * perRow).reduce((sum, p) => sum + fitLogo(p.box, h).width + 8, 0)));
      if (widest <= Z.partners.width) break;
    }
    rows = Math.min(rows, 4);
    const perRow = Math.ceil(partners.length / rows);
    for (let r = 0; r < rows; r++) {
      const row = partners.slice(r * perRow, (r + 1) * perRow), total = row.reduce((sum, p) => sum + fitLogo(p.box, h).width + 8, -8);
      let x = Z.partners.x + (Z.partners.width - total) / 2;
      const y = Z.partners.y + r * (Z.partners.height / rows) + (Z.partners.height / rows - h) / 2;
      for (const p of row) { const size = fitLogo(p.box, h); p.box = { ...p.box, x: Math.round(x), y: Math.round(y), width: Math.round(size.width), height: Math.round(size.height) }; x += size.width + 8; }
    }
  }
  // On new artwork the small print and the partner logos sit on a white card (an editable shape of the legal block), so
  // they stay readable over busy artwork; the text on it is set dark.
  const footer = [...partners.map(p => p.box), ...[...legal, ...other.filter(g => /emi|valid|t&c|terms/i.test(g.label))].flatMap(g => out.texts.filter(t => t.groupId === g.id && !t.hidden && t.text.trim()).map(t => { const size = t.style.fontSize; return { x: t.x, y: t.baselineY - size * 0.85, width: measure(t.text, t.style), height: size * 1.1, rotation: 0 }; }))];
  const owner = legal[0] ?? other[other.length - 1] ?? blocks[blocks.length - 1];
  if (footer.length && owner) {
    const pad = Math.round(Math.min(canvas.width, canvas.height) * 0.015), x0 = Math.min(...footer.map(b => b.x)) - pad, y0 = Math.min(...footer.map(b => b.y)) - pad;
    const box = { x: Math.max(2, x0), y: Math.max(2, y0), width: Math.min(canvas.width - 4, Math.max(...footer.map(b => b.x + b.width)) + pad - x0), height: Math.min(canvas.height - 4, Math.max(...footer.map(b => b.y + b.height)) + pad - y0), rotation: 0 };
    const z = Math.min(...partners.map(p => p.z), ...out.texts.map(t => t.z)) - 1;
    out.shapes = [...out.shapes, { id: `cs-${owner.id.slice(3, 13).padEnd(10, '0')}`, plateId: null, groupId: owner.id, box, fill: '#ffffff', stroke: null, radius: Math.round(pad * 1.2), hidden: false, z: Math.max(0, z) }];
    const inside = (t: CreativeText) => t.x >= box.x && t.x <= box.x + box.width && t.baselineY >= box.y && t.baselineY <= box.y + box.height;
    out.texts = out.texts.map(t => (inside(t) ? { ...t, style: { ...t.style, color: '#111827' } } : t));
  }
  return out;
}
