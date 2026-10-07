/**
 * Protected people and interactions, applied to the layers Seedream returned (any prompt, any model output): a cleaner,
 * visually correct layer list beats a technically separate but broken one.
 *
 *   body part on its own           → back into the person it was cut from (a hand or arm returned as its own layer)
 *   finger / grip fragments        → back into the person they belong to (a fragment touching a held object makes
 *                                    that object held, with an interleaved grip)
 *   held object                    → stays with the person when the split is not clearly clean: fingers cross it,
 *                                    the stack hides hand pixels the original shows (interleave check against the
 *                                    original), or the planner rated the split risky; a clean split stays separate
 *   content on a held object       → follows it (a badge or text on a held phone's screen)
 *   worn ornament                  → into the wearer (bangles, rings, watches, jewelry touching and inside a person);
 *                                    a standalone ornament no person wears stays its own layer
 *   cast shadow                    → with the subject it touches (a person first), so it moves and hides with it
 *   tiny attached piece            → into the layer it sits in (a chevron inside a button)
 *   tiny scattered decorations     → one decoration group when there are three or more
 *
 * Text is never merged into a person, whatever words its name carries. Each group is one new full-canvas PNG of its
 * members in their own back-to-front order, at the position of its front-most member, so the composition is unchanged
 * while the person, hand and object move as one. Every decision, including a clean split kept separate, is recorded.
 * Deterministic, no model call; all geometry on the analysis grid (backgroundContamination.ts).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { backgroundRole, composeLayers, writeContactSheet, type Canvas, type LayerInfo, type LayerGrouping, type GroupMemberRole } from './layerizeArtifacts.js';
import { head, layerWords, posterRole, similarity } from './layerCount.js';
import { compositeOnGrid, countOf, gridFor, intersectCount, layerShape, rgbOnGrid, type Box, type Grid, type LayerShape } from './backgroundContamination.js';
import { grow } from './outerBackground.js';
import { BODY_PART, EFFECT, FRAGMENT, idWords, ORNAMENT, PERSON, SCENE, SHADOW, TEXTISH, WHOLE_PERSON } from './interactionTerms.js';
import type { SemanticAnalysis, SemanticElement } from './semanticPlanner.js';

export type InteractionKind = 'scene' | 'text' | 'person' | 'fragment' | 'ornament' | 'decor' | 'object';
export type InteractionDecision = { decision: 'grouped' | 'kept-separate'; role: GroupMemberRole | 'clean_split' | 'standalone_ornament'; file: string; name?: string; parent?: string; reason: string };
export type InteractionRecord = { layersBefore: number; layersAfter: number; groups: number; decisions: InteractionDecision[] };
/** A resolved, non-base layer with its shape on the analysis grid. */
export type InteractionEntry = { layer: LayerInfo; png: Buffer; shape: LayerShape };
export type InteractionOptions = {
  /** Keep held objects with the person when the split is not clearly clean. False for runs whose user asked to separate them (Template A's checkbox). */
  heldObjects: boolean;
};

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
const boxArea = (b: Box) => Math.max(1, (b.x1 - b.x0) * (b.y1 - b.y0));
/** Share of `inner`'s box inside `outer`'s box grown by `margin` (fraction of the outer box's size). */
function insideShare(inner: Box | undefined, outer: Box | undefined, margin: number): number {
  if (!inner || !outer) return 0;
  const mx = (outer.x1 - outer.x0) * margin, my = (outer.y1 - outer.y0) * margin;
  const w = Math.max(0, Math.min(inner.x1, outer.x1 + mx) - Math.max(inner.x0, outer.x0 - mx)), h = Math.max(0, Math.min(inner.y1, outer.y1 + my) - Math.max(inner.y0, outer.y0 - my));
  return (w * h) / boxArea(inner);
}

