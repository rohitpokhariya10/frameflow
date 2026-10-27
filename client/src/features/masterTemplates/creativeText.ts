/**
 * Measuring and placing a creative's text exactly as Konva draws it (the preview, the editor and the export all draw with
 * Konva). Konva puts a line's baseline (lineHeight·size)/2 + (ascent − descent)/2 below the text's top, with the ascent
 * and descent of "M" in the drawn font (konva/lib/shapes/Text.js); the same canvas measurement here gives each word's top
 * from its saved baseline. Measure only after the fonts loaded (loadCreativeFonts).
 */
import { fontStack, type CreativeInstance, type CreativeTextStyle, type MeasureText } from '@frameflow/shared';
import { loadRequiredFonts } from '../fonts/fontLoader';

let context: CanvasRenderingContext2D | null | undefined;
const ctx = () => (context ??= document.createElement('canvas').getContext('2d'));
/** The family string the editor gives Konva for a font (textGeometry.ts textNodeStyle). */
export const konvaFamily = (family: string) => (family === 'Inter' || family === 'Lora' ? family : fontStack(family));
/** Konva's own font string: style, variant, size, family (Text#_getContextFont). */
export const canvasFont = (style: Pick<CreativeTextStyle, 'fontFamily' | 'fontWeight' | 'fontStyle'>, px: number) => {
  const family = konvaFamily(style.fontFamily).split(',').map(f => f.trim()).map(f => (/^["'].*["']$/.test(f) || !/\s/.test(f) ? f : `"${f}"`)).join(', ');
  return `${style.fontStyle === 'italic' ? 'italic' : 'normal'} ${style.fontWeight} ${px}px ${family}`;
};
/**
 * The drawn advance of a text in a style (source pixels when the style is): Konva measures a line whole when there is no
 * letter spacing (kerning kept), and character by character, each followed by the spacing, when there is.
 */
export const measureAdvance: MeasureText = (text, style) => {
  const c = ctx();
  if (!c) return text.length * style.fontSize * 0.55;
  c.font = canvasFont(style, style.fontSize);
  if (!style.letterSpacing) return c.measureText(text).width;
  let width = 0;
  for (const ch of text) width += c.measureText(ch).width + style.letterSpacing;
  return width;
};
/** From a Konva text's top to its first baseline, at a font size and line height (the drawn font's own metrics). */
export function baselineOffset(style: Pick<CreativeTextStyle, 'fontFamily' | 'fontWeight' | 'fontStyle'>, fontSize: number, lineHeight = 1): number {
  const c = ctx();
  if (!c) return fontSize * (lineHeight / 2 + 0.3635);
  c.font = canvasFont(style, fontSize);
  const m = c.measureText('M'), ascent = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent, descent = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent;
  return (ascent - descent) / 2 + (lineHeight * fontSize) / 2;
}
/** Every font face a creative draws with, loaded (true when all loaded from their files). */
export const loadCreativeFonts = (c: Pick<CreativeInstance, 'texts'>) => loadRequiredFonts(c.texts.map(t => ({ family: t.style.fontFamily, weight: t.style.fontWeight, italic: t.style.fontStyle === 'italic', text: t.text })));
