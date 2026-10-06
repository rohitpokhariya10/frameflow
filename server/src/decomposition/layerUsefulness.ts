/**
 * Which of a refined decomposition's layers are worth an editor layer (recursiveDecomposition.ts). Seedream returns
 * what it can separate, not what a designer would edit: a grey slab it invented behind a person, a plate hidden under
 * another plate, a faint blur remnant, a shadow stain, a full background plate that is the background a second time.
 * Each one costs the user a confusing layer, and some show a broken background the moment the subject is moved.
 *
 * Kept, always: people and their protected groups, products, text, and every layer that holds something the creative
 * shows. Dropped, with the reason recorded:
 *
 *   not-in-original      its visible pixels are not the creative's (a hallucinated filler panel)            → fold
 *   hidden               (almost) never visible in the design: a guess at what lies behind something        → fold
 *   filler-behind-subject  what lies behind the subject is colors its visible part never shows (a grey slab baked
 *                        into a wall panel where the person stood): hiding the person would show it           → fold
 *   background-fragment  a small scene or decoration piece that barely shows (background noise, a faint patch);
 *                        looser on a simple background, where fewer layers serve the editor better          → fold
 *   faint-remnant        a small, soft layer that barely changes the image (a blur remnant, a smudge; an
 *                        opaque object colored like its background, a white product on white, is kept)      → fold
 *   detached-shadow      a shadow stain that no subject casts (attached shadows are grouped with it)        → remove
 *   merged-into-background / duplicates-background / replaced-by-clean-background
 *                        a full background plate: the clean background is that plate, so a second one only
 *                        hides it (or shows the plate's own broken copy of what was behind the subject)
 *
 * fold: its pixels stay in the background (it was never a separate element); remove: its area is rebuilt with the rest
 * of the foreground. Deterministic, on the analysis grid; no model call.
 */
import type { LayerInfo } from './layerizeArtifacts.js';
import { backgroundModel, type Grid, type LayerShape } from './backgroundContamination.js';
import { palette } from './backgroundRecovery.js';
import { grow } from './outerBackground.js';
import { EFFECT, idWords, PERSON, TEXTISH } from './interactionTerms.js';
import { isShadowLayer } from './interactionGrouping.js';

export type LayerCategory = 'person' | 'product' | 'text' | 'scene' | 'decoration' | 'support' | 'object' | 'effect';
export type DropReason = 'not-in-original' | 'hidden' | 'filler-behind-subject' | 'faint-remnant' | 'background-fragment' | 'detached-shadow' | 'merged-into-background' | 'duplicates-background' | 'replaced-by-clean-background';
export type UsefulnessDecision = {
  file: string; name?: string; category: LayerCategory; kept: boolean; reason?: DropReason; detail: string;
  /** Dropped layers: fold keeps their pixels in the background, remove rebuilds their area with the foreground's. */
  action?: 'fold' | 'remove';
  /** Share of the layer not covered by layers in front of it, and share of its visible opaque pixels that match the original. */
  visiblePercent?: number; evidencePercent?: number;
  /** Mean change the layer makes to the background under it (0–255), for small layers. */
  changeMean?: number;
  /** Plates: share of their opaque pixels the chosen clean background already has. */
  backgroundMatchPercent?: number;
};
/**
 * What the editor gets: the layers screened (after grouping), the meaningful ones (the background counts as one) by
 * category, every one left out, and the kind of background they were judged against (plain field, simple graphic
 * design, or a scene/photograph).
 */
export type LayerPlan = { screenedLayers: number; editableLayers: number; byCategory: Partial<Record<LayerCategory | 'background', number>>; dropped: UsefulnessDecision[]; backgroundKind?: 'plain' | 'graphic' | 'scene' };
export type ScreenItem = { layer: LayerInfo; shape: LayerShape; kind: 'background' | 'foreground'; role: string };

