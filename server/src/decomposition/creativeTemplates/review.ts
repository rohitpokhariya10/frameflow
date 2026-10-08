/**
 * The local review of a generated creative: pixel comparisons of the image that was edited and the image that came back,
 * inside the regions the user asked to replace or remove (and outside them). It can show that a region still carries the
 * original object's outline — the edit kept the product it was asked to replace — or that areas nobody asked about
 * changed. It cannot tell whether the new product is the right one: every review ends with a person looking at it.
 *
 * Regions: the template's own source layers when the edited image is the template's source creative (exact shapes), else
 * the saved coarse zones (thirds of the canvas). No model call.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { describeTemplateSlots, type EditChange, type GenerationReview, type GenerationReviewCheck, type TemplateVersion, type TemplateZone } from '@frameflow/shared';
import { layerShape } from '../backgroundContamination.js';
import type { LayerInfo } from '../layerizeArtifacts.js';
import { zoneOf } from './capture.js';

/** Calibrated on saved live runs: a product the edit kept showed 80%+ of its outline, a replaced one far less. */
export const KEPT_OUTLINE_PERCENT = 60;
const SIDE = 256, MIN_EDGES = 40, SHIFT = 4;
const NOTE = 'Local pixel comparison only: it can show that a region still looks like the original, not that the new content is correct. Review the image before using it.';

const rgbOf = (png: Buffer, w: number, h: number) => sharp(png).flatten({ background: '#ffffff' }).resize(w, h, { fit: 'fill' }).removeAlpha().raw().toBuffer();
const lum = (rgb: ArrayLike<number>, i: number) => 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
/** Edge strength after a light blur: texture and outlines, not noise. */
function edges(rgb: ArrayLike<number>, w: number, h: number): Float32Array {
  const blur = new Float32Array(w * h), g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let sum = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h) { sum += lum(rgb, yy * w + xx); n++; } }
    blur[y * w + x] = sum / n;
  }
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; g[i] = Math.abs(blur[i + 1] - blur[i - 1]) + Math.abs(blur[i + w] - blur[i - w]); }
  return g;
}
/** Each pixel's strongest edge within `r` pixels: a re-rendered image is rarely aligned to the pixel. */
function spread(g: Float32Array, w: number, h: number, r: number): Float32Array {
  const row = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let m = 0; for (let dx = -r; dx <= r; dx++) { const xx = x + dx; if (xx >= 0 && xx < w) m = Math.max(m, g[y * w + xx]); } row[y * w + x] = m; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let m = 0; for (let dy = -r; dy <= r; dy++) { const yy = y + dy; if (yy >= 0 && yy < h) m = Math.max(m, row[yy * w + x]); } out[y * w + x] = m; }
  return out;
}
const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>, i: number) => Math.max(Math.abs(a[i * 3] - b[i * 3]), Math.abs(a[i * 3 + 1] - b[i * 3 + 1]), Math.abs(a[i * 3 + 2] - b[i * 3 + 2]));
/** A zone as a third of the canvas (full-canvas: everything). */
export function zoneMask(zone: TemplateZone, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  if (zone === 'full-canvas') return out.fill(1);
  const [v, hz] = zone === 'center' ? ['middle', 'center'] : zone.split('-');
  const rows = { top: [0, 1 / 3], middle: [1 / 3, 2 / 3], bottom: [2 / 3, 1] }[v as 'top' | 'middle' | 'bottom'], cols = { left: [0, 1 / 3], center: [1 / 3, 2 / 3], right: [2 / 3, 1] }[hz as 'left' | 'center' | 'right'];
  for (let y = Math.floor(rows[0] * h); y < Math.ceil(rows[1] * h); y++) for (let x = Math.floor(cols[0] * w); x < Math.ceil(cols[1] * w); x++) out[y * w + x] = 1;
  return out;
}

type SourceRun = { canvas?: { width: number; height: number }; outputLayers?: LayerInfo[]; planner?: { capture?: { roles?: Record<string, string> }; semantic_analysis?: { elements: { id: string; approximate_region: string }[] } } };
/**
 * Each template field's exact region in its source creative: the source run's layers whose planner element had that
 * field's role (and zone). Undefined when the run, its capture or its layers are missing.
 */
export async function sourceSlotMasks(runDir: string, version: Pick<TemplateVersion, 'structure'>, w: number, h: number): Promise<Map<string, Uint8Array> | undefined> {
  if (!existsSync(join(runDir, 'run.json'))) return undefined;
  const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as SourceRun, roles = run.planner?.capture?.roles, elements = run.planner?.semantic_analysis?.elements;
  if (!roles || !elements || !run.outputLayers?.length || !run.canvas) return undefined;
  const grid = { width: w, height: h, scale: w / run.canvas.width }, masks = new Map<string, Uint8Array>();
  for (const slot of describeTemplateSlots(version)) {
    const ids = elements.filter(e => roles[e.id] === slot.role && (!slot.zone || zoneOf(e.approximate_region) === slot.zone)).map(e => e.id);
    const layers = run.outputLayers.filter(l => l.semantic?.id && ids.includes(l.semantic.id) && l.placement.kind !== 'base' && existsSync(join(runDir, l.file)));
    if (!layers.length) continue;
    const mask = new Uint8Array(w * h);
    for (const layer of layers) { const shape = await layerShape(readFileSync(join(runDir, layer.file)), layer, grid); for (let i = 0; i < mask.length; i++) if (shape.alpha[i]) mask[i] = 1; }
    masks.set(slot.id, mask);
  }
  return masks;
}

