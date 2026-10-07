/**
 * Editor-layer curation for refined decompositions (recursiveDecomposition.ts): the provider returns technical layers
 * (a base, plates, shadows, fragments, fillers, residual-pass pieces); the editor gets a small set of meaningful,
 * independently editable layers. Every raw candidate is kept in the record with what became of it and why:
 *
 *   editor      shown in the editor (people, products, text, CTAs, logos, badges, real decorations, the one background)
 *   merge       part of another editor layer (a cast shadow in its subject, a glow in its headline, a bangle in its
 *               hands, decorations in one decoration group)
 *   background  its pixels are part of the one background (a plate, a fragment, noise, a filler the background replaces)
 *   internal    kept for reconstruction and debugging only (the provider base when a cleaner background replaced it,
 *               an unplaceable layer)
 *   drop        not part of the result (a shadow stain removed with its subject, a residual-pass duplicate)
 *
 * Scores (0–1) explain the choices: usefulness (would a user move, hide or replace it on its own: its role, size and
 * visible contribution) and quality (does it look like a clean cutout: matching the creative, opaque, in one piece).
 * A soft layer budget per creative complexity only consolidates decorations; essential layers are never removed to meet
 * it. Deterministic and local: no model call.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import type { Canvas, LayerInfo } from './layerizeArtifacts.js';
import { compositeOnGrid, intersectCount, label, layerShape, type Grid, type LayerShape } from './backgroundContamination.js';
import { layerCategory, type LayerCategory, type ScreenItem, type UsefulnessDecision } from './layerUsefulness.js';

export type LayerDisposition = 'editor' | 'merge' | 'background' | 'internal' | 'drop';
export type CurationEntry = {
  file: string; name?: string;
  /** Where it came from: the provider base, the initial decomposition, a residual pass, or a layer the pipeline made. */
  source: 'provider-base' | 'initial' | `residual-${number}` | 'clean-background' | 'group' | 'decoration-group';
  category?: LayerCategory | 'background';
  disposition: LayerDisposition; editorVisible: boolean;
  usefulnessScore: number; qualityScore: number; reasons: string[];
  /** merge: the editor layer it is part of. */
  mergedInto?: string;
  areaPercent?: number; meanAlpha?: number;
};
export type Complexity = 'simple' | 'medium' | 'complex';
export type CurationRecord = {
  complexity: Complexity;
  /** The soft editor-layer target for that complexity: never met by removing an essential layer. */
  budget: { min: number; max: number }; overBudget: boolean;
  counts: { providerLayers: number; rawLayers: number; editorLayers: number; merged: number; background: number; internal: number; dropped: number };
  entries: CurationEntry[];
  /** Curated assets, in stacking order, before an optional explicit target-count merge. */
  editorLayerFiles: string[];
};

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
export const BUDGETS: Record<Complexity, { min: number; max: number }> = { simple: { min: 4, max: 7 }, medium: { min: 6, max: 10 }, complex: { min: 8, max: 14 } };
const WEIGHT: Record<LayerCategory | 'background', number> = { person: 1, product: 1, text: 0.9, object: 0.6, support: 0.55, scene: 0.4, decoration: 0.35, effect: 0.15, background: 1 };
const ESSENTIAL = new Set<LayerCategory>(['person', 'product', 'text']);

/** Usefulness and quality of a layer on the analysis grid (see the module comment), with the numbers behind them. */
export function scoreLayer(item: ScreenItem, grid: Grid, decision?: Pick<UsefulnessDecision, 'evidencePercent' | 'visiblePercent'>) {
  const n = grid.width * grid.height, category = layerCategory(item, n), { rgba, alpha, count } = item.shape;
  let soft = 0, alphaSum = 0;
  for (let i = 0; i < n; i++) { const a = rgba[i * 4 + 3]; if (a > 16) { soft++; alphaSum += a; } }
  const areaPercent = 100 * soft / n, meanAlpha = soft ? alphaSum / soft / 255 : 0;
  const { labels, count: pieces } = label(alpha, grid.width, grid.height), sizes = new Int32Array(pieces + 1);
  for (let i = 0; i < n; i++) sizes[labels[i]]++;
  let largest = 0; for (let i = 1; i <= pieces; i++) largest = Math.max(largest, sizes[i]);
  const wholeness = count ? largest / count : 0;
  const evidence = (decision?.evidencePercent ?? 100) / 100, visible = (decision?.visiblePercent ?? 100) / 100;
  const usefulness = Math.min(1, 0.6 * WEIGHT[category] + 0.25 * Math.min(1, areaPercent / 2) + 0.15 * visible);
  const quality = Math.min(1, 0.5 * evidence + 0.3 * wholeness + 0.2 * meanAlpha);
  return { category, usefulnessScore: round(usefulness), qualityScore: round(quality), areaPercent: round(areaPercent), meanAlpha: round(meanAlpha) };
}