const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
const maxDiff = (rgba: ArrayLike<number>, i: number, rgb: ArrayLike<number>) => Math.max(Math.abs(rgba[i * 4] - rgb[i * 3]), Math.abs(rgba[i * 4 + 1] - rgb[i * 3 + 1]), Math.abs(rgba[i * 4 + 2] - rgb[i * 3 + 2]));

/** What a layer is for the editor, from its kind, grouping, name and role (`n`: pixels of the grid its shape is on). */
export function layerCategory(item: ScreenItem, n: number): LayerCategory {
  const words = idWords(`${item.layer.name ?? ''}`);
  if (TEXTISH.test(words) || item.role === 'text') return 'text';
  if (item.kind === 'background') return 'scene';
  if (item.layer.grouping) return PERSON.test(words) || item.layer.grouping.members.some(m => ['held_object', 'finger_fragment', 'body_part', 'worn_ornament'].includes(m.role)) ? 'person' : item.role === 'decor' ? 'decoration' : 'object';
  if (isShadowLayer(item.layer, item.shape.rgba, n)) return 'effect';
  if (PERSON.test(words)) return 'person';
  if (EFFECT.test(words)) return 'effect';
  if (item.role === 'product') return 'product';
  if (item.role === 'support') return 'support';
  if (item.role === 'decor') return 'decoration';
  return 'object';
}
const isProtected = (item: ScreenItem, category: LayerCategory) => !!item.layer.grouping || category === 'person' || category === 'product' || category === 'text';

/**
 * Before the background: fillers, hidden guesses, faint remnants and detached shadow stains (see the module comment).
 * `original`: the creative as raw RGB on `grid`. Returns one decision per item, in the items' order.
 */
