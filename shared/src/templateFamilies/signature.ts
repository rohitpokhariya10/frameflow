/**
 * Structural signatures: normalization, a short quantized key, the composition pattern, geometric relations and the
 * role-aware similarity families are matched with. Layout, roles and relations decide; colour, product and wording are
 * not part of a signature at all, so they cannot make two creatives look alike or different.
 */
import { BACKGROUND_KINDS, SEMANTIC_RELATIONS, STRUCTURAL_ROLES, type BackgroundKind, type MatchValidation, type NormalizedBox, type StructuralRole, type StructuralSignature } from './types.js';

/** Configurable decision thresholds. high: reuse automatically. ambiguous: worth a cheap structural check. dedupe: a new family this close to an existing one joins it instead. */
export interface MatchThresholds { high: number; ambiguous: number; dedupe: number; localHigh: number; minPlannerConfidence: number }
export const DEFAULT_MATCH_THRESHOLDS: MatchThresholds = { high: 0.85, ambiguous: 0.6, dedupe: 0.85, localHigh: 0.88, minPlannerConfidence: 0.6 };
export function matchThresholds(overrides: Partial<Record<keyof MatchThresholds, unknown>> = {}): MatchThresholds {
  const out = { ...DEFAULT_MATCH_THRESHOLDS };
  for (const key of Object.keys(out) as (keyof MatchThresholds)[]) {
    const value = Number(overrides[key]);
    if (overrides[key] !== undefined && overrides[key] !== '' && Number.isFinite(value) && value > 0 && value <= 1) out[key] = value;
  }
  if (out.ambiguous > out.high) out.ambiguous = out.high;
  return out;
}

const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));
const round = (n: number) => Math.round(n * 10000) / 10000;
export const center = (b: NormalizedBox) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
export const area = (b: NormalizedBox) => b.width * b.height;
/** The dominant extent: comparable between a wide product (headphones) and a tall one (a phone) in the same slot. */
const extent = (b: NormalizedBox) => Math.max(b.width, b.height);

/** A clean copy: boxes clamped to the canvas, unknown roles/relations dropped, ids unique, sorted by z. */
export function normalizeSignature(value: StructuralSignature): StructuralSignature {
  const seen = new Set<string>();
  const elements = value.elements.filter(e => (STRUCTURAL_ROLES as readonly string[]).includes(e.role) && e.role !== 'background' && e.id && !seen.has(e.id) && seen.add(e.id)).map((e) => {
    const x = clamp(e.box.x), y = clamp(e.box.y);
    return { id: e.id, role: e.role, z: Number.isFinite(e.z) ? Math.round(e.z) : 0, box: { x: round(x), y: round(y), width: round(clamp(e.box.width, 0.001, 1 - x)), height: round(clamp(e.box.height, 0.001, 1 - y)) } };
  }).sort((a, b) => a.z - b.z || a.id.localeCompare(b.id));
  const ids = new Set(elements.map(e => e.id));
  return { version: 1, background: (BACKGROUND_KINDS as readonly string[]).includes(value.background) ? value.background : 'unknown', elements,
    relations: value.relations.filter(r => ids.has(r.from) && ids.has(r.to) && r.from !== r.to && (SEMANTIC_RELATIONS as readonly string[]).includes(r.type)) };
}

/** 3×3 zone of a box's centre: tl tc tr / ml c mr / bl bc br. */
export function zoneOf(box: NormalizedBox): string {
  const c = center(box), col = c.x < 1 / 3 ? 'l' : c.x > 2 / 3 ? 'r' : 'c', row = c.y < 1 / 3 ? 't' : c.y > 2 / 3 ? 'b' : 'm';
  return row === 'm' && col === 'c' ? 'c' : `${row}${col}`;
}
const ZONE_WORDS: Record<string, string> = { tl: 'top-left', tc: 'top-center', tr: 'top-right', ml: 'middle-left', c: 'center', mr: 'middle-right', bl: 'bottom-left', bc: 'bottom-center', br: 'bottom-right' };
export const zoneWords = (box: NormalizedBox) => ZONE_WORDS[zoneOf(box)];
export const sizeClass = (box: NormalizedBox) => { const e = extent(box); return e < 0.2 ? 'S' : e < 0.4 ? 'M' : e < 0.65 ? 'L' : 'XL'; };
export const plainBackground = (kind: BackgroundKind) => kind === 'flat' || kind === 'gradient';