/** What a layer is, from its name (or its matched planned element) and geometry. */
export function interactionKind(layer: LayerInfo, shape: LayerShape, grid: Grid, element?: SemanticElement): InteractionKind {
  const n = grid.width * grid.height, box = shape.box;
  const boxShare = box ? boxArea(box) / n : 0;
  const fullSolid = !!box && box.x1 - box.x0 >= 0.9 * grid.width && box.y1 - box.y0 >= 0.9 * grid.height && shape.count / n >= 0.6;
  const name = idWords(layer.name ?? (element ? `${element.id} ${element.type}` : layer.description ?? '')), role = posterRole(layer);
  const semanticType = idWords(layer.semantic?.type ?? element?.type ?? '');
  if (isSemanticText(layer) || /\b(?:cta|badge)\b/i.test(semanticType)) return 'text';
  if (PERSON.test(semanticType)) return 'person';
  if (/\bproduct\b/i.test(semanticType)) return 'object';
  const sceneNamed = !!backgroundRole(layer.name) || role === 'background' || role === 'backdrop' || role === 'border';
  const largeScene = SCENE.test(name) && (shape.count / n >= 0.15 || boxShare >= 0.5) && !PERSON.test(name) && !TEXTISH.test(name) && role !== 'product' && role !== 'text';
  if ((fullSolid && !PERSON.test(name) && !TEXTISH.test(name) && role !== 'product') || (sceneNamed && boxShare >= 0.5) || largeScene) return 'scene';
  if (TEXTISH.test(name) || role === 'text') return 'text';
  if (EFFECT.test(name)) return 'decor';
  if (FRAGMENT.test(name)) return 'fragment';
  if (ORNAMENT.test(name)) return 'ornament';
  if (PERSON.test(name) || (element && PERSON.test(idWords(element.type)))) return 'person';
  return role === 'decor' ? 'decor' : 'object';
}

/**
 * A shadow or stain layer, not a subject: the head of its name ("Soft cast shadow of the man", not "Woman with shadow")
 * names one, and its pixels are translucent or dark (a person or product is neither). `rgba` on a grid of `n` pixels.
 */
export function isShadowLayer(layer: Pick<LayerInfo, 'name' | 'semantic'>, rgba: Buffer, n: number): boolean {
  if (!shadowNamed(layer)) return false;
  let count = 0, alpha = 0, lum = 0;
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3];
    if (a <= 16) continue;
    count++; alpha += a; lum += a * (0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]);
  }
  return count > 0 && (alpha / count <= 0.9 * 255 || lum / alpha <= 80);
}

/** A layer whose name says it is a shadow or stain (the head of the name: "Soft cast shadow of the man", not "Woman with shadow"). */
export const shadowNamed = (layer: Pick<LayerInfo, 'name' | 'semantic'>) => {
  const type = idWords(layer.semantic?.type ?? '');
  if (!SHADOW.test(type) && (PERSON.test(type) || TEXTISH.test(type) || /\b(?:product|badge|cta)\b/i.test(type))) return false;
  return SHADOW.test(idWords(head(layer.name ?? '')));
};
/** A text effect returned as a layer: its name says text, and its head an effect ("Headline glow", "Glow behind the title"; not "Headline text with drop shadow"). */
const TEXT_EFFECT_WORDS = /\b(?:effects?|glows?|outlines?|strokes?|shadows?|extrusions?|extruded|bevel\w*|emboss\w*|backing|offset|3d)\b/i;
export const isSemanticText = (layer: Pick<LayerInfo, 'semantic'>) => !!layer.semantic && TEXTISH.test(idWords(layer.semantic.type)) && !TEXT_EFFECT_WORDS.test(idWords(layer.semantic.type));
export const isTextEffectLayer = (layer: Pick<LayerInfo, 'name' | 'semantic'>) => !isSemanticText(layer) && (
  layer.semantic ? TEXT_EFFECT_WORDS.test(idWords(layer.semantic.type)) && TEXTISH.test(idWords(`${layer.semantic.id} ${layer.semantic.type}`))
    : TEXTISH.test(idWords(layer.name ?? '')) && TEXT_EFFECT_WORDS.test(idWords(head(layer.name ?? ''))));
