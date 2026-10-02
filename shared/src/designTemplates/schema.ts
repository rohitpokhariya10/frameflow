/**
 * Reusable design templates ("Create Own Template"). A TEMPLATE is a fixed, reusable design structure; a CREATIVE
 * (creative.ts) is one content-filled instance of it. Everything in this folder is local and deterministic: no AI, no
 * network, no pixels stored.
 *
 * Geometry is canonical in NORMALIZED form: x, y, width and height are fractions (0..1) of the canvas width and height,
 * with optional per-ratio layouts for themes. Pixels exist only while rendering (geometry.ts). Sizes that are not
 * boxes are normalized too: a font size is a fraction of the canvas short edge, letter spacing is in em, a corner
 * radius is a fraction of half the box's shorter side. Rotation is in degrees, about the box centre.
 */
import { CANVAS_ELEMENT_TYPES, CANVAS_IMAGE_ROLES, CANVAS_SHAPE_ROLES, CANVAS_TEXT_ROLES, EDITABLE_PROPERTIES, type CanvasBackgroundElement, type CanvasElement, type CanvasElementType, type CanvasImageElement,
  type CanvasImageRole, type CanvasShapeElement, type CanvasShapeRole, type CanvasShapeStyle, type CanvasTextBehavior, type CanvasTextElement, type CanvasTextRole, type CanvasTextStyle, type NormalizedLayout } from '../canvasElement.js';
import { parseThemeSpec, type OfferTemplateMetadata } from './themeSpec.js';
import { isCatalogFont } from '../fonts/catalog.js';
import { TEXT_FONTS, TEXT_WEIGHTS } from '../text.js';

export const TEMPLATE_SCHEMA_VERSION = 1;
export const DESIGN_ASPECT_RATIOS = ['1:1', '4:5', '3:4', '9:16', '16:9'] as const;
export type DesignAspectRatio = typeof DESIGN_ASPECT_RATIOS[number];

/**
 * minSize keeps a box from collapsing to nothing (0.5% of the canvas); the larger size needed to grab an element with
 * the pointer is the authoring canvas's own rule, in screen pixels. precision: stored values are rounded to 6 decimals.
 */
export const LAYOUT_LIMITS = { minSize: 0.005, precision: 1e6, tolerance: 1e-9 } as const;
export const TEMPLATE_LIMITS = { maxElements: 50, maxName: 200, maxText: 5000, maxLines: 50 } as const;

// A template's elements are CanvasElements (../canvasElement.ts), the model shared with Creative mode and the editor.
// The Template* names below are the same types and constants under the names the template code was written with.
export { ALL_LOCKED, EDITABLE_PROPERTIES, FULL_CANVAS, type EditableProperties, type EditableProperty, type ImageBehavior, type ImageFit, type NormalizedLayout } from '../canvasElement.js';
export const TEMPLATE_TEXT_ROLES = CANVAS_TEXT_ROLES, TEMPLATE_IMAGE_ROLES = CANVAS_IMAGE_ROLES, TEMPLATE_SHAPE_ROLES = CANVAS_SHAPE_ROLES, TEMPLATE_ELEMENT_TYPES = CANVAS_ELEMENT_TYPES;
export type TemplateTextRole = CanvasTextRole;
export type TemplateImageRole = CanvasImageRole;
export type TemplateShapeRole = CanvasShapeRole;
export type TemplateTextStyle = CanvasTextStyle;
export type TemplateTextBehavior = CanvasTextBehavior;
export type TemplateShapeStyle = CanvasShapeStyle;
export type TemplateTextElement = CanvasTextElement;
export type TemplateImageElement = CanvasImageElement;
export type TemplateShapeElement = CanvasShapeElement;
export type TemplateBackgroundElement = CanvasBackgroundElement;
export type TemplateElement = CanvasElement;
export type TemplateElementType = CanvasElementType;

