/**
 * Exact output layer count, applied locally after Seedream and the background rebuild. Seedream is never asked for a
 * count: it returns its natural semantic layers, and this merges them deterministically down to the user's target.
 *
 * Background layers merge first, top-down: border into inner backdrop, then that into the outer background, then the
 * base as well (one clean background composition). Foreground layers (subject, held objects) stay separate while the
 * target leaves room for them; only then does the smallest merge into the largest. Target 1 is the full composite.
 * Counts include the base. Semantic layers and raw provider files are never modified; merged groups are new PNGs.
 * That is Template A's strategy (groupLayers); Template B (product posters) classifies roles locally from names and
 * geometry (classifyPosterLayers), has its own merge order (groupPosterLayers), and its suggested count is the natural
 * count found in the decomposition.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { backgroundRole, placedOverlay, type Canvas, type LayerInfo } from './layerizeArtifacts.js';

/** A final output layer; `sources` are the semantic layer files it was made from (its own file when not merged). */
export type OutputLayer = LayerInfo & { sources: string[] };
export type LayerCount = {
  suggestedLayers?: number; targetLayers?: number;
  /** Layers Seedream returned; semanticLayers adds a locally rebuilt outer background when Seedream returned none. */
  providerReturnedLayers: number; semanticLayers: number; finalOutputLayers: number; normalized: boolean;
  groups: { name: string; file: string; sourceLayers: string[] }[];
  warnings: string[];
  /** Template B only: each semantic layer's locally classified role and why. */
  roles?: LayerRoleInfo[];
};

type Role = 'base' | 'outer' | 'inner' | 'border' | 'foreground';
const ORDER: Record<Role, number> = { base: 0, outer: 1, inner: 2, border: 3, foreground: 4 };
const LABEL: Partial<Record<Role, string>> = { base: 'Base', outer: 'Outer background', inner: 'Inner backdrop', border: 'Border' };
const roleOf = (l: LayerInfo): Role => l.placement.kind === 'base' ? 'base' : backgroundRole(l.name) ?? 'foreground';
const area = (group: LayerInfo[]) => group.reduce((sum, l) => sum + (l.opaquePercent / 100) * l.placement.width * l.placement.height, 0);
const byZ = (a: LayerInfo, b: LayerInfo) => a.zIndex - b.zIndex;

/** Groups of semantic layers, exactly `target` of them when the layers allow it. */
export function groupLayers(layers: LayerInfo[], target: number): LayerInfo[][] {
  if (target <= 1) return [layers];
  const bg = layers.filter(l => roleOf(l) !== 'foreground').sort((a, b) => ORDER[roleOf(a)] - ORDER[roleOf(b)] || byZ(a, b)).map(l => [l]);
  const fg = layers.filter(l => roleOf(l) === 'foreground').sort(byZ).map(l => [l]);
  // Foreground keeps every layer separate while there is room beside at least one background layer.
  const fgRoom = Math.max(1, target - (bg.length ? 1 : 0));
  while (fg.length > fgRoom) {
    const smallest = fg.reduce((min, g) => (area(g) < area(min) ? g : min));
    fg.splice(fg.indexOf(smallest), 1);
    const largest = fg.reduce((max, g) => (area(g) > area(max) ? g : max));
    largest.push(...smallest);
  }
  // Background merges top-down: [base][outer][inner][border] → [base][outer][inner+border] → [base][outer+inner+border] → [all].
  while (bg.length + fg.length > target && bg.length >= 2) { const top = bg.pop()!; bg[bg.length - 1].push(...top); }
  return [...bg, ...fg];
}

// ---------------------------------------------------------------------------------------------------------------------
// Template B (product/editorial posters): its own roles and merge order. Template A's groupLayers above is unchanged.
//
// Seedream only separates the major visible elements and names them in its own words ("Black power cable", "Floating
// orange spheres"); it is never told which roles exist. Roles are decided here, from the layer's name, the positive part
// of its description, its box, area and fill, and its relation to the main product. Not every role exists in a poster.

