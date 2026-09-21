import type { CanvasSize, TextElement } from './index.js';

export const TEXT_LIMITS = {
  minWidth: 32, maxWidth: 8192, minFontSize: 8, maxFontSize: 512,
  maxCharacters: 5000, maxElements: 50, visiblePortion: 24, duplicateOffset: 24,
} as const;
export const TEXT_FONTS = ['Inter', 'Lora'] as const;
export const TEXT_WEIGHTS = [400, 600, 700] as const;
export type TextKind = 'heading' | 'subheading' | 'body';
export type TextChanges = Partial<Pick<TextElement, 'text' | 'fontFamily' | 'fontSize' | 'fontWeight' | 'fill' | 'align'>>;
export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function createTextElement(kind: TextKind, canvas: CanvasSize, id: string, count = 0): TextElement {
  const presets = {
    heading: { text: 'Add a beautiful heading', role: 'title', fontSize: 72, fontWeight: 600, fontFamily: 'Lora', y: 0.32, lineHeight: 1.2 },
    subheading: { text: 'A little more to the story', role: 'custom', fontSize: 38, fontWeight: 600, fontFamily: 'Inter', y: 0.48, lineHeight: 1.35 },
    body: { text: 'Every idea starts with a few words. Make these yours.', role: 'body', fontSize: 26, fontWeight: 400, fontFamily: 'Inter', y: 0.6, lineHeight: 1.5 },
  } as const;
  const preset = presets[kind];
  return {
    id, type: 'text', role: preset.role, text: preset.text,
    x: Math.round(canvas.width * 0.15),
    y: Math.round(Math.min(canvas.height * 0.8, canvas.height * preset.y + (count % 5) * TEXT_LIMITS.duplicateOffset)),
    width: Math.round(canvas.width * 0.7), fontFamily: preset.fontFamily, fontWeight: preset.fontWeight,
    fontSize: clamp(Math.round(preset.fontSize * Math.min(canvas.width, canvas.height) / 1080), TEXT_LIMITS.minFontSize, TEXT_LIMITS.maxFontSize),
    fill: '#1F2925', align: 'center', lineHeight: preset.lineHeight, letterSpacing: 0,
  };
}

/** Retain a selectable strip inside the frame. Measured height is transient input only. */
export function recoverablePosition(position: { x: number; y: number }, bounds: CanvasSize, canvas: CanvasSize) {
  const visibleX = Math.min(TEXT_LIMITS.visiblePortion, bounds.width);
  const visibleY = Math.min(TEXT_LIMITS.visiblePortion, bounds.height);
  return {
    x: clamp(position.x, -bounds.width + visibleX, canvas.width - visibleX),
    y: clamp(position.y, -bounds.height + visibleY, canvas.height - visibleY),
  };
}

export function validTextChanges(changes: TextChanges): boolean {
  return Object.entries(changes).every(([key, value]) => {
    switch (key) {
      case 'text': return typeof value === 'string' && value.length <= TEXT_LIMITS.maxCharacters;
      case 'fontFamily': return TEXT_FONTS.some((font) => font === value);
      case 'fontSize': return typeof value === 'number' && Number.isFinite(value) && value >= TEXT_LIMITS.minFontSize && value <= TEXT_LIMITS.maxFontSize;
      case 'fontWeight': return TEXT_WEIGHTS.some((weight) => weight === value);
      case 'fill': return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);
      case 'align': return value === 'left' || value === 'center' || value === 'right';
      default: return false;
    }
  });
}
