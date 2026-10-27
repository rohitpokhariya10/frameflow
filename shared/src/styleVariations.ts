/**
 * Style variations of a protected template: new artwork for the same creative, with the template's own words and logos
 * placed on it by FrameFlow, never drawn by the image model.
 *
 *   analyse      the words and logo slots of the template (protectedWords.ts, local recognizer, reviewed by an admin)
 *   reference    the approved text-free base: the only picture the image model sees, with a wordless guide of the
 *                areas text and logos occupy (no letters in either, so none can leak into the artwork)
 *   generate     one image request per variation, after an explicit, priced confirmation; or a local restyle / reuse
 *   align        the artwork is fitted to the template canvas; every word and logo keeps its slot
 *   reconstruct  variant layout: words as native text, logos as image slots, in VARIANT coordinates of their own
 *
 * TWO COORDINATE SYSTEMS: the template's ORIGINAL boxes (protectedWords.ts) are never written by a variation; each
 * variation holds VARIANT boxes (VariantLayout) in the same source-pixel canvas, which typography changes reflow and an
 * editor may move. Typography and logo changes never need new artwork, so they never start a paid call.
 *
 * Nothing here calls a provider.
 */
import { catalogFont, fontWeightFor, isCatalogFont } from './fonts/catalog.js';
import { boundingBox, type SourceBox, type SourceSize } from './protectedContent.js';
import { PROTECTED_ROLES, type DetectedWord, type TextAnalysis, type WordGroup, type WordStyle } from './protectedWords.js';
import type { StudioFx, StudioImageQuality, StudioMoney } from './templateStudio.js';

export const STYLE_VARIATION_SCHEMA = 1;
export const VARIATION_LIMITS = { maxCount: 8, defaultCount: 4, maxCustomInstructions: 600, maxPresetName: 60, safeInsetShare: 0.03 } as const;

/** Where a variation's artwork came from. Shown on every variation and kept on the editor document. */
export type VariationProvenance = 'ai_generated' | 'local_reuse' | 'local_restyle' | 'reconstructed';
export const PROVENANCE_LABELS: Record<VariationProvenance, string> = {
  ai_generated: 'AI-generated artwork',
  local_reuse: 'Locally reused reference artwork',
  local_restyle: 'Deterministically restyled artwork (no AI)',
  reconstructed: 'Reconstructed original',
};
export const PROVENANCE_DETAILS: Record<VariationProvenance, string> = {
  ai_generated: 'New pixels from the image model, made from the approved text-free base. The words and logos are the template’s own, placed by FrameFlow.',
  local_reuse: 'The approved text-free base, byte for byte. No AI call.',
  local_restyle: 'The approved text-free base with a fixed local colour treatment from the preset. No AI call; the same inputs always give the same pixels.',
  reconstructed: 'The template as decomposed: Seedream’s layers with the preserved text and logos.',
};
/** ai: one paid image request. restyle: a local colour treatment of the base. reuse: the base unchanged. */
export type VariationSource = 'ai' | 'restyle' | 'reuse';
export const SOURCE_PROVENANCE: Record<VariationSource, VariationProvenance> = { ai: 'ai_generated', restyle: 'local_restyle', reuse: 'local_reuse' };

export type TypographyMode = 'match' | 'suggested' | 'custom';
export const TYPOGRAPHY_MODE_LABELS: Record<TypographyMode, { label: string; detail: string }> = {
  match: { label: 'Match original', detail: 'The fonts, sizes, weights and colours measured on the template, in their original places.' },
  suggested: { label: 'Suggested for the style', detail: 'A type pairing for the chosen style, picked by rule from the licensed font catalogue (no AI call, so it is free and repeatable). Colours are kept unless they would be hard to read on the new artwork.' },
  custom: { label: 'Custom', detail: 'Fonts, weights and colours you choose from the licensed font catalogue.' },
};

