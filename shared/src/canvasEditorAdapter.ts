/**
 * CanvasElement[] ⇄ the existing editor's document format. The editor keeps its own pixel format (index.ts), extended
 * with optional fields so that it can hold everything the shared model (canvasElement.ts) says about an element:
 *
 *   canvasElementsToVariant   normalized CanvasElement[]  →  a DesignVariant in the pixels of one canvas
 *   variantToCanvasElements   a DesignVariant             →  normalized CanvasElement[]
 *
 * Going to the editor and back returns the same elements: the same ids, one back-to-front order across text, images
 * and shapes, rotation, the raw text with its overflow rules beside it, image fit and focal point, and the normalized
 * geometry (exact for values stored with at most 6 decimals, which is how the template tools store them). Nothing is
 * flattened, reordered or baked in. Both functions are pure: they copy values and never touch their input, so a design
 * opened in the editor shares nothing with the template it came from.
 */
import type { CanvasSize, DesignLayer, DesignVariant, ShapeLayerElement, TextElement } from './index.js';
import { ALL_LOCKED, CANVAS_IMAGE_ROLES, CANVAS_SHAPE_ROLES, CANVAS_TEXT_ROLES, FULL_CANVAS, type CanvasBackgroundElement, type CanvasElement, type CanvasImageElement, type CanvasImageRole,
  type CanvasShapeElement, type CanvasShapeRole, type CanvasTextElement, type CanvasTextRole } from './canvasElement.js';
import { boxFromOrigin, canvasShortEdge, cornerRadiusPixels, rotatedOrigin, roundNormalized, toNormalized, toPixels } from './designTemplates/geometry.js';
import type { ResolvedText } from './designTemplates/resolve.js';
import { TEMPLATE_LIMITS, TemplateError, isTemplateFont } from './designTemplates/schema.js';
import { TEXT_LIMITS } from './text.js';

type Stack = Pick<DesignVariant, 'elements' | 'layers'>;
export type PaintItem = { kind: 'layer'; layer: DesignLayer } | { kind: 'text'; element: TextElement };

/** Some element says where it sits in the shared order. Without that (every older document) layers are drawn in their list order, then all text. */
export const hasExplicitOrder = (variant: Stack) => variant.elements.some(element => element.zIndex !== undefined) || (variant.layers ?? []).some(layer => layer.zIndex !== undefined);
/**
 * Everything the editor draws above the background, back to front: by zIndex across layers and text alike. Elements
 * without a zIndex come after those with one, in the older order (layers, then text), so a document with no zIndex at
 * all is drawn exactly as it always was.
 */
export function paintOrder(variant: Stack): PaintItem[] {
  const layers = variant.layers ?? [];
  const items = [
    ...layers.map((layer, index) => ({ item: { kind: 'layer', layer } as PaintItem, zIndex: layer.zIndex, older: index })),
    ...variant.elements.map((element, index) => ({ item: { kind: 'text', element } as PaintItem, zIndex: element.zIndex, older: layers.length + index })),
  ];
  const depth = (zIndex: number | undefined) => zIndex ?? Number.POSITIVE_INFINITY;
  return items.sort((a, b) => depth(a.zIndex) === depth(b.zIndex) ? a.older - b.older : depth(a.zIndex) - depth(b.zIndex)).map(entry => entry.item);
}

/** A text with a height is a fixed text box: it is drawn by the shared overflow policy, like a template text. */
export type TextBox = TextElement & { height: number };
export const isTextBox = (element: TextElement): element is TextBox => element.height !== undefined;
/** A fixed text box in the form the shared text fitting and drawing take (designTemplates/textFit.ts), so the editor draws it exactly as Template Studio does. */
export function textBoxOf(element: TextBox): ResolvedText {
  return {
    id: element.id, name: element.name ?? '', zIndex: element.zIndex ?? 0, type: 'text', role: canvasTextRole(element.role),
    box: { x: element.x, y: element.y, width: element.width, height: element.height, rotation: element.rotation ?? 0 },
    text: element.text, fontFamily: element.fontFamily, fontPx: element.fontSize, minFontPx: Math.min(element.minFontSize ?? element.fontSize, element.fontSize),
    fontWeight: element.fontWeight, color: element.fill, align: element.align, verticalAlign: element.verticalAlign ?? 'top', lineHeight: element.lineHeight,
    letterSpacing: element.fontSize ? element.letterSpacing / element.fontSize : 0, backgroundColor: element.box?.fill ?? null, cornerRadiusPx: element.box?.radius ?? 0,
    maxLines: element.maxLines ?? TEMPLATE_LIMITS.maxLines, overflow: element.overflow ?? 'ellipsis',
  };
}

