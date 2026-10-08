/**
 * The creative template library on disk, beside the decomposition runs it was learned from:
 *
 *   <root>/<templateId>/v<N>.json         one version (written once, never changed: past executions keep theirs)
 *   <root>/<templateId>/thumbnail.<ext>   the source creative, shown on its card
 *   <root>/<templateId>/template.json     the template: name, status, versions, stats (rewritten)
 *
 * A template is listed only once template.json exists, and that is written last, after its first version: a creation
 * that fails or is interrupted leaves nothing in the library. Every write is atomic (temporary file, then rename).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CreativeTemplate, TemplateVersion } from '@frameflow/shared';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TEMPLATES_DIR = resolve(here, '../../../../artifacts/decomposition/creative-templates');

const TEMPLATE_ID = /^tpl-[a-f0-9]{12}$/;
export const validTemplateId = (id: string) => TEMPLATE_ID.test(id);
export const newTemplateId = () => `tpl-${randomBytes(6).toString('hex')}`;
export class ImmutableVersionError extends Error { constructor(path: string) { super(`${path} already exists and is never replaced.`); this.name = 'ImmutableVersionError'; } }

export interface TemplateStore {
  /** Active templates, newest first. */
  list(): CreativeTemplate[];
  get(id: string): CreativeTemplate | undefined;
  /** One exact version; an execution's recorded version stays readable after newer ones exist. */
  version(id: string, version: number): TemplateVersion | undefined;
  current(id: string): TemplateVersion | undefined;
  /** A new template at v1 from a successful creation: the version, the thumbnail, then the listed record. */
  create(build: (templateId: string) => TemplateVersion, thumbnail?: { bytes: Buffer; ext: string }): { template: CreativeTemplate; version: TemplateVersion };
  /** A new immutable version; earlier versions are left exactly as they were. The record keeps its own name and description. */
  addVersion(id: string, build: (version: number) => TemplateVersion): TemplateVersion;
  /** Read, change, write a template's mutable record (name, description, status, stats). Never its versions. */
  update(id: string, change: (template: CreativeTemplate) => void): CreativeTemplate;
  thumbnailPath(id: string): string | undefined;
}

export function fileTemplateStore(root = DEFAULT_TEMPLATES_DIR): TemplateStore {
  const dirOf = (id: string) => { if (!validTemplateId(id)) throw new Error(`Invalid template id: ${id}`); return join(root, id); };
  const write = (path: string, value: unknown, createOnly = false) => {
    if (createOnly && existsSync(path)) throw new ImmutableVersionError(path);
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
    writeFileSync(temp, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2));
    renameSync(temp, path);
  };
  const read = <T>(path: string): T | undefined => { if (!existsSync(path)) return undefined; try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return undefined; } };
  const get = (id: string) => validTemplateId(id) ? read<CreativeTemplate>(join(root, id, 'template.json')) : undefined;
  const version = (id: string, n: number) => validTemplateId(id) && Number.isSafeInteger(n) && n > 0 ? read<TemplateVersion>(join(root, id, `v${n}.json`)) : undefined;
  const summary = (v: TemplateVersion) => ({ name: v.name, description: v.description, layerRoles: [...v.structure.layers].sort((a, b) => a.order - b.order).filter(l => l.independent).map(l => l.role) });
  return {
    list: () => (existsSync(root) ? readdirSync(root) : []).filter(validTemplateId).map(get).filter((t): t is CreativeTemplate => !!t && t.status === 'active')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    get,
    version,
    current: id => { const t = get(id); return t ? version(id, t.currentVersion) : undefined; },
    create(build, thumbnail) {
      const id = newTemplateId(), dir = dirOf(id), v = build(id);
      if (v.templateId !== id || v.version !== 1) throw new Error('A new template starts at version 1 with its own id.');
      write(join(dir, 'v1.json'), v, true);
      const file = thumbnail ? `thumbnail.${thumbnail.ext}` : undefined;
      if (thumbnail && file) write(join(dir, file), thumbnail.bytes);
      const template: CreativeTemplate = { id, ...summary(v), status: 'active', currentVersion: 1, versions: [1], ...(file ? { thumbnail: file } : {}), createdAt: v.createdAt, updatedAt: v.createdAt, stats: { reuses: 0, edits: 0 } };
      write(join(dir, 'template.json'), template);
      return { template, version: v };
    },
    addVersion(id, build) {
      const template = get(id);
      if (!template) throw new Error(`Template ${id} not found.`);
      const n = Math.max(...template.versions) + 1, v = build(n);
      if (v.templateId !== id || v.version !== n) throw new Error('A new version must keep the template id and take the next number.');
      write(join(dirOf(id), `v${n}.json`), v, true);
      write(join(dirOf(id), 'template.json'), { ...template, layerRoles: summary(v).layerRoles, currentVersion: n, versions: [...template.versions, n], updatedAt: v.createdAt });
      return v;
    },
    update(id, change) {
      const template = get(id);
      if (!template) throw new Error(`Template ${id} not found.`);
      const { versions, currentVersion, id: own, createdAt } = template;
      change(template);
      // Versions are append-only through addVersion; a metadata or stats update can never move them.
      Object.assign(template, { id: own, versions, currentVersion, createdAt, updatedAt: new Date().toISOString() });
      write(join(dirOf(id), 'template.json'), template);
      return template;
    },
    thumbnailPath(id) { const t = get(id); return t?.thumbnail ? join(dirOf(id), t.thumbnail) : undefined; },
  };
}
