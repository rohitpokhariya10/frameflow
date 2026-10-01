import { elementAtRatio } from './responsive.js';
/**
 * Creatives: content-filled instances of a template. A creative holds a reference to one template version, an aspect
 * ratio and the content it changes, never a copy of the template's geometry:
 *
 *   template structure  +  creative content overrides  →  what is rendered
 *
 * An override is accepted only where the template author marked the property editable. Geometry (position, size,
 * rotation) is locked unless the author explicitly opened it for that element.
 */
import { clampLayout } from './geometry.js';
import { findElement } from './editing.js';
import { EDITABLE_PROPERTIES, TEMPLATE_LIMITS, TEMPLATE_SCHEMA_VERSION, TemplateError, isDesignAspectRatio, isTemplateColor, isTemplateFont,
  type DesignTemplate, type EditableProperty, type NormalizedLayout, type DesignAspectRatio, type TemplateElement, type TemplateIssue } from './schema.js';

/**
 * What a creative changes on one element. text: the wording. color: the text colour, a shape's fill or the background
 * colour. backgroundColor: the box behind a text (a CTA's button). assetId, focalX, focalY: the picture in an image slot
 * or the background, and the point of it kept in view. fontFamily: the font. layout: only for geometry the template opened.
 */
export interface ElementOverride {
  text?: string; color?: string; backgroundColor?: string; assetId?: string | null; focalX?: number; focalY?: number; fontFamily?: string;
  layout?: Partial<NormalizedLayout>;
}
export interface Creative {
  schemaVersion: typeof TEMPLATE_SCHEMA_VERSION; id: string; name: string; templateId: string;
  /** The template version this creative was made with and is always rendered with; later template edits do not reach it. */
  templateVersion: number;
  aspectRatio: DesignAspectRatio;
  /** By element id. Only what differs from the template. */
  contentOverrides: Record<string, ElementOverride>;
  createdAt: string; updatedAt: string;
}

type OverrideKey = Exclude<keyof ElementOverride, 'layout'>;
/** For each override: the editable property that allows it, and the element types it means something on. */
const OVERRIDE_RULES: Record<OverrideKey, { property: EditableProperty; types: TemplateElement['type'][]; valid: (value: unknown) => boolean }> = {
  text: { property: 'content', types: ['text'], valid: value => typeof value === 'string' && value.length <= TEMPLATE_LIMITS.maxText },
  color: { property: 'color', types: ['text', 'shape', 'background'], valid: isTemplateColor },
  backgroundColor: { property: 'backgroundColor', types: ['text'], valid: isTemplateColor },
  assetId: { property: 'image', types: ['image', 'background'], valid: value => value === null || (typeof value === 'string' && value.length > 0 && value.length <= 200 && !/^(blob:|data:)/i.test(value)) },
  focalX: { property: 'image', types: ['image', 'background'], valid: value => typeof value === 'number' && value >= 0 && value <= 1 },
  focalY: { property: 'image', types: ['image', 'background'], valid: value => typeof value === 'number' && value >= 0 && value <= 1 },
  fontFamily: { property: 'fontFamily', types: ['text'], valid: isTemplateFont },
};
const LAYOUT_PROPERTY: Record<keyof NormalizedLayout, EditableProperty> = { x: 'position', y: 'position', width: 'size', height: 'size', rotation: 'rotation' };

/** Why this override cannot be applied to this element (locked, meaningless or invalid), one line per problem; empty when it can. */
export function overrideProblems(element: TemplateElement, override: ElementOverride): string[] {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    if (key === 'layout') {
      const changes = Object.entries(value as Partial<NormalizedLayout>).filter(([, number]) => number !== undefined);
      if (changes.length && element.type === 'background') { problems.push('The background always covers the whole canvas.'); continue; }
      for (const [field, number] of changes) {
        const property = LAYOUT_PROPERTY[field as keyof NormalizedLayout];
        if (!property) problems.push(`"${field}" is not a layout value.`);
        else if (!element.editableProperties[property]) problems.push(`${element.name}: ${property} is locked by the template.`);
        else if (typeof number !== 'number' || !Number.isFinite(number)) problems.push(`${element.name}: ${field} must be a finite number.`);
      }
      continue;
    }
    const rule = OVERRIDE_RULES[key as OverrideKey];
    if (!rule) problems.push(`"${key}" is not something a creative can change.`);
    else if (!rule.types.includes(element.type)) problems.push(`${element.name}: ${element.type === 'image' ? 'an' : 'a'} ${element.type} element has no ${key}.`);
    else if (!element.editableProperties[rule.property]) problems.push(`${element.name}: ${rule.property} is locked by the template.`);
    else if (!rule.valid(value)) problems.push(`${element.name}: ${JSON.stringify(value)} is not a valid ${key}.`);
  }
  return problems;
}

