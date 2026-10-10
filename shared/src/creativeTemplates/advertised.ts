/**
 * Which objects of an analyzed creative are the products it advertises: what "Generate creative template" keeps exactly
 * (its own pixels) when nobody chose. The same rules run in the browser (to show the choice) and on the server (to use
 * it), so what the user sees is what is kept.
 *
 * Evidence, strongest first:
 *   1. what the analysis says the creative is about: its main candidates, of any foreground kind (a sofa is furniture;
 *      a person is the subject when no product is shown), plus the analysis' own advertised list when it gave one
 *   2. products tied to those by evidence: an accessory, the same brand, a related product shown as part of the offer
 *      (each with confidence ≥ 0.7), or a product carrying the same visible brand as a kept one
 * Never kept on their own: the background scenery, decorations and effects, supporting furniture (stands, plinths,
 * pedestals), props merely placed on or next to a product, logos and overlaid text (a new scene has none), and
 * detections the user marked as wrong. A product's attached parts (a control panel, a lid) go with it, not as
 * products of their own. Whoever holds or wears a kept product is kept with it (protectedGroup), so a grip is never cut.
 */
import { holderOf, isForeground, type SceneDescription, type SceneObject } from './scene.js';

export interface AdvertisedSelection {
  /** The products (and subjects) to keep, in the scene's order. */
  ids: string[];
  /** Why each was chosen, in plain words ("what the creative is about", "related to Freestanding appliance"). */
  reasons: Record<string, string>;
  /** Attached parts that travel inside their product's cutout: part id → product id. */
  parts: Record<string, string>;
  /** analysis: the analysis named what it advertises; rules: chosen from its main candidates and relations. */
  basis: 'analysis' | 'rules';
  /** Nothing was named as main: the most prominent foreground objects were taken instead. */
  fallback: boolean;
}
/** The most objects kept at once (each is one mask request). */
export const MAX_ADVERTISED = 8;
const LINKS = ['accessory_of', 'same_brand_as', 'related_to'] as const;
const LINK_WORDS: Record<(typeof LINKS)[number], string> = { accessory_of: 'an accessory of', same_brand_as: 'the same brand as', related_to: 'shown with' };
const live = (o: SceneObject | undefined): o is SceneObject => !!o && !o.ignored && isForeground(o);
const area = (o: SceneObject) => o.box.w * o.box.h;
const sellable = (o: SceneObject) => o.kind === 'product' || o.kind === 'object';
/** Two regions overlap (or meet within 1% of the image). */
const touching = (a: SceneObject, b: SceneObject) => a.box.x < b.box.x + b.box.w + 0.01 && b.box.x < a.box.x + a.box.w + 0.01 && a.box.y < b.box.y + b.box.h + 0.01 && b.box.y < a.box.y + a.box.h + 0.01;

export function advertisedProducts(scene: SceneDescription & { advertised?: string[] }): AdvertisedSelection {
  const byId = (id: string) => scene.objects.find(o => o.id === id);
  const reasons: Record<string, string> = {}, kept: string[] = [];
  const keep = (o: SceneObject, why: string) => { if (!kept.includes(o.id)) { kept.push(o.id); reasons[o.id] = why; } };
  // 1. What the creative is about.
  // A stand or plinth is never a product, whatever an analysis calls it.
  const named = (scene.advertised ?? []).map(byId).filter(live).filter(o => o.kind !== 'furniture' || o.importance === 'main');
  for (const o of named) keep(o, 'named by the analysis as advertised');
  const mains = scene.mainCandidates.map(byId).filter(live);
  for (const o of mains) keep(o, 'what the creative is about');
  let fallback = false;
  if (!kept.length) {
    // Nothing named as main: the most prominent products, else the most prominent foreground object.
    const candidates = scene.objects.filter(o => live(o) && o.importance !== 'decoration' && o.kind !== 'furniture');
    const products = candidates.filter(sellable).sort((a, b) => area(b) - area(a));
    for (const o of (products.length ? products.slice(0, 3) : candidates.sort((a, b) => area(b) - area(a)).slice(0, 1))) keep(o, 'the most prominent product (nothing was named as main)');
    fallback = kept.length > 0;
  }
  // 2. Products tied to them by evidence (until nothing more is added).
  for (let added = true; added;) {
    added = false;
    for (const r of scene.relations) {
      if (!(LINKS as readonly string[]).includes(r.relation) || r.confidence < 0.7) continue;
      for (const [from, to] of [[r.source, r.target], [r.target, r.source]]) {
        const anchor = byId(to), other = byId(from);
        if (!kept.includes(to) || !live(other) || !sellable(other) || kept.includes(other.id)) continue;
        keep(other, `${LINK_WORDS[r.relation as (typeof LINKS)[number]]} ${anchor!.label}`); added = true;
      }
    }
    // A product standing against a kept one (a purifier's faucet, a dock under a phone): a spatial relation the analysis
    // is sure of, and their regions overlap. Only products: a prop or a lemon beside a product never qualifies.
    for (const r of scene.relations) {
      if (!['next_to', 'attached_to', 'on', 'in_front_of', 'behind'].includes(r.relation) || r.confidence < 0.7) continue;
      for (const [from, to] of [[r.source, r.target], [r.target, r.source]]) {
        const anchor = byId(to), other = byId(from);
        if (!kept.includes(to) || !live(other) || other.kind !== 'product' || other.importance === 'decoration' || kept.includes(other.id) || !touching(other, anchor!)) continue;
        keep(other, `part of the product set: right against ${anchor!.label}`); added = true;
      }
    }
    const brands = new Map(kept.map(byId).filter(live).filter(o => o.identity?.brand && o.identity.confidence >= 0.6).map(o => [o.identity!.brand.toLowerCase(), o.label]));
    for (const o of scene.objects) {
      const brand = o.identity?.brand?.toLowerCase();
      if (!live(o) || !sellable(o) || kept.includes(o.id) || !brand || (o.identity!.confidence < 0.6) || !brands.has(brand)) continue;
      keep(o, `the same brand (${o.identity!.brand}) as ${brands.get(brand)}`); added = true;
    }
  }
  // Attached parts go with their product (one cutout, one layer).
  const parts: Record<string, string> = {};
  for (const r of scene.relations) if ((r.relation === 'part_of' || r.relation === 'attached_to') && kept.includes(r.target) && live(byId(r.source)) && !holderOf(scene, r.source)) {
    parts[r.source] = r.target;
    const at = kept.indexOf(r.source);
    if (at >= 0) { kept.splice(at, 1); delete reasons[r.source]; }
  }
  // At most MAX_ADVERTISED, the most important and largest first; then back in the scene's order.
  const rank = (id: string) => { const o = byId(id)!; return (o.importance === 'main' ? 0 : 1) * 10 - area(o); };
  const ids = [...kept].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_ADVERTISED);
  const order = new Map(scene.objects.map((o, i) => [o.id, i]));
  ids.sort((a, b) => order.get(a)! - order.get(b)!);
  return { ids, reasons: Object.fromEntries(ids.map(id => [id, reasons[id]])), parts, basis: named.length ? 'analysis' : 'rules', fallback };
}