/** A short canonical key: "plain|product@c:L|headline@tc:M|cta@bc:S". Equal keys are very likely the same family. */
export function signatureKey(signature: StructuralSignature): string {
  const s = normalizeSignature(signature);
  const bg = plainBackground(s.background) ? 'plain' : s.background;
  const parts = s.elements.filter(e => e.role !== 'decoration').map(e => `${e.role}@${zoneOf(e.box)}:${sizeClass(e.box)}`).sort();
  const rel = s.relations.map(r => `${s.elements.find(e => e.id === r.from)!.role}-${r.type}-${s.elements.find(e => e.id === r.to)!.role}`).sort();
  return [bg, ...parts, ...rel].join('|');
}

export const roleCount = (s: StructuralSignature, role: StructuralRole) => s.elements.filter(e => e.role === role).length;
/** The dominant composition pattern, from roles, counts, positions and relations. */
export function compositionPattern(signature: StructuralSignature): string {
  const s = normalizeSignature(signature), people = roleCount(s, 'person'), products = roleCount(s, 'product');
  const holds = s.relations.some(r => r.type === 'holds' || r.type === 'wears');
  if (people >= 1 && roleCount(s, 'frame') >= 1) return 'framed-portrait';
  if (people >= 1 && products >= 1 && holds) return 'person-with-product';
  if (people >= 2) return 'people-campaign';
  if (people === 1) return products ? 'person-and-product' : 'person-hero';
  if (products >= 3) return 'product-collection';
  if (products === 2) {
    const [a, b] = s.elements.filter(e => e.role === 'product').map(e => center(e.box));
    return Math.abs(a.x - b.x) > Math.abs(a.y - b.y) ? 'split-products' : 'stacked-products';
  }
  if (products === 1) {
    const c = center(s.elements.find(e => e.role === 'product')!.box);
    return Math.abs(c.x - 0.5) <= 0.15 ? 'centered-product' : c.x < 0.5 ? 'product-left' : 'product-right';
  }
  return 'text-led';
}
const PATTERN_NAMES: Record<string, string> = {
  'framed-portrait': 'Framed Portrait', 'person-with-product': 'Person + Product', 'people-campaign': 'People Campaign', 'person-and-product': 'Person and Product',
  'person-hero': 'Person Hero', 'product-collection': 'Product Collection', 'split-products': 'Split Product Offer', 'stacked-products': 'Stacked Products',
  'centered-product': 'Centered Product', 'product-left': 'Product Left', 'product-right': 'Product Right', 'text-led': 'Text-led Layout',
};
/** A readable structural name: the pattern, plus "Offer" when it carries offer text or a CTA. */
export function structuralName(signature: StructuralSignature): string {
  const s = normalizeSignature(signature), base = PATTERN_NAMES[compositionPattern(s)] ?? 'Custom Layout';
  const offer = s.elements.some(e => ['cta', 'offer', 'price', 'badge'].includes(e.role)) && !/offer|campaign/i.test(base);
  return offer ? `${base} Offer` : base;
}

/** Vertical/horizontal relation category between two boxes: "above", "below", "left", "right" or "overlap". */
export function geometricRelation(a: NormalizedBox, b: NormalizedBox): { vertical: 'above' | 'below' | 'level'; horizontal: 'left' | 'right' | 'level'; overlaps: boolean } {
  const ca = center(a), cb = center(b);
  const overlaps = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  const dy = cb.y - ca.y, dx = cb.x - ca.x;
  return { vertical: Math.abs(dy) < 0.08 ? 'level' : dy > 0 ? 'above' : 'below', horizontal: Math.abs(dx) < 0.08 ? 'level' : dx > 0 ? 'left' : 'right', overlaps };
}