/** A new creative of this template version, with no overrides: it looks exactly like the template. */
export function createCreative(template: DesignTemplate, options: { id: string; name: string; now: string; aspectRatio?: DesignAspectRatio }): Creative {
  const aspectRatio = options.aspectRatio ?? template.canvas.masterAspectRatio;
  if (!template.supportedAspectRatios.includes(aspectRatio)) throw new TemplateError('UNSUPPORTED_ASPECT_RATIO', `"${template.name}" does not support ${aspectRatio}; it supports ${template.supportedAspectRatios.join(', ')}.`);
  return { schemaVersion: TEMPLATE_SCHEMA_VERSION, id: options.id, name: options.name, templateId: template.id, templateVersion: template.version, aspectRatio, contentOverrides: {}, createdAt: options.now, updatedAt: options.now };
}

function requireSameTemplate(creative: Creative, template: DesignTemplate) {
  if (creative.templateId !== template.id || creative.templateVersion !== template.version) throw new TemplateError('TEMPLATE_MISMATCH', `This creative uses template ${creative.templateId} version ${creative.templateVersion}, not ${template.id} version ${template.version}.`);
}

/**
 * Changes what a creative overrides on one element. A value of undefined removes that override (back to the template's
 * own value). Locked or invalid changes are refused with a TemplateError; the creative and the template are not touched.
 */
export function setCreativeOverride(creative: Creative, template: DesignTemplate, elementId: string, change: ElementOverride, now: string): Creative {
  requireSameTemplate(creative, template);
  const element = findElement(template, elementId);
  if (!element) throw new TemplateError('ELEMENT_NOT_FOUND', `This template has no element "${elementId}".`);
  const problems = overrideProblems(element, change);
  if (problems.length) throw new TemplateError('LOCKED_BY_TEMPLATE', problems.join(' '));
  const current = creative.contentOverrides[elementId] ?? {};
  const layout = change.layout === undefined ? current.layout : Object.fromEntries(Object.entries({ ...current.layout, ...change.layout }).filter(([, value]) => value !== undefined));
  const merged = Object.fromEntries(Object.entries({ ...current, ...change, layout: layout && Object.keys(layout).length ? layout : undefined }).filter(([, value]) => value !== undefined)) as ElementOverride;
  const { [elementId]: _previous, ...others } = creative.contentOverrides; void _previous;
  return { ...creative, contentOverrides: Object.keys(merged).length ? { ...others, [elementId]: merged } : others, updatedAt: now };
}
export function setCreativeAspectRatio(creative: Creative, template: DesignTemplate, aspectRatio: DesignAspectRatio, now: string): Creative {
  requireSameTemplate(creative, template);
  if (!template.supportedAspectRatios.includes(aspectRatio)) throw new TemplateError('UNSUPPORTED_ASPECT_RATIO', `"${template.name}" does not support ${aspectRatio}; it supports ${template.supportedAspectRatios.join(', ')}.`);
  return aspectRatio === creative.aspectRatio ? creative : { ...creative, aspectRatio, updatedAt: now };
}

function applyOverride(element: TemplateElement, override: ElementOverride): TemplateElement {
  const layout = override.layout && element.type !== 'background' ? clampLayout({ ...element.layout, ...override.layout }) : element.layout;
  switch (element.type) {
    case 'text': return { ...element, layout, defaultContent: { text: override.text ?? element.defaultContent.text },
      style: { ...element.style, color: override.color ?? element.style.color, backgroundColor: override.backgroundColor ?? element.style.backgroundColor, fontFamily: override.fontFamily ?? element.style.fontFamily } };
    case 'image': return { ...element, layout, defaultContent: { assetId: override.assetId === undefined ? element.defaultContent.assetId : override.assetId },
      behavior: { ...element.behavior, focalX: override.focalX ?? element.behavior.focalX, focalY: override.focalY ?? element.behavior.focalY } };
    case 'shape': return { ...element, layout, style: { ...element.style, fill: override.color ?? element.style.fill } };
    case 'background': return { ...element, defaultContent: { color: override.color ?? element.defaultContent.color, assetId: override.assetId === undefined ? element.defaultContent.assetId : override.assetId },
      behavior: { ...element.behavior, focalX: override.focalX ?? element.behavior.focalX, focalY: override.focalY ?? element.behavior.focalY } };
  }
}

