/**
 * Backdrop components: panels, cards, geometric shapes and decorative blocks that sit ON a creative's base canvas. Seedream
 * returns them as their own layers, but a large one reads as "scene" (classify in recursiveDecomposition.ts), and scene
 * layers were folded into the clean background: a white canvas and an orange panel became one bitmap, so hiding or moving
 * the panel was impossible. A component is kept as its own editor layer, and the base must then be clean behind it too
 * (it joins the removed foreground), so hiding it reveals the base, never a copy of it.
 *
 * Which large scene layers are components, in order of evidence:
 *
 *   plan   the planner's (or the reused template's) own inventory: a layer matched to an element whose role is a
 *          backdrop, decoration or prop is a component; one matched to the base canvas ('background') never is. A
 *          reused plan names roles, not content, so a backdrop it asks for may match no layer by words: the largest
 *          solid scene layer left unmatched then takes that requested slot
 *   shape  without a role: a solid, smooth design surface (flat or gradient, not photographic texture) that touches at
 *          most two canvas edges, an inset panel, a corner wedge, a band; a floor, a sky or a wall reaches three or four.
 *          The refinement keeps such a shape in the base when separating it would turn a free, trusted rebuild of the
 *          base into a paid one (keepShapesFree): only the plan's own request justifies that cost
 *
 * Never a component: a layer covering (almost) the whole canvas (it is the base), a soft one (a glow, a vignette), or a
 * set that together covers the canvas (the scene itself, with nothing of a base left to reveal). No colour is special.
 * Deterministic, on the analysis grid; no model call.
 */
import { isTemplateRole, type TemplateRole } from '@frameflow/shared';
import type { Grid, LayerShape } from './backgroundContamination.js';
import type { LayerInfo } from './layerizeArtifacts.js';
import type { SemanticAnalysis } from './semanticPlanner.js';

/** Roles that are their own design element on the canvas. */
export const COMPONENT_ROLES: ReadonlySet<TemplateRole> = new Set(['backdrop', 'decoration', 'prop']);
/** Below this share of the canvas a scene layer is not a backdrop decision (classify already makes small ones foreground). */
const MIN_AREA = 0.01, BASE_AREA = 0.9, MIN_SOLID_ALPHA = 0.85 * 255, MIN_OPAQUE_SHARE = 0.7;
/** Mean step between neighbouring opaque pixels (0–255): flat colours and gradients stay under it, photographs do not. */
export const SMOOTH_STEP = 4;
/** Components may cover at most this share of the canvas together: the base has to show somewhere. */
const MAX_UNION = 0.85;

export type BackdropDecision = {
  file: string; name?: string; component: boolean; basis: 'plan' | 'shape' | 'none'; reason: string;
  role?: TemplateRole; areaPercent: number; edges: number; solidPercent: number; smoothness: number;
};
export type BackdropItem = { layer: Pick<LayerInfo, 'file' | 'name' | 'semantic' | 'placement'>; shape: LayerShape; kind: 'background' | 'foreground' };

/** The template role the plan gave an element: its capture role (a new template) or its type (a reused template's plan). */
export function planRoles(semantic: SemanticAnalysis | undefined, captureRoles?: Record<string, TemplateRole>): (elementId: string) => TemplateRole | undefined {
  const types = new Map((semantic?.elements ?? []).map(e => [e.id, e.type]));
  return id => captureRoles?.[id] ?? (isTemplateRole(types.get(id) ?? '') ? types.get(id) as TemplateRole : undefined);
}

/** Pixel measures of one layer: area, how solid it is, how smooth its surface is, and which canvas edges it reaches. */
export function surfaceOf(shape: LayerShape, grid: Grid) {
  const n = grid.width * grid.height, { rgba, box } = shape;
  let visible = 0, alphaSum = 0, opaque = 0, steps = 0, pairs = 0;
  for (let i = 0; i < n; i++) { const a = rgba[i * 4 + 3]; if (a > 16) { visible++; alphaSum += a; if (a >= 240) opaque++; } }
  // Neighbour steps inside the opaque surface (both pixels opaque): texture, not the shape's own outline.
  for (let y = 0; y < grid.height - 1; y++) for (let x = 0; x < grid.width - 1; x++) {
    const i = y * grid.width + x;
    if (rgba[i * 4 + 3] < 240) continue;
    for (const j of [i + 1, i + grid.width]) {
      if (rgba[j * 4 + 3] < 240) continue;
      steps += Math.max(Math.abs(rgba[i * 4] - rgba[j * 4]), Math.abs(rgba[i * 4 + 1] - rgba[j * 4 + 1]), Math.abs(rgba[i * 4 + 2] - rgba[j * 4 + 2]));
      pairs++;
    }
  }
  const margin = (size: number) => Math.max(1, Math.round(0.02 * size));
  const edges = !box ? 0 : [box.x0 <= margin(grid.width), box.y0 <= margin(grid.height), box.x1 >= grid.width - margin(grid.width), box.y1 >= grid.height - margin(grid.height)].filter(Boolean).length;
  return { area: visible / n, meanAlpha: visible ? alphaSum / visible : 0, opaqueShare: visible ? opaque / visible : 0, smoothness: pairs ? steps / pairs : 0, edges };
}