/** Importance of a role in a layout: geometry of a product matters more than that of a confetti piece. */
export const ROLE_WEIGHT: Record<StructuralRole, number> = { background: 0, product: 3, person: 3, frame: 2, headline: 2, cta: 2, panel: 1.5, offer: 1.5, price: 1.5, badge: 1, logo: 1, subheadline: 1, object: 1, body: 0.5, decoration: 0.3 };
/** Roles whose count defines the structure: one product and two products are different families. */
export const COUNT_CRITICAL: readonly StructuralRole[] = ['product', 'person', 'frame'];
const MAJOR = (role: StructuralRole) => ROLE_WEIGHT[role] >= 1;

export function elementSimilarity(a: NormalizedBox, b: NormalizedBox): number {
  const ca = center(a), cb = center(b), dist = Math.hypot(ca.x - cb.x, ca.y - cb.y);
  const centerSim = clamp(1 - dist / 0.25), extentSim = clamp(1 - Math.abs(Math.log2(extent(a) / extent(b))) / 1.5);
  return 0.65 * centerSim + 0.35 * extentSim;
}
/** Best one-to-one assignment within each role (greedy on similarity; element counts are small). */
export function mapElements(a: StructuralSignature, b: StructuralSignature): { mapping: Record<string, string>; sims: Record<string, number> } {
  const mapping: Record<string, string> = {}, sims: Record<string, number> = {}, used = new Set<string>();
  const pairs = a.elements.flatMap(x => b.elements.filter(y => y.role === x.role).map(y => ({ x, y, sim: elementSimilarity(x.box, y.box) }))).sort((p, q) => q.sim - p.sim);
  for (const p of pairs) { if (mapping[p.x.id] || used.has(p.y.id)) continue; mapping[p.x.id] = p.y.id; sims[p.x.id] = p.sim; used.add(p.y.id); }
  return { mapping, sims };
}
function backgroundSimilarity(a: BackgroundKind, b: BackgroundKind): number {
  if (a === b) return 1;
  if (plainBackground(a) && plainBackground(b)) return 0.9;
  if (a === 'unknown' || b === 'unknown') return 0.6;
  if (a === 'photo' || b === 'photo') return 0.2;
  return 0.5;
}

export interface SignatureComparison {
  score: number;
  breakdown: { roles: number; geometry: number; relations: number; background: number };
  /** Set when the structures cannot be one family whatever the rest says (e.g. one product vs two). */
  hardMismatch?: string;
  mapping: Record<string, string>;
}
/**
 * Role-aware structural similarity, 0..1, of a family's signature `a` and a creative's `b`. Weighted: geometry 0.5,
 * relations 0.25, role counts 0.15, background kind 0.1. A different count of products, people or frames caps the score
 * at 0.35: those creatives are never the same family, however alike their colours or text.
 */
export function compareSignatures(aIn: StructuralSignature, bIn: StructuralSignature): SignatureComparison {
  const a = normalizeSignature(aIn), b = normalizeSignature(bIn);
  const roles = [...new Set([...a.elements, ...b.elements].map(e => e.role))];
  let diff = 0, total = 0;
  for (const role of roles) { const ca = roleCount(a, role), cb = roleCount(b, role), w = ROLE_WEIGHT[role]; diff += w * Math.abs(ca - cb); total += w * Math.max(ca, cb); }
  const roleScore = total ? 1 - diff / total : 1;
  const { mapping, sims } = mapElements(a, b);
  let got = 0, weight = 0;
  for (const e of a.elements) { weight += ROLE_WEIGHT[e.role]; got += ROLE_WEIGHT[e.role] * (sims[e.id] ?? 0); }
  const mappedB = new Set(Object.values(mapping));
  for (const e of b.elements) if (!mappedB.has(e.id)) weight += ROLE_WEIGHT[e.role];
  const geometry = weight ? got / weight : 1;
  // Relations: for every pair of mapped major elements, does the layout relation agree (headline above product, CTA below…)?
  const major = a.elements.filter(e => MAJOR(e.role) && mapping[e.id]);
  let agree = 0, compared = 0;
  for (let i = 0; i < major.length; i++) for (let j = i + 1; j < major.length; j++) {
    const ra = geometricRelation(major[i].box, major[j].box), bi = b.elements.find(e => e.id === mapping[major[i].id])!, bj = b.elements.find(e => e.id === mapping[major[j].id])!, rb = geometricRelation(bi.box, bj.box);
    compared += 2; agree += Number(ra.vertical === rb.vertical) + Number(ra.horizontal === rb.horizontal);
  }
  const semA = new Set(a.relations.map(r => `${mapping[r.from]}|${r.type}|${mapping[r.to]}`)), semB = new Set(b.relations.map(r => `${r.from}|${r.type}|${r.to}`));
  const semUnion = new Set([...semA, ...semB]).size, semShared = [...semA].filter(k => semB.has(k)).length;
  const relations = (compared + semUnion) ? (agree + semShared) / (compared + semUnion) : 1;
  const background = backgroundSimilarity(a.background, b.background);
  let score = 0.15 * roleScore + 0.5 * geometry + 0.25 * relations + 0.1 * background;
  const critical = COUNT_CRITICAL.find(role => roleCount(a, role) !== roleCount(b, role));
  const hardMismatch = critical ? `${critical} count differs (${roleCount(a, critical)} vs ${roleCount(b, critical)})` : undefined;
  if (hardMismatch) score = Math.min(score, 0.35);
  return { score: round(score), breakdown: { roles: round(roleScore), geometry: round(geometry), relations: round(relations), background: round(background) }, ...(hardMismatch ? { hardMismatch } : {}), mapping };
}