/**
 * The template's elements with the creative's content in place: what is rendered. The template is not modified, and
 * its geometry is used as is. An override the template does not allow (locked, or for an element that no longer
 * exists) is left out and reported in `ignored`, never applied.
 */
export function applyCreative(template: DesignTemplate, creative: Creative): { elements: TemplateElement[]; ignored: TemplateIssue[] } {
  requireSameTemplate(creative, template);
  const ignored: TemplateIssue[] = [];
  for (const id of Object.keys(creative.contentOverrides)) if (!findElement(template, id)) ignored.push({ severity: 'warning', path: `contentOverrides.${id}`, message: `The template has no element "${id}"; its content is ignored.` });
  const elements = template.elements.map(source => {
    const element = elementAtRatio(source, creative.aspectRatio);
    const override = creative.contentOverrides[element.id];
    if (!override) return element;
    const problems = overrideProblems(element, override);
    if (!problems.length) return applyOverride(element, override);
    ignored.push(...problems.map(message => ({ severity: 'warning' as const, path: `contentOverrides.${element.id}`, message })));
    // Apply what is allowed, one value at a time, and leave the rest at the template's own value.
    const { layout, ...content } = override;
    const allowed = Object.fromEntries(Object.entries(content).filter(([key, value]) => !overrideProblems(element, { [key]: value } as ElementOverride).length)) as ElementOverride;
    const allowedLayout = layout && Object.fromEntries(Object.entries(layout).filter(([key, value]) => !overrideProblems(element, { layout: { [key]: value } } as ElementOverride).length)) as Partial<NormalizedLayout>;
    return applyOverride(element, { ...allowed, ...(allowedLayout && Object.keys(allowedLayout).length ? { layout: allowedLayout } : {}) });
  });
  return { elements, ignored };
}

/** The properties of an element a creative may change, in a fixed order; empty for a fully locked element. */
export const editablePropertiesOf = (element: TemplateElement) => EDITABLE_PROPERTIES.filter(property => element.editableProperties[property]);

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Problems with a stored creative's own shape (its overrides are checked against the template when it is applied). */
export function creativeIssues(value: unknown): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const error = (path: string, message: string) => { issues.push({ severity: 'error', path, message }); };
  if (!isRecord(value)) return [{ severity: 'error', path: 'creative', message: 'A creative must be an object.' }];
  const text = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= TEMPLATE_LIMITS.maxName;
  if (value.schemaVersion !== TEMPLATE_SCHEMA_VERSION) error('schemaVersion', `Unsupported creative schema version ${JSON.stringify(value.schemaVersion)}.`);
  for (const key of ['id', 'name', 'templateId'] as const) if (!text(value[key])) error(key, `${key} must be 1 to ${TEMPLATE_LIMITS.maxName} characters.`);
  if (!Number.isInteger(value.templateVersion) || (value.templateVersion as number) < 1) error('templateVersion', 'templateVersion must be a whole number from 1.');
  if (!isDesignAspectRatio(value.aspectRatio)) error('aspectRatio', `Invalid aspect ratio ${JSON.stringify(value.aspectRatio)}.`);
  for (const key of ['createdAt', 'updatedAt'] as const) if (typeof value[key] !== 'string' || !Number.isFinite(Date.parse(value[key]))) error(key, `${key} must be a date.`);
  if (!isRecord(value.contentOverrides) || !Object.values(value.contentOverrides).every(override => isRecord(override) && (override.layout === undefined || isRecord(override.layout)))) error('contentOverrides', 'contentOverrides must map element ids to their overrides.');
  return issues;
}
export const isCreative = (value: unknown): value is Creative => creativeIssues(value).length === 0;
