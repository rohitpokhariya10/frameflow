/**
 * Template authoring: the operations the template author's editor performs. Pure and immutable: each returns a new
 * template (or the same one when nothing changed) and never touches its input. Geometry is created here, and only
 * here; a creative (creative.ts) cannot reach these.
 */
import type { CanvasSize } from '../index.js';
import { clampLayout, toNormalized, toPixels, type PixelBox } from './geometry.js';
import { FULL_CANVAS, ALL_LOCKED, TEMPLATE_IMAGE_ROLES, TEMPLATE_LIMITS, TEMPLATE_SCHEMA_VERSION, TEMPLATE_SHAPE_ROLES, TEMPLATE_TEXT_ROLES, DESIGN_ASPECT_RATIOS, TemplateError,
  type DesignTemplate, type NormalizedLayout, type DesignAspectRatio, type TemplateElement, type TemplateImageRole, type TemplateShapeRole, type TemplateTextRole, type TemplateTextStyle } from './schema.js';

export type TemplateElementRole = TemplateTextRole | TemplateImageRole | TemplateShapeRole | 'background';

/** A new, unsaved template: no elements, every aspect ratio supported. It becomes version 1 when first saved. */
export function createTemplateDraft(id: string, now: string, name = 'Untitled template', masterAspectRatio: DesignAspectRatio = '1:1'): DesignTemplate {
  return { schemaVersion: TEMPLATE_SCHEMA_VERSION, id, name, version: 1, supportedAspectRatios: [...DESIGN_ASPECT_RATIOS], canvas: { masterAspectRatio }, elements: [], createdAt: now, updatedAt: now };
}

const box = (x: number, y: number, width: number, height: number): NormalizedLayout => ({ x, y, width, height, rotation: 0 });
const textStyle = (fontFamily: string, fontSize: number, fontWeight: 400 | 600 | 700, extra: Partial<TemplateTextStyle> = {}): TemplateTextStyle =>
  ({ fontFamily, fontSize, fontWeight, color: '#1F2925', align: 'left', verticalAlign: 'top', lineHeight: 1.2, letterSpacing: 0, backgroundColor: null, cornerRadius: 0, ...extra });

/**
 * A new element of the given role with a starting box, style and editable properties. The starting values are only a
 * convenience for the author; nothing about a role is fixed except what it means (a CTA is still just a text box).
 * `placed`: how many elements the template already has, used to stagger new ones so they do not hide each other.
 */