/** Review a generated image against the image that was edited, for these requested changes. */
export async function reviewGeneration(input: { source: Buffer; generated: Buffer; version: Pick<TemplateVersion, 'structure'>; changes: EditChange[]; sourceRunDir?: string }): Promise<GenerationReview> {
  const meta = await sharp(input.source).metadata(), scale = SIDE / Math.max(meta.width ?? SIDE, meta.height ?? SIDE);
  const w = Math.max(16, Math.round((meta.width ?? SIDE) * scale)), h = Math.max(16, Math.round((meta.height ?? SIDE) * scale)), n = w * h;
  const [src, gen] = await Promise.all([rgbOf(input.source, w, h), rgbOf(input.generated, w, h)]);
  // Kept edges are looked for within SHIFT pixels (about 1.5% of the image): the model redraws, it rarely aligns to the pixel.
  const gs = edges(src, w, h), gg = spread(edges(gen, w, h), w, h, SHIFT);
  const exact = input.sourceRunDir ? await sourceSlotMasks(input.sourceRunDir, input.version, w, h) : undefined;
  const slots = describeTemplateSlots(input.version), checks: GenerationReviewCheck[] = [];
  const used = { exact: false, zones: false };
  const regionOf = (slotId: string) => {
    const exactMask = exact?.get(slotId);
    if (exactMask) { used.exact = true; return exactMask; }
    const zone = slots.find(s => s.id === slotId)?.zone;
    if (zone && zone !== 'full-canvas') { used.zones = true; return zoneMask(zone, w, h); }
    return undefined;
  };
  // 1. Objects asked to be replaced or removed: their original outline should be gone from where they stood.
  const changed = new Uint8Array(n);
  for (const change of input.changes.filter(c => c.operation === 'replace' || c.operation === 'remove')) {
    const region = regionOf(change.slotId);
    if (!region) { checks.push({ id: 'region-unknown', slotId: change.slotId, label: change.label, severity: 'info', message: `${change.label}: its region is unknown here, so whether it changed was not checked.`, evidence: {} }); continue; }
    let strong = 0, kept = 0, same = 0, area = 0;
    for (let i = 0; i < n; i++) {
      if (!region[i]) continue;
      changed[i] = 1; area++;
      if (maxDiff(src, gen, i) <= 24) same++;
      if (gs[i] >= 24) { strong++; if (gg[i] >= 0.5 * gs[i]) kept++; }
    }
    const outlineKept = Math.round(100 * kept / Math.max(1, strong)), pixelsKept = Math.round(100 * same / Math.max(1, area)), evidence = { outlineKeptPercent: outlineKept, pixelsKeptPercent: pixelsKept };
    if (strong < MIN_EDGES || outlineKept < KEPT_OUTLINE_PERCENT) continue;
    // A zone is a third of the canvas, full of design edges the change never touches: there it is a hint, not evidence.
    if (!exact?.has(change.slotId)) checks.push({ id: 'object-unchanged', slotId: change.slotId, label: change.label, severity: 'info', evidence,
      message: `${change.label}: only its approximate area is known here; ${outlineKept}% of the edges there are unchanged. Check by eye that it changed.` });
    else checks.push({ id: 'object-unchanged', slotId: change.slotId, label: change.label, severity: 'warning', evidence,
      message: change.operation === 'remove' ? `${change.label} may still be there: ${outlineKept}% of its original outline is still in place.` : `${change.label} may not have been replaced: ${outlineKept}% of the original object's outline is still in place.` });
  }
  // 2. Areas nobody asked to change, when no change restyles the whole scene.
  const sceneRestyled = input.changes.some(c => c.operation === 'restyle' && ['background', 'backdrop'].includes(c.role));
  if (!sceneRestyled && input.changes.length) {
    for (const change of input.changes) { const region = regionOf(change.slotId); if (region) for (let i = 0; i < n; i++) if (region[i]) changed[i] = 1; }
    let outside = 0, moved = 0;
    for (let i = 0; i < n; i++) if (!changed[i]) { outside++; if (maxDiff(src, gen, i) > 48) moved++; }
    const percent = Math.round(100 * moved / Math.max(1, outside));
    if (outside >= n * 0.1 && percent >= 35) checks.push({ id: 'unrequested-change', severity: used.exact ? 'warning' : 'info', evidence: { changedOutsidePercent: percent }, message: `Areas you did not ask to change look different (${percent}% of them).` });
  }
  // 3. Nothing changed at all although something was asked.
  if (input.changes.length) {
    let sum = 0; for (let i = 0; i < n; i++) sum += maxDiff(src, gen, i);
    const mean = sum / n;
    if (mean < 4) checks.push({ id: 'image-unchanged', severity: 'warning', evidence: { meanDifference: Math.round(mean * 10) / 10 }, message: 'The generated image looks almost identical to the original.' });
  }
  const method: GenerationReview['method'] = used.exact ? 'source-layer-masks' : used.zones ? 'template-zones' : 'whole-image';
  return { method, checks, requiresAcknowledgement: checks.some(c => c.severity === 'warning'), note: NOTE };
}
