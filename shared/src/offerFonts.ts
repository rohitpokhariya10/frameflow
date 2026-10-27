/**
 * The fonts of offer templates (Text & Graphics masters and the creatives made from them): real font files that ship with
 * FrameFlow. The server measures with them (matching a scanned word to the closest family, placing it on its baseline) and
 * the browser draws with the very same files (preview, editor, export), so a word looks the same everywhere and nothing
 * depends on a font service being reachable.
 *
 * A family is offered only with the weights and styles it has files for: nothing is synthesised (faux bold or a slanted
 * upright) and nothing silently falls back to another family. All are SIL Open Font License 1.1.
 *
 *   studio      server/assets/template-studio/fonts/<file> (Template Studio's bundled .ttf files)
 *   fontsource  node_modules/@fontsource/<file> (the editor's own Inter and Lora; .woff2 in the browser, .woff on the server)
 */
import { catalogFont } from './fonts/catalog.js';

export type OfferWeight = 400 | 600 | 700;
export interface OfferFontFace { weight: OfferWeight; style: 'normal' | 'italic'; root: 'studio' | 'fontsource'; file: string }
export interface OfferFont { family: string; category: 'sans' | 'serif' | 'display' | 'condensed'; note: string; faces: OfferFontFace[] }

const studio = (folder: string, files: Partial<Record<OfferWeight, string>>): OfferFontFace[] =>
  (Object.entries(files) as [string, string][]).map(([w, f]) => ({ weight: Number(w) as OfferWeight, style: 'normal', root: 'studio', file: `${folder}/${f}` }));
const fontsource = (pkg: string, weights: OfferWeight[], italic: boolean): OfferFontFace[] => weights.flatMap(w => [
  { weight: w, style: 'normal' as const, root: 'fontsource' as const, file: `${pkg}/files/${pkg}-latin-${w}-normal` },
  ...(italic ? [{ weight: w, style: 'italic' as const, root: 'fontsource' as const, file: `${pkg}/files/${pkg}-latin-${w}-italic` }] : []),
]);

export const OFFER_FONTS: readonly OfferFont[] = [
  { family: 'Inter', category: 'sans', note: 'Neutral, very legible text face.', faces: fontsource('inter', [400, 600, 700], false) },
  { family: 'Poppins', category: 'sans', note: 'Geometric, friendly; headlines and body.', faces: studio('poppins', { 400: 'Poppins-Regular.ttf', 600: 'Poppins-SemiBold.ttf', 700: 'Poppins-Bold.ttf' }) },
  { family: 'Outfit', category: 'sans', note: 'Round geometric sans with a fintech feel.', faces: studio('outfit', { 400: 'Outfit-400.ttf', 600: 'Outfit-600.ttf', 700: 'Outfit-700.ttf' }) },
  { family: 'Manrope', category: 'sans', note: 'Modern grotesque, compact and clear.', faces: studio('manrope', { 400: 'Manrope-400.ttf', 600: 'Manrope-600.ttf', 700: 'Manrope-700.ttf' }) },
  { family: 'Plus Jakarta Sans', category: 'sans', note: 'Contemporary sans, slightly wide.', faces: studio('plusjakartasans', { 400: 'PlusJakartaSans-400.ttf', 600: 'PlusJakartaSans-600.ttf', 700: 'PlusJakartaSans-700.ttf' }) },
  { family: 'Sora', category: 'sans', note: 'Wide geometric sans for confident offers.', faces: studio('sora', { 400: 'Sora-400.ttf', 600: 'Sora-600.ttf', 700: 'Sora-700.ttf' }) },
  { family: 'Urbanist', category: 'sans', note: 'Clean geometric sans, a little narrow.', faces: studio('urbanist', { 400: 'Urbanist-400.ttf', 600: 'Urbanist-600.ttf', 700: 'Urbanist-700.ttf' }) },
  { family: 'Lexend', category: 'sans', note: 'Open, highly readable sans.', faces: studio('lexend', { 400: 'Lexend-400.ttf', 600: 'Lexend-600.ttf', 700: 'Lexend-700.ttf' }) },
  { family: 'Rubik', category: 'sans', note: 'Slightly rounded sans; its 600 is the file\'s medium (500).', faces: studio('rubik', { 400: 'Rubik-400.ttf', 600: 'Rubik-500.ttf', 700: 'Rubik-700.ttf' }) },
  { family: 'Bricolage Grotesque', category: 'display', note: 'Characterful grotesque for headlines (semibold and bold only).', faces: studio('bricolagegrotesque', { 600: 'BricolageGrotesque-600.ttf', 700: 'BricolageGrotesque-700.ttf' }) },
  { family: 'Archivo Black', category: 'display', note: 'Heavy, wide headline face (one weight).', faces: studio('archivoblack', { 400: 'ArchivoBlack-Regular.ttf' }) },
  { family: 'Anton', category: 'condensed', note: 'Tall condensed headline face (one weight).', faces: studio('anton', { 400: 'Anton-Regular.ttf' }) },
  { family: 'Bebas Neue', category: 'condensed', note: 'Condensed capitals (one weight).', faces: studio('bebasneue', { 400: 'BebasNeue-Regular.ttf' }) },
  { family: 'Lora', category: 'serif', note: 'Text serif with true italics.', faces: fontsource('lora', [400, 600, 700], true) },
  { family: 'DM Serif Display', category: 'serif', note: 'High-contrast display serif (one weight).', faces: studio('dmserifdisplay', { 400: 'DMSerifDisplay-Regular.ttf' }) },
  { family: 'Abril Fatface', category: 'display', note: 'Fat-face display serif (one weight).', faces: studio('abrilfatface', { 400: 'AbrilFatface-Regular.ttf' }) },
];
export const OFFER_FONT_FAMILIES = OFFER_FONTS.map(f => f.family);
export const offerFont = (family: string) => OFFER_FONTS.find(f => f.family === family);
export const isOfferFont = (family: unknown): family is string => typeof family === 'string' && !!offerFont(family);
/** The weights a family has files for, in order. */
export const offerWeights = (family: string): OfferWeight[] => [...new Set(offerFont(family)?.faces.filter(f => f.style === 'normal').map(f => f.weight) ?? [])].sort((a, b) => a - b);
export const offerHasItalic = (family: string, weight?: OfferWeight) => !!offerFont(family)?.faces.some(f => f.style === 'italic' && (weight === undefined || f.weight === weight));
/** The face drawn for a family, weight and style: the nearest weight it has; italic only where an italic file exists. */
export function offerFace(family: string, weight: number, style: 'normal' | 'italic' = 'normal'): OfferFontFace | undefined {
  const font = offerFont(family);
  if (!font) return undefined;
  const pool = font.faces.filter(f => f.style === style).length ? font.faces.filter(f => f.style === style) : font.faces.filter(f => f.style === 'normal');
  return [...pool].sort((a, b) => Math.abs(a.weight - weight) - Math.abs(b.weight - weight) || b.weight - a.weight)[0];
}
/** A style that the files can draw: the nearest available weight, italic dropped where the family has none. */
export function drawableOfferStyle(family: string, weight: number, italic: boolean): { weight: OfferWeight; italic: boolean } {
  const face = offerFace(family, weight, italic ? 'italic' : 'normal');
  return { weight: face?.weight ?? 400, italic: face?.style === 'italic' };
}
/** Every offer family is also in the editor's catalogue (so its documents validate); checked by the tests. */
export const offerFontsInCatalogue = () => OFFER_FONTS.every(f => !!catalogFont(f.family));