export function screenFillers(items: ScreenItem[], original: ArrayLike<number>, grid: Grid): UsefulnessDecision[] {
  const n = grid.width * grid.height;
  // A simple background (a few flat colors where no layer is): fragments of it are folded in more readily.
  const bare: number[] = [];
  for (let i = 0; i < n; i++) if (!items.some(item => item.shape.rgba[i * 4 + 3] > 16)) bare.push(i);
  const backdrop = palette(original, bare), simpleBackground = backdrop.simple && backdrop.centers.length <= 3;
  // What lies in front of each layer: the union of every layer above it.
  const byZ = [...items].sort((a, b) => a.layer.zIndex - b.layer.zIndex), front = new Map<ScreenItem, Uint8Array>();
  let cover = new Uint8Array(n);
  for (let k = byZ.length - 1; k >= 0; k--) {
    front.set(byZ[k], cover);
    const next = Uint8Array.from(cover), alpha = byZ[k].shape.alpha;
    for (let i = 0; i < n; i++) if (alpha[i]) next[i] = 1;
    cover = next;
  }
  // The background under small layers, estimated without any layer (only when a small layer needs it).
  let model: Float32Array | undefined;
  const modelOf = () => {
    if (!model) {
      const all = new Uint8Array(n);
      for (const item of items) for (let i = 0; i < n; i++) if (item.shape.rgba[i * 4 + 3] > 16) all[i] = 1;
      model = backgroundModel(Uint8Array.from(original), grid.width, grid.height, grow(all, grid.width, grid.height, 2)).model;
    }
    return model;
  };
  return items.map((item): UsefulnessDecision => {
    const category = layerCategory(item, n), base = { file: item.layer.file, ...(item.layer.name ? { name: item.layer.name } : {}), category };
    const { alpha, rgba, count } = item.shape, f = front.get(item)!;
    let visible = 0, opaqueVisible = 0, match = 0, faint = 0, alphaSum = 0;
    for (let i = 0; i < n; i++) {
      if (rgba[i * 4 + 3] > 16) { faint++; alphaSum += rgba[i * 4 + 3]; }
      if (!alpha[i] || f[i]) continue;
      visible++;
      if (rgba[i * 4 + 3] >= 240) { opaqueVisible++; if (maxDiff(rgba, i, original) <= 40) match++; }
    }
    const visiblePercent = round(100 * visible / Math.max(1, count)), evidencePercent = opaqueVisible ? round(100 * match / opaqueVisible) : undefined;
    const metrics = { visiblePercent, ...(evidencePercent !== undefined ? { evidencePercent } : {}) };
    if (isProtected(item, category)) return { ...base, kept: true, detail: `${category}: always an editable layer`, ...metrics };
    const drop = (reason: DropReason, action: 'fold' | 'remove', detail: string, extra: Partial<UsefulnessDecision> = {}): UsefulnessDecision => ({ ...base, kept: false, reason, action, detail, ...metrics, ...extra });
    if (item.kind === 'foreground' && isShadowLayer(item.layer, rgba, n))
      return drop('detached-shadow', 'remove', 'a shadow stain that touches no subject: removed from the background with the foreground instead of kept as a layer');
    if (opaqueVisible >= Math.max(0.0015 * n, 0.03 * count) && match < 0.25 * opaqueVisible)
      return drop('not-in-original', 'fold', `only ${evidencePercent}% of its visible pixels are what the creative shows there: a filler the provider invented, not an element of the design`);
    if (count > 0 && visible < 0.03 * count)
      return drop('hidden', 'fold', `only ${visiblePercent}% of it is ever visible in the design (the rest is behind other layers): a guess at what lies behind them, which the clean background replaces`);
    // What it holds behind the subject: colors its own visible part never shows are a filler the provider invented there.
    if (opaqueVisible >= 20) {
      const shown: number[] = [], behind: number[] = [], rgb = new Uint8Array(n * 3);
      for (let i = 0; i < n; i++) {
        if (rgba[i * 4 + 3] < 240) continue;
        rgb[i * 3] = rgba[i * 4]; rgb[i * 3 + 1] = rgba[i * 4 + 1]; rgb[i * 3 + 2] = rgba[i * 4 + 2];
        (f[i] ? behind : shown).push(i);
      }
      if (behind.length >= Math.max(0.003 * n, 0.1 * count)) {
        const { centers } = palette(rgb, shown);
        const foreign = behind.filter(i => Math.min(...centers.map(c => Math.max(Math.abs(c[0] - rgb[i * 3]), Math.abs(c[1] - rgb[i * 3 + 1]), Math.abs(c[2] - rgb[i * 3 + 2])))) > 60).length;
        if (foreign >= 0.4 * behind.length)
          return drop('filler-behind-subject', 'fold', `${Math.round(100 * foreign / behind.length)}% of what it holds behind other layers is colors its visible part never shows: a filler that hiding them would reveal; the clean background continues there instead`);
      }
    }
    // How much it changes the background under it, for small layers: a remnant or a fragment barely does.
    const changeOf = () => {
      const m = modelOf();
      let change = 0;
      for (let i = 0; i < n; i++) { const a = rgba[i * 4 + 3]; if (a > 16) change += (a / 255) * Math.max(Math.abs(rgba[i * 4] - m[i * 3]), Math.abs(rgba[i * 4 + 1] - m[i * 3 + 1]), Math.abs(rgba[i * 4 + 2] - m[i * 3 + 2])); }
      return round(change / faint);
    };
    // Soft (mostly translucent) and small: a remnant can only be that; an opaque object is a real element however faint.
    if (item.kind === 'foreground' && faint < 0.02 * n && faint > 0 && alphaSum / faint < 0.75 * 255) {
      const changeMean = changeOf();
      if (changeMean < 10) return drop('faint-remnant', 'fold', `barely changes the image (mean ${changeMean}/255 over its pixels): a remnant, kept in the background`, { changeMean });
    }
    // A small piece of the scene or of its decoration that barely shows: background, not an editable layer.
    if ((category === 'scene' || category === 'decoration' || category === 'effect') && faint > 0 && faint < 0.1 * n && !isPlate(item, grid)) {
      const changeMean = changeOf(), limit = simpleBackground ? 16 : 10;
      if (changeMean < limit) return drop('background-fragment', 'fold', `a ${category} piece that barely shows (mean ${changeMean}/255 against the background${simpleBackground ? ', a simple design' : ''}): kept in the background`, { changeMean });
    }
    return { ...base, kept: true, detail: `holds what the creative shows (${visiblePercent}% visible${evidencePercent !== undefined ? `, ${evidencePercent}% matching` : ''})`, ...metrics };
  });
}

