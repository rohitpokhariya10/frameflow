/**
 * Text overflow inside a fixed box. Longer wording never moves or resizes anything: the box stays where the template
 * put it, and the text is made to fit inside it by this fixed policy.
 *
 *   1. wrap inside the box width, at the design font size;
 *   2. it fits when it needs no more lines than maxLines and the box height allow;
 *   3. otherwise, with overflow 'shrink': use the largest of 32 evenly spaced font sizes between the design size and
 *      the minimum size that fits;
 *   4. if nothing fits (or overflow is 'ellipsis'): keep the lines that fit and end them with an ellipsis. The cut is
 *      reported (`truncated`), so the UI can warn instead of hiding it.
 *
 * Counting wrapped lines needs real font metrics, so the caller passes `countLines` (Konva in the browser, a stand-in
 * in tests). Everything else is arithmetic, and the same inputs always give the same result.
 */
import type { ResolvedText } from './resolve.js';

export const TEXT_FIT_STEPS = 32;
/** How many lines the text wraps to at this font size (px), inside the box width. At least 1. */
export type CountLines = (fontPx: number) => number;
export interface TextFitInput { boxHeight: number; fontPx: number; minFontPx: number; lineHeight: number; maxLines: number; overflow: 'shrink' | 'ellipsis' }
export interface TextFit {
  /** The font size to draw at. */
  fontPx: number;
  /** Lines the whole text needs at that size, and how many of them are drawn. */
  lines: number; visibleLines: number;
  shrunk: boolean;
  /** The text does not fit even after the policy: it is cut with an ellipsis. */
  truncated: boolean;
}

/** Lines the box has room for at a font size: the box height and maxLines, whichever is fewer (may be 0). */
export const linesThatFit = (input: Pick<TextFitInput, 'boxHeight' | 'lineHeight' | 'maxLines'>, fontPx: number) =>
  Math.min(input.maxLines, Math.floor((input.boxHeight + 0.01) / (fontPx * input.lineHeight)));

export function fitText(input: TextFitInput, countLines: CountLines): TextFit {
  const needs = (fontPx: number) => Math.max(1, Math.round(countLines(fontPx)));
  const result = (fontPx: number, lines: number): TextFit => {
    const room = linesThatFit(input, fontPx), truncated = lines > room;
    // A box too low for even one line still shows one line: cutting the text to nothing would hide that it overflows.
    return { fontPx, lines, visibleLines: truncated ? Math.max(1, room) : lines, shrunk: fontPx < input.fontPx, truncated };
  };
  const fits = (fontPx: number) => needs(fontPx) <= linesThatFit(input, fontPx);
  if (fits(input.fontPx)) return result(input.fontPx, needs(input.fontPx));
  const minFontPx = Math.min(input.minFontPx, input.fontPx);
  if (input.overflow !== 'shrink' || minFontPx >= input.fontPx) return result(input.fontPx, needs(input.fontPx));
  const size = (step: number) => input.fontPx - (input.fontPx - minFontPx) * step / TEXT_FIT_STEPS;
  if (!fits(minFontPx)) return result(minFontPx, needs(minFontPx));
  // Smaller text never needs more room, so the first step that fits is found by bisection: the largest size that fits.
  let low = 0, high = TEXT_FIT_STEPS;
  while (high - low > 1) { const middle = (low + high) >> 1; if (fits(size(middle))) high = middle; else low = middle; }
  return result(size(high), needs(size(high)));
}

export const textFitInput = (element: ResolvedText): TextFitInput =>
  ({ boxHeight: element.box.height, fontPx: element.fontPx, minFontPx: element.minFontPx, lineHeight: element.lineHeight, maxLines: element.maxLines, overflow: element.overflow });
/** The warning for a text that was cut, or undefined when the whole text is shown. */
export const textFitWarning = (element: Pick<ResolvedText, 'name' | 'themeRole'>, fit: TextFit) => fit.truncated
  ? ["headline", "offer-value", "cta", "offer-prefix", "offer-suffix", "date", "location"].includes(element.themeRole ?? "") ? `"${element.name}" needs shorter text or a larger box. Correct it before saving this layout or opening it in the editor.` : `"${element.name}" does not fit its box${fit.shrunk ? ' even at the smallest font size' : ''}: ${fit.visibleLines} of ${fit.lines} lines are shown, ending with an ellipsis. Shorten the text; the layout is not changed.`
  : undefined;
/** Where the drawn lines sit inside the box: the block's height, and its top relative to the box's top by vertical alignment. */
export function textBlock(element: Pick<ResolvedText, 'box' | 'lineHeight' | 'verticalAlign'>, fit: Pick<TextFit, 'fontPx' | 'visibleLines'>): { y: number; height: number } {
  const height = fit.visibleLines * fit.fontPx * element.lineHeight, free = element.box.height - height;
  return { y: element.verticalAlign === 'top' ? 0 : element.verticalAlign === 'middle' ? free / 2 : free, height };
}