const canvasTextRole = (role: TextElement['role']): CanvasTextRole =>
  (CANVAS_TEXT_ROLES as readonly string[]).includes(role) ? role as CanvasTextRole : role === 'title' ? 'heading' : role === 'body' ? 'paragraph' : 'generic-text';
const SHAPE_TYPES: Record<CanvasShapeRole, ShapeLayerElement['shapeType']> = { rectangle: 'rectangle', 'rounded-rectangle': 'rounded-rectangle', decorative: 'rounded-rectangle', circle: 'circle', ellipse: 'ellipse' };

export interface VariantSource {
  id: string; name: string;
  /** Where the elements came from, recorded on the design. */
  template: { templateId: string; templateVersion: number; creativeId?: string };
  /** The editor's own copy of each picture: asset id in the elements → asset id the design uses. Absent: the same ids. */
  assets?: Record<string, string>;
}

/**
 * The elements as an editor design on this canvas. Every shared property is carried over; nothing the editor cannot
 * hold is dropped quietly: a text the editor's limits do not allow (font, font size, width) is refused with the reason.
 */
export function canvasElementsToVariant(elements: readonly CanvasElement[], canvas: CanvasSize, source: VariantSource): DesignVariant {
  const shortEdge = canvasShortEdge(canvas);
  const refuse = (message: string): never => { throw new TemplateError('EDITOR_CANNOT_HOLD', message); };
  const asset = (assetId: string) => {
    const mapped = source.assets ? source.assets[assetId] : assetId;
    return mapped ?? refuse(`The picture "${assetId}" is missing from this browser. Replace it, then open the design in the editor.`);
  };
  const ordered = elements.map((element, index) => ({ element, index })).sort((a, b) => a.element.zIndex - b.element.zIndex || a.index - b.index).map(entry => entry.element);
  const texts: TextElement[] = [], layers: DesignLayer[] = [];
  let backdrop: CanvasBackgroundElement | undefined;
  for (const element of ordered) {
    if (element.type === 'background') { backdrop = element; continue; }
    const box = toPixels(element.layout, canvas), origin = rotatedOrigin(box);
    const shared = { zIndex: element.zIndex, editable: { ...element.editableProperties } };
    if (element.type === 'text') {
      const fontSize = element.style.fontSize * shortEdge;
      if (!isTemplateFont(element.style.fontFamily)) refuse(`"${element.name}" uses the font "${element.style.fontFamily}", which the editor does not have.`);
      if (fontSize < TEXT_LIMITS.minFontSize || fontSize > TEXT_LIMITS.maxFontSize) refuse(`"${element.name}" has a font size of ${Math.round(fontSize * 10) / 10} px on this canvas; the editor takes ${TEXT_LIMITS.minFontSize} to ${TEXT_LIMITS.maxFontSize} px.`);
      if (box.width < TEXT_LIMITS.minWidth || box.width > TEXT_LIMITS.maxWidth) refuse(`"${element.name}" is ${Math.round(box.width)} px wide on this canvas; the editor takes text ${TEXT_LIMITS.minWidth} to ${TEXT_LIMITS.maxWidth} px wide.`);
      texts.push({
        id: element.id, type: 'text', role: element.role, text: element.defaultContent.text, x: origin.x, y: origin.y, width: box.width,
        fontFamily: element.style.fontFamily, fontSize, fontWeight: element.style.fontWeight, fill: element.style.color, align: element.style.align, lineHeight: element.style.lineHeight,
        letterSpacing: element.style.letterSpacing * fontSize, name: element.name, rotation: box.rotation, ...shared, ...(element.visible !== undefined ? { visible: element.visible } : {}),
        height: box.height, verticalAlign: element.style.verticalAlign, maxLines: element.behavior.maxLines, overflow: element.behavior.overflow, minFontSize: element.behavior.minFontSize * shortEdge,
        ...(element.style.backgroundColor !== null || element.style.cornerRadius !== 0 ? { box: { fill: element.style.backgroundColor, radius: cornerRadiusPixels(element.style.cornerRadius, box) } } : {}),
      });
      continue;
    }
    const base = { id: element.id, name: element.name, x: origin.x, y: origin.y, width: box.width, height: box.height, rotation: box.rotation, opacity: element.style.opacity, visible: element.visible !== false, locked: false, role: element.role, ...shared };
    if (element.type === 'image') {
      layers.push({ ...base, type: 'image', ...(element.defaultContent.assetId ? { assetId: asset(element.defaultContent.assetId) } : {}), fit: element.behavior.fit,
        focalPoint: { x: element.behavior.focalX, y: element.behavior.focalY }, radius: cornerRadiusPixels(element.style.cornerRadius, box) });
    } else {
      layers.push({ ...base, type: 'shape', shapeType: SHAPE_TYPES[element.role], fill: element.style.fill, radius: cornerRadiusPixels(element.style.cornerRadius, box),
        ...(element.style.gradient ? { gradient: { ...element.style.gradient } } : {}), ...(element.style.stroke !== null ? { stroke: { color: element.style.stroke, width: element.style.strokeWidth * shortEdge } } : {}) });
    }
  }
  if (texts.length > TEXT_LIMITS.maxElements) refuse(`The editor takes at most ${TEXT_LIMITS.maxElements} text elements.`);
  return {
    id: source.id, name: source.name, revision: 0,
    canvas: { width: canvas.width, height: canvas.height, backgroundColor: backdrop?.defaultContent.color ?? '#FFFFFF' },
    elements: texts, layers,
    ...(backdrop?.defaultContent.assetId ? { background: { assetId: asset(backdrop.defaultContent.assetId), fit: backdrop.behavior.fit, focalPoint: { x: backdrop.behavior.focalX, y: backdrop.behavior.focalY } } } : {}),
    template: { ...source.template, ...(backdrop ? { background: { id: backdrop.id, name: backdrop.name, fit: backdrop.behavior.fit, focalPoint: { x: backdrop.behavior.focalX, y: backdrop.behavior.focalY }, editable: { ...backdrop.editableProperties } } } : {}) },
  };
}