export type PosterRole = 'base' | 'background' | 'backdrop' | 'border' | 'support' | 'decor' | 'text' | 'product' | 'secondary' | 'unknown';
/** A name-level reading: a role, or a hint resolved against the main product (lighting effect, attached part, dish). */
type Hint = PosterRole | 'effect' | 'part' | 'container';
/** Layer geometry in canvas pixels: the box of its opaque pixels, their area, and area / box area. */
export type LayerGeometry = { box: { x0: number; y0: number; x1: number; y1: number }; area: number; fill: number };
/** A layer's Template B role and why; `attached` joins the main product, `folded` joins the background (never a layer). */
export type PosterLayerRole = { file: string; name?: string; role: PosterRole; reason: string; attached?: boolean; folded?: boolean };

const words = (list: string) => new RegExp(`\\b(?:${list})\\b`, 'i');
const EFFECT = words('highlights?|reflections?|shadows?|glare|glow|shine|sheen|specular|gloss|flares?');
const TEXT = words('text|texts|headline|heading|title|caption|badge|label|logo|logotype|wordmark|price|slogan|tagline|typography|lettering|letters|words');
const BORDER = words('border|borders|frame|framing');
const BACKGROUND = words('background|wall|sky|studio|floor|gradient|scene');
const BACKDROP = words('backdrop|panel|card|board|colou?r ?block');
const DECOR = words('decor\\w*|ornament\\w*|graphics?|spheres?|orbs?|bubbles?|circles?|dots?|lines?|stripes?|grids?|stars?|starbursts?|sunbursts?|bursts?|rays?|sparkles?|confetti|patterns?|accents?|shapes?|waves?|swirls?|squiggles?|ovals?|ellipses?|triangles?|squares?|rectangles?|polygons?|geometric|blobs?|splash\\w*|motifs?');
const PRODUCT = words('main product|product|hero|main object|main item|centerpiece|centrepiece');
const SECONDARY = words('secondary|prop|props|accessory|accessories|companion');
const SUPPORT = words('support|pedestal|plinth|podium|platform|riser|stand|tabletop|countertop|shelf|slab|steps?|stairs|cube');
const CONTAINER = words('plate|bowl|dish|tray|platter|cup|mug|jar|basket|pan|pot|saucer');
const PART = words('cable|cord|wire|chain|rope|string|stem|shade|lampshade|bulb|canopy|cap|lid|handle|strap|buttons?|cameras?|lens|lenses|screen|case|body|legs?|arms?|feet|foot|knob|switch|plug|base|garnish|toppings?|sauce|crumbs?|pieces?|slices?|chunks?|bits|flakes?|sprinkles?|florets?|leaves|leaf|seeds?');
/** "Hero lamp on a white pedestal" is about the lamp: only the head, before a relation word, names the layer. */
const head = (text: string) => text.split(/\b(?:with|including|plus|on|onto|over|under|beneath|below|above|beside|behind|around|against|in front of|near|next to|holding|supporting|inside|within|of the|for)\b/i)[0];

function nameHint(name: string): Hint {
  const h = head(name);
  if (EFFECT.test(h) && !PRODUCT.test(h)) return 'effect';
  if (TEXT.test(h)) return 'text';
  if (BORDER.test(h)) return 'border';
  if (BACKGROUND.test(h)) return 'background';
  if (BACKDROP.test(h)) return 'backdrop';
  if (DECOR.test(h)) return 'decor';
  if (PRODUCT.test(h)) return 'product';
  if (SECONDARY.test(h)) return 'secondary';
  if (SUPPORT.test(h)) return 'support';
  if (CONTAINER.test(h)) return 'container';
  if (PART.test(h)) return 'part';
  return 'unknown';
}
/** The clauses of a description that say what is in the layer: never those that exclude or only preserve something. */
const positiveClauses = (description: string) => description.split(/[.;:,]|\bbut\b/i).filter(c => !/\b(?:no|not|exclud\w*|without|except|avoid\w*|never|other than|keep out|preserve|keep its)\b/i.test(c));
/**
 * Descriptions say what to keep and what to leave out ("exclude the lamp", "preserve its shape and lines"), so only
 * their positive clauses count, and only for unambiguous roles; shape and effect words there are never a role.
 */
