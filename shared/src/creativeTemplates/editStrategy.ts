/**
 * How a smart edit is generated, decided locally from its resolved plan (no call, so the preview and the server agree):
 *
 *   none        nothing changes: no image request; the original is used as it is
 *   local       every change has its own region and together they cover at most half of the image: the image model may
 *               paint only inside those regions, and every pixel outside them stays the source's own
 *   background  the background is restyled: the products that stay are cut out and keep their own pixels exactly (the
 *               creative-variant method); everything else is painted new
 *   global      the changes cover most of the image: one whole-image edit
 *
 * Every strategy keeps the source's own size and aspect: the image is contained in the model's canvas and mapped back.
 */
import type { ChangePlan, PlanEntry } from './changePlan.js';
import { attachedTo, isForeground, type SceneBox, type SceneDescription, sceneTarget } from './scene.js';

export type EditStrategyKind = 'none' | 'local' | 'background' | 'global';
/** A region the model may paint, as fractions of the image (grown around its change, inside the image). */
export interface EditRegion { targetId: string; label: string; box: Pick<SceneBox, 'x' | 'y' | 'w' | 'h'> }
export interface EditStrategy {
  kind: EditStrategyKind;
  regions: EditRegion[];
  /** How much of the image the regions cover together (0–100). */
  areaPercent: number;
  /** background: the objects kept exactly as the source's own pixels (each is cut out). */
  protectIds: string[];
  /** Why this strategy, in plain words (shown before generating, and with the result). */
  reasons: string[];
}
/** Local edits paint at most this share of the image; more, and one whole-image edit is better. */
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

export function editStrategy(scene: SceneDescription, plan: Pick<ChangePlan, 'entries'>): EditStrategy {
  const changes = plan.entries.filter(e => e.operation !== 'keep' && !(e.property === 'brand' && e.source === 'inferred'));
  if (!changes.length) return { kind: 'none', regions: [], areaPercent: 0, protectIds: [], reasons: ['Nothing changes: the original image is used, with no image request.'] };
  const changed = new Set(plan.entries.filter(e => e.operation !== 'keep').map(e => e.targetId));
  // A restyled background: the products that stay are protected as their own pixels; everything else is new.
  if (changes.some(e => isBackground(scene, e.targetId))) {
    const protectIds = scene.objects.filter(o => !o.ignored && isForeground(o) && !changed.has(o.id) && plan.entries.filter(e => e.targetId === o.id).every(e => e.operation === 'keep')).map(o => o.id);
    if (protectIds.length) return { kind: 'background', regions: [], areaPercent: 100, protectIds,
      reasons: [`The background is restyled: ${protectIds.map(id => scene.objects.find(o => o.id === id)!.label).join(', ')} ${protectIds.length > 1 ? 'are' : 'is'} cut out and keep${protectIds.length > 1 ? '' : 's'} your image's own pixels; the rest is painted new.`] };
    return { kind: 'global', regions: [], areaPercent: 100, protectIds: [], reasons: ['The background is restyled and every object in front of it changes too: the whole image is edited.'] };
  }
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
  const area = coverage(regions.map(r => r.box)), areaPercent = Math.round(area * 1000) / 10;
  if (area > LOCAL_AREA_LIMIT) return { kind: 'global', regions, areaPercent, protectIds: [], reasons: [`The changes cover about ${Math.round(areaPercent)}% of the image: the whole image is edited, and mapped back to its own size.`] };
  const names = [...new Set(regions.map(r => r.label))];
  return { kind: 'local', regions, areaPercent, protectIds: [], reasons: [`Only the area${names.length > 1 ? 's' : ''} of ${names.join(', ')} (about ${Math.max(1, Math.round(areaPercent))}% of the image) ${names.length > 1 ? 'are' : 'is'} edited; every other pixel stays your image's own.`] };
}