/**
 * Accepting a family for a creative: every required element present and in place, the relation graph compatible, the
 * slot mapping unambiguous, and nothing large left unexplained. A high score alone is never enough.
 */
export function validateMatch(family: StructuralSignature, creative: StructuralSignature, required: string[], comparison = compareSignatures(family, creative)): MatchValidation {
  const a = normalizeSignature(family), b = normalizeSignature(creative), problems: string[] = [];
  if (comparison.hardMismatch) problems.push(`Structure differs: ${comparison.hardMismatch}.`);
  for (const id of required) {
    const e = a.elements.find(x => x.id === id);
    if (!e) continue;
    const mapped = b.elements.find(x => x.id === comparison.mapping[id]);
    if (!mapped) { problems.push(`Required ${e.role} is missing.`); continue; }
    const sim = elementSimilarity(e.box, mapped.box);
    if (sim < 0.5) problems.push(`The ${e.role} is in a different place (${zoneWords(e.box)} vs ${zoneWords(mapped.box)}).`);
  }
  for (const role of new Set(a.elements.map(e => e.role))) {
    if (COUNT_CRITICAL.includes(role)) continue;
    const slotsOfRole = a.elements.filter(e => e.role === role && required.includes(e.id)).length, inCreative = roleCount(b, role);
    if (slotsOfRole === 1 && inCreative > 1) {
      const boxes = b.elements.filter(e => e.role === role).map(e => area(e.box)).sort((x, y) => y - x);
      if (boxes[1] > boxes[0] * 0.8) problems.push(`Two ${role} regions compete for one field.`);
    }
  }
  const mapped = new Set(Object.values(comparison.mapping));
  // A badge, logo, button or text block without a field would be lost from the form: unexplained whatever its size.
  for (const e of b.elements) if (!mapped.has(e.id) && e.role !== 'decoration' && (MAJOR(e.role) || area(e.box) >= 0.04)) problems.push(`An unexplained ${e.role} (${zoneWords(e.box)}) is not part of this layout.`);
  if (comparison.breakdown.relations < 0.6) problems.push('The arrangement of elements differs.');
  return { passed: problems.length === 0, problems };
}

export type MatchDecision = 'high' | 'ambiguous' | 'new';
export const decide = (score: number, t: MatchThresholds, high = t.high): MatchDecision => score >= high ? 'high' : score >= t.ambiguous ? 'ambiguous' : 'new';
/** A neutral description of the layout, used in the prompt templates. Structural only. */
export function layoutSentence(signature: StructuralSignature): string {
  const s = normalizeSignature(signature);
  const parts = s.elements.filter(e => e.role !== 'decoration').map(e => `${e.role} ${zoneWords(e.box)} (~${Math.round(extent(e.box) * 100)}% of the canvas)`);
  return parts.join('; ');
}