function descriptionHint(description: string): Hint {
  const clauses = positiveClauses(description);
  for (const clause of clauses) {
    const h = head(clause);
    for (const [re, hint] of [[PRODUCT, 'product'], [BACKGROUND, 'background'], [BACKDROP, 'backdrop'], [SUPPORT, 'support'], [CONTAINER, 'container'], [/\b(?:decorative|ornament\w*)\b/i, 'decor']] as const) if (re.test(h)) return hint;
  }
  return 'unknown';
}
/** A layer the Template B planner asked Seedream for; the first is the hero (layerizeTemplateB.ts asks for the hero first). */
export type PlannedPosterLayer = { name: string; description: string };
/** Words that say how to extract or group rather than what is in a layer. */
const FILLER = new Set(['the', 'and', 'with', 'its', 'their', 'this', 'that', 'for', 'from', 'into', 'onto', 'one', 'layer', 'layers', 'extract', 'separate', 'separately', 'include', 'includes',
  'including', 'all', 'any', 'other', 'object', 'objects', 'only', 'each', 'keep', 'are', 'together', 'group', 'groups', 'grouped', 'whole', 'complete', 'entire', 'visible', 'original']);
export const layerWords = (name?: string, description?: string) =>
  new Set(([name ?? '', ...positiveClauses(description ?? '')].join(' ').toLowerCase().match(/\p{L}+/gu) ?? []).filter(word => word.length >= 3 && !FILLER.has(word)));
export const similarity = (a: Set<string>, b: Set<string>) => { let shared = 0; for (const word of a) if (b.has(word)) shared++; return shared / Math.max(1, a.size + b.size - shared); };
/**
 * The layer that is the planner's hero: its name and positive description share the most words with the first planned
 * layer, that planned layer is also its own best match, and enough words are shared. Seedream names layers freely, so a
 * hero combined with decoration it touches can carry a decoration word ("Group 1: Phone and specified spheres"); the
 * planner, which reasoned about the image, says which layer is the hero. Undefined when nothing matches clearly.
 */
function plannedHero<T extends { l: LayerInfo }>(items: T[], planned: PlannedPosterLayer[] | undefined): T | undefined {
  if (!planned?.length) return undefined;
  const plans = planned.map(p => layerWords(p.name, p.description));
  const scored = items.map(it => { const words = layerWords(it.l.name, it.l.description); return { it, scores: plans.map(plan => similarity(words, plan)) }; });
  if (!scored.length) return undefined;
  const best = scored.reduce((a, b) => (b.scores[0] > a.scores[0] ? b : a));
  return best.scores[0] >= 0.2 && best.scores[0] >= Math.max(...best.scores) ? best.it : undefined;
}
const HINT_ROLE: Record<Hint, PosterRole> = { base: 'base', background: 'background', backdrop: 'backdrop', border: 'border', support: 'support', decor: 'decor', text: 'text', product: 'product', secondary: 'secondary', unknown: 'unknown', effect: 'unknown', part: 'unknown', container: 'unknown' };
/** Template B role from placement and the provider's layer name alone (no geometry). classifyPosterLayers decides for real. */
export const posterRole = (l: LayerInfo): PosterRole => l.placement.kind === 'base' ? 'base' : HINT_ROLE[nameHint(l.name ?? '')];

/** Geometry from the placement box and opaque percentage; measureLayers gives the exact opaque box when files are at hand. */
function placementGeometry(l: LayerInfo): LayerGeometry {
  const p = l.placement, boxArea = Math.max(1, p.width * p.height), area = (l.opaquePercent / 100) * boxArea;
  return { box: { x0: p.x, y0: p.y, x1: p.x + p.width, y1: p.y + p.height }, area, fill: area / boxArea };
}
/** Exact geometry: the box of each layer's opaque pixels (alpha > 127) in canvas pixels. */
export async function measureLayers(dir: string, layers: LayerInfo[]): Promise<Map<string, LayerGeometry>> {
  const out = new Map<string, LayerGeometry>();
  for (const l of layers) {
    if (l.placement.kind === 'unresolved') continue;
    const { data, info } = await sharp(readFileSync(join(dir, l.file))).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
    let x0 = info.width, y0 = info.height, x1 = -1, y1 = -1, count = 0;
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      if (data[y * info.width + x] <= 127) continue;
      count++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (!count) continue;
    const sx = l.placement.width / info.width, sy = l.placement.height / info.height;
    const box = { x0: l.placement.x + x0 * sx, y0: l.placement.y + y0 * sy, x1: l.placement.x + (x1 + 1) * sx, y1: l.placement.y + (y1 + 1) * sy };
    const area = count * sx * sy;
    out.set(l.file, { box, area, fill: area / Math.max(1, (box.x1 - box.x0) * (box.y1 - box.y0)) });
  }
  return out;
}

