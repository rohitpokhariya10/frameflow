/**
 * The region editor's geometry, in SOURCE PIXELS only (shared/src/protectedContent.ts). The view (zoom and pan) is an SVG
 * viewBox in the same units, and a pointer is mapped through the SVG's own screen transform, so CSS scaling, browser zoom
 * and device-pixel ratio never enter a stored coordinate.
 */
import { boundingBox, PROTECTED_LIMITS, type SourceBox, type SourceSize } from '@frameflow/shared';

export type Point = { x: number; y: number };
export type View = { x: number; y: number; width: number; height: number };
export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const rad = (deg: number) => deg * Math.PI / 180;
const centre = (b: SourceBox) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
/** A point in the box's own (unrotated) frame, relative to its centre. */
export function toLocal(b: SourceBox, p: Point): Point {
  const c = centre(b), a = -rad(b.rotation), dx = p.x - c.x, dy = p.y - c.y;
  return { x: dx * Math.cos(a) - dy * Math.sin(a), y: dx * Math.sin(a) + dy * Math.cos(a) };
}
/** Where a handle is, in source pixels (rotated with its box). */
export function handlePoint(b: SourceBox, h: Handle | 'rotate', rotateOffset = 0): Point {
  // 'rotate' sits above the top edge's centre (its letters are no compass direction).
  const lx = h === 'rotate' ? 0 : h.includes('w') ? -b.width / 2 : h.includes('e') ? b.width / 2 : 0;
  const ly = h === 'rotate' ? -b.height / 2 - rotateOffset : h.includes('n') ? -b.height / 2 : h.includes('s') ? b.height / 2 : 0;
  const c = centre(b), a = rad(b.rotation);
  return { x: c.x + lx * Math.cos(a) - ly * Math.sin(a), y: c.y + lx * Math.sin(a) + ly * Math.cos(a) };
}
/** The box with one edge (or corner) dragged to the pointer; the opposite edge stays where it was, rotation unchanged. */
export function resizeBox(start: SourceBox, handle: Handle, pointer: Point, min = PROTECTED_LIMITS.minRegionPx): SourceBox {
  const p = toLocal(start, pointer);
  let left = -start.width / 2, right = start.width / 2, top = -start.height / 2, bottom = start.height / 2;
  if (handle.includes('w')) left = Math.min(p.x, right - min);
  if (handle.includes('e')) right = Math.max(p.x, left + min);
  if (handle.includes('n')) top = Math.min(p.y, bottom - min);
  if (handle.includes('s')) bottom = Math.max(p.y, top + min);
  const lc = { x: (left + right) / 2, y: (top + bottom) / 2 }, c = centre(start), a = rad(start.rotation);
  const wc = { x: c.x + lc.x * Math.cos(a) - lc.y * Math.sin(a), y: c.y + lc.x * Math.sin(a) + lc.y * Math.cos(a) };
  const width = right - left, height = bottom - top;
  return { x: wc.x - width / 2, y: wc.y - height / 2, width, height, rotation: start.rotation };
}
/** The rotation that points the box's top at the pointer (the rotate handle sits above it); 15° steps when `snap`. */
export function rotateTowards(start: SourceBox, pointer: Point, snap = false): SourceBox {
  const c = centre(start);
  let deg = Math.atan2(pointer.y - c.y, pointer.x - c.x) * 180 / Math.PI + 90;
  if (snap) deg = Math.round(deg / 15) * 15;
  deg = ((deg + 540) % 360) - 180;
  return { ...start, rotation: Math.abs(deg) < 1e-9 ? 0 : Math.round(deg * 100) / 100 };
}
/** The box spanned by two corners, at least the minimum size. */
export function drawnBox(a: Point, b: Point): SourceBox {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y), rotation: 0 };
}
/** Whole source pixels, for positions and sizes (rotation kept). */
export const roundBox = (b: SourceBox): SourceBox => ({ x: Math.round(b.x), y: Math.round(b.y), width: Math.max(1, Math.round(b.width)), height: Math.max(1, Math.round(b.height)), rotation: b.rotation });
/**
 * Snaps a moved or resized box: its edges and centre lines to the canvas edges and centre and to other boxes' edges, each
 * within `threshold` source pixels, then to whole pixels. A rotated box snaps by its bounding box.
 */
export function snapBox(b: SourceBox, size: SourceSize, others: SourceBox[], threshold: number, edges: { x: ('start' | 'centre' | 'end')[]; y: ('start' | 'centre' | 'end')[] } = { x: ['start', 'centre', 'end'], y: ['start', 'centre', 'end'] }): SourceBox {
  const bb = boundingBox(b), xs = [0, size.width / 2, size.width], ys = [0, size.height / 2, size.height];
  for (const o of others) { const ob = boundingBox(o); xs.push(ob.x, ob.x + ob.width); ys.push(ob.y, ob.y + ob.height); }
  const best = (values: number[], targets: number[]) => {
    let shift = 0, distance = threshold + 1;
    for (const v of values) for (const t of targets) if (Math.abs(t - v) < distance) { distance = Math.abs(t - v); shift = t - v; }
    return distance <= threshold ? shift : 0;
  };
  const pick = (start: number, length: number, which: ('start' | 'centre' | 'end')[]) => which.map(w => w === 'start' ? start : w === 'centre' ? start + length / 2 : start + length);
  const dx = best(pick(bb.x, bb.width, edges.x), xs), dy = best(pick(bb.y, bb.height, edges.y), ys);
  return roundBox({ ...b, x: b.x + dx, y: b.y + dy });
}
/** Arrow keys: one source pixel, ten with Shift. */
export function nudge(b: SourceBox, key: string, large: boolean): SourceBox | undefined {
  const step = large ? 10 : 1, d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[key];
  return d ? { ...b, x: b.x + d[0], y: b.y + d[1] } : undefined;
}

/** The whole image in a viewport of this aspect (width / height), centred. */
export function fitView(size: SourceSize, viewportAspect: number): View {
  const aspect = size.width / size.height;
  return aspect > viewportAspect ? { x: 0, y: -(size.width / viewportAspect - size.height) / 2, width: size.width, height: size.width / viewportAspect }
    : { x: -(size.height * viewportAspect - size.width) / 2, y: 0, width: size.height * viewportAspect, height: size.height };
}
/** Zoomed by `factor` (above 1 zooms in) about a source point that stays under the pointer; between 1/8× and 32× of the fit. */
export function zoomView(view: View, factor: number, anchor: Point, fit: View): View {
  const width = Math.min(fit.width * 8, Math.max(fit.width / 32, view.width / factor)), k = width / view.width;
  return { x: anchor.x - (anchor.x - view.x) * k, y: anchor.y - (anchor.y - view.y) * k, width, height: view.height * k };
}
export const panView = (view: View, dx: number, dy: number): View => ({ ...view, x: view.x - dx, y: view.y - dy });
/** How many source pixels one screen pixel covers at this view (for handle sizes and snap distances). */
export const sourcePerScreen = (view: View, screenWidth: number) => view.width / Math.max(1, screenWidth);
