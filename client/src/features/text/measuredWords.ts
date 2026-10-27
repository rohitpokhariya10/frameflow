import type { TextChanges, TextElement } from '@frameflow/shared';
import type { MeasuredWords } from '../../store/editorSlice';
import { canvasFont, measureAdvance } from '../masterTemplates/creativeText';

type WordStyle = Pick<TextElement, 'fontFamily' | 'fontSize' | 'fontWeight' | 'fontStyle' | 'letterSpacing'>;
const styleOf = (s: WordStyle) => ({ fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight, fontStyle: s.fontStyle ?? 'normal' as const, letterSpacing: s.letterSpacing, color: '#000000', opacity: 1 });
const loaded = (s: WordStyle) => typeof document === 'undefined' || !document.fonts || document.fonts.check(canvasFont(styleOf(s), s.fontSize));

/**
 * How wide product-template words are drawn before and after a change, measured as the canvas draws them (the store
 * moves the words after each by the difference). Undefined when a font is not loaded yet: the store then estimates.
 */
export function measuredWords(edits: { element: TextElement; changes: TextChanges }[]): MeasuredWords | undefined {
  const out: MeasuredWords = {};
  for (const { element, changes } of edits) {
    if (!element.protectedSlot?.word) continue;
    const after = { ...element, ...changes };
    if (!loaded(element) || !loaded(after)) return undefined;
    out[element.id] = { before: measureAdvance(element.text, styleOf(element)), after: measureAdvance(after.text, styleOf(after)) };
  }
  return Object.keys(out).length ? out : undefined;
}