type Box = LayerGeometry['box'];
const boxW = (b: Box) => b.x1 - b.x0, boxH = (b: Box) => b.y1 - b.y0, boxArea = (b: Box) => Math.max(1, boxW(b) * boxH(b));
const intersection = (a: Box, b: Box) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
const gap = (a: Box, b: Box) => Math.max(0, a.x0 - b.x1, b.x0 - a.x1, a.y0 - b.y1, b.y0 - a.y1);
const centerIn = (inner: Box, outer: Box) => { const cx = (inner.x0 + inner.x1) / 2, cy = (inner.y0 + inner.y1) / 2; return cx >= outer.x0 && cx <= outer.x1 && cy >= outer.y0 && cy <= outer.y1; };

/**
 * Template B roles for a decomposition (see PosterLayerRole). In order:
 * 1. Name first (only the head, before "on/with/…"), else the positive clauses of the description.
 * 2. Geometry corrects names: a "frame" that is not canvas-sized is decoration; a full-canvas backdrop is the background.
 * 3. Main product: the layer matching the planner's hero (`planned`, first entry), whatever its name says; else the
 *    largest product-named layer, else the largest central unnamed foreground layer.
 * 4. Attached to the product: other product-named pieces; parts (cable, stem, shade, camera, button, case…) touching it;
 *    a dish/plate overlapping it; unnamed pieces or "supports" at least 60% inside its box; small unnamed pieces (up to
 *    a quarter of its area) touching it; text 90% inside it; highlights/reflections/shadows mostly over it. "Touching"
 *    is transitive (cable → cap → shade). Other lighting effects fold into the background.
 * 5. Unnamed leftovers: full-canvas solid → background; large solid shape behind the product → backdrop; solid layer
 *    under the product at least as wide as 60% of it → support; repeated similar shapes, or sparse/thin marks → decoration;
 *    a solid object of at least 1% of the canvas → secondary object; anything else stays unknown.
 * 6. A large solid decorative shape behind the product is a backdrop/panel. Decoration is never attached to the product
 *    and never a secondary object, however much it overlaps.
 */
