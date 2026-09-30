import type { ImageProvider } from './ai.js';
import type { CanvasImageRole, CanvasShapeRole, CanvasTextRole, EditableProperties, ImageFit } from './canvasElement.js';

/** The editor's own roles, and the shared CanvasElement text roles a text opened from a template keeps. */
export type TextRole = 'eyebrow' | 'title' | 'date' | 'venue' | 'body' | 'custom' | CanvasTextRole;
export * from './text.js';

/**
 * Every position and dimension is in logical canvas pixels.
 *
 * The fields after `letterSpacing` are optional and absent on text made in the editor, which behaves as it always has:
 * free text with a width and a natural height, drawn above the layers. A text opened from a template carries them, so
 * nothing of the shared CanvasElement model (canvasElement.ts) is lost in the editor (canvasEditorAdapter.ts).
 */
export interface TextElement {
  id: string;
  type: 'text';
  role: TextRole;
  /** The text as written. Display rules below never change it: a cut or shrunk text is still stored whole. */
  text: string;
  x: number;
  y: number;
  width: number;
  fontFamily: string;
  /** The design size. A fixed text box may be drawn smaller (see `overflow`), never stored smaller. */
  fontSize: number;
  fontWeight: 400 | 600 | 700;
  fill: string;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
  letterSpacing: number;
  name?: string;
  /** Degrees about the element's own origin (x, y), like layers. */
  rotation?: number;
  /** Place in the one back-to-front order shared with layers (paintOrder). Absent: above every layer, as before. */
  zIndex?: number;
  visible?: boolean;
  /** With a height the text is a fixed box: it wraps inside it and follows the overflow rules below. */
  height?: number;
  verticalAlign?: 'top' | 'middle' | 'bottom';
  /** Overflow rules of a fixed box: at most maxLines; 'shrink' draws it smaller, down to minFontSize, before cutting it with an ellipsis; 'ellipsis' cuts it at the design size. */
  maxLines?: number;
  overflow?: 'shrink' | 'ellipsis';
  minFontSize?: number;
  /** A filled box behind the text (a CTA's button), the size of the fixed box; fill null keeps only the radius. */
  box?: { fill: string | null; radius: number };
  /** What a creative of the template may change; kept as metadata, the editor itself edits freely. */
  editable?: EditableProperties;
}

export interface CanvasSize { width: number; height: number }

/** Editable layers (e.g. from image decomposition, or a template). Logical canvas pixels; rotation in degrees about the origin (x, y). */
export interface DesignLayerBase {
  id: string; name: string; x: number; y: number; width: number; height: number;
  rotation: number; opacity: number; visible: boolean; locked: boolean;
  /** Decomposition provenance: the job and scene layer this came from. */
  source?: { jobId: string; layerId: string; kind: 'image' | 'text' | 'shape' };
  /** Place in the one back-to-front order shared with text (paintOrder). Absent: the order of `layers`, below all text, as before. */
  zIndex?: number;
  /** The shared CanvasElement role, and what a creative of the template may change (metadata, as on text). */
  role?: CanvasImageRole | CanvasShapeRole;
  editable?: EditableProperties;
}
export interface ImageLayerElement extends DesignLayerBase {
  type: 'image';
  /** Absent on an empty image slot of a template: the slot keeps its place and can be given a picture. */
  assetId?: string;
  /** For text rasters: an editable suggestion the user can convert into a text element. */
  textSuggestion?: { text: string; confidence: 'none' | 'low'; fill?: string; fontSize?: number; fontWeight?: 400 | 600 | 700 };
  /** How the picture fills the box without distortion, around the focal point (0..1). Absent: stretched to the box, as before. */
  fit?: ImageFit;
  focalPoint?: { x: number; y: number };
  /** Corner radius in pixels. */
  radius?: number;
}
export interface ShapeLayerElement extends DesignLayerBase {
  /** circle: the largest circle centred in the box (it stays round when the box is not square). */
  type: 'shape'; shapeType: 'rectangle' | 'rounded-rectangle' | 'ellipse' | 'circle';
  fill: string; gradient?: { from: string; to: string; angle: number }; stroke?: { color: string; width: number }; radius: number;
}
export type DesignLayer = ImageLayerElement | ShapeLayerElement;
export const LAYER_LIMITS = { maxLayers: 60, minSide: 1, maxSide: 16384 } as const;

export interface DesignVariant {
  id: string;
  name: string;
  revision: number;
  /** `transparent` shows no fill (checkerboard in the editor, alpha in PNG export); `backgroundColor` is kept for when it is turned off. */
  canvas: CanvasSize & { backgroundColor: string; transparent?: boolean };
  elements: TextElement[];
  /** Optional, back-to-front, rendered above the background. Drawn below all text unless the elements carry a zIndex. Absent on older documents. */
  layers?: DesignLayer[];
  background?: {
    assetId: string;
    fit: 'cover' | 'contain';
    focalPoint: { x: number; y: number };
  };
  sourceVariantId?: string;
  /** Opened from an "Image to layers" job: which job, and whether it started on a blank canvas or the original image. */
  decomposition?: { jobId: string; mode: 'blank' | 'original' };
  /**
   * Opened from a template creative: which template version and creative. From then on this is an independent design:
   * editing it never changes the template or the creative. `background` keeps the template's background element (its
   * content is the canvas colour and the background artwork above).
   */
  template?: {
    templateId: string; templateVersion: number; creativeId?: string;
    background?: { id: string; name: string; fit: ImageFit; focalPoint: { x: number; y: number }; editable: EditableProperties };
  };
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
export * from './templateAGeneration.js';
export * from './canvasElement.js';
export * from './designTemplates/index.js';
export * from './canvasEditorAdapter.js';

export { nativePointer } from './decompositionCoordinates.js';
