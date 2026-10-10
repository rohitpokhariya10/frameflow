/**
 * How a smart edit (Feature 2) is generated, decided locally from its resolved plan (no call, so the preview and the
 * server agree). Feature 2 edits the CONTENT of the template: its structure (every slot's place, size, tilt and depth, the
 * framing and the canvas) is kept by construction, never left to the image model's judgment:
 *
 *   none        nothing changes: no image request; the original is used as it is
 *   local       each change has its own region (its slot): the image model may paint only there, and every pixel outside
 *               them stays the source's own, however much of the image the regions cover
 *   background  only the background (with removals) changes: the products are cut out and keep their own pixels exactly
 *   layered     the background changes AND objects change: first the background around every product (all kept as their
 *               own pixels, in place), then each changed object repainted inside its own slot of that image
 *   global      the creative becomes an ad for another kind of product (plan.intent), or there is nothing in front of a
 *               restyled background to keep: one whole-image edit, guided by the template's layout zones
 *
 * Every strategy keeps the source's own size and aspect (the model's canvas has the source's own ratio, editCanvasSize).
 */
import type { ChangePlan, PlanEntry } from './changePlan.js';
import { attachedTo, isForeground, type SceneBox, type SceneDescription, sceneTarget } from './scene.js';

export type EditStrategyKind = 'none' | 'local' | 'background' | 'layered' | 'global';
/** A region the model may paint, as fractions of the image (grown around its change, inside the image). */
export interface EditRegion { targetId: string; label: string; box: Pick<SceneBox, 'x' | 'y' | 'w' | 'h'> }
export interface EditStrategy {
  kind: EditStrategyKind;
  regions: EditRegion[];
  /** How much of the image the regions cover together (0–100). */
  areaPercent: number;
  /** background and layered: the objects kept exactly as the source's own pixels while the background is restyled (each is cut out). */
  protectIds: string[];
  /** Why this strategy, in plain words (shown before generating, and with the result). */
  reasons: string[];
}
/** The share of the image the regions of a typical local edit stay under (kept for reports; Feature 2 no longer switches on it). */
export const LOCAL_AREA_LIMIT = 0.5;

const clamp = (b: { x: number; y: number; w: number; h: number }) => {
  const x = Math.max(0, b.x), y = Math.max(0, b.y);
  return { x, y, w: Math.max(0, Math.min(1, b.x + b.w) - x), h: Math.max(0, Math.min(1, b.y + b.h) - y) };
};
/** A box grown by `share` of its own size on every side, plus `pad` of the image. */
const grow = (b: Pick<SceneBox, 'x' | 'y' | 'w' | 'h'>, share: number, pad: number) => clamp({ x: b.x - b.w * share - pad, y: b.y - b.h * share - pad, w: b.w * (1 + 2 * share) + 2 * pad, h: b.h * (1 + 2 * share) + 2 * pad });
/** How much a change may reach beyond its item: a replacement may differ in shape and cast its own shadow; a removal is filled around. */
const GROWTH: Record<string, [number, number]> = { replace: [0.15, 0.015], remove: [0.08, 0.01], modify: [0.04, 0.01], mark: [0.25, 0.01], overlay: [0.06, 0.01] };
const isBackground = (scene: SceneDescription, id: string) => { const t = sceneTarget(scene, id); return t?.type === 'object' && t.item.kind === 'scenery' && t.item.importance === 'background'; };
/** The union of boxes as a share of the image (a 200×200 grid: exact enough to choose a strategy). */
export function coverage(boxes: Pick<SceneBox, 'x' | 'y' | 'w' | 'h'>[]): number {
  const N = 200, grid = new Uint8Array(N * N);
  for (const b of boxes) for (let y = Math.floor(b.y * N); y < Math.min(N, Math.ceil((b.y + b.h) * N)); y++) for (let x = Math.floor(b.x * N); x < Math.min(N, Math.ceil((b.x + b.w) * N)); x++) grid[y * N + x] = 1;
  return grid.reduce((s, v) => s + v, 0) / (N * N);
}