/**
 * An editor design as normalized CanvasElements: the inverse of canvasElementsToVariant, and the way any editor design,
 * older ones included, is read as the shared model. Pixels become fractions of the design's canvas (rounded and kept
 * inside the canvas, like every stored layout); the order is one zIndex per element.
 *
 * A free text made in the editor has no box height of its own: `textHeight` supplies its measured height (the browser
 * measures with Konva); without it, the height of its explicit lines is used. Editor-only state that is not part of a
 * design's content (a layer's lock, decomposition provenance) has no place in the shared model.
 */
export function variantToCanvasElements(variant: DesignVariant, options: { textHeight?: (element: TextElement) => number } = {}): CanvasElement[] {
  const canvas = { width: variant.canvas.width, height: variant.canvas.height }, shortEdge = canvasShortEdge(canvas);
  const items = paintOrder(variant), kept = variant.template?.background;
  // A design from a template has a background element only if the template had one; any other design has one unless its canvas is transparent.
  const background: CanvasBackgroundElement | undefined = (variant.template ? !kept : variant.canvas.transparent) ? undefined : {
    id: kept?.id ?? 'background', name: kept?.name ?? 'Background', type: 'background', role: 'background', zIndex: 0, layout: { ...FULL_CANVAS },
    defaultContent: { color: variant.canvas.backgroundColor, assetId: variant.background?.assetId ?? null }, style: {},
    behavior: { fit: variant.background?.fit ?? kept?.fit ?? 'cover', focalX: variant.background?.focalPoint.x ?? kept?.focalPoint.x ?? 0.5, focalY: variant.background?.focalPoint.y ?? kept?.focalPoint.y ?? 0.5 },
    editableProperties: { ...(kept?.editable ?? ALL_LOCKED) },
  };
  // The stored zIndex values are kept when they form a valid order above the background; otherwise the drawn order is numbered.
  const depths = items.map(item => item.kind === 'layer' ? item.layer.zIndex : item.element.zIndex);
  const usable = depths.every((depth, index) => depth !== undefined && Number.isInteger(depth) && depth >= (background ? 1 : 0) && depths.indexOf(depth) === index);
  const depthOf = (index: number) => usable ? depths[index]! : index + (background ? 1 : 0);
  const radiusOf = (radius: number, width: number, height: number) => roundNormalized(Math.min(1, radius / (Math.min(width, height) / 2)));
  const elements = items.map((item, index): CanvasElement => {
    if (item.kind === 'text') {
      const text = item.element, height = text.height ?? options.textHeight?.(text) ?? text.text.split('\n').length * text.fontSize * text.lineHeight;
      const element: CanvasTextElement = {
        id: text.id, name: text.name ?? (text.text.trim().slice(0, 40) || 'Text'), type: 'text', role: canvasTextRole(text.role), zIndex: depthOf(index),
        layout: toNormalized(boxFromOrigin(text, text.width, height, text.rotation ?? 0), canvas), ...(text.visible !== undefined ? { visible: text.visible } : {}),
        defaultContent: { text: text.text },
        style: { fontFamily: text.fontFamily, fontSize: roundNormalized(text.fontSize / shortEdge), fontWeight: text.fontWeight, color: text.fill, align: text.align, verticalAlign: text.verticalAlign ?? 'top',
          lineHeight: text.lineHeight, letterSpacing: roundNormalized(text.letterSpacing / text.fontSize), backgroundColor: text.box?.fill ?? null, cornerRadius: text.box ? radiusOf(text.box.radius, text.width, height) : 0 },
        behavior: { maxLines: text.maxLines ?? TEMPLATE_LIMITS.maxLines, overflow: text.overflow ?? 'ellipsis', minFontSize: roundNormalized((text.minFontSize ?? text.fontSize) / shortEdge) },
        editableProperties: { ...(text.editable ?? ALL_LOCKED) },
      };
      return element;
    }
    const layer = item.layer;
    const base = { id: layer.id, name: layer.name, zIndex: depthOf(index), layout: toNormalized(boxFromOrigin(layer, layer.width, layer.height, layer.rotation), canvas),
      ...(layer.visible ? {} : { visible: false }), editableProperties: { ...(layer.editable ?? ALL_LOCKED) } };
    if (layer.type === 'image') {
      const image: CanvasImageElement = { ...base, type: 'image', role: (CANVAS_IMAGE_ROLES as readonly string[]).includes(layer.role ?? '') ? layer.role as CanvasImageRole : 'generic-image',
        defaultContent: { assetId: layer.assetId ?? null }, style: { opacity: layer.opacity, cornerRadius: radiusOf(layer.radius ?? 0, layer.width, layer.height) },
        // A picture the editor stretches to its box has no fit of its own; its box has the picture's shape, so contain shows it the same.
        behavior: { fit: layer.fit ?? 'contain', focalX: layer.focalPoint?.x ?? 0.5, focalY: layer.focalPoint?.y ?? 0.5 } };
      return image;
    }
    const shape: CanvasShapeElement = { ...base, type: 'shape', role: (CANVAS_SHAPE_ROLES as readonly string[]).includes(layer.role ?? '') ? layer.role as CanvasShapeRole : layer.shapeType, defaultContent: {}, behavior: {},
      style: { fill: layer.fill, opacity: layer.opacity, cornerRadius: radiusOf(layer.radius, layer.width, layer.height), stroke: layer.stroke?.color ?? null, strokeWidth: layer.stroke ? roundNormalized(layer.stroke.width / shortEdge) : 0,
        ...(layer.gradient ? { gradient: { ...layer.gradient } } : {}) } };
    return shape;
  });
  return background ? [background, ...elements] : elements;
}
