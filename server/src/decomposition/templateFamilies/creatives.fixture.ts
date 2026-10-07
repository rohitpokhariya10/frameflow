/**
 * Synthetic offer creatives for template family tests: one layout spec renders both a PNG (sharp, SVG) and the
 * structural analysis a planner would return for it, so local fingerprints and fake analyses always agree.
 */
import sharp from 'sharp';
import { structuralName, type StructureAnalysis } from '@frameflow/shared';

type Box = { x: number; y: number; width: number; height: number };
export type CreativeSpec = {
  background: [string, string];
  product?: { box: Box; shape: 'headphones' | 'phone' | 'bottle'; color: string; label: string }[];
  person?: Box;
  headline?: Box & { text: string };
  cta?: Box & { text: string };
  badge?: Box & { text: string };
  size?: number;
};
const px = (v: number, s: number) => Math.round(v * s);
function productSvg(p: NonNullable<CreativeSpec['product']>[number], s: number): string {
  const x = px(p.box.x, s), y = px(p.box.y, s), w = px(p.box.width, s), h = px(p.box.height, s);
  if (p.shape === 'phone') return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.round(w / 6)}" fill="${p.color}"/><rect x="${x + w * 0.08}" y="${y + h * 0.05}" width="${w * 0.84}" height="${h * 0.86}" rx="${Math.round(w / 10)}" fill="#111"/>`;
  if (p.shape === 'bottle') return `<rect x="${x + w * 0.3}" y="${y}" width="${w * 0.4}" height="${h * 0.2}" fill="${p.color}"/><rect x="${x}" y="${y + h * 0.18}" width="${w}" height="${h * 0.82}" rx="${Math.round(w / 4)}" fill="${p.color}"/>`;
  return `<path d="M ${x + w * 0.12} ${y + h * 0.75} Q ${x + w / 2} ${y - h * 0.2} ${x + w * 0.88} ${y + h * 0.75}" stroke="${p.color}" stroke-width="${Math.max(6, h * 0.12)}" fill="none"/>`
    + `<rect x="${x}" y="${y + h * 0.5}" width="${w * 0.26}" height="${h * 0.5}" rx="${w * 0.08}" fill="${p.color}"/><rect x="${x + w * 0.74}" y="${y + h * 0.5}" width="${w * 0.26}" height="${h * 0.5}" rx="${w * 0.08}" fill="${p.color}"/>`;
}
/** Text drawn as dark letter bars: deterministic without fonts. */
const textBars = (b: Box, s: number, color: string) => {
  const x = px(b.x, s), y = px(b.y, s), w = px(b.width, s), h = px(b.height, s), n = Math.max(3, Math.round(w / Math.max(8, h * 0.7)));
  return Array.from({ length: n }, (_, i) => `<rect x="${x + (i * w) / n + 1}" y="${y + h * 0.15}" width="${Math.max(2, w / n - 4)}" height="${h * 0.7}" fill="${color}"/>`).join('');
};
export async function renderCreative(spec: CreativeSpec): Promise<Buffer> {
  const s = spec.size ?? 512, [from, to] = spec.background;
  const parts = [`<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="${s}" height="${s}" fill="url(#g)"/>`];
  if (spec.person) parts.push(`<ellipse cx="${px(spec.person.x + spec.person.width / 2, s)}" cy="${px(spec.person.y + spec.person.height * 0.18, s)}" rx="${px(spec.person.width * 0.22, s)}" ry="${px(spec.person.height * 0.16, s)}" fill="#f1c27d"/><rect x="${px(spec.person.x, s)}" y="${px(spec.person.y + spec.person.height * 0.34, s)}" width="${px(spec.person.width, s)}" height="${px(spec.person.height * 0.66, s)}" rx="20" fill="#d9480f"/>`);
  for (const p of spec.product ?? []) parts.push(productSvg(p, s));
  if (spec.headline) parts.push(textBars(spec.headline, s, '#ffffff'));
  if (spec.cta) parts.push(`<rect x="${px(spec.cta.x, s)}" y="${px(spec.cta.y, s)}" width="${px(spec.cta.width, s)}" height="${px(spec.cta.height, s)}" rx="12" fill="#ffd43b"/>`);
  if (spec.badge) parts.push(`<circle cx="${px(spec.badge.x + spec.badge.width / 2, s)}" cy="${px(spec.badge.y + spec.badge.height / 2, s)}" r="${px(Math.min(spec.badge.width, spec.badge.height) / 2, s)}" fill="#ff6b6b"/>`);
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}">${parts.join('')}</svg>`)).png().toBuffer();
}
/** What a structural planner would report for the spec: structure and this image's content, apart. */
export function analysisOf(spec: CreativeSpec, confidence = 0.92): StructureAnalysis {
  const elements: StructureAnalysis['signature']['elements'] = [], content: StructureAnalysis['instance']['elements'] = {};
  (spec.product ?? []).forEach((p, i) => { const id = spec.product!.length > 1 ? `product-${i + 1}` : 'product'; elements.push({ id, role: 'product', z: 2, box: p.box }); content[id] = { label: p.label, text: '' }; });
  if (spec.person) { elements.push({ id: 'person', role: 'person', z: 1, box: spec.person }); content.person = { label: 'a person', text: '' }; }
  if (spec.headline) { elements.push({ id: 'headline', role: 'headline', z: 3, box: spec.headline }); content.headline = { label: 'headline', text: spec.headline.text }; }
  if (spec.cta) { elements.push({ id: 'cta', role: 'cta', z: 3, box: spec.cta }); content.cta = { label: 'button', text: spec.cta.text }; }
  if (spec.badge) { elements.push({ id: 'badge', role: 'badge', z: 4, box: spec.badge }); content.badge = { label: 'badge', text: spec.badge.text }; }
  const signature = { version: 1 as const, background: 'gradient' as const, elements, relations: [] };
  return { signature, instance: { elements: content, background: `${spec.background[0]} to ${spec.background[1]} gradient` }, layoutName: structuralName(signature), decompositionRecipe: 'template-b', confidence };
}
const b = (x: number, y: number, width: number, height: number): Box => ({ x, y, width, height });
const offerText = { headline: { ...b(0.12, 0.07, 0.6, 0.1), text: 'Summer Sale' }, cta: { ...b(0.36, 0.82, 0.28, 0.08), text: 'Shop Now' }, badge: { ...b(0.78, 0.04, 0.16, 0.16), text: '40% OFF' } };
export const CREATIVES = {
  headphonesBlue: { background: ['#1e3a8a', '#60a5fa'], product: [{ box: b(0.28, 0.3, 0.44, 0.34), shape: 'headphones', color: '#111827', label: 'black over-ear headphones' }], ...offerText } as CreativeSpec,
  iphoneRed: { background: ['#7f1d1d', '#f87171'], product: [{ box: b(0.38, 0.25, 0.24, 0.46), shape: 'phone', color: '#e5e7eb', label: 'iPhone in silver' }], ...offerText,
    headline: { ...offerText.headline, text: 'Mega Offer' }, cta: { ...offerText.cta, text: 'Buy Now' } } as CreativeSpec,
  sideways: { background: ['#14532d', '#86efac'], product: [{ box: b(0.05, 0.25, 0.4, 0.5), shape: 'bottle', color: '#f59e0b', label: 'amber bottle' }],
    headline: { ...b(0.52, 0.28, 0.42, 0.1), text: 'Fresh Drop' }, cta: { ...b(0.56, 0.6, 0.3, 0.08), text: 'Order' }, badge: { ...b(0.04, 0.04, 0.16, 0.16), text: 'NEW' } } as CreativeSpec,
  /** The legacy Template B structure: headline, centred product, button. No badge. */
  bottleCentered: { background: ['#4c1d95', '#c4b5fd'], product: [{ box: b(0.36, 0.28, 0.28, 0.46), shape: 'bottle', color: '#f59e0b', label: 'amber perfume bottle' }],
    headline: { ...b(0.15, 0.07, 0.68, 0.1), text: 'Glow Season' }, cta: { ...b(0.36, 0.82, 0.28, 0.08), text: 'Discover' } } as CreativeSpec,
  splitBlue: { background: ['#312e81', '#a5b4fc'], product: [{ box: b(0.06, 0.28, 0.38, 0.42), shape: 'phone', color: '#e5e7eb', label: 'silver phone' }, { box: b(0.56, 0.28, 0.38, 0.42), shape: 'bottle', color: '#f59e0b', label: 'amber bottle' }],
    headline: offerText.headline, cta: offerText.cta } as CreativeSpec,
  splitOrange: { background: ['#7c2d12', '#fdba74'], product: [{ box: b(0.07, 0.29, 0.36, 0.41), shape: 'bottle', color: '#0ea5e9', label: 'blue bottle' }, { box: b(0.57, 0.27, 0.36, 0.44), shape: 'phone', color: '#111827', label: 'black phone' }],
    headline: { ...offerText.headline, text: 'Combo Deal' }, cta: { ...offerText.cta, text: 'Grab it' } } as CreativeSpec,
};