export interface PresetTypography {
  /** Catalogue families: headline for the largest words, body for the rest, accent for words set in italic on the template. */
  headline: string; body: string; accent: string;
  headlineWeight: 400 | 600 | 700; bodyWeight: 400 | 600 | 700;
}
export interface StylePreset {
  id: string; name: string; summary: string;
  /** The art direction given to the image model. Never contains copy, brand names or text to draw. */
  direction: string;
  palette: string[]; mood: string;
  typography: PresetTypography;
  /** The local, deterministic treatment of the base for a restyle (no AI): sharp's modulate, then an optional tint. */
  restyle: { hue: number; saturation: number; brightness: number; tint?: string; tintStrength?: number };
  builtIn: boolean;
}
export const CUSTOM_PRESET_ID = 'custom';
export const DEFAULT_PRESET_IDS = ['original-festive', 'premium-minimal', 'modern-fintech', 'creative-promo'] as const;
/** The built-in library: the four defaults first, then further directions. A request may also bring its own (custom). */
export const STYLE_PRESETS: readonly StylePreset[] = [
  {
    id: 'original-festive', name: 'A · Original-inspired festive', summary: 'Close to the original: its motifs and layout, with richer festive colour and light.',
    direction: 'Stay close to the original artwork: keep its motifs, panels, borders and decorations in the same places and at the same scale. Push it toward a festive celebration: richer, saturated colour, warm glowing light, subtle sparkle and festive texture, a little more depth and polish.',
    palette: ['#0f5c55', '#f2b632', '#e8613c', '#bfeedd'], mood: 'Joyful, festive, familiar',
    typography: { headline: 'Poppins', body: 'Poppins', accent: 'Playfair Display', headlineWeight: 700, bodyWeight: 600 },
    restyle: { hue: 0, saturation: 1.3, brightness: 1.02 }, builtIn: true,
  },
  {
    id: 'premium-minimal', name: 'B · Premium minimal', summary: 'Calm and refined: generous space, restrained palette, one metallic accent.',
    direction: 'Premium minimal: calm, refined and uncluttered, with generous negative space. A restrained palette of deep neutrals and soft ivory with a single soft-gold metallic accent. Replace busy patterns with fine, elegant linework and subtle matte paper texture. Fewer, larger, simpler decorative shapes; soft, even studio light.',
    palette: ['#1f2a2e', '#f4efe6', '#c9a35b', '#8a8f8c'], mood: 'Elegant, quiet, trustworthy',
    typography: { headline: 'Cormorant Garamond', body: 'Manrope', accent: 'Cormorant Garamond', headlineWeight: 700, bodyWeight: 600 },
    restyle: { hue: 0, saturation: 0.35, brightness: 1.04, tint: '#efe6d2', tintStrength: 0.18 }, builtIn: true,
  },
  {
    id: 'modern-fintech', name: 'C · Modern fintech', summary: 'Clean geometry, confident blues and teals, soft gradients and glass panels.',
    direction: 'Modern fintech: clean geometric shapes and smooth gradients in confident blues and teals with one bright accent, soft frosted-glass panels, a subtle dot or grid pattern, crisp vector rendering and a sense of trust and speed. Keep large calm areas behind the reserved zones.',
    palette: ['#0b3d91', '#13b5c8', '#e6f4ff', '#ffb000'], mood: 'Confident, fast, digital',
    typography: { headline: 'Space Grotesk', body: 'Inter', accent: 'Space Grotesk', headlineWeight: 700, bodyWeight: 600 },
    restyle: { hue: 55, saturation: 1.1, brightness: 1 }, builtIn: true,
  },
  {
    id: 'creative-promo', name: 'D · Creative promotional', summary: 'Bold and playful: vivid colour, dynamic shapes, paper-cut energy.',
    direction: 'Creative promotional: bold, playful and energetic. Vivid contrasting colours, dynamic diagonal shapes, burst and confetti shapes, layered paper-cut or sticker-style illustration with high visual energy around the edges, while the reserved zones stay calm, simple and readable.',
    palette: ['#ff4f64', '#ffd23f', '#3a0ca3', '#06d6a0'], mood: 'Energetic, fun, attention-grabbing',
    typography: { headline: 'Bricolage Grotesque', body: 'Outfit', accent: 'DM Serif Display', headlineWeight: 700, bodyWeight: 600 },
    restyle: { hue: -35, saturation: 1.6, brightness: 1.02 }, builtIn: true,
  },
  {
    id: 'fresh-monsoon', name: 'Fresh monsoon', summary: 'Cool greens and blues, rain-washed light, leaves and soft water textures.',
    direction: 'Fresh monsoon: cool rain-washed greens and blues, soft diffused daylight, glossy leaves, gentle water ripples and droplets as decoration, airy and refreshing.',
    palette: ['#1b6b52', '#5fb3a1', '#d9f2ec', '#2b4c7e'], mood: 'Fresh, calm, hopeful',
    typography: { headline: 'Sora', body: 'Nunito', accent: 'Lora', headlineWeight: 700, bodyWeight: 600 },
    restyle: { hue: 20, saturation: 0.9, brightness: 1.03 }, builtIn: true,
  },
  {
    id: 'luxury-gold', name: 'Luxury gold', summary: 'Deep jewel tones with gold-foil detailing and dramatic light.',
    direction: 'Luxury: deep jewel-tone background (emerald or midnight), gold-foil linework and ornaments, dramatic soft spotlighting, rich velvet and metal materials, sparse and opulent.',
    palette: ['#0d2b26', '#d4af37', '#f5e6c4', '#3b1f47'], mood: 'Opulent, exclusive',
    typography: { headline: 'Cinzel', body: 'Libre Baskerville', accent: 'Libre Baskerville', headlineWeight: 700, bodyWeight: 400 },
    restyle: { hue: 0, saturation: 0.8, brightness: 0.9, tint: '#b8892b', tintStrength: 0.12 }, builtIn: true,
  },
  {
    id: 'soft-pastel', name: 'Soft pastel', summary: 'Gentle pastel illustration, rounded shapes and soft shadows.',
    direction: 'Soft pastel illustration: gentle pastel colours, rounded friendly shapes, soft shadows and a light grain, cheerful and approachable.',
    palette: ['#f7c8d0', '#c8e7f7', '#fff1c1', '#b9a8e6'], mood: 'Friendly, light',
    typography: { headline: 'Urbanist', body: 'Urbanist', accent: 'Lora', headlineWeight: 700, bodyWeight: 600 },
    restyle: { hue: 0, saturation: 0.6, brightness: 1.08, tint: '#ffe4ec', tintStrength: 0.15 }, builtIn: true,
  },
  {
    id: 'bold-contrast', name: 'Bold contrast', summary: 'High-contrast duotone with strong graphic blocks.',
    direction: 'Bold high-contrast duotone: two strong colours, large flat graphic blocks and halftone texture, poster-like and striking, with clean quiet areas behind the reserved zones.',
    palette: ['#111111', '#ffe600', '#ffffff', '#ff3d00'], mood: 'Striking, confident',
    typography: { headline: 'Archivo Black', body: 'Archivo', accent: 'Archivo', headlineWeight: 400, bodyWeight: 600 },
    restyle: { hue: 0, saturation: 1.8, brightness: 1 }, builtIn: true,
  },
];
export const presetById = (id: string) => STYLE_PRESETS.find(p => p.id === id);
/** A request's own direction: the administrator's words as the art direction, the original type and a neutral restyle. */
export function customPreset(name: string, direction: string): StylePreset {
  return { id: CUSTOM_PRESET_ID, name: name.trim().slice(0, VARIATION_LIMITS.maxPresetName) || 'Custom direction', summary: 'Your own art direction.', direction: direction.trim().slice(0, VARIATION_LIMITS.maxCustomInstructions),
    palette: [], mood: 'As described', typography: { headline: 'Inter', body: 'Inter', accent: 'Lora', headlineWeight: 700, bodyWeight: 600 }, restyle: { hue: 0, saturation: 1, brightness: 1 }, builtIn: false };
}