/**
 * One saved version of a template (library.ts): a saved version is never modified. `elements` is ordered back to front
 * by zIndex. canvas.masterAspectRatio is the ratio it was designed in; the layout itself belongs to no ratio.
 */
export interface DesignTemplate {
  schemaVersion: typeof TEMPLATE_SCHEMA_VERSION; id: string; name: string; version: number;
  supportedAspectRatios: DesignAspectRatio[]; canvas: { masterAspectRatio: DesignAspectRatio };
  themeId?: string; offerTemplate?: OfferTemplateMetadata;
  /** A server-stored ratio set, associated explicitly; its raster images never replace native elements. */
  referenceSetId?: string;
  elements: TemplateElement[]; createdAt: string; updatedAt: string;
}

export type TemplateIssue = { severity: 'error' | 'warning'; path: string; message: string };
/** A refused template operation; `issues` lists what is wrong when it came from validation. */
export class TemplateError extends Error {
  constructor(public readonly code: string, message: string, public readonly issues: TemplateIssue[] = []) { super(message); this.name = 'TemplateError'; }
}

export const DEFAULT_TEMPLATE_FONT = TEXT_FONTS[0];
export const isTemplateFont = isCatalogFont;
/** The font to draw with: the element's own when it is available, else the default (validation warns about the miss). */
export const usableFont = (fontFamily: string) => isTemplateFont(fontFamily) ? fontFamily : DEFAULT_TEMPLATE_FONT;
export const isDesignAspectRatio = (value: unknown): value is DesignAspectRatio => DESIGN_ASPECT_RATIOS.some(ratio => ratio === value);

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const between = (v: unknown, min: number, max: number): v is number => finite(v) && v >= min && v <= max;
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/^(blob:|data:)/i.test(v);
export const isTemplateColor = (v: unknown): v is string => typeof v === 'string' && /^#[\da-f]{6}$/i.test(v);
const isDate = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const isAsset = (v: unknown) => v === null || isId(v);
const ROLES: Record<TemplateElementType, readonly string[]> = { text: TEMPLATE_TEXT_ROLES, image: TEMPLATE_IMAGE_ROLES, shape: TEMPLATE_SHAPE_ROLES, background: ['background'] };

/** Problems with a layout's numbers; empty when it is a valid canonical layout. Nothing is corrected here. */
export function layoutProblems(layout: unknown): string[] {
  if (!isRecord(layout)) return ['layout must be an object with x, y, width, height and rotation.'];
  const problems: string[] = [], { x, y, width, height, rotation } = layout, { minSize, tolerance } = LAYOUT_LIMITS;
  for (const [key, value] of [['x', x], ['y', y], ['width', width], ['height', height], ['rotation', rotation]] as const) if (!finite(value)) problems.push(`${key} must be a finite number.`);
  if (problems.length) return problems;
  const n = layout as unknown as NormalizedLayout;
  for (const key of ['width', 'height'] as const) if (n[key] < minSize || n[key] > 1) problems.push(`${key} ${n[key]} is outside ${minSize}..1.`);
  for (const [position, size] of [['x', 'width'], ['y', 'height']] as const) {
    if (n[position] < 0) problems.push(`${position} ${n[position]} is negative.`);
    else if (n[position] + n[size] > 1 + tolerance) problems.push(`${position} + ${size} is ${n[position] + n[size]}: the element leaves the canvas.`);
  }
  if (n.rotation < -360 || n.rotation > 360) problems.push(`rotation ${n.rotation} is outside -360..360 degrees.`);
  return problems;
}

function imageBehaviorProblems(behavior: unknown): string[] {
  if (!isRecord(behavior)) return ['behavior must be an object.'];
  return [
    ...(behavior.fit === 'cover' || behavior.fit === 'contain' ? [] : ['behavior.fit must be "cover" or "contain".']),
    ...(['focalX', 'focalY'] as const).filter(key => !between(behavior[key], 0, 1)).map(key => `behavior.${key} must be 0..1.`),
  ];
}

