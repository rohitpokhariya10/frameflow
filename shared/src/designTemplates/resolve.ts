/**
 * Normalized template → what to draw on one canvas. This is the only step between the stored template and the
 * renderer, and it is pure: the same template and canvas always give the same boxes, in every aspect ratio.
 *
 *   normalized template (+ creative content)  →  resolveTemplate(canvas)  →  pixel boxes and sizes  →  Konva nodes
 *
 * Theme ratio layouts are materialized before conversion. Legacy elements keep their single normalized layout.
 */
import { elementAtRatio, ratioOfCanvas } from './responsive.js';
import type { CanvasSize } from '../index.js';
import { applyCreative, type Creative } from './creative.js';
import { canvasShortEdge, cornerRadiusPixels, fontPixels, toPixels, type PixelBox } from './geometry.js';
import { usableFont, type DesignTemplate, type ImageFit, type TemplateElement, type TemplateImageRole, type TemplateShapeRole, type TemplateTextRole, type TemplateTextBehavior, type TemplateTextStyle } from './schema.js';

interface ResolvedBase { themeRole?: string; id: string; name: string; zIndex: number; box: PixelBox }
export interface ResolvedText extends ResolvedBase {
  type: 'text'; role: TemplateTextRole; text: string; fontFamily: string;
  /** The design size and the smallest size overflow may shrink to, in pixels of this canvas. */
  fontPx: number; minFontPx: number;
  fontWeight: TemplateTextStyle['fontWeight']; color: string; align: TemplateTextStyle['align']; verticalAlign: TemplateTextStyle['verticalAlign'];
  lineHeight: number;
  /** In em: multiply by the font size actually drawn. */
  letterSpacing: number;
  backgroundColor: string | null; cornerRadiusPx: number; maxLines: number; overflow: TemplateTextBehavior['overflow'];
}
export interface ResolvedImage extends ResolvedBase { type: 'image'; role: TemplateImageRole; assetId: string | null; fit: ImageFit; focalX: number; focalY: number; opacity: number; cornerRadiusPx: number }
export interface ResolvedShape extends ResolvedBase {
  type: 'shape'; role: TemplateShapeRole; fill: string; opacity: number; cornerRadiusPx: number; stroke: string | null; strokeWidthPx: number;
  /** A circle role: the largest circle centred in the box (centre and radius relative to the box's top-left corner). */
  circle?: { x: number; y: number; radius: number };
  /** An ellipse role: the ellipse that fills the box. */
  ellipse?: true;
  gradient?: { from: string; to: string; angle: number };
}
export interface ResolvedBackground extends ResolvedBase { type: 'background'; role: 'background'; color: string; assetId: string | null; fit: ImageFit; focalX: number; focalY: number }
export type ResolvedElement = ResolvedText | ResolvedImage | ResolvedShape | ResolvedBackground;

/** One element in the pixels of this canvas. */
export function resolveElement(element: TemplateElement, canvas: CanvasSize): ResolvedElement {
  element = elementAtRatio(element, ratioOfCanvas(canvas));
  const box = toPixels(element.layout, canvas), base = { themeRole: element.themeRole, id: element.id, name: element.name, zIndex: element.zIndex, box };
  switch (element.type) {
    case 'text': return { ...base, type: 'text', role: element.role, text: element.defaultContent.text, fontFamily: usableFont(element.style.fontFamily),
      fontPx: fontPixels(element.style.fontSize, canvas), minFontPx: fontPixels(Math.min(element.behavior.minFontSize, element.style.fontSize), canvas),
      fontWeight: element.style.fontWeight, color: element.style.color, align: element.style.align, verticalAlign: element.style.verticalAlign, lineHeight: element.style.lineHeight,
      letterSpacing: element.style.letterSpacing, backgroundColor: element.style.backgroundColor, cornerRadiusPx: cornerRadiusPixels(element.style.cornerRadius, box),
      maxLines: element.behavior.maxLines, overflow: element.behavior.overflow };
    case 'image': return { ...base, type: 'image', role: element.role, assetId: element.defaultContent.assetId, fit: element.behavior.fit, focalX: element.behavior.focalX, focalY: element.behavior.focalY,
      opacity: element.style.opacity, cornerRadiusPx: cornerRadiusPixels(element.style.cornerRadius, box) };
    case 'shape': {
      const radius = Math.min(box.width, box.height) / 2;
      return { ...base, type: 'shape', role: element.role, fill: element.style.fill, opacity: element.style.opacity, stroke: element.style.stroke, strokeWidthPx: element.style.strokeWidth * canvasShortEdge(canvas),
        cornerRadiusPx: element.role === 'rectangle' ? 0 : cornerRadiusPixels(element.style.cornerRadius, box),
        ...(element.role === 'circle' ? { circle: { x: box.width / 2, y: box.height / 2, radius } } : {}), ...(element.role === 'ellipse' ? { ellipse: true as const } : {}),
        ...(element.style.gradient ? { gradient: element.style.gradient } : {}) };
    }
    case 'background': return { ...base, type: 'background', role: 'background', color: element.defaultContent.color, assetId: element.defaultContent.assetId, fit: element.behavior.fit, focalX: element.behavior.focalX, focalY: element.behavior.focalY };
  }
}

/** The visible elements back to front (lowest zIndex first), in the pixels of this canvas. The input is not modified or reordered. */
export function resolveElements(elements: readonly TemplateElement[], canvas: CanvasSize): ResolvedElement[] {
  return elements.filter(element => element.visible !== false).map((element, index) => ({ element, index })).sort((a, b) => a.element.zIndex - b.element.zIndex || a.index - b.index).map(({ element }) => resolveElement(element, canvas));
}
/** A template on a canvas; with a creative, its content in place of the template's defaults. */
export function resolveTemplate(template: DesignTemplate, canvas: CanvasSize, creative?: Creative): ResolvedElement[] {
  return resolveElements(creative ? applyCreative(template, creative).elements : template.elements, canvas);
}
/** The colour behind everything: the background element's, or white when the template has none. */
export const canvasColor = (elements: readonly ResolvedElement[]) => elements.find((element): element is ResolvedBackground => element.type === 'background')?.color ?? '#FFFFFF';