export function classifyPosterLayers(layers: LayerInfo[], canvas: Canvas, measured?: Map<string, LayerGeometry>, planned?: PlannedPosterLayer[]): PosterLayerRole[] {
  const W = canvas.width, H = canvas.height, canvasArea = W * H;
  const items = [...layers].sort(byZ).map(l => {
    const g = measured?.get(l.file) ?? placementGeometry(l);
    const byName = l.name ? nameHint(l.name) : 'unknown';
    const hint: Hint = l.placement.kind === 'base' ? 'base' : byName !== 'unknown' ? byName : l.description ? descriptionHint(l.description) : 'unknown';
    const source = l.placement.kind === 'base' ? 'provider base image' : byName !== 'unknown' ? `name "${l.name}"` : hint !== 'unknown' ? 'description' : 'geometry';
    return { l, g, hint, source, role: undefined as PosterRole | undefined, reason: '', attached: false, folded: false };
  });
  const full = (b: Box) => boxW(b) >= 0.9 * W && boxH(b) >= 0.9 * H;
  for (const it of items) {
    if (it.hint === 'base') { it.role = 'base'; it.reason = 'provider base image'; continue; }
    if (it.g.area < canvasArea * 0.001) { it.folded = true; it.role = 'background'; it.reason = 'near-empty (under 0.1% of the canvas)'; continue; }
    if (it.hint === 'border' && !(boxW(it.g.box) >= 0.8 * W && boxH(it.g.box) >= 0.8 * H)) { it.hint = 'decor'; it.source += ', not canvas-sized so an ornament'; }
    if (it.hint === 'background' && DECOR.test(head(it.l.name ?? '')) && boxArea(it.g.box) < 0.25 * canvasArea) { it.hint = 'decor'; it.source += ', small so decoration'; }
    if (it.hint === 'backdrop' && full(it.g.box) && it.g.fill >= 0.6) { it.hint = 'background'; it.source += ', full-canvas so the background'; }
  }
  const open = items.filter(it => !it.role);
  // 3. The main product: the planner's hero when one layer clearly matches it.
  const hero = plannedHero(open, planned);
  if (hero) { hero.hint = 'product'; hero.source = `the planner's hero layer "${planned![0].name}"${hero.l.name ? `, named "${hero.l.name}"` : ''}`; }
  const named = open.filter(it => it.hint === 'product');
  const score = (it: typeof items[number]) => {
    const cx = (it.g.box.x0 + it.g.box.x1) / 2 - W / 2, cy = (it.g.box.y0 + it.g.box.y1) / 2 - H / 2;
    return it.g.area * (1 - 0.5 * Math.min(1, Math.hypot(cx, cy) / Math.hypot(W / 2, H / 2)));
  };
  const candidates = named.length ? named : open.filter(it => ['unknown', 'container', 'part'].includes(it.hint) && !(full(it.g.box) && it.g.fill >= 0.6));
  const main = hero ?? (candidates.length ? candidates.reduce((best, it) => ((named.length ? it.g.area > best.g.area : score(it) > score(best)) ? it : best)) : undefined);
  if (main) { main.role = 'product'; main.reason = named.length ? `main product (${main.source})` : `main product: largest central foreground layer (${main.source})`; }
  // 4. What belongs to the main product. Repeated until stable, so a cable touching a cap that touches the shade joins
  // too; attached pieces extend where the product is, never what the product box is measured against (`main.g.box`).
  const reach = 0.02 * Math.max(W, H);
  const productPieces = main ? [main] : [];
  for (let changed = true; changed;) {
    changed = false;
    for (const it of open) {
      if (it.role || it === main) continue;
      if (attachOne(it)) { productPieces.push(it); changed = true; }
    }
  }
  for (const it of open) if (!it.role && it.hint === 'effect') { it.role = 'background'; it.folded = true; it.reason = `lighting effect, never a layer of its own; folded into the background (${it.source})`; }
  function attachOne(it: typeof items[number]): boolean {
    const inside = main ? intersection(it.g.box, main.g.box) / boxArea(it.g.box) : 0;
    const touching = productPieces.some(p => gap(it.g.box, p.g.box) <= reach);
    const attach = (why: string) => { it.role = 'product'; it.attached = true; it.reason = `attached to the main product: ${why} (${it.source})`; return true; };
    if (!main) return false;
    if (it.hint === 'effect') return inside >= 0.5 && attach('lighting effect over the product');
    if (it.hint === 'product') return attach('another product-named piece');
    if (it.hint === 'part' && touching) return attach('a part touching the product');
    if (it.hint === 'container' && intersection(it.g.box, main.g.box) / Math.min(boxArea(it.g.box), boxArea(main.g.box)) >= 0.3) return attach('the dish or container of the product composition');
    if (['unknown', 'part', 'container', 'support'].includes(it.hint) && inside >= 0.6) return attach(`${Math.round(inside * 100)}% inside the product's box`);
    if (it.hint === 'unknown' && touching && it.g.area <= 0.25 * main.g.area) return attach('a small unnamed piece touching the product');
    if (it.hint === 'text' && inside >= 0.9) return attach('text printed on the product');
    if (it.hint === 'secondary' && inside >= 0.9) return attach('entirely inside the product');
    return false;
  }
  // 5–6. Named roles stand; unnamed leftovers are read from geometry.
  const leftovers: typeof items = [];
  for (const it of open) {
    if (it.role) continue;
    if (it.hint === 'decor' && main && it.g.area >= 0.1 * canvasArea && it.g.fill >= 0.8 && !full(it.g.box) && centerIn(main.g.box, it.g.box)) { it.role = 'backdrop'; it.reason = `large solid shape behind the product, so a backdrop/panel (${it.source})`; continue; }
    if (!['unknown', 'part', 'container'].includes(it.hint)) { it.role = HINT_ROLE[it.hint]; it.reason = `${it.role} (${it.source})`; continue; }
    const b = it.g.box, geometry = (role: PosterRole, why: string) => { it.role = role; it.reason = `${why} (${it.source})`; };
    if (full(b) && it.g.fill >= 0.6) geometry('background', 'solid full-canvas layer');
    else if (main && it.g.area >= 0.1 * canvasArea && it.g.fill >= 0.8 && centerIn(main.g.box, b)) geometry('backdrop', 'large solid shape behind the product');
    else if (main && b.y0 >= main.g.box.y0 + 0.5 * boxH(main.g.box) && b.y0 <= main.g.box.y1 + 0.05 * H && Math.min(b.x1, main.g.box.x1) - Math.max(b.x0, main.g.box.x0) >= 0.5 * boxW(main.g.box)
      && boxW(b) >= 0.6 * boxW(main.g.box) && it.g.fill >= 0.5) geometry('support', 'solid layer directly under the product');
    else leftovers.push(it);
  }
  const similar = (a: typeof items[number], b: typeof items[number]) => {
    const ratio = (x: number, y: number) => Math.max(x, y) / Math.max(1e-6, Math.min(x, y));
    return ratio(boxArea(a.g.box), boxArea(b.g.box)) <= 2.5 && ratio(boxW(a.g.box) / boxH(a.g.box), boxW(b.g.box) / boxH(b.g.box)) <= 1.6 && Math.abs(a.g.fill - b.g.fill) <= 0.12;
  };
  for (const it of leftovers) {
    if (leftovers.some(other => other !== it && similar(it, other))) { it.role = 'decor'; it.reason = `repeated similar shape, so decoration (${it.source})`; }
    else if (it.g.fill < 0.3) { it.role = 'decor'; it.reason = `sparse or thin marks, so decoration (${it.source})`; }
    else if (main && it.g.area >= 0.01 * canvasArea) { it.role = 'secondary'; it.reason = `independent solid foreground object apart from the product (${it.source})`; }
    else { it.role = 'unknown'; it.reason = `small unclassified element (${it.source})`; }
  }
  return items.map(it => ({ file: it.l.file, ...(it.l.name ? { name: it.l.name } : {}), role: it.role!, reason: it.reason, ...(it.attached ? { attached: true } : {}), ...(it.folded ? { folded: true } : {}) }));
}

