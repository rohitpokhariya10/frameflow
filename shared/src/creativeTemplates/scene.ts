/**
 * What ONE uploaded image shows, read by a vision model and validated here: its objects with stable ids and readable,
 * position-aware labels, how they relate (holds, wears, accessory of…), the brand marks printed on products as distinct
 * from merchant or bank logos, any overlaid advertising text, and the light. A scene belongs to its image; templates stay
 * role-based (roles.ts) and never keep what a scene says. A scene is reused only while its image, the template version
 * and the analysis configuration all still match (the server binds it).
 *
 * Every string here came from a model reading an uploaded image: untrusted data. It is sanitized and bounded, never
 * followed as an instruction, and prompts refer to objects by kind and position, never by quoting image text.
 */
import { TEMPLATE_ROLE_LABELS, type TemplateRole, type TemplateZone } from './roles.js';
import { describeTemplateSlots, type TemplateSlot } from './editPlan.js';
import { sanitizeEditInstruction } from './editPrompt.js';
import type { TemplateVersion } from './types.js';

/** Bumped whenever the analysis output changes meaning: a scene of another version is never reused. */
export const SCENE_SCHEMA_VERSION = 'scene-v1';

export const SCENE_OBJECT_KINDS = ['product', 'person', 'character', 'animal', 'object', 'furniture', 'scenery', 'decoration', 'effect'] as const;
export type SceneObjectKind = typeof SCENE_OBJECT_KINDS[number];
/** main: what the creative is about; supporting: shown with it; background: the scene behind; decoration: graphics. */
export const SCENE_IMPORTANCE = ['main', 'supporting', 'background', 'decoration'] as const;
export type SceneImportance = typeof SCENE_IMPORTANCE[number];
export const SCENE_PROPERTY_KEYS = ['color', 'material', 'finish', 'shape', 'pattern', 'clothing', 'hair', 'pose', 'expression', 'style', 'other'] as const;
export type ScenePropertyKey = typeof SCENE_PROPERTY_KEYS[number];
export const SCENE_PROPERTY_LABELS: Record<ScenePropertyKey, string> = { color: 'Color', material: 'Material', finish: 'Finish', shape: 'Shape', pattern: 'Pattern', clothing: 'Clothing',
  hair: 'Hair', pose: 'Pose', expression: 'Expression', style: 'Style', other: 'Detail' };
/** Relations that matter for edits: what moves together, and what belongs to what. */
export const SCENE_RELATIONS = ['holds', 'wears', 'attached_to', 'part_of', 'accessory_of', 'same_brand_as', 'on', 'next_to', 'in_front_of', 'behind', 'related_to'] as const;
export type SceneRelationKind = typeof SCENE_RELATIONS[number];
/** A product's own brand mark is not a merchant's or a bank's logo: each is its own entity, changed only on its own. */
export const SCENE_MARK_KINDS = ['product_brand', 'merchant_logo', 'bank_logo', 'payment_logo', 'other_logo'] as const;
export type SceneMarkKind = typeof SCENE_MARK_KINDS[number];
export const SCENE_MARK_LABELS: Record<SceneMarkKind, string> = { product_brand: 'Product brand mark', merchant_logo: 'Merchant logo', bank_logo: 'Bank logo', payment_logo: 'Payment logo', other_logo: 'Logo' };
export const SCENE_OVERLAY_ROLES = ['headline', 'offer', 'price', 'legal', 'cta', 'caption', 'other'] as const;
export type SceneOverlayRole = typeof SCENE_OVERLAY_ROLES[number];
export const LIGHT_DIRECTIONS = ['left', 'right', 'top', 'front', 'back', 'diffuse', 'unclear'] as const;
export const LIGHT_QUALITIES = ['soft', 'hard', 'mixed', 'unclear'] as const;
export const LIGHT_COLORS = ['warm', 'neutral', 'cool', 'unclear'] as const;