/** The words of a name that name a thing (not a shadow or how it looks): "Translucent oversized-phone shadow" → oversized, phone. */
export const thingWords = (name: string) => new Set(idWords(name).toLowerCase().match(/\p{L}{3,}/gu)?.filter(w => !/^(?:shadows?|stains?|smudges?|cast|soft|translucent|drop|contact|floor|ground|dark|light|subtle|large|small|glows?|outlines?|strokes?|effect|text|layer|the|and|with)$/.test(w)) ?? []);

/** Planned elements matched to provider layers by the words they share (each element at most once). */
function matchElements(entries: InteractionEntry[], semantic?: SemanticAnalysis): Map<InteractionEntry, SemanticElement> {
  const out = new Map<InteractionEntry, SemanticElement>();
  if (!semantic) return out;
  const pairs = entries.flatMap(entry => semantic.elements.map(element => ({ entry, element,
    score: similarity(layerWords(entry.layer.name, entry.layer.description), layerWords(idWords(element.id), element.description)) })));
  const used = new Set<SemanticElement>();
  for (const pair of pairs.sort((a, b) => b.score - a.score)) {
    if (pair.score < 0.15 || out.has(pair.entry) || used.has(pair.element)) continue;
    // "Shadow of the woman" can share more words with the planned woman than her actual layer does. Give that
    // identity to a plausible subject layer first. A real "Shadow" product remains eligible when no such alternative
    // exists, or when the planned identity itself names Shadow.
    if (SHADOW.test(idWords(head(pair.entry.layer.name ?? ''))) && !SHADOW.test(idWords(`${pair.element.id} ${pair.element.type}`))
      && pairs.some(other => other.element === pair.element && other.entry !== pair.entry && other.score >= 0.15
        && !out.has(other.entry) && !SHADOW.test(idWords(head(other.entry.layer.name ?? ''))))) continue;
    // A headline naming a product is still text (e.g. "BANGLES OF INDIA"); do not let one shared product word give it
    // a product's semantic identity. Generic provider names can still be reconciled through their descriptions.
    if (TEXTISH.test(idWords(pair.entry.layer.name ?? '')) && !TEXTISH.test(idWords(`${pair.element.type} ${pair.element.id}`)) && !/\b(?:badge|cta)\b/i.test(pair.element.type)) continue;
    out.set(pair.entry, pair.element); used.add(pair.element);
  }
  return out;
}

/**
 * Applies the protection rules (see the module comment). `original`: the source image as raw RGB on `grid` (the
 * interleave check; without it only names, contact and the planner decide). Returns the entries after grouping (groups
 * as new entries with their PNGs written to `dir`) and the record of every decision.
 */