function elementIssues(element: unknown, path: string): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const error = (message: string, at = path) => { issues.push({ severity: 'error', path: at, message }); };
  if (!isRecord(element)) { error('An element must be an object.'); return issues; }
  if (!isId(element.id)) error('id must be a non-empty string.');
  if (typeof element.name !== 'string' || element.name.length > TEMPLATE_LIMITS.maxName) error(`name must be text of at most ${TEMPLATE_LIMITS.maxName} characters.`);
  const type = element.type as TemplateElementType;
  if (!TEMPLATE_ELEMENT_TYPES.includes(type)) { error(`Unsupported element type ${JSON.stringify(element.type)}; supported: ${TEMPLATE_ELEMENT_TYPES.join(', ')}.`); return issues; }
  if (!ROLES[type].includes(element.role as string)) error(`role ${JSON.stringify(element.role)} is not a ${type} role (${ROLES[type].join(', ')}).`);
  if (!Number.isInteger(element.zIndex)) error('zIndex must be a whole number.');
  for (const problem of layoutProblems(element.layout)) error(problem, `${path}.layout`);
  if (element.themeRole !== undefined && (typeof element.themeRole !== 'string' || element.themeRole.length > 100)) error('themeRole must be short text.');
  if (element.ratioLayouts !== undefined) {
    if (!isRecord(element.ratioLayouts)) error('ratioLayouts must be an object.');
    else for (const [ratio, layout] of Object.entries(element.ratioLayouts)) {
      if (!isDesignAspectRatio(ratio)) error('Unknown ratio layout.');
      for (const problem of layoutProblems(layout)) error(problem, `${path}.ratioLayouts.${ratio}`);
    }
  }
  if (element.visible !== undefined && typeof element.visible !== 'boolean') error('visible must be true or false.');
  if (!isRecord(element.editableProperties) || !EDITABLE_PROPERTIES.every(key => typeof (element.editableProperties as Record<string, unknown>)[key] === 'boolean')) {
    error(`editableProperties must say true or false for each of ${EDITABLE_PROPERTIES.join(', ')}.`);
  }
  const content = element.defaultContent, style = element.style, behavior = element.behavior;
  if (!isRecord(content) || !isRecord(style) || !isRecord(behavior)) { error('defaultContent, style and behavior must be objects.'); return issues; }
  if (type === 'text') {
    if (typeof content.text !== 'string' || content.text.length > TEMPLATE_LIMITS.maxText) error(`defaultContent.text must be text of at most ${TEMPLATE_LIMITS.maxText} characters.`);
    if (typeof style.fontFamily !== 'string' || !style.fontFamily) error('style.fontFamily must name a font.');
    else if (!isTemplateFont(style.fontFamily)) issues.push({ severity: 'warning', path: `${path}.style.fontFamily`, message: `Font "${style.fontFamily}" is not available here (${TEXT_FONTS.join(', ')}); ${DEFAULT_TEMPLATE_FONT} is used instead.` });
    if (!finite(style.fontSize) || style.fontSize <= 0 || style.fontSize > 1) error('style.fontSize must be a fraction of the canvas short edge, above 0 and at most 1.');
    if (!TEXT_WEIGHTS.some(weight => weight === style.fontWeight)) error(`style.fontWeight must be one of ${TEXT_WEIGHTS.join(', ')}.`);
    if (!isTemplateColor(style.color)) error('style.color must be a #rrggbb colour.');
    if (!['left', 'center', 'right'].includes(style.align as string)) error('style.align must be left, center or right.');
    if (!['top', 'middle', 'bottom'].includes(style.verticalAlign as string)) error('style.verticalAlign must be top, middle or bottom.');
    if (!between(style.lineHeight, 0.5, 4)) error('style.lineHeight must be 0.5..4.');
    if (!between(style.letterSpacing, -0.5, 2)) error('style.letterSpacing must be -0.5..2 em.');
    if (style.backgroundColor !== null && !isTemplateColor(style.backgroundColor)) error('style.backgroundColor must be a #rrggbb colour or null.');
    if (!between(style.cornerRadius, 0, 1)) error('style.cornerRadius must be 0..1.');
    if (!Number.isInteger(behavior.maxLines) || !between(behavior.maxLines, 1, TEMPLATE_LIMITS.maxLines)) error(`behavior.maxLines must be a whole number from 1 to ${TEMPLATE_LIMITS.maxLines}.`);
    if (behavior.overflow !== 'shrink' && behavior.overflow !== 'ellipsis') error('behavior.overflow must be "shrink" or "ellipsis".');
    if (!finite(behavior.minFontSize) || behavior.minFontSize <= 0 || (finite(style.fontSize) && behavior.minFontSize > style.fontSize)) error('behavior.minFontSize must be above 0 and at most style.fontSize.');
  } else if (type === 'image') {
    if (!isAsset(content.assetId)) error('defaultContent.assetId must be an asset id or null.');
    if (!between(style.opacity, 0, 1)) error('style.opacity must be 0..1.');
    if (!between(style.cornerRadius, 0, 1)) error('style.cornerRadius must be 0..1.');
    for (const problem of imageBehaviorProblems(behavior)) error(problem);
  } else if (type === 'shape') {
    if (!isTemplateColor(style.fill)) error('style.fill must be a #rrggbb colour.');
    if (!between(style.opacity, 0, 1)) error('style.opacity must be 0..1.');
    if (!between(style.cornerRadius, 0, 1)) error('style.cornerRadius must be 0..1.');
    if (style.stroke !== null && !isTemplateColor(style.stroke)) error('style.stroke must be a #rrggbb colour or null.');
    if (!between(style.strokeWidth, 0, 0.2)) error('style.strokeWidth must be 0..0.2 of the canvas short edge.');
    if (style.gradient !== undefined && (!isRecord(style.gradient) || !isTemplateColor(style.gradient.from) || !isTemplateColor(style.gradient.to) || !between(style.gradient.angle, -360, 360))) error('style.gradient must have #rrggbb colours "from" and "to" and an angle of -360..360 degrees.');
  } else {
    if (!isTemplateColor(content.color)) error('defaultContent.color must be a #rrggbb colour.');
    if (!isAsset(content.assetId)) error('defaultContent.assetId must be an asset id or null.');
    for (const problem of imageBehaviorProblems(behavior)) error(problem);
    const layout = element.layout as NormalizedLayout;
    if (!layoutProblems(layout).length && (layout.x !== 0 || layout.y !== 0 || layout.width !== 1 || layout.height !== 1 || layout.rotation !== 0)) error('The background always covers the whole canvas (x 0, y 0, width 1, height 1, rotation 0).', `${path}.layout`);
  }
  return issues;
}