/** How complex a creative is, from its editor layers: people, products, text and other objects. */
export function complexityOf(categories: (LayerCategory | 'background')[]): Complexity {
  const count = (c: string) => categories.filter(k => k === c).length;
  const people = count('person'), products = count('product'), objects = count('object') + count('support') + count('scene');
  if (people + products >= 3 || (people >= 1 && products >= 2) || objects >= 3) return 'complex';
  if (people >= 1 || products >= 2 || objects >= 2 || count('decoration') >= 2) return 'medium';
  return 'simple';
}

/**
 * Over the soft budget, decorations and effects (never people, products, text or objects) become one decoration group:
 * a full-canvas PNG of the members in their order, at the depth of the top one. Members with a non-member layer between
 * them that overlaps them are left as they are (the composition must not change). Returns the group and its members.
 */
export async function consolidateDecorations<T extends ScreenItem & { png: Buffer }>(items: T[], editorCount: number, budget: { max: number }, input: { dir: string; canvas: Canvas; grid: Grid }): Promise<{ group: T; members: T[] } | undefined> {
  if (editorCount <= budget.max) return undefined;
  const n = input.grid.width * input.grid.height;
  const byZ = [...items].sort((a, b) => a.layer.zIndex - b.layer.zIndex);
  const candidates = byZ.filter(item => !item.layer.grouping && ['decoration', 'effect'].includes(layerCategory(item, n)));
  if (candidates.length < 2) return undefined;
  const lo = Math.min(...candidates.map(c => c.layer.zIndex)), hi = Math.max(...candidates.map(c => c.layer.zIndex));
  const between = byZ.filter(item => !candidates.includes(item) && item.layer.zIndex > lo && item.layer.zIndex < hi);
  let members = candidates.filter(c => !between.some(b => intersectCount(b.shape.alpha, c.shape.alpha) > 0));
  // An excluded decoration can itself be between the survivors. Never move another decoration across its pixels.
  for (let changed = true; changed;) {
    const excluded = byZ.filter(item => !members.includes(item));
    const safe = members.filter(c => !excluded.some(b => b.layer.zIndex > c.layer.zIndex && b.layer.zIndex < members[members.length - 1].layer.zIndex && intersectCount(b.shape.alpha, c.shape.alpha) > 0));
    changed = safe.length !== members.length; members = safe;
  }
  if (members.length < 2) return undefined;
  const full = { width: input.canvas.width, height: input.canvas.height, scale: 1 };
  const rgba = await compositeOnGrid(members.map(m => ({ png: m.png, placement: m.layer.placement })), full);
  const png = await sharp(rgba, { raw: { width: full.width, height: full.height, channels: 4 } }).png().toBuffer(), file = 'decorations-group.png';
  writeFileSync(join(input.dir, file), png);
  let opaque = 0; for (let i = 3; i < rgba.length; i += 4) if (rgba[i] > 127) opaque++;
  const top = members[members.length - 1];
  const layer: LayerInfo = { index: top.layer.index, file, zIndex: top.layer.zIndex, name: 'Decorations', description: `Kept together: ${members.length} decorations.`,
    pixelWidth: full.width, pixelHeight: full.height, opaquePercent: round(100 * opaque / (full.width * full.height), 1), placement: { kind: 'full-canvas', x: 0, y: 0, width: full.width, height: full.height } };
  const shape: LayerShape = await layerShape(png, layer, input.grid);
  return { group: { ...top, layer, png, shape, kind: 'foreground', role: 'decor' }, members };
}

/** Counts and complexity of a set of curation entries (one per raw candidate). */
export function curationRecord(entries: CurationEntry[], providerLayers: number, overBudget: boolean): CurationRecord {
  const editor = entries.filter(e => e.editorVisible), complexity = complexityOf(editor.map(e => e.category ?? 'object'));
  const raw = entries.filter(e => e.source === 'provider-base' || e.source === 'initial' || e.source.startsWith('residual-'));
  const count = (d: LayerDisposition) => raw.filter(e => e.disposition === d).length;
  return { complexity, budget: BUDGETS[complexity], overBudget: overBudget || editor.length > BUDGETS[complexity].max,
    counts: { providerLayers, rawLayers: raw.length, editorLayers: editor.length, merged: count('merge'), background: count('background'), internal: count('internal'), dropped: count('drop') }, entries, editorLayerFiles: editor.map(e => e.file) };
}
export const isEssential = (category: LayerCategory | 'background' | undefined) => !!category && ESSENTIAL.has(category as LayerCategory);

export type CurationCandidate = {
  layer: LayerInfo; source: CurationEntry['source'];
  item?: ScreenItem;
  /** Early rejection, e.g. unplaced assets and residual duplicates. */
  rejected?: { disposition: LayerDisposition; reason: string };
};

