import type { ImageProvider } from './ai.js';

export type TextRole = 'eyebrow' | 'title' | 'date' | 'venue' | 'body' | 'custom';
export * from './text.js';

/** Every position and dimension is in logical canvas pixels. */
export interface TextElement {
  id: string;
  type: 'text';
  role: TextRole;
  text: string;
  x: number;
  y: number;
  width: number;
  fontFamily: string;
  fontSize: number;
  fontWeight: 400 | 600 | 700;
  fill: string;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
  letterSpacing: number;
}

export interface CanvasSize { width: number; height: number }

export interface DesignVariant {
  id: string;
  name: string;
  revision: number;
  canvas: CanvasSize & { backgroundColor: string };
  elements: TextElement[];
  background?: {
    assetId: string;
    fit: 'cover' | 'contain';
    focalPoint: { x: number; y: number };
  };
  sourceVariantId?: string;
  generation?: {
    mode: 'live' | 'example';
    provider?: ImageProvider;
    model?: string;
    promptUsed: string;
    sourceAssetId?: string;
    requestedAspectRatio: string;
    returnedWidth: number;
    returnedHeight: number;
  };
}

export interface ProjectDocument {
  schemaVersion: 1;
  id: string;
  name: string;
  originalPrompt?: string;
  styleBrief?: { theme: string; palette: string[]; motifs: string[]; mood: string };
  variants: DesignVariant[];
  createdAt: string;
  updatedAt: string;
}

export const CANVAS_LIMITS = { minSide: 256, maxSide: 4096, maxArea: 12_000_000 } as const;
export const CANVAS_PRESETS = [
  { id: 'poster', name: 'Poster', width: 1080, height: 1350, ratio: '4:5' },
  { id: 'square', name: 'Square', width: 1080, height: 1080, ratio: '1:1' },
  { id: 'landscape', name: 'Landscape', width: 1600, height: 900, ratio: '16:9' },
  { id: 'story', name: 'Story', width: 1080, height: 1920, ratio: '9:16' },
] as const;

type SizeErrors = Partial<Record<'width' | 'height' | 'area', string>>;
export type SizeValidation = { valid: true; size: CanvasSize } | { valid: false; errors: SizeErrors };

/** Validate raw form strings before conversion; never clamp or truncate input. */
export function validateCanvasSize(width: string | number, height: string | number): SizeValidation {
  const errors: SizeErrors = {};
  for (const [field, raw] of [['width', width], ['height', height]] as const) {
    const label = field === 'width' ? 'Width' : 'Height';
    const value = typeof raw === 'string' ? raw.trim() : raw;
    if (value === '') errors[field] = `Enter a ${field}.`;
    else if ((typeof value === 'string' && !/^\d+$/.test(value)) || !Number.isSafeInteger(Number(value))) {
      errors[field] = `${label} must be a whole number in pixels.`;
    } else if (Number(value) < CANVAS_LIMITS.minSide || Number(value) > CANVAS_LIMITS.maxSide) {
      errors[field] = `${label} must be between 256 and 4096 px.`;
    }
  }
  if (Object.keys(errors).length) return { valid: false, errors };
  const size = { width: Number(width), height: Number(height) };
  if (size.width * size.height > CANVAS_LIMITS.maxArea) {
    return { valid: false, errors: { area: 'Keep the total area at or below 12,000,000 pixels.' } };
  }
  return { valid: true, size };
}
export * from './ai.js';
export * from './decomposition.js';

export { nativePointer } from './decompositionCoordinates.js';