export function createTemplateElement(role: TemplateElementRole, id: string, zIndex: number, placed = 0): TemplateElement {
  const nudge = (layout: NormalizedLayout) => clampLayout({ ...layout, x: layout.x + (placed % 5) * 0.02, y: layout.y + (placed % 5) * 0.02 });
  const text = (name: string, content: string, layout: NormalizedLayout, style: TemplateTextStyle, maxLines: number, editable: Partial<typeof ALL_LOCKED> = {}): TemplateElement =>
    ({ id, name, type: 'text', role: role as TemplateTextRole, zIndex, layout: nudge(layout), defaultContent: { text: content }, style,
      behavior: { maxLines, overflow: 'shrink', minFontSize: Math.round(style.fontSize * 500) / 1000 }, editableProperties: { ...ALL_LOCKED, content: true, color: true, ...editable } });
  const image = (name: string, layout: NormalizedLayout, fit: 'cover' | 'contain'): TemplateElement =>
    ({ id, name, type: 'image', role: role as TemplateImageRole, zIndex, layout: nudge(layout), defaultContent: { assetId: null }, style: { opacity: 1, cornerRadius: 0 }, behavior: { fit, focalX: 0.5, focalY: 0.5 }, editableProperties: { ...ALL_LOCKED, image: true } });
  const shape = (name: string, layout: NormalizedLayout, cornerRadius: number, opacity = 1): TemplateElement =>
    ({ id, name, type: 'shape', role: role as TemplateShapeRole, zIndex, layout: nudge(layout), defaultContent: {}, style: { fill: '#285443', opacity, cornerRadius, stroke: null, strokeWidth: 0 }, behavior: {}, editableProperties: { ...ALL_LOCKED, color: true } });
  switch (role) {
    case 'heading': return text('Heading', 'Heading', box(0.08, 0.1, 0.84, 0.16), textStyle('Lora', 0.075, 700, { lineHeight: 1.1 }), 2);
    case 'subheading': return text('Subheading', 'Subheading', box(0.08, 0.28, 0.84, 0.08), textStyle('Inter', 0.04, 600), 2);
    case 'paragraph': return text('Paragraph', 'Paragraph text', box(0.08, 0.38, 0.6, 0.18), textStyle('Inter', 0.028, 400, { lineHeight: 1.4 }), 5);
    case 'offer': return text('Offer', 'Offer', box(0.08, 0.58, 0.5, 0.12), textStyle('Inter', 0.09, 700, { lineHeight: 1.05 }), 1);
    case 'cta': return text('CTA', 'Call to action', box(0.08, 0.8, 0.36, 0.08), textStyle('Inter', 0.032, 600, { color: '#FFFFFF', align: 'center', verticalAlign: 'middle', backgroundColor: '#285443', cornerRadius: 1 }), 1, { backgroundColor: true });
    case 'generic-text': return text('Text', 'Text', box(0.3, 0.46, 0.4, 0.08), textStyle('Inter', 0.032, 400), 2);
    case 'hero': return image('Hero image', box(0.45, 0.2, 0.5, 0.55), 'cover');
    case 'logo': return image('Logo', box(0.05, 0.04, 0.18, 0.08), 'contain');
    case 'product': return image('Product image', box(0.3, 0.3, 0.4, 0.4), 'contain');
    case 'generic-image': return image('Image', box(0.3, 0.3, 0.4, 0.3), 'cover');
    case 'rectangle': return shape('Rectangle', box(0.1, 0.7, 0.3, 0.15), 0);
    case 'rounded-rectangle': return shape('Rounded rectangle', box(0.1, 0.7, 0.3, 0.15), 0.3);
    case 'circle': return shape('Circle', box(0.7, 0.1, 0.2, 0.2), 1);
    case 'ellipse': return shape('Ellipse', box(0.6, 0.1, 0.3, 0.2), 1);
    case 'decorative': return shape('Decoration', box(0.6, 0.62, 0.3, 0.3), 1, 0.35);
    case 'background': return { id, name: 'Background', type: 'background', role: 'background', zIndex, layout: { ...FULL_CANVAS }, defaultContent: { color: '#FFFEFA', assetId: null }, style: {}, behavior: { fit: 'cover', focalX: 0.5, focalY: 0.5 }, editableProperties: { ...ALL_LOCKED, color: true, image: true } };
    default: throw new TemplateError('UNSUPPORTED_ELEMENT', `Unsupported element role ${JSON.stringify(role)}; supported: ${[...TEMPLATE_TEXT_ROLES, ...TEMPLATE_IMAGE_ROLES, ...TEMPLATE_SHAPE_ROLES, 'background'].join(', ')}.`);
  }
}

/** Back to front, the background first, numbered 0, 1, 2 …: the stored order is explicit and has no gaps or ties. */
export function orderElements(elements: TemplateElement[]): TemplateElement[] {
  const rank = (element: TemplateElement) => element.type === 'background' ? Number.NEGATIVE_INFINITY : element.zIndex;
  return elements.map((element, index) => ({ element, index })).sort((a, b) => rank(a.element) - rank(b.element) || a.index - b.index)
    .map(({ element }, zIndex) => element.zIndex === zIndex ? element : { ...element, zIndex });
}
export const findElement = (template: Pick<DesignTemplate, 'elements'>, id: string) => template.elements.find(element => element.id === id);
function requireElement(template: DesignTemplate, id: string): TemplateElement {
  const element = findElement(template, id);
  if (!element) throw new TemplateError('ELEMENT_NOT_FOUND', `This template has no element "${id}".`);
  return element;
}