/**
 * Final local assembly after grouping, usefulness screening and background recovery. The existing usefulness decisions
 * own pixel removal/folding so that the recovery mask and final image agree. This step consolidates the remaining
 * decorations and gives EVERY provider candidate (including rejected residuals and group members) a terminal decision.
 * Raw files are referenced, never overwritten. A group member inherits a suppressed group's outcome instead of claiming
 * to be merged into an editor layer that does not exist.
 */
export async function curateLayers<T extends ScreenItem & { png: Buffer }>(input: {
  dir: string; canvas: Canvas; grid: Grid; items: T[]; background: ScreenItem;
  candidates: CurationCandidate[]; decisions: UsefulnessDecision[];
  groups: { file: string; members: string[] }[];
}): Promise<{ items: T[]; record: CurationRecord }> {
  const n = input.grid.width * input.grid.height;
  const complexity = complexityOf(['background', ...input.items.map(item => layerCategory(item, n))]), budget = BUDGETS[complexity];
  const consolidated = await consolidateDecorations(input.items, input.items.length + 1, budget, input);
  const items = consolidated ? [...input.items.filter(item => !consolidated.members.includes(item)), consolidated.group].sort((a, b) => a.layer.zIndex - b.layer.zIndex) : input.items;
  const groups = [...input.groups, ...(consolidated ? [{ file: consolidated.group.layer.file, members: consolidated.members.map(m => m.layer.file) }] : [])];
  const parent = new Map(groups.flatMap(g => g.members.map(file => [file, g.file] as const)));
  const decisions = new Map(input.decisions.map(d => [d.file, d]));
  const editor = new Map([input.background, ...items].map(item => [item.layer.file, item]));
  const candidates = new Map(input.candidates.map(c => [c.layer.file, c]));
  for (const item of [input.background, ...items]) if (!candidates.has(item.layer.file)) candidates.set(item.layer.file, {
    layer: item.layer, item, source: item === input.background ? 'clean-background' : item === consolidated?.group ? 'decoration-group' : 'group',
  });
  const terminal = (file: string): string => { const seen = new Set<string>(); let next = file; while (parent.has(next) && !seen.has(next)) { seen.add(next); next = parent.get(next)!; } return next; };
  const outcome = (file: string): { disposition: LayerDisposition; reasons: string[] } => {
    if (editor.has(file)) return { disposition: 'editor', reasons: [file === input.background.layer.file ? 'Selected primary background; other technical variants remain internal.' : decisions.get(file)?.detail ?? 'Meaningful editable content retained after grouping and background recovery.'] };
    const rejected = candidates.get(file)?.rejected;
    if (rejected) return { disposition: rejected.disposition, reasons: [rejected.reason] };
    const decision = decisions.get(file);
    if (decision && !decision.kept) {
      const empty = candidateHasNoVisibleAlpha(candidates.get(file));
      return { disposition: empty || decision.reason === 'duplicate' || decision.action === 'remove' ? 'drop' : 'background', reasons: [decision.detail] };
    }
    return { disposition: 'internal', reasons: ['Technical candidate superseded by the selected background or a refined asset.'] };
  };
  const entries = [...candidates.values()].map((candidate): CurationEntry => {
    const file = candidate.layer.file, target = terminal(file), merged = target !== file && editor.has(target);
    const result = outcome(target), item = editor.get(file) ?? candidate.item;
    const scores = item ? scoreLayer(item, input.grid, decisions.get(file)) : { usefulnessScore: 0, qualityScore: 0 };
    return { file, ...(candidate.layer.name ? { name: candidate.layer.name } : {}), source: candidate.source, ...scores,
      ...(file === input.background.layer.file ? { category: 'background' as const, usefulnessScore: 1 } : {}),
      disposition: merged ? 'merge' : result.disposition, editorVisible: editor.has(file),
      reasons: merged ? [`Grouped into ${target}: ${editor.get(target)?.layer.grouping?.attachmentReason ?? 'related decoration or residual details'}.`]
        : target !== file ? [`Part of ${target}, which is not an editor layer.`, ...result.reasons] : result.reasons,
      ...(merged ? { mergedInto: target } : {}) };
  });
  const record = curationRecord(entries, input.candidates.filter(c => ['provider-base', 'initial'].includes(c.source) || c.source.startsWith('residual-')).length, false);
  Object.assign(record, { complexity, budget, overBudget: editor.size > budget.max, editorLayerFiles: [input.background.layer.file, ...items.map(item => item.layer.file)] });
  return { items, record };
}

const candidateHasNoVisibleAlpha = (candidate?: CurationCandidate) => !!candidate?.item && !candidate.item.shape.rgba.some((value, i) => i % 4 === 3 && value > 16);