const POSTER_LABEL: Record<PosterRole, string> = { base: 'Base', background: 'Background', backdrop: 'Backdrop', border: 'Border', decor: 'Decorative graphics', support: 'Support', text: 'Text',
  product: 'Main product', secondary: 'Secondary object', unknown: 'Unclassified element' };
type Buckets = Record<PosterRole, LayerInfo[][]>;

/**
 * Template B groups, from classifyPosterLayers. Natural consolidation first (always): the main product with everything
 * attached to it is one layer; all decoration is one group; border pieces are one group; near-empty layers and stray
 * lighting effects fold into the base (or background); in combined mode secondary objects join the product. Then, while
 * above the target: text together; unclassified into the background; decoration into the backdrop; border, support,
 * text and backdrops into the background; backgrounds into one, then into the base; secondary objects together;
 * everything at target 1. Decoration and backgrounds never merge into the product except at target 1.
 * `natural` is the consolidated count (Template B's suggested layer count).
 */
export function groupPosterLayers(layers: LayerInfo[], target: number, separate: boolean, canvas: Canvas, measured?: Map<string, LayerGeometry>, planned?: PlannedPosterLayer[]): { groups: LayerInfo[][]; natural: number; notes: string[]; roles: PosterLayerRole[] } {
  const notes: string[] = [];
  const roles = classifyPosterLayers(layers, canvas, measured, planned), byFile = new Map(layers.map(l => [l.file, l]));
  const b: Buckets = { base: [], background: [], backdrop: [], border: [], decor: [], support: [], text: [], product: [], secondary: [], unknown: [] };
  const folded: LayerInfo[] = [], attached: LayerInfo[] = [];
  for (const r of roles) {
    const l = byFile.get(r.file)!;
    if (r.folded) folded.push(l);
    else if (r.attached) attached.push(l);
    else b[r.role].push([l]);
  }
  if (b.product.length && attached.length) {
    b.product[0].push(...attached);
    notes.push(`PRODUCT_PARTS_KEPT_TOGETHER: ${attached.map(l => `${l.file}${l.name ? ` (${l.name})` : ''}`).join(', ')} kept with the main product as one layer.`);
  }
  if (b.decor.length > 1) { notes.push(`DECORATION_GROUPED: ${b.decor.length} decorative layers form one decorative group.`); b.decor = [b.decor.flat()]; }
  if (b.border.length > 1) b.border = [b.border.flat()];
  if (!separate && b.secondary.length && b.product.length) {
    b.product[0].push(...b.secondary.flat());
    notes.push('SECONDARY_COMBINED: secondary objects are kept with the main product ("Separate secondary object from main product" is off).');
    b.secondary = [];
  }
  if (folded.length) {
    const home = b.base[0] ?? b.background[0] ?? b.decor[0];
    if (home) home.push(...folded); else b.decor.push(folded);
    const tiny = roles.filter(r => r.folded && /near-empty/.test(r.reason)).map(r => r.file), effects = roles.filter(r => r.folded && !/near-empty/.test(r.reason)).map(r => r.file);
    if (tiny.length) notes.push(`NEAR_EMPTY_LAYERS_FOLDED: ${tiny.join(', ')} are nearly empty and were folded into the background.`);
    if (effects.length) notes.push(`EFFECT_LAYERS_FOLDED: ${effects.join(', ')} are lighting effects (highlight, reflection or shadow) and were folded into the background.`);
  }
  const total = () => Object.values(b).reduce((sum, groups) => sum + groups.length, 0);
  const natural = total();
  /** Moves one group of `from` into the first group of the first non-empty receiver; false when nothing to do. */
  const merge = (from: PosterRole, ...into: PosterRole[]) => {
    const receiver = into.find(k => b[k].length && !(k === from && b[k].length < 2));
    if (!b[from].length || !receiver) return false;
    const group = b[from].pop()!;
    b[receiver][0].push(...group);
    return true;
  };
  const steps: (() => boolean)[] = [
    () => b.text.length > 1 && merge('text', 'text'),
    () => merge('unknown', 'background', 'base'),
    () => merge('decor', 'backdrop', 'background', 'base'),
    () => merge('border', 'background', 'base'),
    () => merge('support', 'background', 'base'),
    () => merge('text', 'background', 'base'),
    () => merge('backdrop', 'background', 'base'),
    () => (b.background.length > 1 ? merge('background', 'background') : merge('background', 'base')),
    () => b.secondary.length > 1 && merge('secondary', 'secondary'),
    () => merge('secondary', 'product'),
  ];
  for (const step of steps) while (total() > target && step()) { /* keep merging at this priority */ }
  const groups = Object.values(b).flat().filter(g => g.length);
  return { groups: target <= 1 ? [layers] : groups, natural, notes, roles };
}