/**
 * Which of a decomposition's scene ('background') layers are backdrop components (see the module comment). Returns a
 * decision for every scene layer large enough to be one, in the items' order. Foreground layers are not judged.
 */
export function backdropComponents(items: BackdropItem[], grid: Grid, roleOf: (elementId: string) => TemplateRole | undefined = () => undefined, openSlots: TemplateRole[] = []): BackdropDecision[] {
  const n = grid.width * grid.height, claimable = new Set<string>();
  let decisions = items.filter(item => item.kind === 'background' && item.shape.box && item.layer.placement.kind !== 'unresolved').map((item): BackdropDecision => {
    const s = surfaceOf(item.shape, grid), role = item.layer.semantic ? roleOf(item.layer.semantic.id) : undefined;
    const base = { file: item.layer.file, ...(item.layer.name ? { name: item.layer.name } : {}), ...(role ? { role } : {}), areaPercent: round(100 * s.area), edges: s.edges,
      solidPercent: round(100 * s.opaqueShare), smoothness: round(s.smoothness) };
    const no = (basis: BackdropDecision['basis'], reason: string): BackdropDecision => ({ ...base, component: false, basis, reason });
    if (s.area < MIN_AREA) return no('none', 'too small to be a backdrop decision');
    if (s.area >= BASE_AREA) return no('none', `covers ${base.areaPercent}% of the canvas: it is the base canvas`);
    if (s.meanAlpha < MIN_SOLID_ALPHA || s.opaqueShare < MIN_OPAQUE_SHARE) return no('none', `soft (${base.solidPercent}% opaque): atmosphere such as a glow or vignette, part of the background`);
    if (role === 'background') return no('plan', 'the plan names it the base canvas');
    if (role && COMPONENT_ROLES.has(role) && item.layer.semantic?.editableIndependently !== false) return { ...base, component: true, basis: 'plan', reason: `the plan lists it as its own ${role} on the canvas` };
    if (!role) claimable.add(item.layer.file);
    if (s.smoothness > SMOOTH_STEP) return no('shape', `a textured or photographic surface (mean step ${base.smoothness}): part of the scene`);
    if (s.edges > 2) return no('shape', `reaches ${s.edges} canvas edges: a region of the scene (a floor, a wall, a sky), not a shape placed on it`);
    return { ...base, component: true, basis: 'shape', reason: `a solid ${s.edges ? `shape reaching ${s.edges} canvas edge${s.edges > 1 ? 's' : ''}` : 'inset shape'} on the canvas` };
  });
  // Backdrops the plan asks for that no layer matched: the largest unmatched solid scene layers take those slots.
  const slots = [...openSlots];
  for (const d of [...decisions].sort((a, b) => b.areaPercent - a.areaPercent)) {
    if (!slots.length) break;
    if (d.component || !claimable.has(d.file)) continue;
    const role = slots.shift()!;
    decisions = decisions.map(x => x === d ? { ...d, component: true, basis: 'plan', role, reason: `the plan asks for its own ${role}, and no other layer is it` } : x);
  }
  // Together they must leave the base visible somewhere; otherwise they are the scene itself.
  const chosen = decisions.filter(d => d.component);
  if (chosen.length) {
    const union = new Uint8Array(n);
    for (const d of chosen) { const shape = items.find(item => item.layer.file === d.file)!.shape; for (let i = 0; i < n; i++) if (shape.alpha[i]) union[i] = 1; }
    let covered = 0; for (const v of union) covered += v;
    if (covered >= MAX_UNION * n) return decisions.map(d => d.component ? { ...d, component: false, reason: `together the backdrop shapes cover ${round(100 * covered / n)}% of the canvas: they are the scene itself` } : d);
  }
  return decisions;
}

const round = (value: number) => Math.round(value * 10) / 10;

/**
 * Shape-only components (no plan role) that would make the base's rebuild untrusted — a paid edit — where it is
 * trusted and free without them stay in the base: an incidental shape is not worth a call the plan never asked for.
 * `trusted(extra)` answers whether the base can be continued locally with these shapes removed too.
 */
export function keepShapesFree(decisions: BackdropDecision[], trusted: (shapes: string[]) => boolean): BackdropDecision[] {
  const shapes = decisions.filter(d => d.component && d.basis === 'shape').map(d => d.file);
  if (!shapes.length || trusted(shapes) || !trusted([])) return decisions;
  return decisions.map(d => shapes.includes(d.file) ? { ...d, component: false, reason: 'kept in the base: separating it would turn a free, local rebuild of the base into a paid edit, and the plan does not ask for it' } : d);
}