/**
 * Checks a template without changing it: errors make it unusable, warnings (a font that is not available) do not.
 * Nothing is corrected or dropped here, so a template that loads is exactly the template that was saved.
 */
export function templateIssues(value: unknown): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const error = (path: string, message: string) => { issues.push({ severity: 'error', path, message }); };
  if (!isRecord(value)) return [{ severity: 'error', path: 'template', message: 'A template must be an object.' }];
  if (value.referenceSetId !== undefined && (typeof value.referenceSetId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(value.referenceSetId))) error('referenceSetId', 'Invalid reference set identifier.');
  if (value.themeId !== undefined && (typeof value.themeId !== 'string' || value.themeId.length > 100)) error('themeId', 'themeId must be short text.');
  if (value.offerTemplate !== undefined) {
    try { const m = value.offerTemplate as OfferTemplateMetadata; if (!m || m.version !== 1 || !['curated','ai'].includes(m.source) || m.festival !== 'diwali' || !isId(m.definitionId)) throw new Error(); parseThemeSpec(m.spec); }
    catch { error('offerTemplate', 'Invalid offer template metadata.'); }
  }
  if (value.schemaVersion !== TEMPLATE_SCHEMA_VERSION) error('schemaVersion', `Unsupported template schema version ${JSON.stringify(value.schemaVersion)}; this build reads version ${TEMPLATE_SCHEMA_VERSION}.`);
  if (!isId(value.id)) error('id', 'id must be a non-empty string.');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > TEMPLATE_LIMITS.maxName) error('name', `name must be 1 to ${TEMPLATE_LIMITS.maxName} characters.`);
  if (!Number.isInteger(value.version) || (value.version as number) < 1) error('version', 'version must be a whole number from 1.');
  if (!isDate(value.createdAt) || !isDate(value.updatedAt)) error('createdAt', 'createdAt and updatedAt must be dates.');
  const ratios = value.supportedAspectRatios;
  if (!Array.isArray(ratios) || !ratios.length) error('supportedAspectRatios', 'At least one aspect ratio must be supported.');
  else {
    for (const ratio of ratios) if (!isDesignAspectRatio(ratio)) error('supportedAspectRatios', `Invalid aspect ratio ${JSON.stringify(ratio)}; supported: ${DESIGN_ASPECT_RATIOS.join(', ')}.`);
    if (new Set(ratios).size !== ratios.length) error('supportedAspectRatios', 'An aspect ratio is listed twice.');
  }
  const master = isRecord(value.canvas) ? value.canvas.masterAspectRatio : undefined;
  if (!isDesignAspectRatio(master)) error('canvas.masterAspectRatio', `Invalid aspect ratio ${JSON.stringify(master)}; supported: ${DESIGN_ASPECT_RATIOS.join(', ')}.`);
  else if (Array.isArray(ratios) && !ratios.includes(master)) error('canvas.masterAspectRatio', `The master aspect ratio ${master} must be one of the supported ratios.`);
  if (!Array.isArray(value.elements)) { error('elements', 'elements must be a list.'); return issues; }
  if (value.elements.length > TEMPLATE_LIMITS.maxElements) error('elements', `A template has at most ${TEMPLATE_LIMITS.maxElements} elements.`);
  value.elements.forEach((element, index) => { issues.push(...elementIssues(element, `elements[${index}]`)); });
  const elements = value.elements.filter(isRecord);
  const seen = new Set<unknown>(), depths = new Set<unknown>();
  for (const element of elements) {
    if (isId(element.id) && seen.has(element.id)) error('elements', `Duplicate element id "${element.id}".`);
    seen.add(element.id);
    if (Number.isInteger(element.zIndex) && depths.has(element.zIndex)) error('elements', `zIndex ${element.zIndex} is used by more than one element.`);
    depths.add(element.zIndex);
  }
  const backgrounds = elements.filter(element => element.type === 'background');
  if (backgrounds.length > 1) error('elements', 'A template has at most one background.');
  const backgroundDepth = backgrounds[0]?.zIndex;
  if (backgrounds.length === 1 && finite(backgroundDepth) && elements.some(element => element !== backgrounds[0] && finite(element.zIndex) && element.zIndex <= backgroundDepth)) error('elements', 'The background must have the lowest zIndex.');
  return issues;
}
export const templateErrors = (value: unknown) => templateIssues(value).filter(issue => issue.severity === 'error');
export const isDesignTemplate = (value: unknown): value is DesignTemplate => templateErrors(value).length === 0;
/** The template, or a TemplateError listing every problem. */
export function assertDesignTemplate(value: unknown): DesignTemplate {
  const errors = templateErrors(value);
  if (errors.length) throw new TemplateError('INVALID_TEMPLATE', `The template is not valid: ${errors.map(issue => `${issue.path}: ${issue.message}`).join(' ')}`, errors);
  return value as DesignTemplate;
}