// ---------------------------------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------------------------------
export interface VariationSlotRequest { presetId: string; source: VariationSource; customName?: string; customDirection?: string }
export interface CustomTypography { headline: string; body: string; accent?: string; headlineWeight: 400 | 600 | 700; bodyWeight: 400 | 600 | 700; color?: string }
export interface StyleVariationRequest {
  slots: VariationSlotRequest[];
  /** Added to every AI slot's direction (never to text or logos). */
  customInstructions?: string;
  typographyMode: TypographyMode;
  customTypography?: CustomTypography;
  quality: StudioImageQuality;
}
/** The default request: the four default presets, AI artwork, original typography. */
export const defaultVariationRequest = (quality: StudioImageQuality = 'medium', count: number = VARIATION_LIMITS.defaultCount): StyleVariationRequest => ({
  slots: Array.from({ length: count }, (_, i) => ({ presetId: DEFAULT_PRESET_IDS[i % DEFAULT_PRESET_IDS.length], source: 'ai' as const })), typographyMode: 'match', quality,
});
export function variationRequestProblems(r: StyleVariationRequest): string[] {
  const out: string[] = [];
  if (!Array.isArray(r.slots) || r.slots.length < 1 || r.slots.length > VARIATION_LIMITS.maxCount) out.push(`Ask for 1–${VARIATION_LIMITS.maxCount} variations.`);
  for (const [i, s] of (r.slots ?? []).entries()) {
    if (s.presetId === CUSTOM_PRESET_ID) { if (!s.customDirection?.trim()) out.push(`Variation ${i + 1}: describe the custom direction.`); }
    else if (!presetById(s.presetId)) out.push(`Variation ${i + 1}: unknown style.`);
    if (!['ai', 'restyle', 'reuse'].includes(s.source)) out.push(`Variation ${i + 1}: choose AI artwork, a local restyle or a reuse.`);
    if ((s.customDirection?.length ?? 0) > VARIATION_LIMITS.maxCustomInstructions) out.push(`Variation ${i + 1}: the direction is limited to ${VARIATION_LIMITS.maxCustomInstructions} characters.`);
  }
  if ((r.customInstructions?.length ?? 0) > VARIATION_LIMITS.maxCustomInstructions) out.push(`Extra instructions are limited to ${VARIATION_LIMITS.maxCustomInstructions} characters.`);
  if (!['match', 'suggested', 'custom'].includes(r.typographyMode)) out.push('Choose a typography mode.');
  if (r.typographyMode === 'custom') {
    const t = r.customTypography;
    if (!t || !isCatalogFont(t.headline) || !isCatalogFont(t.body) || (t.accent !== undefined && !isCatalogFont(t.accent))) out.push('Custom typography: choose fonts from the font catalogue.');
    if (t && (![400, 600, 700].includes(t.headlineWeight) || ![400, 600, 700].includes(t.bodyWeight))) out.push('Custom typography: weights must be 400, 600 or 700.');
    if (t?.color !== undefined && !/^#[\da-f]{6}$/i.test(t.color)) out.push('Custom typography: the colour must be #RRGGBB.');
  }
  if (!['low', 'medium', 'high'].includes(r.quality)) out.push('Choose an image quality.');
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Variant layout (VARIANT coordinates, separate from the template's original boxes)
// ---------------------------------------------------------------------------------------------------------------------
export interface VariantWordPlacement {
  wordId: string; groupId: string; lineId: string; order: number;
  /** Variant coordinates (source pixels of the template canvas). */
  box: SourceBox;
  text: string; style: WordStyle;
  hidden: boolean;
  /** What differs from the template's original (text needs an administrator's confirmation on a protected word). */
  changed: { text: boolean; style: boolean; box: boolean };
  protected: boolean; role: DetectedWord['role'];
}
export interface VariantLogoPlacement { slotId: string; box: SourceBox; asset: 'original' | 'replacement'; hidden: boolean; changed: { box: boolean } }
export interface VariantLayout {
  /** The template analysis revision the layout was made from. */
  analysisRevision: number;
  canvas: SourceSize;
  typographyMode: TypographyMode;
  words: VariantWordPlacement[]; logos: VariantLogoPlacement[];
}
export type LayoutIssueCode = 'COLLISION' | 'OUT_OF_CANVAS' | 'SAFE_AREA' | 'OVERFLOW' | 'PROTECTED_CHANGED' | 'LOW_CONTRAST' | 'FONT_NOT_IN_CATALOGUE' | 'TEXT_IN_ARTWORK';
export interface LayoutIssue { severity: 'error' | 'warning'; code: LayoutIssueCode; message: string; ids: string[] }
export type CheckState = 'pass' | 'warn' | 'fail' | 'not_checked';
export interface LayoutValidation {
  checkedAt: string;
  /** True only when the collision check ran and found none. */
  collisionFree: boolean;
  checks: { collisions: CheckState; canvas: CheckState; safeArea: CheckState; overflow: CheckState; contrast: CheckState; protectedText: CheckState; artworkText: CheckState };
  /** estimated: text widths from average glyph widths (server); measured: from the loaded fonts (browser). */
  overflowMethod: 'estimated' | 'measured';
  issues: LayoutIssue[];
}

/** Average advance widths in em, by character class: an estimate for fonts the server has not loaded. */
const GLYPH_EM = { upper: 0.66, lower: 0.53, wide: 0.84, digit: 0.58, space: 0.28, narrow: 0.27, semi: 0.36, other: 0.6 };
const CONDENSED = new Set(['Bebas Neue', 'Oswald', 'Anton', 'Barlow Condensed', 'Archivo Narrow', 'Pathway Gothic One', 'Fjalla One']);
const WIDE = new Set(['Unbounded', 'Syne', 'Archivo Black', 'Lexend', 'Poppins', 'Montserrat', 'Righteous']);
/** An estimate of the drawn width of a text in source pixels (no font loaded): within about ±15% for common faces. */
export function estimateTextWidth(text: string, style: Pick<WordStyle, 'fontFamily' | 'fontSize' | 'fontWeight' | 'fontStyle' | 'letterSpacing'>): number {
  let em = 0;
  for (const ch of text) em += /[.,:;'!|ilIj]/.test(ch) ? GLYPH_EM.narrow : /[frt\-/()[\]]/.test(ch) ? GLYPH_EM.semi : /[MWmw]/.test(ch) ? GLYPH_EM.wide : /[A-Z]/.test(ch) ? GLYPH_EM.upper : /[a-z]/.test(ch) ? GLYPH_EM.lower : /\d/.test(ch) ? GLYPH_EM.digit : ch === ' ' ? GLYPH_EM.space : GLYPH_EM.other;
  const font = catalogFont(style.fontFamily);
  const family = CONDENSED.has(style.fontFamily) ? 0.78 : WIDE.has(style.fontFamily) ? 1.1 : font?.category === 'Serif' ? 0.96 : font?.category === 'Handwriting' ? 1.05 : 1;
  const weight = style.fontWeight === 700 ? 1.06 : style.fontWeight === 600 ? 1.03 : 1;
  return em * style.fontSize * family * weight * (style.fontStyle === 'italic' ? 0.98 : 1) + Math.max(0, [...text].length - 1) * style.letterSpacing;
}
/** WCAG relative luminance contrast of two #RRGGBB colours (1..21). */
export function contrastRatio(a: string, b: string): number {
  const lum = (h: string) => {
    const [r, g, bl] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Which of the preset's families a word takes: headline for the largest words, accent for italic ones, body for the rest. */
function presetStyle(word: DetectedWord, t: PresetTypography, headlineFrom: number): WordStyle {
  const italic = word.style.fontStyle === 'italic';
  const family = italic ? t.accent : word.style.fontSize >= headlineFrom ? t.headline : t.body;
  const requested = word.style.fontSize >= headlineFrom ? t.headlineWeight : Math.max(word.style.fontWeight, t.bodyWeight) as 400 | 600 | 700;
  const weight = ([400, 600, 700] as const).reduce((best, w) => Math.abs(w - fontWeightFor(family, requested)) < Math.abs(best - fontWeightFor(family, requested)) ? w : best, 400 as 400 | 600 | 700);
  return { ...word.style, fontFamily: family, fontMatch: 'admin', fontWeight: weight, fontStyle: italic && catalogFont(family)?.italic ? 'italic' : 'normal' };
}
/** The style each word takes in a typography mode. Text is never touched here: only fonts, weights and colours. */
export function typographyFor(mode: TypographyMode, words: DetectedWord[], preset: Pick<StylePreset, 'typography'>, custom?: CustomTypography): Map<string, WordStyle> {
  // Headline words: clearly larger than the template's typical word (all one size: every word is body text).
  const sizes = words.map(w => w.style.fontSize).sort((a, b) => a - b), median = sizes[Math.floor(sizes.length / 2)] ?? 0;
  const headlineFrom = Math.max(1, median * 1.6);
  const out = new Map<string, WordStyle>();
  for (const w of words) {
    if (mode === 'match') out.set(w.id, { ...w.style });
    else if (mode === 'suggested') out.set(w.id, presetStyle(w, preset.typography, headlineFrom));
    else {
      const t: PresetTypography = { headline: custom?.headline ?? 'Inter', body: custom?.body ?? 'Inter', accent: custom?.accent ?? custom?.headline ?? 'Inter', headlineWeight: custom?.headlineWeight ?? 700, bodyWeight: custom?.bodyWeight ?? 400 };
      const style = presetStyle(w, t, headlineFrom);
      out.set(w.id, custom?.color ? { ...style, color: custom.color } : style);
    }
  }
  return out;
}

const sameStyle = (a: WordStyle, b: WordStyle) => JSON.stringify([a.fontFamily, a.fontSize, a.fontWeight, a.fontStyle, a.color, a.opacity, a.letterSpacing, a.lineHeight]) === JSON.stringify([b.fontFamily, b.fontSize, b.fontWeight, b.fontStyle, b.color, b.opacity, b.letterSpacing, b.lineHeight]);
const sameBox = (a: SourceBox, b: SourceBox) => [a.x - b.x, a.y - b.y, a.width - b.width, a.height - b.height, a.rotation - b.rotation].every(d => Math.abs(d) < 0.01);
/**
 * Lays one line out again for new styles: each word as wide as its text in its new style, the original gaps between
 * words kept, and the line kept on its original anchor (left edge, centre or right edge, by the group's alignment).
 * With the original styles every box stays exactly where it was.
 */
function reflowLine(words: DetectedWord[], styles: Map<string, WordStyle>, align: WordGroup['align']): Map<string, SourceBox> {
  const out = new Map<string, SourceBox>();
  if (!words.length) return out;
  if (words.every(w => sameStyle(w.style, styles.get(w.id)!))) { for (const w of words) out.set(w.id, { ...w.box }); return out; }
  const first = words[0], last = words[words.length - 1];
  const widths = words.map(w => {
    const s = styles.get(w.id)!, before = estimateTextWidth(w.text, w.style), after = estimateTextWidth(w.text, s);
    // The measured box times the change the new style makes, so an estimate error on the original cancels out.
    return before > 0 ? w.box.width * (after / before) : after;
  });
  const gaps = words.slice(1).map((w, i) => Math.max(0, w.box.x - (words[i].box.x + words[i].box.width)) * (styles.get(w.id)!.fontSize / Math.max(1e-6, w.style.fontSize)));
  const total = widths.reduce((a, b) => a + b, 0) + gaps.reduce((a, b) => a + b, 0);
  const originalLeft = first.box.x, originalRight = last.box.x + last.box.width;
  let x = align === 'center' ? (originalLeft + originalRight) / 2 - total / 2 : align === 'right' ? originalRight - total : originalLeft;
  words.forEach((w, i) => {
    const s = styles.get(w.id)!, scale = s.fontSize / Math.max(1e-6, w.style.fontSize), height = w.box.height * scale;
    // The baseline stays where it was: the box grows or shrinks around it.
    const baselineY = w.box.y + w.style.baseline;
    out.set(w.id, { x, y: baselineY - w.style.baseline * scale, width: widths[i], height, rotation: w.box.rotation });
    x += widths[i] + (gaps[i] ?? 0);
  });
  return out;
}
/** A variation's layout from the template's analysis: every usable word and logo in its own variant box. */
export function buildVariantLayout(analysis: TextAnalysis, canvas: SourceSize, mode: TypographyMode, preset: Pick<StylePreset, 'typography'>, custom?: CustomTypography): VariantLayout {
  const words = analysis.words.filter(w => w.review.status !== 'rejected');
  const styles = typographyFor(mode, words, preset, custom), boxes = new Map<string, SourceBox>();
  for (const g of analysis.groups) for (const line of g.lines) {
    const lineWords = line.wordIds.map(id => words.find(w => w.id === id)).filter((w): w is DetectedWord => !!w);
    for (const [id, box] of reflowLine(lineWords, styles, g.align)) boxes.set(id, box);
  }
  return {
    analysisRevision: analysis.revision, canvas: { width: canvas.width, height: canvas.height }, typographyMode: mode,
    words: words.map(w => {
      const style = { ...styles.get(w.id)!, baseline: w.style.baseline * (styles.get(w.id)!.fontSize / Math.max(1e-6, w.style.fontSize)) }, box = boxes.get(w.id) ?? { ...w.box };
      return { wordId: w.id, groupId: w.groupId, lineId: w.lineId, order: w.order, box, text: w.text, style, hidden: false,
        changed: { text: false, style: !sameStyle(style, w.style), box: !sameBox(box, w.box) }, protected: w.protected || PROTECTED_ROLES.includes(w.role), role: w.role };
    }),
    logos: analysis.logoSlots.filter(l => l.review.status !== 'rejected').map(l => ({ slotId: l.id, box: { ...l.box }, asset: l.replacement ? 'replacement' as const : 'original' as const, hidden: false, changed: { box: false } })),
  };
}
/** The layout after a typography change: new styles and reflowed boxes for every word, text and logos unchanged. */
export function retypeLayout(layout: VariantLayout, analysis: TextAnalysis, mode: TypographyMode, preset: Pick<StylePreset, 'typography'>, custom?: CustomTypography): VariantLayout {
  const fresh = buildVariantLayout(analysis, layout.canvas, mode, preset, custom), previous = new Map(layout.words.map(w => [w.wordId, w]));
  return { ...layout, typographyMode: mode, analysisRevision: analysis.revision,
    words: fresh.words.map(w => { const p = previous.get(w.wordId); return p ? { ...w, text: p.text, hidden: p.hidden, changed: { ...w.changed, text: p.changed.text } } : w; }),
    logos: layout.logos };
}

/** Overlap area of two boxes' bounds, as a share of the smaller one. */
function overlapShare(a: SourceBox, b: SourceBox): number {
  const p = boundingBox(a), q = boundingBox(b);
  const w = Math.min(p.x + p.width, q.x + q.width) - Math.max(p.x, q.x), h = Math.min(p.y + p.height, q.y + q.height) - Math.max(p.y, q.y);
  return w > 0 && h > 0 ? (w * h) / Math.max(1e-9, Math.min(p.width * p.height, q.width * q.height)) : 0;
}
export interface ValidationInputs {
  /** Original words, to tell a changed protected text and to compare styles. */
  analysis: TextAnalysis;
  /** Drawn width of a word in its variant style, from the loaded fonts (browser); absent: estimated. */
  measure?: (text: string, style: WordStyle) => number;
  /** The artwork's colour behind each word (#RRGGBB), sampled from the variation's pixels; absent: contrast not checked. */
  background?: Map<string, string>;
  /** Words the local check read in the generated artwork. */
  artworkText?: { text: string; confidence: number }[] | null;
  /** Protected words whose text an administrator confirmed changing. */
  confirmedProtectedEdits?: string[];
  at?: string;
}
/**
 * Every layout check. Collisions are reported only from an actual comparison of every pair of visible boxes, so
 * `collisionFree` is never claimed without it. Words of the same line may touch (2% overlap) without counting.
 */
export function validateLayout(layout: VariantLayout, input: ValidationInputs): LayoutValidation {
  const issues: LayoutIssue[] = [], add = (severity: LayoutIssue['severity'], code: LayoutIssueCode, message: string, ids: string[]) => issues.push({ severity, code, message, ids });
  const original = new Map(input.analysis.words.map(w => [w.id, w]));
  const items = [
    ...layout.words.filter(w => !w.hidden).map(w => ({ id: w.wordId, box: w.box, label: `“${w.text}”`, groupId: w.groupId, lineId: w.lineId })),
    ...layout.logos.filter(l => !l.hidden).map(l => ({ id: l.slotId, box: l.box, label: 'a logo', groupId: `logo:${l.slotId}`, lineId: `logo:${l.slotId}` })),
  ];
  let collisions = 0;
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i], b = items[j], share = overlapShare(a.box, b.box);
    const tolerance = a.lineId === b.lineId ? 0.02 : 0.005;
    if (share > tolerance) { collisions++; add(a.groupId === b.groupId ? 'warning' : 'error', 'COLLISION', `${a.label} overlaps ${b.label} (${Math.round(share * 100)}% of the smaller).`, [a.id, b.id]); }
  }
  const { width: W, height: H } = layout.canvas, inset = Math.min(W, H) * VARIATION_LIMITS.safeInsetShare;
  let outside = 0, unsafe = 0;
  for (const it of items) {
    const b = boundingBox(it.box);
    if (b.x < -0.5 || b.y < -0.5 || b.x + b.width > W + 0.5 || b.y + b.height > H + 0.5) { outside++; add('error', 'OUT_OF_CANVAS', `${it.label} is partly outside the canvas.`, [it.id]); }
    else if (b.x < inset || b.y < inset || b.x + b.width > W - inset || b.y + b.height > H - inset) { unsafe++; add('warning', 'SAFE_AREA', `${it.label} is inside the ${Math.round(inset)} px safe margin; it can be cut off when printed or cropped.`, [it.id]); }
  }
  let overflow = 0;
  for (const w of layout.words.filter(x => !x.hidden)) {
    if (!isCatalogFont(w.style.fontFamily)) add('error', 'FONT_NOT_IN_CATALOGUE', `“${w.text}” uses ${w.style.fontFamily}, which is not in the licensed font catalogue.`, [w.wordId]);
    const width = input.measure ? input.measure(w.text, w.style) : estimateTextWidth(w.text, w.style);
    // A word is one line: drawn wider than its box (5% grace for the estimate), it runs into whatever follows.
    if (width > w.box.width * (input.measure ? 1.02 : 1.08) + 1) { overflow++; add('warning', 'OVERFLOW', `“${w.text}” is about ${Math.round(width)} px wide in ${w.style.fontFamily}; its box is ${Math.round(w.box.width)} px.`, [w.wordId]); }
    const o = original.get(w.wordId);
    if (o && w.protected && w.text !== o.text) {
      const confirmed = input.confirmedProtectedEdits?.includes(w.wordId);
      add(confirmed ? 'warning' : 'error', 'PROTECTED_CHANGED', confirmed ? `“${o.text}” → “${w.text}”: protected ${o.role} text changed by an administrator.` : `“${o.text}” is protected ${o.role} text; changing it to “${w.text}” needs an administrator's confirmation.`, [w.wordId]);
    }
  }
  let lowContrast = 0;
  if (input.background) for (const w of layout.words.filter(x => !x.hidden)) {
    const bg = input.background.get(w.wordId);
    if (!bg) continue;
    const ratio = contrastRatio(w.style.color, bg), large = w.style.fontSize >= 24 || (w.style.fontSize >= 18.5 && w.style.fontWeight >= 700);
    if (ratio < (large ? 3 : 4.5)) { lowContrast++; add('warning', 'LOW_CONTRAST', `“${w.text}” (${w.style.color}) on ${bg} has a contrast of ${ratio.toFixed(1)}:1; ${large ? 3 : 4.5}:1 is the minimum for reading it.`, [w.wordId]); }
  }
  const drawn = input.artworkText ?? null;
  if (drawn?.length) add('error', 'TEXT_IN_ARTWORK', `The local check read text in the generated artwork: ${drawn.slice(0, 6).map(d => `“${d.text}”`).join(', ')}. Look at it before using this variation.`, []);
  const state = (n: number, severity: 'warn' | 'fail'): CheckState => n ? severity : 'pass';
  const protectedErrors = issues.some(i => i.code === 'PROTECTED_CHANGED' && i.severity === 'error'), protectedWarn = issues.some(i => i.code === 'PROTECTED_CHANGED');
  return {
    checkedAt: input.at ?? new Date().toISOString(), collisionFree: collisions === 0,
    checks: { collisions: issues.some(i => i.code === 'COLLISION' && i.severity === 'error') ? 'fail' : state(collisions, 'warn'), canvas: state(outside, 'fail'), safeArea: state(unsafe, 'warn'), overflow: state(overflow, 'warn'),
      contrast: input.background ? state(lowContrast, 'warn') : 'not_checked', protectedText: protectedErrors ? 'fail' : protectedWarn ? 'warn' : 'pass',
      artworkText: drawn === null ? 'not_checked' : drawn.length ? 'fail' : 'pass' },
    overflowMethod: input.measure ? 'measured' : 'estimated', issues,
  };
}
/** Errors that stop a variation from being saved (warnings are shown and may be accepted). */
export const blockingIssues = (v: LayoutValidation) => v.issues.filter(i => i.severity === 'error');

// ---------------------------------------------------------------------------------------------------------------------
// API views
// ---------------------------------------------------------------------------------------------------------------------
export type VariationStatus = 'queued' | 'generating' | 'checking' | 'ready' | 'needs_review' | 'failed' | 'cancelled';
export type VariationReview = 'unreviewed' | 'selected' | 'rejected' | 'saved';
export interface VariationEvent { at: string; action: 'created' | 'generated' | 'reused-cache' | 'checked' | 'layout-changed' | 'typography-changed' | 'selected' | 'rejected' | 'saved' | 'reopened' | 'failed' | 'duplicated' | 'protected-text-confirmed'; detail?: string }
export interface StyleVariationView {
  schemaVersion: typeof STYLE_VARIATION_SCHEMA;
  id: string; batchId: string; index: number; templateId: string; templateName: string; createdAt: string; updatedAt: string;
  preset: StylePreset; customInstructions: string | null; source: VariationSource; provenance: VariationProvenance;
  status: VariationStatus;
  error: { code: string; message: string; requestId?: string | null } | null;
  /** The artwork at the template's canvas size, and how it was made. */
  artwork: null | {
    url: string; width: number; height: number; sha256: string;
    model: string | null; providerSize: string | null; quality: StudioImageQuality | null; promptVersion: string | null; requestId: string | null;
    /** Reused from an identical earlier variation (same base, direction, model, size and quality): no new call. */
    cachedFrom: string | null;
  };
  /** The local recognizer's read of the generated artwork, looking for drawn text. */
  artworkCheck: null | { status: 'clean' | 'text_found' | 'not_run'; words: { text: string; confidence: number }[]; note: string };
  layout: VariantLayout; validation: LayoutValidation;
  customTypography: CustomTypography | null;
  confirmedProtectedEdits: string[];
  review: { status: VariationReview; history: VariationEvent[] };
  cost: { estimate: StudioMoney; actual: StudioMoney | null; unknown: boolean };
  jobId: string | null;
  /** What it was made from: the template's base and analysis; the variation it was duplicated from, and its copies. */
  parent: { templateId: string; baseSha256: string; analysisRevision: number; elementsRevision: number; variationId: string | null };
  children: string[];
}
export interface VariationEstimateLine { stage: string; model: string; count: number; cost: StudioMoney; cached: boolean; note: string; assumptions: string[] }
export interface VariationEstimate {
  lines: VariationEstimateLine[]; total: StudioMoney; perVariationCap: StudioMoney; withinCap: boolean;
  daily: { cap: StudioMoney; used: StudioMoney; held: StudioMoney; remaining: StudioMoney; fits: boolean; resets: string };
  /** Paid image requests this request would send (cached and local slots excluded). */
  paidRequests: number;
  quality: StudioImageQuality; providerSize: string; model: string; fx: StudioFx; rateCardVersion: string;
  /** The exact amount a confirmation must name. */
  confirmMicroUsd: number;
  blockedReason: string | null; note: string;
}