/** A region as fractions of the canvas. Approximate unless the model called it tight; never a segmentation mask. */
export interface SceneBox { x: number; y: number; w: number; h: number; certainty: 'tight' | 'approximate' }
export interface SceneProperty { key: ScenePropertyKey; value: string }
/** Who made the object, as far as the image shows it: evidence and confidence, never a guess presented as fact. */
export interface SceneIdentity { brand: string; model: string; evidence: string; confidence: number; markings: 'none' | 'physical' | 'overlay' | 'both' }
export interface SceneObject {
  /** Stable for this scene: `<category>_<n>`, numbered left to right. */
  id: string;
  kind: SceneObjectKind; importance: SceneImportance;
  /** What it is, in plain words ("smartphone", "football", "फ्रिज"). */
  category: string;
  /** Readable and unique in the scene: "Smartphone · left". */
  label: string;
  /** What it looks like now. */
  description: string;
  properties: SceneProperty[];
  identity?: SceneIdentity;
  box: SceneBox; zone: TemplateZone;
  occluded: boolean;
  confidence: number;
  /** Fields the user corrected (the detected value is kept in `detected`). */
  corrected?: { fields: (keyof SceneCorrection)[]; detected: Partial<Pick<SceneObject, 'category' | 'description'>> & { brand?: string; model?: string } };
  /** The user said this detection is wrong: it is neither edited nor protected. */
  ignored?: boolean;
}
export interface SceneRelation { source: string; relation: SceneRelationKind; target: string; evidence: string; confidence: number }
export interface SceneMark { id: string; kind: SceneMarkKind; label: string; text: string; ownerId?: string; overlay: boolean; box: SceneBox; zone: TemplateZone }
export interface SceneOverlay { id: string; role: SceneOverlayRole; label: string; text: string; refersTo: string[]; box: SceneBox; zone: TemplateZone }
export interface SceneLighting { direction: typeof LIGHT_DIRECTIONS[number]; quality: typeof LIGHT_QUALITIES[number]; color: typeof LIGHT_COLORS[number] }
export interface SceneDescription {
  schema: typeof SCENE_SCHEMA_VERSION;
  summary: string;
  objects: SceneObject[]; relations: SceneRelation[]; marks: SceneMark[]; overlays: SceneOverlay[];
  lighting: SceneLighting;
  /** Objects that could each be "the main one" (more than one: the user chooses). */
  mainCandidates: string[];
  uncertainties: string[];
}
/** A user's correction of one detected object. */
export interface SceneCorrection { category?: string; description?: string; brand?: string; model?: string; ignored?: boolean }

export class SceneValidationError extends Error { constructor(message: string) { super(message); this.name = 'SceneValidationError'; } }
export const SCENE_LIMITS = { objects: 24, marks: 12, overlays: 12, relations: 60, text: 160, overlayText: 200, category: 40, uncertainties: 8, correction: 120 } as const;

