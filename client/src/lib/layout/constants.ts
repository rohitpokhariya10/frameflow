import { clamp, type CanvasSize } from '@frameflow/shared';

export interface LayoutRegion { x: number; y: number; width: number; height: number }
export const FIT_TOLERANCE = 1;
export const FONT_SEARCH_STEPS = 16;
// Avoid single-character columns when a box needs repair; never change an already-fitting box.
export const PREFERRED_WIDTH_FRACTION = 0.35;
export function safeRegion(canvas: CanvasSize): LayoutRegion {
  const margin = clamp(Math.round(Math.min(canvas.width, canvas.height) * 0.04), 12, 96);
  return { x: margin, y: margin, width: canvas.width - margin * 2, height: canvas.height - margin * 2 };
}
export function fontFloor(canvas: CanvasSize, original: number) {
  return Math.min(original, clamp(Math.round(Math.min(canvas.width, canvas.height) * 18 / 1080), 10, 32));
}
