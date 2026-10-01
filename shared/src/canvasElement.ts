/**
 * CanvasElement: the one element model shared by Template Studio, Creative mode and the existing editor.
 *
 *   Template Studio   authors CanvasElement[]
 *   Creative          a template's CanvasElement[] + content overrides (designTemplates/creative.ts)
 *   Existing editor   keeps its pixel document format, extended so that CanvasElement[] → editor → CanvasElement[] is
 *                     lossless (canvasEditorAdapter.ts)
 *
 * Geometry is canonical in NORMALIZED form: x, y, width and height are fractions (0..1) of the canvas width and height.
 * Sizes that are not boxes are normalized too: a font size is a fraction of the canvas short edge, letter spacing is in
 * em, a corner radius is a fraction of half the box's shorter side. Rotation is in degrees, about the box centre. The
 * layer order is one explicit zIndex across every element type.
 */
import type { TEXT_WEIGHTS } from './text.js';
import type { DesignAspectRatio } from './designTemplates/schema.js';

/** x, y, width, height: fractions of the canvas (0..1), the unrotated box. rotation: degrees about the box centre. */
export interface NormalizedLayout { x: number; y: number; width: number; height: number; rotation: number }
export const FULL_CANVAS: NormalizedLayout = { x: 0, y: 0, width: 1, height: 1, rotation: 0 };

/**
 * What a creative may change on an element. Everything not listed as true is locked. position, size and rotation are
 * geometry: false unless the template author explicitly opens them.
 */
export const EDITABLE_PROPERTIES = ['content', 'color', 'backgroundColor', 'image', 'fontFamily', 'position', 'size', 'rotation'] as const;
export type EditableProperty = typeof EDITABLE_PROPERTIES[number];
export type EditableProperties = Record<EditableProperty, boolean>;
export const ALL_LOCKED: EditableProperties = { content: false, color: false, backgroundColor: false, image: false, fontFamily: false, position: false, size: false, rotation: false };

export const CANVAS_TEXT_ROLES = ['heading', 'subheading', 'paragraph', 'offer', 'cta', 'generic-text'] as const;
export const CANVAS_IMAGE_ROLES = ['hero', 'logo', 'product', 'generic-image'] as const;
export const CANVAS_SHAPE_ROLES = ['rectangle', 'rounded-rectangle', 'circle', 'ellipse', 'decorative'] as const;
export type CanvasTextRole = typeof CANVAS_TEXT_ROLES[number];
export type CanvasImageRole = typeof CANVAS_IMAGE_ROLES[number];
export type CanvasShapeRole = typeof CANVAS_SHAPE_ROLES[number];
export type ImageFit = 'cover' | 'contain';
/** How an image fills its fixed box: fit, and the focal point (0..1) kept in view when it is cropped. */
export interface ImageBehavior { fit: ImageFit; focalX: number; focalY: number }

interface CanvasElementBase {
  id: string; name: string;
  /** Optional theme semantics. Old elements keep their single layout. Overrides belong to one ratio only. */
  themeRole?: string;
  ratioLayouts?: Partial<Record<DesignAspectRatio, NormalizedLayout>>;
  /** Back to front, across text, images and shapes alike. */
  zIndex: number;
  layout: NormalizedLayout;
  /** Hidden when false; absent means visible. */
  visible?: boolean;
  editableProperties: EditableProperties;
}

export interface CanvasTextStyle {
  fontFamily: string;
  /** Fraction of the canvas short edge: fontPx = fontSize × min(canvasWidth, canvasHeight). */
  fontSize: number;
  fontWeight: typeof TEXT_WEIGHTS[number];
  color: string; align: 'left' | 'center' | 'right'; verticalAlign: 'top' | 'middle' | 'bottom';
  /** Multiple of the font size. */
  lineHeight: number;
  /** In em: letterSpacingPx = letterSpacing × fontPx. */
  letterSpacing: number;
  /** A filled box behind the text (a button for a CTA), or null. */
  backgroundColor: string | null;
  /** 0..1 of half the box's shorter side; 1 is a pill. */
  cornerRadius: number;
}
/**
 * Display rules, kept apart from the text itself. Overflow never moves or resizes the box and never changes the stored
 * text: it wraps inside the box, up to maxLines and the box height; when it still does not fit, 'shrink' reduces the
 * font down to minFontSize (a fraction of the short edge, like fontSize) and only then ends it with an ellipsis;
 * 'ellipsis' cuts it at the full size.
 */
export interface CanvasTextBehavior { maxLines: number; overflow: 'shrink' | 'ellipsis'; minFontSize: number }
export interface CanvasTextElement extends CanvasElementBase { type: 'text'; role: CanvasTextRole; defaultContent: { text: string }; style: CanvasTextStyle; behavior: CanvasTextBehavior }

/** A fixed slot: replacing the picture never changes the box. assetId: an image in the browser's asset store, or null (empty slot). */
export interface CanvasImageElement extends CanvasElementBase { type: 'image'; role: CanvasImageRole; defaultContent: { assetId: string | null }; style: { opacity: number; cornerRadius: number }; behavior: ImageBehavior }

export interface CanvasShapeStyle {
  fill: string; opacity: number;
  /** 0..1 of half the box's shorter side (rounded-rectangle, decorative). */
  cornerRadius: number;
  stroke: string | null;
  /** Fraction of the canvas short edge. */
  strokeWidth: number;
  /** A linear gradient in place of the solid fill: angle in degrees. */
  gradient?: { from: string; to: string; angle: number };
}
/**
 * rectangle, rounded-rectangle and ellipse fill their box; circle is the largest circle centred in its box, so it stays
 * round in every aspect ratio; decorative is a rounded shape that carries no content.
 */
export interface CanvasShapeElement extends CanvasElementBase { type: 'shape'; role: CanvasShapeRole; defaultContent: Record<string, never>; style: CanvasShapeStyle; behavior: Record<string, never> }

/** At most one per design: always the full canvas and always the lowest layer. A solid colour, optionally an image over it. */
export interface CanvasBackgroundElement extends CanvasElementBase { type: 'background'; role: 'background'; defaultContent: { color: string; assetId: string | null }; style: Record<string, never>; behavior: ImageBehavior }

export type CanvasElement = CanvasTextElement | CanvasImageElement | CanvasShapeElement | CanvasBackgroundElement;
export type CanvasElementType = CanvasElement['type'];
export const CANVAS_ELEMENT_TYPES = ['text', 'image', 'shape', 'background'] as const satisfies readonly CanvasElementType[];