/** Untrusted model text as data: sanitized, double quotes softened (prompts quote values), bounded. */
export function cleanSceneText(value: unknown, limit: number = SCENE_LIMITS.text): string {
  return sanitizeEditInstruction(typeof value === 'string' ? value : '').replace(/["“”]/g, '\'').slice(0, limit).trim();
}
const ID = /^[a-z][a-z0-9_]{0,40}$/;
const finite01 = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
const capital = (text: string) => text ? text[0].toLocaleUpperCase() + text.slice(1) : text;
/** The zone a box's center falls in (thirds), or the whole canvas for a box that covers nearly all of it. */
export function zoneOfBox(box: Pick<SceneBox, 'x' | 'y' | 'w' | 'h'>): TemplateZone {
  if (box.w * box.h >= 0.85) return 'full-canvas';
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const row = cy < 1 / 3 ? 'top' : cy < 2 / 3 ? 'middle' : 'bottom', col = cx < 1 / 3 ? 'left' : cx < 2 / 3 ? 'center' : 'right';
  if (row === 'middle') return col === 'center' ? 'center' : `middle-${col}` as TemplateZone;
  return `${row}-${col}` as TemplateZone;
}
const POSITION_WORDS: Record<TemplateZone, string> = { 'top-left': 'top left', 'top-center': 'top', 'top-right': 'top right', 'middle-left': 'left', center: 'center',
  'middle-right': 'right', 'bottom-left': 'bottom left', 'bottom-center': 'bottom', 'bottom-right': 'bottom right', 'full-canvas': 'whole canvas' };
export const positionWords = (zone: TemplateZone) => POSITION_WORDS[zone];
/** "on the left", "at the top right", "in the center", "across the whole canvas". */
export function positionPhrase(zone: TemplateZone): string {
  return zone === 'center' ? 'in the center' : zone === 'full-canvas' ? 'across the whole canvas' : zone === 'middle-left' || zone === 'middle-right' ? `on the ${POSITION_WORDS[zone]}` : `at the ${POSITION_WORDS[zone]}`;
}
/** An ASCII id stem from a category ("Smart TV" → "smart_tv"); non-Latin categories fall back to their kind. */
const slug = (text: string, fallback: string) => {
  const s = text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24).replace(/_+$/, '');
  return /^[a-z]/.test(s) ? s : fallback;
};

type RawBox = { x: number; y: number; w: number; h: number; certainty?: string };
function box(value: unknown, what: string): SceneBox {
  const b = value as RawBox | undefined;
  if (!b || ![b.x, b.y, b.w, b.h].every(finite01) || b.w <= 0 || b.h <= 0 || b.x + b.w > 1.001 || b.y + b.h > 1.001) throw new SceneValidationError(`${what} has no valid region.`);
  return { x: b.x, y: b.y, w: Math.min(b.w, 1 - b.x), h: Math.min(b.h, 1 - b.y), certainty: b.certainty === 'tight' ? 'tight' : 'approximate' };
}
const oneOf = <T extends string>(list: readonly T[], value: unknown, what: string): T => {
  if (!(list as readonly unknown[]).includes(value)) throw new SceneValidationError(`${what} is not one of ${list.join(', ')}.`);
  return value as T;
};
/** Readable labels, unique in the scene: same-category objects are told apart by position, then by number. */
function labelled<T extends { category: string; zone: TemplateZone; label?: string }>(items: T[], base: (item: T) => string): string[] {
  const count = new Map<string, number>(), names = items.map(base);
  for (const name of names) count.set(name.toLowerCase(), (count.get(name.toLowerCase()) ?? 0) + 1);
  const labels = items.map((item, i) => (count.get(names[i].toLowerCase()) ?? 0) > 1 && item.zone !== 'full-canvas' ? `${names[i]} · ${POSITION_WORDS[item.zone]}` : names[i]);
  const seen = new Map<string, number>();
  return labels.map(label => { const n = (seen.get(label) ?? 0) + 1; seen.set(label, n); return labels.filter(l => l === label).length > 1 ? `${label} ${n}` : label; });
}
const byPosition = (a: { box: SceneBox }, b: { box: SceneBox }) => (a.box.x + a.box.w / 2) - (b.box.x + b.box.w / 2) || (a.box.y + a.box.h / 2) - (b.box.y + b.box.h / 2);
const byReading = (a: { box: SceneBox }, b: { box: SceneBox }) => (a.box.y + a.box.h / 2) - (b.box.y + b.box.h / 2) || (a.box.x + a.box.w / 2) - (b.box.x + b.box.w / 2);

/**
 * A model's scene answer (the analysis schema's snake_case shape), validated and made canonical: ids are reassigned
 * from category and position so the same image reads the same way however the model ordered its answer; every
 * reference is checked; held/worn chains cannot loop. Throws SceneValidationError; nothing partial is ever returned.
 */
export function parseSceneDescription(value: unknown): SceneDescription {
  const v = value as Record<string, unknown> | undefined;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new SceneValidationError('The analysis is not an object.');
  const objects = v.objects as Record<string, unknown>[], relations = v.relations as Record<string, unknown>[], marks = (v.marks ?? []) as Record<string, unknown>[], overlays = (v.text_overlays ?? []) as Record<string, unknown>[];
  if (!Array.isArray(objects) || !objects.length || objects.length > SCENE_LIMITS.objects) throw new SceneValidationError(`The analysis must list 1–${SCENE_LIMITS.objects} objects.`);
  if (!Array.isArray(relations) || relations.length > SCENE_LIMITS.relations || !Array.isArray(marks) || marks.length > SCENE_LIMITS.marks || !Array.isArray(overlays) || overlays.length > SCENE_LIMITS.overlays) throw new SceneValidationError('The analysis lists too many relations, marks or text overlays.');
  const ids = new Set<string>();
  const ownId = (raw: unknown, what: string) => {
    if (typeof raw !== 'string' || !ID.test(raw) || ids.has(raw)) throw new SceneValidationError(`${what} needs a unique id of lowercase letters, digits and "_".`);
    ids.add(raw); return raw;
  };
  // 1. Objects as the model gave them, validated field by field.
  const parsed = objects.map((o, i) => {
    if (!o || typeof o !== 'object') throw new SceneValidationError(`Object ${i + 1} is not an object.`);
    const rawId = ownId(o.id, `Object ${i + 1}`), kind = oneOf(SCENE_OBJECT_KINDS, o.kind, `Object ${rawId} kind`), importance = oneOf(SCENE_IMPORTANCE, o.importance, `Object ${rawId} importance`);
    const category = cleanSceneText(o.category, SCENE_LIMITS.category);
    if (!category) throw new SceneValidationError(`Object ${rawId} has no category.`);
    if (!finite01(o.confidence)) throw new SceneValidationError(`Object ${rawId} needs a confidence between 0 and 1.`);
    const props = Array.isArray(o.properties) ? o.properties : [];
    if (props.length > 12) throw new SceneValidationError(`Object ${rawId} lists too many properties.`);
    const properties = props.map(p => ({ key: oneOf(SCENE_PROPERTY_KEYS, (p as Record<string, unknown>)?.key, `A property of ${rawId}`), value: cleanSceneText((p as Record<string, unknown>).value, 80) })).filter(p => p.value);
    const id = o.identity as Record<string, unknown> | undefined;
    let identity: SceneIdentity | undefined;
    if (id && typeof id === 'object') {
      if (!finite01(id.confidence)) throw new SceneValidationError(`Object ${rawId} identity needs a confidence between 0 and 1.`);
      identity = { brand: cleanSceneText(id.brand, 60), model: cleanSceneText(id.model, 60), evidence: cleanSceneText(id.evidence, 160), confidence: id.confidence, markings: oneOf(['none', 'physical', 'overlay', 'both'] as const, id.markings, `Object ${rawId} markings`) };
      if (!identity.brand && !identity.model) identity = identity.markings === 'none' ? undefined : identity;
    }
    const b = box(o.box, `Object ${rawId}`);
    return { rawId, kind, importance, category, description: cleanSceneText(o.description) || category, properties, identity, box: b, zone: zoneOfBox(b), occluded: o.occluded === true, confidence: o.confidence };
  });
  // Every scene has a background: an analysis that named none gets the whole canvas as one.
  if (!parsed.some(o => o.kind === 'scenery' && o.importance === 'background')) {
    let rawId = 'background'; while (ids.has(rawId)) rawId += '_x';
    ids.add(rawId);
    parsed.push({ rawId, kind: 'scenery', importance: 'background', category: 'background', description: 'The background', properties: [], identity: undefined, box: { x: 0, y: 0, w: 1, h: 1, certainty: 'approximate' }, zone: 'full-canvas', occluded: true, confidence: 0.5 });
  }
  // 2. Canonical ids: category stem + number, left to right, so a repeated read of the same image keeps them.
  const remap = new Map<string, string>(), stems = new Map<string, typeof parsed>();
  for (const o of parsed) { const stem = slug(o.category, o.kind); stems.set(stem, [...(stems.get(stem) ?? []), o]); }
  for (const [stem, group] of stems) [...group].sort(byPosition).forEach((o, n) => remap.set(o.rawId, `${stem}_${n + 1}`));
  const markItems = marks.map((m, i) => {
    if (!m || typeof m !== 'object') throw new SceneValidationError(`Mark ${i + 1} is not an object.`);
    const rawId = ownId(m.id, `Mark ${i + 1}`), b = box(m.box, `Mark ${rawId}`), owner = typeof m.owner_id === 'string' && m.owner_id ? m.owner_id : undefined;
    if (owner && !remap.has(owner)) throw new SceneValidationError(`Mark ${rawId} belongs to an unknown object.`);
    return { rawId, kind: oneOf(SCENE_MARK_KINDS, m.kind, `Mark ${rawId} kind`), text: cleanSceneText(m.text, 60), owner, overlay: m.overlay === true, box: b, zone: zoneOfBox(b) };
  });
  [...markItems].sort(byReading).forEach((m, n) => remap.set(m.rawId, `mark_${n + 1}`));
  const overlayItems = overlays.map((t, i) => {
    if (!t || typeof t !== 'object') throw new SceneValidationError(`Text overlay ${i + 1} is not an object.`);
    const rawId = ownId(t.id, `Text overlay ${i + 1}`), b = box(t.box, `Text overlay ${rawId}`);
    const refersTo = Array.isArray(t.refers_to) ? t.refers_to : [];
    if (refersTo.length > 8 || refersTo.some(r => typeof r !== 'string' || !remap.has(r))) throw new SceneValidationError(`Text overlay ${rawId} refers to an unknown object.`);
    return { rawId, role: oneOf(SCENE_OVERLAY_ROLES, t.role, `Text overlay ${rawId} role`), text: cleanSceneText(t.text, SCENE_LIMITS.overlayText), refersTo: refersTo as string[], box: b, zone: zoneOfBox(b) };
  });
  [...overlayItems].sort(byReading).forEach((t, n) => remap.set(t.rawId, `text_${n + 1}`));
  const to = (raw: string) => remap.get(raw)!;
  // 3. Relations: known ends, no self-relation, at most one of each kind per pair, and no holding loop.
  const relationList: SceneRelation[] = [];
  for (const r of relations) {
    const source = (r as Record<string, unknown>)?.source, target = (r as Record<string, unknown>)?.target;
    if (typeof source !== 'string' || typeof target !== 'string' || !parsed.some(o => o.rawId === source) || !parsed.some(o => o.rawId === target) || source === target) throw new SceneValidationError('A relation names an unknown object or relates an object to itself.');
    if (!finite01(r.confidence)) throw new SceneValidationError('A relation needs a confidence between 0 and 1.');
    const relation = oneOf(SCENE_RELATIONS, r.relation, 'A relation');
    if (!relationList.some(x => x.source === to(source) && x.target === to(target) && x.relation === relation)) relationList.push({ source: to(source), relation, target: to(target), evidence: cleanSceneText(r.evidence), confidence: r.confidence as number });
  }
  const attaching = (rel: SceneRelation) => ['holds', 'wears'].includes(rel.relation) ? { parent: rel.source, child: rel.target } : ['attached_to', 'part_of'].includes(rel.relation) ? { parent: rel.target, child: rel.source } : undefined;
  const parents = new Map<string, string[]>();
  for (const rel of relationList) { const a = attaching(rel); if (a) parents.set(a.child, [...(parents.get(a.child) ?? []), a.parent]); }
  const loops = (start: string) => { const seen = new Set<string>(), stack = [start]; while (stack.length) { const id = stack.pop()!; for (const p of parents.get(id) ?? []) { if (p === start) return true; if (!seen.has(p)) { seen.add(p); stack.push(p); } } } return false; };
  if ([...parents.keys()].some(loops)) throw new SceneValidationError('Holding, wearing or part-of relations form a loop.');
  // 4. The scene, with labels told apart by position.
  const sceneObjects: SceneObject[] = parsed.map(o => ({ id: to(o.rawId), kind: o.kind, importance: o.importance, category: o.category, label: '', description: o.description, properties: o.properties,
    ...(o.identity ? { identity: o.identity } : {}), box: o.box, zone: o.zone, occluded: o.occluded, confidence: o.confidence })).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  labelled(sceneObjects, o => capital(o.category)).forEach((label, i) => { sceneObjects[i].label = label; });
  const sceneMarks: SceneMark[] = markItems.map(m => ({ id: to(m.rawId), kind: m.kind, label: '', text: m.text, ...(m.owner ? { ownerId: to(m.owner) } : {}), overlay: m.overlay, box: m.box, zone: m.zone })).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  labelled(sceneMarks.map(m => ({ ...m, category: m.kind })), m => SCENE_MARK_LABELS[m.kind]).forEach((label, i) => { sceneMarks[i].label = label; });
  const sceneOverlays: SceneOverlay[] = overlayItems.map(t => ({ id: to(t.rawId), role: t.role, label: '', text: t.text, refersTo: [...new Set(t.refersTo.map(to))], box: t.box, zone: t.zone })).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  labelled(sceneOverlays.map(t => ({ ...t, category: 'text' })), () => 'Overlaid text').forEach((label, i) => { sceneOverlays[i].label = label; });
  const candidates = Array.isArray(v.main_candidates) ? v.main_candidates : [];
  if (candidates.some(c => typeof c !== 'string' || !parsed.some(o => o.rawId === c))) throw new SceneValidationError('A main candidate is not one of the objects.');
  const mainCandidates = [...new Set((candidates as string[]).map(to))].filter(id => { const o = sceneObjects.find(x => x.id === id)!; return !['scenery', 'decoration', 'effect'].includes(o.kind); });
  const lighting = (v.lighting ?? {}) as Record<string, unknown>;
  const uncertainties = (Array.isArray(v.uncertainties) ? v.uncertainties : []).slice(0, SCENE_LIMITS.uncertainties).map(u => cleanSceneText(u)).filter(Boolean);
  return { schema: SCENE_SCHEMA_VERSION, summary: cleanSceneText(v.summary, 300), objects: sceneObjects, relations: relationList, marks: sceneMarks, overlays: sceneOverlays,
    lighting: { direction: (LIGHT_DIRECTIONS as readonly unknown[]).includes(lighting.direction) ? lighting.direction as SceneLighting['direction'] : 'unclear',
      quality: (LIGHT_QUALITIES as readonly unknown[]).includes(lighting.quality) ? lighting.quality as SceneLighting['quality'] : 'unclear',
      color: (LIGHT_COLORS as readonly unknown[]).includes(lighting.color) ? lighting.color as SceneLighting['color'] : 'unclear' },
    mainCandidates: mainCandidates.length ? mainCandidates : sceneObjects.filter(o => o.importance === 'main' && !['scenery', 'decoration', 'effect'].includes(o.kind)).map(o => o.id), uncertainties };
}

/** Any id of a scene: an object, a mark or a text overlay. */
export type SceneTarget = { type: 'object'; item: SceneObject } | { type: 'mark'; item: SceneMark } | { type: 'overlay'; item: SceneOverlay };
export function sceneTarget(scene: SceneDescription, id: string): SceneTarget | undefined {
  const object = scene.objects.find(o => o.id === id); if (object) return { type: 'object', item: object };
  const mark = scene.marks.find(m => m.id === id); if (mark) return { type: 'mark', item: mark };
  const overlay = scene.overlays.find(t => t.id === id); return overlay ? { type: 'overlay', item: overlay } : undefined;
}
/** The object that holds or wears this one (its parent in an attachment), if any. */
export const holderOf = (scene: Pick<SceneDescription, 'relations'>, id: string) => scene.relations.find(r => (r.relation === 'holds' || r.relation === 'wears') && r.target === id)?.source;
/** Objects attached to this one: what it holds or wears, and its parts. */
export const attachedTo = (scene: Pick<SceneDescription, 'relations'>, id: string) => [...new Set(scene.relations.flatMap(r =>
  (r.relation === 'holds' || r.relation === 'wears') && r.source === id ? [r.target] : (r.relation === 'attached_to' || r.relation === 'part_of') && r.target === id ? [r.source] : []))];
export const isForeground = (o: Pick<SceneObject, 'kind'>) => !['scenery', 'decoration', 'effect'].includes(o.kind);

/** A scene with the user's corrections applied: detected values stay visible as `corrected.detected`. */
export function applySceneCorrections(scene: SceneDescription, corrections: Record<string, SceneCorrection> = {}): SceneDescription {
  if (!Object.keys(corrections).length) return scene;
  const objects = scene.objects.map(o => {
    const c = corrections[o.id];
    if (!c) return o;
    const fields = (Object.keys(c) as (keyof SceneCorrection)[]).filter(k => c[k] !== undefined && c[k] !== '');
    if (!fields.length) return o;
    // A corrected brand clears the detected model: another brand's model never sticks to it.
    const brand = c.brand ?? o.identity?.brand ?? '', model = c.model ?? (c.brand !== undefined ? '' : o.identity?.model ?? '');
    return { ...o, ...(c.category ? { category: c.category } : {}), ...(c.description ? { description: c.description } : {}), ...(c.ignored ? { ignored: true } : {}),
      ...(c.brand !== undefined || c.model !== undefined ? { identity: { brand, model, evidence: 'corrected by the user', confidence: 1, markings: o.identity?.markings ?? 'none' } as SceneIdentity } : {}),
      corrected: { fields, detected: { category: o.category, description: o.description, ...(o.identity ? { brand: o.identity.brand, model: o.identity.model } : {}) } } };
  });
  return { ...scene, objects };
}
/** User corrections, checked: known objects, plain bounded text. */
export function cleanCorrections(scene: SceneDescription, value: unknown): Record<string, SceneCorrection> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SceneValidationError('Corrections name detected objects.');
  const out: Record<string, SceneCorrection> = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!scene.objects.some(o => o.id === id) || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SceneValidationError('A correction names an object the analysis did not detect.');
    const r = raw as Record<string, unknown>, c: SceneCorrection = {};
    for (const key of Object.keys(r)) if (!['category', 'description', 'brand', 'model', 'ignored'].includes(key)) throw new SceneValidationError(`A correction has no field "${key}".`);
    for (const key of ['category', 'description', 'brand', 'model'] as const) {
      if (r[key] === undefined) continue;
      if (typeof r[key] !== 'string' || (r[key] as string).length > SCENE_LIMITS.correction) throw new SceneValidationError(`A corrected ${key} is plain text of at most ${SCENE_LIMITS.correction} characters.`);
      c[key] = cleanSceneText(r[key], SCENE_LIMITS.correction);
    }
    if (r.ignored !== undefined) { if (typeof r.ignored !== 'boolean') throw new SceneValidationError('ignored is true or false.'); if (r.ignored) c.ignored = true; }
    if (Object.keys(c).length) out[id] = c;
  }
  return out;
}