/** Adds an element on top (a background goes to the bottom). Refuses a duplicate id, a second background or a full template. */
export function addElement(template: DesignTemplate, element: TemplateElement): DesignTemplate {
  if (findElement(template, element.id)) throw new TemplateError('DUPLICATE_ELEMENT_ID', `This template already has an element "${element.id}".`);
  if (element.type === 'background' && template.elements.some(item => item.type === 'background')) throw new TemplateError('BACKGROUND_EXISTS', 'This template already has a background; change it instead of adding another.');
  if (template.elements.length >= TEMPLATE_LIMITS.maxElements) throw new TemplateError('TOO_MANY_ELEMENTS', `A template has at most ${TEMPLATE_LIMITS.maxElements} elements.`);
  const top = Math.max(-1, ...template.elements.map(item => item.zIndex)) + 1;
  return { ...template, elements: orderElements([...template.elements, { ...element, zIndex: top }]) };
}
export function removeElement(template: DesignTemplate, id: string): DesignTemplate {
  requireElement(template, id);
  return { ...template, elements: orderElements(template.elements.filter(element => element.id !== id)) };
}
/** Replaces one element with `change(element)`. Its id, type, zIndex and layout are not changed this way. */
export function updateElement(template: DesignTemplate, id: string, change: (element: TemplateElement) => TemplateElement): DesignTemplate {
  const current = requireElement(template, id), next = change(current);
  if (next === current) return template;
  return { ...template, elements: template.elements.map(element => element === current ? { ...next, id: current.id, type: current.type, zIndex: current.zIndex, layout: current.layout } as TemplateElement : element) };
}

/**
 * Sets normalized layout values on an element (clamped into the canvas). The background is always the full canvas and
 * refuses. Returns the same template when the stored layout would not change.
 */
export function setElementLayout(template: DesignTemplate, id: string, change: Partial<NormalizedLayout>): DesignTemplate {
  const current = requireElement(template, id);
  if (current.type === 'background') throw new TemplateError('BACKGROUND_FIXED', 'The background always covers the whole canvas.');
  const layout = clampLayout({ ...current.layout, ...change });
  if ((Object.keys(layout) as (keyof NormalizedLayout)[]).every(key => layout[key] === current.layout[key])) return template;
  return { ...template, elements: template.elements.map(element => element === current ? { ...current, layout } : element) };
}

/** The normalized values for the pixel values a gesture changed on this canvas; untouched values are not converted at all. */
export function pixelChangeToNormalized(current: NormalizedLayout, change: Partial<PixelBox>, canvas: CanvasSize): NormalizedLayout {
  const full = toNormalized({ ...toPixels(current, canvas), ...change }, canvas);
  return clampLayout({
    x: change.x === undefined ? current.x : full.x, y: change.y === undefined ? current.y : full.y,
    width: change.width === undefined ? current.width : full.width, height: change.height === undefined ? current.height : full.height,
    rotation: change.rotation === undefined ? current.rotation : full.rotation,
  });
}
/**
 * A drag or resize on the rendered canvas: the pixel values the canvas reports are converted to normalized values once,
 * here, and stored. A drag passes only x and y, so width, height and rotation keep their exact stored values.
 */
export function commitPixelBox(template: DesignTemplate, id: string, change: Partial<PixelBox>, canvas: CanvasSize): DesignTemplate {
  return setElementLayout(template, id, pixelChangeToNormalized(requireElement(template, id).layout, change, canvas));
}

/** Moves an element in the layer order. The background stays at the bottom whatever is asked. */
export function reorderElement(template: DesignTemplate, id: string, move: 'forward' | 'backward' | 'front' | 'back'): DesignTemplate {
  const current = requireElement(template, id);
  if (current.type === 'background') return template;
  const movable = orderElements(template.elements).filter(element => element.type !== 'background'), from = movable.findIndex(element => element.id === id);
  const to = Math.max(0, Math.min(movable.length - 1, move === 'front' ? movable.length - 1 : move === 'back' ? 0 : move === 'forward' ? from + 1 : from - 1));
  if (to === from) return template;
  const [moved] = movable.splice(from, 1);
  movable.splice(to, 0, moved);
  const background = template.elements.filter(element => element.type === 'background');
  // Numbered in the new order first, so the ordering that follows keeps exactly this sequence.
  return { ...template, elements: orderElements([...background, ...movable].map((element, zIndex) => ({ ...element, zIndex }))) };
}