export async function groupInteractions(input: { dir: string; canvas: Canvas; grid: Grid; entries: InteractionEntry[]; original?: Buffer; semantic?: SemanticAnalysis; options: InteractionOptions }): Promise<{ entries: InteractionEntry[]; groups: { entry: InteractionEntry; members: InteractionEntry[] }[]; record: InteractionRecord }> {
  const { grid, entries } = input, n = grid.width * grid.height, reach = Math.max(2, Math.round(0.01 * Math.max(grid.width, grid.height)));
  const elements = matchElements(entries, input.semantic);
  for (const [entry, element] of elements) entry.layer.semantic = { id: element.id, type: element.type, editableIndependently: element.editable_independently };
  const kinds = new Map(entries.map(e => [e, interactionKind(e.layer, e.shape, grid, elements.get(e))]));
  const grownCache = new Map<InteractionEntry, Uint8Array>();
  const grown = (e: InteractionEntry) => { let g = grownCache.get(e); if (!g) { g = grow(e.shape.alpha, grid.width, grid.height, reach); grownCache.set(e, g); } return g; };
  /** Pixels of `a` touching or overlapping `b` (within `reach`). */
  const contact = (a: InteractionEntry, b: InteractionEntry) => intersectCount(a.shape.alpha, grown(b));
  const people = entries.filter(e => kinds.get(e) === 'person' && e.shape.count > 0);
  const decisions: InteractionDecision[] = [];
  const parentOf = new Map<InteractionEntry, InteractionEntry>(), memberInfo = new Map<InteractionEntry, { role: GroupMemberRole; reason: string }>();
  const rootOf = (e: InteractionEntry): InteractionEntry => { let r = e; while (parentOf.has(r)) r = parentOf.get(r)!; return r; };
  const attach = (child: InteractionEntry, parent: InteractionEntry, role: GroupMemberRole, reason: string) => {
    const root = rootOf(parent);
    if (rootOf(child) === root || child === root) return false;
    parentOf.set(child, parent); memberInfo.set(child, { role, reason });
    decisions.push({ decision: 'grouped', role, file: child.layer.file, ...(child.layer.name ? { name: child.layer.name } : {}), parent: root.layer.file, reason });
    return true;
  };
  const free = (e: InteractionEntry) => !parentOf.has(e);
  const bestPerson = (e: InteractionEntry, minContact: number) => people.map(p => ({ p, c: contact(e, p) })).filter(x => x.p !== e && x.c >= minContact).sort((a, b) => b.c - a.c)[0]?.p;
  const plannedPersonFor = (e: InteractionEntry) => { const parentId = elements.get(e)?.attachment?.parent_id; return parentId ? people.find(p => elements.get(p)?.id === parentId) : undefined; };

  // 0. A body part on its own (a hand or an arm cut from its person, often by a residual pass) goes back to the person it
  // touches when that person is clearly the whole (at least three times its size). Pairs of hands with no person stay.
  for (const part of people.filter(p => BODY_PART.test(idWords(p.layer.name ?? '')) && !WHOLE_PERSON.test(idWords(p.layer.name ?? '')))) {
    const whole = people.filter(q => q !== part && q.shape.count >= 3 * part.shape.count).map(q => ({ q, c: contact(part, q) }))
      .filter(x => x.c >= Math.max(6, 0.05 * part.shape.count)).sort((a, b) => b.c - a.c)[0]?.q;
    if (whole) attach(part, whole, 'body_part', 'a body part separated from its person; a separate layer would leave the person cut');
  }
  // 1. Finger / grip fragments go back to their person; an object they touch is held with an interleaved grip.
  const heldByFragment = new Map<InteractionEntry, InteractionEntry>();
  for (const f of entries.filter(e => kinds.get(e) === 'fragment' && e.shape.count > 0)) {
    const person = bestPerson(f, Math.max(4, 0.05 * f.shape.count)) ?? plannedPersonFor(f)
      ?? people.find(p => insideShare(f.shape.box, p.shape.box, 0.1) >= 0.5);
    const grips = entries.filter(o => o !== f && ['object', 'ornament'].includes(kinds.get(o)!) && contact(f, o) >= Math.max(4, 0.05 * f.shape.count));
    if (person) for (const o of grips) heldByFragment.set(o, person);
    // A grip around an object the user asked to keep separate stays as it is: merged into the person it would end up behind the object.
    if (person && grips.length && !input.options.heldObjects) decisions.push({ decision: 'kept-separate', role: 'finger_fragment', file: f.layer.file, ...(f.layer.name ? { name: f.layer.name } : {}), parent: person.layer.file, reason: 'grips an object kept separate for this run' });
    else if (person) attach(f, person, 'finger_fragment', 'finger/grip fragment of the hand; a separate layer would leave a cut hand');
    else decisions.push({ decision: 'kept-separate', role: 'finger_fragment', file: f.layer.file, ...(f.layer.name ? { name: f.layer.name } : {}), reason: 'no person layer it belongs to' });
  }
  // 2. Held objects: grouped unless the split is clearly clean.
  const held: InteractionEntry[] = [];
  for (const o of entries.filter(e => kinds.get(e) === 'object' && free(e) && e.shape.count > 0)) {
    const person = heldByFragment.get(o) ?? bestPerson(o, Math.max(6, 0.01 * o.shape.count));
    if (!person) continue;
    const element = elements.get(o), attachment = element?.attachment;
    const plannedHeld = attachment?.relation === 'held_in_hand' || !!input.semantic?.relationships.some(r => elements.get(person)?.id === r.source && r.target === element?.id && /hold|grip|carr/i.test(r.relationship));
    const plannedRisk = !!attachment && attachment.relation === 'held_in_hand' && (attachment.separation_risk !== 'low' || attachment.keep_with_parent);
    const interleaved = input.original ? interleavePixels(person, o, input.original) : 0;
    const reasons = [
      ...(heldByFragment.get(o) ? ['finger fragments cross it'] : []),
      ...(interleaved >= Math.max(10, 0.01 * o.shape.count) ? [`the stack hides ${interleaved} hand pixels the original shows in front of it`] : []),
      ...(plannedRisk ? [`the planner rated the split ${attachment!.separation_risk} risk`] : []),
      ...(plannedHeld && !attachment ? ['the planner says it is held, with no clean-split rating'] : []),
    ];
    if (!input.options.heldObjects) { if (reasons.length) decisions.push({ decision: 'kept-separate', role: 'held_object', file: o.layer.file, ...(o.layer.name ? { name: o.layer.name } : {}), parent: person.layer.file, reason: `separate held object requested for this run (${reasons.join('; ')})` }); continue; }
    if (reasons.length) { if (attach(o, person, 'held_object', `held by the person: ${reasons.join('; ')}`)) held.push(o); }
    else decisions.push({ decision: 'kept-separate', role: 'clean_split', file: o.layer.file, ...(o.layer.name ? { name: o.layer.name } : {}), parent: person.layer.file,
      reason: plannedHeld ? 'held, but the planner rated the split low risk and no fragment or interleave shows otherwise' : 'touches a person, but nothing shows an interleaved grip' });
  }
  // 3. What sits on a held object follows it (a badge or text on a held phone's screen).
  for (const o of held) for (const e of entries) {
    if (e === o || !free(e) || ['scene', 'person'].includes(kinds.get(e)!) || e.shape.count > 0.5 * o.shape.count) continue;
    if (insideShare(e.shape.box, o.shape.box, 0.03) >= 0.85 && contact(e, o) > 0) attach(e, o, 'object_content', 'sits on the held object');
  }
  // 4. Worn ornaments go to the wearer; a standalone one stays.
  for (const w of entries.filter(e => kinds.get(e) === 'ornament' && free(e) && e.shape.count > 0)) {
    const worn = elements.get(w)?.attachment?.relation === 'worn_by_human' || elements.get(w)?.attachment?.relation === 'attached_to_human';
    // Worn: it touches the person and either sits within them (earrings, a necklace) or lies largely on them (bangles and
    // watches wider than the wrist they wrap). A standalone item at most brushes a person.
    const person = people.map(p => ({ p, c: contact(w, p), overlap: intersectCount(w.shape.alpha, p.shape.alpha) / w.shape.count, inside: insideShare(w.shape.box, p.shape.box, 0.08) }))
      .filter(x => x.c >= Math.max(6, 0.03 * w.shape.count) && (x.inside >= (worn ? 0.4 : 0.6) || x.overlap >= 0.2)).sort((a, b) => b.c - a.c)[0]?.p;
    if (person) attach(w, person, 'worn_ornament', 'worn on the person (touches them and sits within or across them); kept with the wearer');
    else decisions.push({ decision: 'kept-separate', role: 'standalone_ornament', file: w.layer.file, ...(w.layer.name ? { name: w.layer.name } : {}), reason: 'no person wears it: a standalone item' });
  }
  // 4b. A cast shadow goes with the subject it touches, so it moves and hides with it and the clean background is rebuilt
  // where it was. A layer named as a shadow is one when it looks like one (translucent or dark) or when it is small next
  // to the subject it touches (providers render "translucent" shadows as opaque mid-tones). It joins the subject its name
  // refers to ("oversized phone shadow" → the phone), else a person, else the one it touches most. Shadows are soft:
  // their contact is measured on every visible pixel.
  const shadows = new Set<InteractionEntry>();
  for (const s of entries.filter(e => !['scene', 'text'].includes(kinds.get(e)!) && shadowNamed(e.layer))) {
    if (!free(s)) continue;
    const soft = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (s.shape.rgba[i * 4 + 3] > 16) soft[i] = 1;
    const area = countOf(soft), looksLike = isShadowLayer(s.layer, s.shape.rgba, n), own = thingWords(s.layer.name ?? '');
    const owner = entries.filter(o => o !== s && !shadowNamed(o.layer) && ['person', 'object', 'ornament'].includes(kinds.get(o)!) && o.shape.count > 0 && (looksLike || o.shape.count >= 2.5 * area))
      .map(o => ({ o, c: intersectCount(soft, grown(o)), named: [...thingWords(o.layer.name ?? '')].filter(w => own.has(w)).length, person: kinds.get(o) === 'person' ? 1 : 0 }))
      .filter(x => x.c >= Math.max(4, 0.02 * area)).sort((a, b) => b.named - a.named || b.person - a.person || b.c - a.c)[0]?.o;
    if (looksLike || owner) shadows.add(s);
    if (owner) attach(s, owner, 'cast_shadow', `its cast shadow; kept with ${owner.layer.name ?? owner.layer.file} so it moves and hides with it and leaves no ghost`);
  }
  // 4c. A text effect returned as its own layer (a headline's glow, outline, shadow or extrusion) joins the text it
  // belongs to: the text it overlaps or touches most, the one its name shares words with first.
  const texts = entries.filter(e => kinds.get(e) === 'text' && !isTextEffectLayer(e.layer) && e.shape.count > 0);
  for (const fx of entries.filter(e => free(e) && isTextEffectLayer(e.layer))) {
    const soft = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (fx.shape.rgba[i * 4 + 3] > 16) soft[i] = 1;
    const own = thingWords(fx.layer.name ?? '');
    const text = texts.filter(t => t !== fx).map(t => ({ t, c: intersectCount(soft, grown(t)), named: [...thingWords(t.layer.name ?? '')].filter(w => own.has(w)).length }))
      .filter(x => x.c >= Math.max(4, 0.05 * countOf(soft))).sort((a, b) => b.named - a.named || b.c - a.c)[0]?.t;
    if (text) attach(fx, text, 'text_effect', `the ${fx.layer.name ?? 'effect'} of ${text.layer.name ?? text.layer.file}; one text layer with its effect`);
  }
  // 5. Tiny attached pieces go into the layer they sit in.
  for (const e of entries.filter(e => ['object', 'decor', 'fragment', 'ornament'].includes(kinds.get(e)!) && free(e) && e.shape.count > 0 && e.shape.count / n < 0.0015)) {
    const container = entries.filter(c => c !== e && !['scene', 'text'].includes(kinds.get(c)!) && c.shape.count >= 4 * e.shape.count && insideShare(e.shape.box, c.shape.box, 0.02) >= 0.8 && contact(e, c) > 0)
      .sort((a, b) => a.shape.count - b.shape.count)[0];
    if (container) attach(e, container, 'attached_fragment', `tiny piece (${round(100 * e.shape.count / n)}% of the canvas) inside ${container.layer.name ?? container.layer.file}`);
  }
  // 6. Three or more small scattered decorations (sparkles, confetti, stars) become one decoration group.
  const tinyDecor = entries.filter(e => kinds.get(e) === 'decor' && free(e) && !shadows.has(e) && !isTextEffectLayer(e.layer) && e.shape.count > 0 && e.shape.count / n < 0.006 && !entries.some(x => parentOf.get(x) === e));
  if (tinyDecor.length >= 3) {
    const lead = [...tinyDecor].sort((a, b) => b.shape.count - a.shape.count)[0];
    for (const e of tinyDecor) if (e !== lead) attach(e, lead, 'decoration', 'small scattered decoration, grouped with the others');
  }

  // Groups: one PNG per root, members in their own back-to-front order, placed at the front-most member's position.
  const roots = new Map<InteractionEntry, InteractionEntry[]>();
  for (const e of entries) if (parentOf.has(e)) { const root = rootOf(e); roots.set(root, [...(roots.get(root) ?? []), e]); }
  const groups: { entry: InteractionEntry; members: InteractionEntry[] }[] = [];
  let index = 0;
  // The composition as it is, to keep: a group sits at its front-most member's depth unless a layer between its members
  // overlaps it and the back-most depth reproduces the composition better.
  const stackOf = (list: { png: Buffer; layer: LayerInfo }[]) => compositeOnGrid([...list].sort((a, b) => a.layer.zIndex - b.layer.zIndex).map(e => ({ png: e.png, placement: e.layer.placement })), grid);
  let before: Buffer | undefined;
  const difference = (a: Buffer, b: Buffer) => { let sum = 0; for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]); return sum; };
  for (const [root, members] of roots) {
    const all = [root, ...members].sort((a, b) => a.layer.zIndex - b.layer.zIndex);
    const file = `group-${String(++index).padStart(2, '0')}.png`, full = { width: input.canvas.width, height: input.canvas.height, scale: 1 };
    const rgba = await compositeOnGrid(all.map(m => ({ png: m.png, placement: m.layer.placement })), full);
    const png = await sharp(rgba, { raw: { width: full.width, height: full.height, channels: 4 } }).png().toBuffer();
    writeFileSync(join(input.dir, file), png);
    let opaque = 0; for (let i = 3; i < rgba.length; i += 4) if (rgba[i] > 127) opaque++;
    const protectedInteraction = members.some(m => ['held_object', 'finger_fragment'].includes(memberInfo.get(m)!.role)) ? 'hand_holding_object' as const : undefined;
    const roles = [...new Set(members.map(m => memberInfo.get(m)!.role))];
    const grouping: LayerGrouping = { groupedWithParent: true, parent: root.layer.file, ...(protectedInteraction ? { protectedInteraction } : {}),
      attachmentReason: roles.map(r => r.replace(/_/g, ' ')).join(', '),
      members: [{ file: root.layer.file, ...(root.layer.name ? { name: root.layer.name } : {}), role: 'parent', reason: 'the layer the others stay with' },
        ...members.map(m => ({ file: m.layer.file, ...(m.layer.name ? { name: m.layer.name } : {}), ...memberInfo.get(m)! }))] };
    const name = [root.layer.name ?? 'Layer', ...members.map(m => m.layer.name ?? m.layer.file)].join(' + ');
    const front = Math.max(...all.map(m => m.layer.zIndex)), back = Math.min(...all.map(m => m.layer.zIndex));
    const between = entries.filter(e => !all.includes(e) && e.layer.zIndex > back && e.layer.zIndex < front && all.some(m => intersectCount(m.shape.alpha, e.shape.alpha) > 0));
    let zIndex = front;
    if (between.length) {
      before ??= await stackOf(entries);
      const others = entries.filter(e => !all.includes(e)), placed = (z: number) => stackOf([...others, { png, layer: { ...root.layer, zIndex: z, placement: { kind: 'full-canvas', x: 0, y: 0, width: full.width, height: full.height } } }]);
      if (difference(await placed(back), before) < difference(await placed(front), before)) zIndex = back;
      decisions.push({ decision: 'grouped', role: 'parent', file, parent: root.layer.file, reason: `${between.map(e => e.layer.name ?? e.layer.file).join(', ')} lies between its members; placed at the ${zIndex === front ? 'front-most' : 'back-most'} member's depth, which keeps the composition closer` });
    }
    const layer: LayerInfo = { index: root.layer.index, file, zIndex, name: name.length > 100 ? `${name.slice(0, 99)}…` : name,
      description: protectedInteraction ? 'Kept together so the hand and what it holds stay intact.' : `Kept together: ${grouping.attachmentReason}.`,
      pixelWidth: full.width, pixelHeight: full.height, opaquePercent: round(100 * opaque / (full.width * full.height), 1),
      placement: { kind: 'full-canvas', x: 0, y: 0, width: full.width, height: full.height }, grouping, ...(root.layer.semantic ? { semantic: root.layer.semantic } : {}) };
    groups.push({ entry: { layer, png, shape: await layerShape(png, layer, grid) }, members: all });
  }
  const grouped = new Set(groups.flatMap(g => g.members));
  const out = [...entries.filter(e => !grouped.has(e)), ...groups.map(g => g.entry)].sort((a, b) => a.layer.zIndex - b.layer.zIndex);
  return { entries: out, groups, record: { layersBefore: entries.length, layersAfter: out.length, groups: groups.length, decisions } };
}