/** Near-empty: under 0.1% of the canvas (folded into the background, never named in a group). */
const nearEmpty = (l: LayerInfo, canvas: Canvas) => l.placement.kind !== 'base' && area([l]) < canvas.width * canvas.height * 0.001;

async function composite(dir: string, group: LayerInfo[], canvas: Canvas): Promise<Buffer> {
  const overlays: OverlayOptions[] = [];
  for (const l of [...group].sort(byZ)) {
    const overlay = await placedOverlay(readFileSync(join(dir, l.file)), l.placement, canvas);
    if (overlay) overlays.push(overlay);
  }
  return sharp({ create: { width: canvas.width, height: canvas.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(overlays).png().toBuffer();
}

/**
 * Final output layers for a run. Without a target the semantic layers are the output, unchanged. With one, unplaced
 * layers are left out (they cannot be composited) and the rest are grouped to the target; a single-layer group is the
 * semantic layer itself (same file and placement), a merged group becomes output-NN.png on the full canvas.
 */
/**
 * `strategy`: the template's merge order (default Template A); `separate`: its grouping checkbox (Template B needs it);
 * `plannedLayers`: Template B's planned layers, hero first, used to find the main product (ignored by Template A).
 */
export type NormalizeOptions = { strategy?: 'template-a' | 'template-b' | 'template-c'; separate?: boolean; plannedLayers?: PlannedPosterLayer[]; roleStrategy?: RoleStrategy };
/** A layer's locally decided role and why (Template B's are PosterLayerRole; other templates name their own roles). */
export type LayerRoleInfo = { file: string; name?: string; role: string; reason: string; attached?: boolean; folded?: boolean };
/**
 * A template's own local roles and merge order (Template C), used instead of Template A's or B's grouping. `group` returns
 * exactly `target` groups when the layers allow it, the natural (consolidated) count and each layer's role; `label` names a role.
 */
export type RoleStrategy = {
  group: (layers: LayerInfo[], target: number, canvas: Canvas, measured: Map<string, LayerGeometry>) => { groups: LayerInfo[][]; natural: number; notes: string[]; roles: LayerRoleInfo[] };
  label: (role: string) => string | undefined;
};

export async function normalizeLayerCount(dir: string, canvas: Canvas, layers: LayerInfo[], target?: { suggestedLayers?: number; targetLayers?: number }, options: NormalizeOptions = {}): Promise<{ outputLayers: OutputLayer[]; layerCount: LayerCount }> {
  const poster = options.strategy === 'template-b', separate = options.separate !== false, custom = options.roleStrategy;
  const providerReturnedLayers = layers.filter(l => !l.rebuilt || l.rawFile).length;
  const placeable = layers.filter(l => l.placement.kind !== 'unresolved'), unplaced = layers.filter(l => l.placement.kind === 'unresolved');
  // Template B: roles from exact opaque geometry; its suggested count is the natural semantic count of this decomposition.
  const measured = poster || custom ? await measureLayers(dir, placeable) : undefined;
  const natural = custom ? custom.group(placeable, Infinity, canvas, measured!) : poster ? groupPosterLayers(placeable, Infinity, separate, canvas, measured, options.plannedLayers) : undefined;
  const roleByFile = new Map(natural?.roles.map(r => [r.file, r.role]));
  const suggestedLayers = natural ? natural.natural : target?.suggestedLayers;
  const base = { suggestedLayers, targetLayers: target?.targetLayers, providerReturnedLayers, semanticLayers: layers.length, ...(natural ? { roles: natural.roles } : {}) };
  const label = (l: LayerInfo) => (custom ? custom.label(roleByFile.get(l.file) ?? 'unknown') : poster ? POSTER_LABEL[(roleByFile.get(l.file) as PosterRole | undefined) ?? posterRole(l)] : LABEL[roleOf(l)]) ?? l.name ?? 'Layer';
  if (target?.targetLayers === undefined) {
    const outputLayers = layers.map(l => ({ ...l, sources: [l.file] }));
    return { outputLayers, layerCount: { ...base, finalOutputLayers: layers.length, normalized: false, groups: layers.map(l => ({ name: label(l), file: l.file, sourceLayers: [l.file] })), warnings: [] } };
  }
  const warnings: string[] = [];
  if (unplaced.length) warnings.push(`UNPLACED_LAYERS_EXCLUDED: ${unplaced.map(l => l.file).join(', ')} could not be placed, so they are not part of the ${target.targetLayers}-layer output (raw files kept).`);
  const posterGroups = custom ? custom.group(placeable, target.targetLayers, canvas, measured!) : poster ? groupPosterLayers(placeable, target.targetLayers, separate, canvas, measured, options.plannedLayers) : undefined;
  if (posterGroups) warnings.push(...posterGroups.notes);
  const groups = (posterGroups ? posterGroups.groups : groupLayers(placeable, target.targetLayers)).sort((a, b) => Math.min(...a.map(l => l.zIndex)) - Math.min(...b.map(l => l.zIndex)));
  if (groups.length < target.targetLayers) warnings.push(`FEWER_LAYERS_THAN_TARGET: Seedream returned ${placeable.length} placeable layers, so ${groups.length} are output instead of ${target.targetLayers} (layers are only merged, never split).`);
  const outputLayers: OutputLayer[] = [];
  let merged = 0;
  for (const group of groups) {
    if (group.length === 1) { outputLayers.push({ ...group[0], index: outputLayers.length, sources: [group[0].file] }); continue; }
    const members = [...group].sort(byZ), file = `output-${String(++merged).padStart(2, '0')}.png`;
    const png = await composite(dir, members, canvas);
    writeFileSync(join(dir, file), png);
    const alpha = await sharp(png).extractChannel(3).raw().toBuffer();
    let opaque = 0; for (const a of alpha) if (a > 127) opaque++;
    outputLayers.push({ index: outputLayers.length, file, zIndex: members[0].zIndex, name: groups.length === 1 ? 'Composite (all layers)' : [...new Set(members.filter(l => !((poster || custom) && nearEmpty(l, canvas))).map(label))].join(' + '),
      pixelWidth: canvas.width, pixelHeight: canvas.height, opaquePercent: Math.round(1000 * opaque / (canvas.width * canvas.height)) / 10,
      placement: { kind: 'full-canvas', x: 0, y: 0, width: canvas.width, height: canvas.height }, sources: members.map(l => l.file) });
  }
  return { outputLayers, layerCount: { ...base, finalOutputLayers: outputLayers.length, normalized: true,
    groups: outputLayers.map(l => ({ name: l.sources.length === 1 ? label(l) : l.name!, file: l.file, sourceLayers: l.sources })), warnings } };
}