/** A full background plate: covers (almost) the whole canvas, mostly opaque. */
export function isPlate(item: ScreenItem, grid: Grid): boolean {
  const n = grid.width * grid.height, box = item.shape.box;
  if (item.kind !== 'background' || !box || box.x1 - box.x0 < 0.85 * grid.width || box.y1 - box.y0 < 0.85 * grid.height) return false;
  let opaque = 0; for (let i = 0; i < n; i++) if (item.shape.rgba[i * 4 + 3] >= 240) opaque++;
  return opaque >= 0.6 * n;
}

/**
 * After the background is chosen: full background plates are the background, never a second one on top of it. Merged
 * when the clean background is their own composite; dropped when it already holds them (90% of their opaque pixels
 * within 24); dropped too when the clean background was rebuilt from the original instead (the plate's copy of what was
 * behind the subject was not clean). Kept only over a provider base they differ from.
 */
export function screenPlates(items: ScreenItem[], background: ArrayLike<number>, method: string, grid: Grid): UsefulnessDecision[] {
  const n = grid.width * grid.height;
  return items.filter(item => isPlate(item, grid)).map((item): UsefulnessDecision => {
    const base = { file: item.layer.file, ...(item.layer.name ? { name: item.layer.name } : {}), category: 'scene' as const };
    let opaque = 0, same = 0;
    for (let i = 0; i < n; i++) if (item.shape.rgba[i * 4 + 3] >= 240) { opaque++; if (maxDiff(item.shape.rgba, i, background) <= 24) same++; }
    const backgroundMatchPercent = round(100 * same / Math.max(1, opaque));
    if (method === 'scene-composite') return { ...base, kept: false, reason: 'merged-into-background', action: 'fold', detail: 'a full background plate: the clean background is built from it, so it is not repeated as a layer', backgroundMatchPercent };
    if (same >= 0.9 * opaque) return { ...base, kept: false, reason: 'duplicates-background', action: 'fold', detail: `a full background plate the clean background already shows (${backgroundMatchPercent}% the same)`, backgroundMatchPercent };
    if (method !== 'provider-base') return { ...base, kept: false, reason: 'replaced-by-clean-background', action: 'fold', detail: `a full background plate whose copy of what lies behind the subject is not clean (${backgroundMatchPercent}% matches the validated clean background); the clean background replaces it`, backgroundMatchPercent };
    return { ...base, kept: true, detail: `a full background plate that differs from the provider base (${backgroundMatchPercent}% the same)`, backgroundMatchPercent };
  });
}

/** The editor's layers in numbers: the background plus every kept layer by category, and every dropped one. */
export function layerPlan(kept: ScreenItem[], decisions: UsefulnessDecision[], grid: Grid, backgroundKind?: LayerPlan['backgroundKind']): LayerPlan {
  const byCategory: LayerPlan['byCategory'] = { background: 1 };
  for (const item of kept) { const c = layerCategory(item, grid.width * grid.height); byCategory[c] = (byCategory[c] ?? 0) + 1; }
  return { screenedLayers: kept.length + decisions.filter(d => !d.kept).length, editableLayers: kept.length + 1, byCategory, dropped: decisions.filter(d => !d.kept), ...(backgroundKind ? { backgroundKind } : {}) };
}
