/**
 * The template library: saved templates and the creatives made from them. Pure functions over a plain, serializable
 * value; where it is kept (the browser's localStorage) is the client's concern.
 *
 * Versions. A saved template version is immutable. Saving an edited template whose structure changed adds version n+1
 * and leaves every earlier version as it was. A creative records the template version it was made with and is always
 * rendered with exactly that version, so editing a template can never change or break an existing creative. Moving a
 * creative to the newest version is an explicit action (upgradeCreative). The name is a label, not structure:
 * renaming changes no version. Old versions are never removed automatically, used or not: a version goes only when its
 * whole template is deleted.
 */
import { applyCreative, creativeIssues, overrideProblems, type Creative, type ElementOverride } from './creative.js';
import { findElement, orderElements } from './editing.js';
import { TEMPLATE_LIMITS, TEMPLATE_SCHEMA_VERSION, TemplateError, assertDesignTemplate, templateErrors, type DesignTemplate, type NormalizedLayout } from './schema.js';

/** Something in storage that could not be read as a template or creative. It is kept as it was, never rewritten or dropped. */
export type RejectedEntry = { kind: 'template' | 'creative'; value: unknown; problems: string[] };
export interface TemplateLibrary {
  schemaVersion: typeof TEMPLATE_SCHEMA_VERSION;
  /** Every kept version of every template: (id, version) is unique. */
  templates: DesignTemplate[];
  creatives: Creative[];
  rejected?: RejectedEntry[];
}
export const emptyLibrary = (): TemplateLibrary => ({ schemaVersion: TEMPLATE_SCHEMA_VERSION, templates: [], creatives: [] });