/**
 * Pixels where a person and an object overlap and the stack shows the wrong one: the visible (front) layer differs from
 * the original while the hidden one matches it. Fingers wrapped around a phone, rendered behind it, count here.
 */
export function interleavePixels(person: InteractionEntry, object: InteractionEntry, original: Buffer): number {
  const front = person.layer.zIndex > object.layer.zIndex ? person : object, back = front === person ? object : person;
  const diff = (rgba: Buffer, i: number) => Math.max(Math.abs(rgba[i * 4] - original[i * 3]), Math.abs(rgba[i * 4 + 1] - original[i * 3 + 1]), Math.abs(rgba[i * 4 + 2] - original[i * 3 + 2]));
  let count = 0;
  for (let i = 0; i < person.shape.alpha.length; i++) if (person.shape.alpha[i] && object.shape.alpha[i] && diff(front.shape.rgba, i) > 40 && diff(back.shape.rgba, i) <= 20) count++;
  return count;
}

/**
 * The protection for a run's rendered layers when no refinement runs (refined runs apply it inside the refinement):
 * groups, then rewrites layers.json, reconstructed.png and contact-sheet.png when anything was grouped.
 */
export async function protectRenderedLayers(input: { dir: string; canvas: Canvas; layers: LayerInfo[]; warnings: string[]; read: (file: string) => Buffer; sourceImage?: Buffer; semantic?: SemanticAnalysis; options: InteractionOptions }): Promise<{ layers: LayerInfo[]; record: InteractionRecord }> {
  const grid = gridFor(input.canvas, 640);
  const candidates = input.layers.filter(l => l.placement.kind !== 'base' && l.placement.kind !== 'unresolved');
  const entries: InteractionEntry[] = [];
  for (const layer of candidates) { const png = input.read(layer.file); entries.push({ layer, png, shape: await layerShape(png, layer, grid) }); }
  const meta = input.sourceImage ? await sharp(input.sourceImage).metadata().catch(() => undefined) : undefined;
  const original = meta?.width && meta.height && Math.abs((meta.width / meta.height) / (input.canvas.width / input.canvas.height) - 1) <= 0.01 ? await rgbOnGrid(input.sourceImage!, grid) : undefined;
  const result = await groupInteractions({ dir: input.dir, canvas: input.canvas, grid, entries, original, semantic: input.semantic, options: input.options });
  if (!result.groups.length) return { layers: input.layers, record: result.record };
  const kept = new Set(result.entries.map(e => e.layer.file));
  const layers = [...input.layers.filter(l => l.placement.kind === 'base' || l.placement.kind === 'unresolved' || kept.has(l.file)), ...result.groups.map(g => g.entry.layer)]
    .sort((a, b) => a.zIndex - b.zIndex).map((l, i) => ({ ...l, index: i }));
  const pngs = new Map(result.groups.map(g => [g.entry.layer.file, g.entry.png]));
  const pngOf = (l: LayerInfo) => pngs.get(l.file) ?? input.read(l.file);
  writeFileSync(join(input.dir, 'layers.json'), JSON.stringify({ canvas: input.canvas, warnings: input.warnings, layers, interactions: result.record }, null, 2));
  await writeContactSheet(join(input.dir, 'contact-sheet.png'), layers.map(l => ({ png: pngOf(l), title: `${l.zIndex}. ${l.name ?? (l.placement.kind === 'base' ? '(base image)' : 'layer')}`,
    sub: l.grouping ? `${l.grouping.protectedInteraction ? 'hand holding object' : l.grouping.attachmentReason} · ${l.grouping.members.length} layers` : `${l.placement.kind} · ${l.opaquePercent}% opaque` })));
  await composeLayers(join(input.dir, 'reconstructed.png'), input.canvas, layers.map(l => ({ png: pngOf(l), zIndex: l.zIndex, placement: l.placement })));
  return { layers, record: result.record };
}