/** Plausible main objects: more than one means the user picks (a product photo, a protected subject). */
export const mainObjects = (scene: SceneDescription) => scene.mainCandidates.map(id => scene.objects.find(o => o.id === id)!).filter(o => o && !o.ignored);
export const mainIsAmbiguous = (scene: SceneDescription) => mainObjects(scene).length !== 1 || mainObjects(scene).some(o => o.confidence < 0.6);

/**
 * A protected subject and everything that must stay with it: what it holds or wears, its parts, and the person holding
 * it (a held object cut out without its hand would damage the grip). Ignored detections are never protected.
 */
export function protectedGroup(scene: SceneDescription, ids: string[]): { ids: string[]; added: { id: string; because: string }[] } {
  const keep = new Set(ids.filter(id => scene.objects.some(o => o.id === id && !o.ignored))), added: { id: string; because: string }[] = [], queue = [...keep];
  while (queue.length) {
    const id = queue.shift()!, label = scene.objects.find(o => o.id === id)!.label;
    const linked = [...attachedTo(scene, id).map(c => ({ id: c, because: `attached to ${label}` })), ...(holderOf(scene, id) ? [{ id: holderOf(scene, id)!, because: `holds or wears ${label}` }] : []),
      ...scene.relations.filter(r => r.relation === 'attached_to' && r.source === id).map(r => ({ id: r.target, because: `${label} is attached to it` }))];
    for (const next of linked) if (!keep.has(next.id) && scene.objects.some(o => o.id === next.id && !o.ignored)) { keep.add(next.id); added.push(next); queue.push(next.id); }
  }
  return { ids: [...keep], added };
}

