import { clamp, type CanvasSize, type TextElement } from '@frameflow/shared';
import { FIT_TOLERANCE, FONT_SEARCH_STEPS, PREFERRED_WIDTH_FRACTION, fontFloor, safeRegion, type LayoutRegion } from './constants';

export interface TextMeasurement { width: number; height: number; lines: number; complete: boolean }
export type MeasureText = (element: TextElement) => TextMeasurement;
export type LayoutChange = 'wrapped' | 'widened' | 'moved' | 'font-reduced';
export type LayoutResult =
  | { status: 'unchanged'; element: TextElement }
  | { status: 'fitted'; element: TextElement; changes: LayoutChange[] }
  | { status: 'unresolved'; element: TextElement; reason: string };

const positive = (value: number) => Number.isFinite(value) && value > 0;
const validRegion = (region: LayoutRegion) => Number.isFinite(region.x) && Number.isFinite(region.y) && positive(region.width) && positive(region.height);
const validMeasurement = (bounds: TextMeasurement) => bounds.complete && positive(bounds.width) && positive(bounds.height) && positive(bounds.lines);
export function boundsFit(element: TextElement, bounds: TextMeasurement, target: LayoutRegion) {
  return validRegion(target) && validMeasurement(bounds)
    && element.x >= target.x - FIT_TOLERANCE && element.y >= target.y - FIT_TOLERANCE
    && element.x + bounds.width <= target.x + target.width + FIT_TOLERANCE
    && element.y + bounds.height <= target.y + target.height + FIT_TOLERANCE;
}

/** Derived from natural rendered height as well as width; never persisted. */
export function textOverflows(element: TextElement, target: LayoutRegion, measure: MeasureText) {
  if (element.text === '') return false;
  try { return !boundsFit(element, measure(element), target); } catch { return true; }
}

/** Pure fitting policy: all runtime font/canvas work is supplied by the adapter. */
export function autoLayout(element: TextElement, canvas: CanvasSize, measure: MeasureText, target = safeRegion(canvas)): LayoutResult {
  const unresolved = (reason: string): LayoutResult => ({ status: 'unresolved', element, reason });
  if (!positive(canvas.width) || !positive(canvas.height) || !validRegion(target)
    || !Number.isFinite(element.x) || !Number.isFinite(element.y) || !positive(element.width)
    || !positive(element.fontSize) || !positive(element.lineHeight) || !Number.isFinite(element.letterSpacing)) {
    return unresolved('This text has invalid dimensions. Check its size and position.');
  }
  if (element.text === '') return { status: 'unchanged', element };
  try {
    const originalBounds = measure(element);
    if (boundsFit(element, originalBounds, target)) return { status: 'unchanged', element };
    function candidate(width: number, fontSize: number): TextElement | null {
      const next = { ...element, width, fontSize };
      const bounds = measure(next);
      if (!validMeasurement(bounds) || bounds.width > target.width + FIT_TOLERANCE || bounds.height > target.height + FIT_TOLERANCE) return null;
      next.x = clamp(element.x, target.x, target.x + Math.max(0, target.width - bounds.width));
      next.y = clamp(element.y, target.y, target.y + Math.max(0, target.height - bounds.height));
      return boundsFit(next, bounds, target) ? next : null;
    }
    const preferred = clamp(element.width, target.width * PREFERRED_WIDTH_FRACTION, target.width);
    let fitted: TextElement | null = null;
    for (const width of new Set([preferred, target.width])) {
      fitted = candidate(width, element.fontSize);
      if (fitted) break;
    }
    if (!fitted) {
      let low = fontFloor(canvas, element.fontSize);
      let high = element.fontSize;
      fitted = candidate(target.width, low);
      if (!fitted) return unresolved('This text cannot fit at a readable size. Try a larger canvas or shorter copy.');
      for (let step = 0; step < FONT_SEARCH_STEPS; step++) {
        const mid = (low + high) / 2;
        const attempt = candidate(target.width, mid);
        if (attempt) { low = mid; fitted = attempt; } else { high = mid; }
      }
    }
    // Verify once more using exactly the values that will be committed.
    const finalBounds = measure(fitted);
    if (!boundsFit(fitted, finalBounds, target)) return unresolved('The measured text could not be fitted reliably. Try again or use a larger canvas.');
    const changes: LayoutChange[] = [];
    if (finalBounds.lines > originalBounds.lines && finalBounds.lines > element.text.split('\n').length) changes.push('wrapped');
    if (fitted.width > element.width) changes.push('widened');
    if (fitted.x !== element.x || fitted.y !== element.y) changes.push('moved');
    if (fitted.fontSize < element.fontSize) changes.push('font-reduced');
    return { status: 'fitted', element: fitted, changes };
  } catch {
    return unresolved('Text measurement is unavailable. Please try again.');
  }
}