export const designTemplateVersions = (library: TemplateLibrary, id: string) => library.templates.filter(template => template.id === id).sort((a, b) => a.version - b.version);
export const latestDesignTemplate = (library: TemplateLibrary, id: string): DesignTemplate | undefined => designTemplateVersions(library, id).at(-1);
export const designTemplateVersion = (library: TemplateLibrary, id: string, version: number) => library.templates.find(template => template.id === id && template.version === version);
/** The newest version of each template, most recently saved first. */
export function listDesignTemplates(library: TemplateLibrary): DesignTemplate[] {
  const ids = [...new Set(library.templates.map(template => template.id))];
  return ids.map(id => latestDesignTemplate(library, id)!).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name));
}
export const creativesOf = (library: TemplateLibrary, templateId: string) => library.creatives.filter(creative => creative.templateId === templateId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

/** What makes a version: the structure. The name, the version number and the dates are not part of it. */
const structure = (template: DesignTemplate) => JSON.stringify({ supportedAspectRatios: template.supportedAspectRatios, canvas: template.canvas, elements: orderElements(template.elements) });
const cleanName = (name: string) => {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > TEMPLATE_LIMITS.maxName) throw new TemplateError('INVALID_NAME', `A name must be 1 to ${TEMPLATE_LIMITS.maxName} characters.`);
  return trimmed;
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export type SaveOutcome = 'created' | 'new-version' | 'renamed' | 'unchanged';
/**
 * Saves the author's draft. A new id becomes version 1. A changed structure becomes the next version; the versions
 * before it are untouched. Only a new name renames; nothing at all changed saves nothing. An invalid draft is refused
 * with every problem listed, and the library is returned to the caller unchanged.
 */
export function saveDesignTemplate(library: TemplateLibrary, draft: DesignTemplate, now: string): { library: TemplateLibrary; template: DesignTemplate; outcome: SaveOutcome } {
  const name = cleanName(draft.name), latest = latestDesignTemplate(library, draft.id);
  const elements = orderElements(clone(draft.elements));
  if (!latest) {
    const template = assertDesignTemplate({ ...clone(draft), name, elements, version: 1, createdAt: now, updatedAt: now });
    return { library: { ...library, templates: [...library.templates, template] }, template, outcome: 'created' };
  }
  if (structure(latest) === structure({ ...draft, elements })) {
    if (latest.name === name) return { library, template: latest, outcome: 'unchanged' };
    const renamed = renameDesignTemplate(library, draft.id, name, now);
    return { library: renamed, template: latestDesignTemplate(renamed, draft.id)!, outcome: 'renamed' };
  }
  const template = assertDesignTemplate({ ...clone(draft), name, elements, version: latest.version + 1, createdAt: latest.createdAt, updatedAt: now });
  // Every earlier version is kept, whether or not a creative uses it; only the shared name label follows the draft's.
  const earlier = library.templates.map(item => item.id === draft.id && item.name !== name ? { ...item, name } : item);
  return { library: { ...library, templates: [...earlier, template] }, template, outcome: 'new-version' };
}

/** The name is a label shared by all versions of a template; renaming creates no version. */
export function renameDesignTemplate(library: TemplateLibrary, id: string, name: string, now: string): TemplateLibrary {
  const next = cleanName(name), latest = latestDesignTemplate(library, id);
  if (!latest) throw new TemplateError('TEMPLATE_NOT_FOUND', `There is no template "${id}".`);
  if (latest.name === next) return library;
  return { ...library, templates: library.templates.map(template => template.id !== id ? template : { ...template, name: next, ...(template === latest ? { updatedAt: now } : {}) }) };
}

/** A new template (new id, version 1) with the same structure as the newest version of `id`. Creatives are not copied. */
export function duplicateDesignTemplate(library: TemplateLibrary, id: string, newId: string, now: string, name?: string): { library: TemplateLibrary; template: DesignTemplate } {
  const source = latestDesignTemplate(library, id);
  if (!source) throw new TemplateError('TEMPLATE_NOT_FOUND', `There is no template "${id}".`);
  if (!newId || library.templates.some(template => template.id === newId)) throw new TemplateError('DUPLICATE_TEMPLATE_ID', `The id "${newId}" is already used by a template.`);
  const template = assertDesignTemplate({ ...clone(source), id: newId, name: cleanName(name ?? `${source.name} copy`.slice(0, TEMPLATE_LIMITS.maxName)), version: 1, createdAt: now, updatedAt: now });
  return { library: { ...library, templates: [...library.templates, template] }, template };
}

/** Deletes a template and all its versions. Refused while creatives still use it: they would have nothing to render. */
export function deleteDesignTemplate(library: TemplateLibrary, id: string): TemplateLibrary {
  if (!latestDesignTemplate(library, id)) throw new TemplateError('TEMPLATE_NOT_FOUND', `There is no template "${id}".`);
  const count = library.creatives.filter(creative => creative.templateId === id).length;
  if (count) throw new TemplateError('TEMPLATE_IN_USE', `${count} creative${count === 1 ? '' : 's'} use this template. Delete ${count === 1 ? 'it' : 'them'} first.`);
  return { ...library, templates: library.templates.filter(template => template.id !== id) };
}

/** Saves a creative (new, or replacing the one with its id). Its template version must exist and allow everything it overrides. */
export function saveCreative(library: TemplateLibrary, creative: Creative, now: string): { library: TemplateLibrary; creative: Creative } {
  const problems = creativeIssues(creative);
  if (problems.length) throw new TemplateError('INVALID_CREATIVE', problems.map(issue => `${issue.path}: ${issue.message}`).join(' '), problems);
  const template = designTemplateVersion(library, creative.templateId, creative.templateVersion);
  if (!template) throw new TemplateError('TEMPLATE_NOT_FOUND', `Template ${creative.templateId} version ${creative.templateVersion} is not in the library. Save the template first.`);
  if (!template.supportedAspectRatios.includes(creative.aspectRatio)) throw new TemplateError('UNSUPPORTED_ASPECT_RATIO', `"${template.name}" does not support ${creative.aspectRatio}.`);
  const { ignored } = applyCreative(template, creative);
  if (ignored.length) throw new TemplateError('LOCKED_BY_TEMPLATE', ignored.map(issue => issue.message).join(' '), ignored);
  const existing = library.creatives.find(item => item.id === creative.id);
  const saved: Creative = { ...clone(creative), name: cleanName(creative.name), createdAt: existing?.createdAt ?? creative.createdAt, updatedAt: now };
  return { library: { ...library, creatives: existing ? library.creatives.map(item => item === existing ? saved : item) : [...library.creatives, saved] }, creative: saved };
}
export function deleteCreative(library: TemplateLibrary, id: string): TemplateLibrary {
  if (!library.creatives.some(creative => creative.id === id)) throw new TemplateError('CREATIVE_NOT_FOUND', `There is no creative "${id}".`);
  return { ...library, creatives: library.creatives.filter(creative => creative.id !== id) };
}

/**
 * Moves a creative to another (normally the newest) version of its template, on request. Overrides are kept where the
 * new version still has that element and still allows the change; the rest are dropped and listed in `dropped`.
 */
export function upgradeCreative(creative: Creative, target: DesignTemplate, now: string): { creative: Creative; dropped: string[] } {
  if (target.id !== creative.templateId) throw new TemplateError('TEMPLATE_MISMATCH', 'A creative can only move to another version of its own template.');
  const dropped: string[] = [], contentOverrides: Record<string, ElementOverride> = {};
  for (const [id, override] of Object.entries(creative.contentOverrides)) {
    const element = findElement(target, id);
    if (!element) { dropped.push(`Element "${id}" no longer exists in version ${target.version}.`); continue; }
    const { layout, ...content } = override, kept: ElementOverride = {};
    for (const [key, value] of Object.entries(content)) {
      const problems = overrideProblems(element, { [key]: value } as ElementOverride);
      if (problems.length) dropped.push(...problems); else Object.assign(kept, { [key]: value });
    }
    const keptLayout: Partial<NormalizedLayout> = {};
    for (const [key, value] of Object.entries(layout ?? {})) {
      const problems = overrideProblems(element, { layout: { [key]: value } } as ElementOverride);
      if (problems.length) dropped.push(...problems); else Object.assign(keptLayout, { [key]: value });
    }
    if (Object.keys(keptLayout).length) kept.layout = keptLayout;
    if (Object.keys(kept).length) contentOverrides[id] = kept;
  }
  const aspectRatio = target.supportedAspectRatios.includes(creative.aspectRatio) ? creative.aspectRatio : target.canvas.masterAspectRatio;
  if (aspectRatio !== creative.aspectRatio) dropped.push(`Version ${target.version} does not support ${creative.aspectRatio}; the creative now uses ${aspectRatio}.`);
  return { creative: { ...creative, templateVersion: target.version, aspectRatio, contentOverrides, updatedAt: now }, dropped };
}

/** The library as the JSON text that is stored. Entries that could not be read are written back exactly as they were. */
export function serializeLibrary(library: TemplateLibrary): string {
  return JSON.stringify({ schemaVersion: TEMPLATE_SCHEMA_VERSION, templates: [...library.templates, ...(library.rejected ?? []).filter(entry => entry.kind === 'template').map(entry => entry.value)],
    creatives: [...library.creatives, ...(library.rejected ?? []).filter(entry => entry.kind === 'creative').map(entry => entry.value)] });
}
/**
 * Reads stored JSON text. Each template and creative is validated on its own: a malformed one is set aside in
 * `rejected` with its problems (and is kept in storage untouched), it never takes the valid ones down with it and is
 * never repaired by guessing. Text that is not a library at all is a TemplateError.
 */
export function parseLibrary(text: string): TemplateLibrary {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new TemplateError('INVALID_LIBRARY', 'The saved templates are not valid JSON.'); }
  const record = value as { schemaVersion?: unknown; templates?: unknown; creatives?: unknown } | null;
  if (!record || typeof record !== 'object' || record.schemaVersion !== TEMPLATE_SCHEMA_VERSION || !Array.isArray(record.templates) || !Array.isArray(record.creatives)) throw new TemplateError('INVALID_LIBRARY', 'The saved templates are not in a format this version can read.');
  const library = emptyLibrary(), rejected: RejectedEntry[] = [];
  for (const item of record.templates) {
    const errors = templateErrors(item);
    if (!errors.length && library.templates.some(template => template.id === (item as DesignTemplate).id && template.version === (item as DesignTemplate).version)) errors.push({ severity: 'error', path: 'id', message: 'The same template version is stored twice.' });
    if (errors.length) rejected.push({ kind: 'template', value: item, problems: errors.map(issue => `${issue.path}: ${issue.message}`) });
    else library.templates.push(item as DesignTemplate);
  }
  for (const item of record.creatives) {
    const problems = creativeIssues(item).map(issue => `${issue.path}: ${issue.message}`);
    if (!problems.length && library.creatives.some(creative => creative.id === (item as Creative).id)) problems.push('id: the same creative is stored twice.');
    if (!problems.length && !designTemplateVersion(library, (item as Creative).templateId, (item as Creative).templateVersion)) problems.push(`templateVersion: template ${(item as Creative).templateId} version ${(item as Creative).templateVersion} is missing.`);
    if (problems.length) rejected.push({ kind: 'creative', value: item, problems });
    else library.creatives.push(item as Creative);
  }
  return rejected.length ? { ...library, rejected } : library;
}