/** Which template field each detected object fills, where one does (a reused template's saved roles). */
export interface SceneSlotMapping { slots: Record<string, string>; unmatchedSlots: string[] }
function rolesFor(scene: SceneDescription, o: SceneObject): TemplateRole[] {
  const held = !!holderOf(scene, o.id);
  if (o.kind === 'person' || o.kind === 'character' || o.kind === 'animal') return o.importance === 'main' ? ['primary_subject', 'secondary_subject'] : ['secondary_subject', 'primary_subject'];
  if (held) return o.kind === 'product' ? ['held_object', 'main_product'] : ['held_object', 'prop'];
  if (o.kind === 'product') return o.importance === 'main' ? ['main_product', 'supporting_product'] : ['supporting_product', 'main_product'];
  if (o.kind === 'scenery') return o.importance === 'background' && o.box.w * o.box.h >= 0.5 ? ['background', 'backdrop'] : ['backdrop', 'prop', 'background'];
  if (o.kind === 'decoration') return ['decoration', 'backdrop'];
  if (o.kind === 'effect') return ['effect'];
  return o.importance === 'main' ? ['main_product', 'prop'] : ['prop', 'supporting_product', 'decoration'];
}
const OVERLAY_ROLES: Record<SceneOverlayRole, TemplateRole[]> = { headline: ['headline'], offer: ['price', 'badge', 'body_text'], price: ['price'], legal: ['body_text'], cta: ['cta'], caption: ['body_text', 'headline'], other: ['body_text', 'badge'] };
/** A greedy, deterministic match: each template field takes the best-fitting unused item of a compatible kind (same zone first). */
export function mapSceneToSlots(scene: SceneDescription, version: Pick<TemplateVersion, 'structure'>): SceneSlotMapping {
  const slots = describeTemplateSlots(version), used = new Set<string>(), mapping: Record<string, string> = {}, unmatched: string[] = [];
  const candidates: { id: string; zone: TemplateZone; roles: TemplateRole[]; rank: number }[] = [
    ...scene.objects.filter(o => !o.ignored).map(o => ({ id: o.id, zone: o.zone, roles: rolesFor(scene, o), rank: o.importance === 'main' ? 0 : 1 })),
    ...scene.overlays.map(t => ({ id: t.id, zone: t.zone, roles: OVERLAY_ROLES[t.role], rank: 1 })),
    ...scene.marks.filter(m => m.overlay).map(m => ({ id: m.id, zone: m.zone, roles: ['logo'] as TemplateRole[], rank: 1 })),
  ];
  for (const slot of slots) {
    const fit = candidates.filter(c => !used.has(c.id) && c.roles.includes(slot.role))
      .map(c => ({ c, score: (c.zone === slot.zone ? 0 : 4) + c.roles.indexOf(slot.role) * 2 + c.rank }))
      .sort((a, b) => a.score - b.score || a.c.id.localeCompare(b.c.id, 'en', { numeric: true }))[0];
    if (fit) { used.add(fit.c.id); mapping[fit.c.id] = slot.id; } else unmatched.push(slot.id);
  }
  return { slots: mapping, unmatchedSlots: unmatched };
}
/** A slot's role label, for showing which saved template field an object fills. */
export const slotLabel = (slots: TemplateSlot[], slotId: string) => slots.find(s => s.id === slotId)?.label ?? TEMPLATE_ROLE_LABELS[slotId as TemplateRole] ?? slotId;
