import { GOOGLE_FONT_ROWS } from './googleFontsCatalog.js';
export interface CatalogFont { family: string; category: string; weights: readonly number[]; devanagari: boolean; italic: boolean }
export const FONT_CATALOG: readonly CatalogFont[] = GOOGLE_FONT_ROWS.map(([family, category, weights, devanagari, italic]) => ({ family, category, weights, devanagari, italic }));
const fonts = new Map(FONT_CATALOG.map(font => [font.family, font]));
export const catalogFont = (family: string) => fonts.get(family);
export const isCatalogFont = (value: unknown): value is string => typeof value === 'string' && fonts.has(value);
export function searchFonts(query: string): readonly CatalogFont[] {
  const q = query.trim().toLocaleLowerCase();
  return q ? FONT_CATALOG.filter(font => font.family.toLocaleLowerCase().includes(q)) : FONT_CATALOG;
}
export const fontFallback = (family: string) => catalogFont(family)?.category === 'Serif' ? 'Lora, Georgia, serif' : 'Inter, Arial, sans-serif';
export const fontStack = (family: string) => isCatalogFont(family) ? `"${family}", "Noto Sans Devanagari", ${fontFallback(family)}` : 'Inter, "Noto Sans Devanagari", Arial, sans-serif';
export function fontWeightFor(family: string, requested: number): number {
  const weights = catalogFont(family)?.weights ?? [400];
  return weights.reduce((best, weight) => Math.abs(weight - requested) < Math.abs(best - requested) ? weight : best, weights[0]);
}