export function editStrategy(scene: SceneDescription, plan: Pick<ChangePlan, 'entries'> & Partial<Pick<ChangePlan, 'intent'>>): EditStrategy {
  const changes = plan.entries.filter(e => e.operation !== 'keep' && !(e.property === 'brand' && e.source === 'inferred'));
  if (!changes.length) return { kind: 'none', regions: [], areaPercent: 0, protectIds: [], reasons: ['Nothing changes: the original image is used, with no image request.'] };
  // A new kind of product: the whole creative is rebuilt around it (nothing of the old offer is kept by its pixels).
  if (plan.intent?.kind === 'new-product') return { kind: 'global', regions: [], areaPercent: 100, protectIds: [], reasons: [`The creative becomes an ad for ${plan.intent.hero}: the whole image is edited around it.`] };
  const changed = new Set(plan.entries.filter(e => e.operation !== 'keep').map(e => e.targetId));
  const regions: EditRegion[] = [];
  const add = (e: PlanEntry, box: Pick<SceneBox, 'x' | 'y' | 'w' | 'h'>) => { if (box.w > 0 && box.h > 0) regions.push({ targetId: e.targetId, label: e.label, box }); };
  for (const e of changes) {
    const t = sceneTarget(scene, e.targetId);
    if (!t) continue;
    if (t.type !== 'object') { const [share, pad] = GROWTH[t.type]; add(e, grow(t.item.box, share, pad)); continue; }
    if (e.operation === 'adjust') {
      // The hand around a changed held object: that object's surroundings, not the whole person.
      const held = attachedTo(scene, e.targetId).map(id => scene.objects.find(o => o.id === id)).filter(o => !!o && changed.has(o.id));
      if (held.length) for (const o of held) add(e, grow(o!.box, 0.5, 0.02));
      else add(e, grow(t.item.box, GROWTH.modify[0], GROWTH.modify[1]));
      continue;
    }
    const [share, pad] = GROWTH[e.operation] ?? GROWTH.modify;
    add(e, grow(t.item.box, share, pad));
  }
  const name = (id: string) => scene.objects.find(o => o.id === id)!.label;
  // A restyled background: every product in front of it keeps its own pixels in place while the background is new; the
  // objects that change are then repainted inside their own slots (layered), never re-composed by the model.
  if (changes.some(e => isBackground(scene, e.targetId))) {
    const removed = new Set(plan.entries.filter(e => e.operation === 'remove').map(e => e.targetId));
    const protectIds = scene.objects.filter(o => !o.ignored && isForeground(o) && !removed.has(o.id)).map(o => o.id);
    const slots = regions.filter(r => !isBackground(scene, r.targetId) && sceneTarget(scene, r.targetId)?.type === 'object' && changes.some(e => e.targetId === r.targetId && e.operation !== 'remove'));
    if (!protectIds.length) return { kind: 'global', regions: [], areaPercent: 100, protectIds: [], reasons: ['The background is restyled and nothing in front of it stays: the whole image is edited, on its own canvas.'] };
    if (!slots.length) return { kind: 'background', regions: [], areaPercent: 100, protectIds, reasons: [`The background is restyled: ${protectIds.map(name).join(', ')} ${protectIds.length > 1 ? 'are' : 'is'} cut out and keep${protectIds.length > 1 ? '' : 's'} your image's own pixels, in place.`] };
    const area = coverage(slots.map(r => r.box)), slotNames = [...new Set(slots.map(r => r.label))];
    return { kind: 'layered', regions: slots, areaPercent: Math.round(area * 1000) / 10, protectIds,
      reasons: [`First the background is restyled while ${protectIds.map(name).join(', ')} keep${protectIds.length > 1 ? '' : 's'} their own pixels in place; then ${slotNames.join(', ')} ${slotNames.length > 1 ? 'are' : 'is'} repainted only inside ${slotNames.length > 1 ? 'their own slots' : 'its own slot'}. The layout stays the template's.`] };
  }
  // Everything else is local, however much of the image it covers: only the changed slots are painted.
  const area = coverage(regions.map(r => r.box)), areaPercent = Math.round(area * 1000) / 10;
  const names = [...new Set(regions.map(r => r.label))];
  return { kind: 'local', regions, areaPercent, protectIds: [], reasons: [`Only the area${names.length > 1 ? 's' : ''} of ${names.join(', ')} (about ${Math.max(1, Math.round(areaPercent))}% of the image) ${names.length > 1 ? 'are' : 'is'} edited; every other pixel stays your image's own.`] };
}
/**
 * The two passes of a layered edit, as two plans of the same decisions: the background pass (the restyle and every
 * removal; the objects that change are kept, as their own pixels, for now) and the objects pass (every object change in
 * its own slot; the background is already restyled, so it is kept). Each compiles to its own prompt.
 */
export function layeredPlans(scene: SceneDescription, plan: ChangePlan): { background: ChangePlan; objects: ChangePlan } {
  const later = (e: PlanEntry) => sceneTarget(scene, e.targetId)?.type === 'object' && !isBackground(scene, e.targetId) && e.operation !== 'remove' && e.operation !== 'keep';
  const keep = (e: PlanEntry): PlanEntry => ({ ...e, id: `inherited:${e.targetId}:keep`, operation: 'keep', source: 'inherited', reason: 'Kept in this pass.', to: undefined, brand: undefined, property: undefined });
  const once = (entries: PlanEntry[]) => { const seen = new Set<string>(); return entries.filter(e => !seen.has(e.id) && !!seen.add(e.id)); };
  const background = once(plan.entries.map(e => later(e) ? keep(e) : e).filter(e => e.operation === 'keep' || !later(e)));
  const objects = once(plan.entries.map(e => isBackground(scene, e.targetId) && e.operation !== 'keep' ? keep(e) : e));
  const status = (entries: PlanEntry[]) => entries.some(e => e.operation !== 'keep') ? 'clear' as const : 'unchanged' as const;
  return { background: { ...plan, entries: dropKeptChanged(background), status: status(background) }, objects: { ...plan, entries: dropKeptChanged(objects), status: status(objects) } };
}
/** One fate per target: a target that changes is never also listed as kept. */
const dropKeptChanged = (entries: PlanEntry[]) => { const changed = new Set(entries.filter(e => e.operation !== 'keep').map(e => e.targetId)); return entries.filter(e => e.operation !== 'keep' || !changed.has(e.targetId)); };
