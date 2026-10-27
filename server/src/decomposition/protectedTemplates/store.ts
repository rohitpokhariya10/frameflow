/**
 * Protected templates on disk, beside the decomposition runs they send to Seedream:
 *
 *   <root>/<templateId>/template.json         the record (ProtectedTemplate), rewritten on every change
 *   <root>/<templateId>/<file>                the source, uploaded assets, rasters, bases, reconstructions
 *
 * A template is listed only once template.json exists, and that is written last: a creation that fails or is interrupted
 * leaves nothing listed. Every write is atomic (temporary file, then rename). A change names the revision it was made
 * from; a change made from an older one is refused, so two people (or two tabs) never silently overwrite each other.
 * Every read and write of a change is synchronous, so one server process never interleaves two of them.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { migrateProtectedTemplate, ProtectedSchemaError, validProtectedTemplateId, type ProtectedTemplate } from '@frameflow/shared';
import { RunError } from '../layerizeExperiment.js';
import { ARTIFACTS_DIR } from '../../deployment.js';

export const DEFAULT_PROTECTED_DIR = resolve(ARTIFACTS_DIR, 'decomposition/protected-templates');
/** File names inside a template folder: lower-case, no separators, a known type. Nothing else is read or served. */
const FILE = /^[a-z0-9][a-z0-9-]{0,100}\.(png|jpg|webp|json)$/;
export const validProtectedFile = (name: unknown): name is string => typeof name === 'string' && FILE.test(name);
export const newProtectedTemplateId = () => `pt-${randomBytes(6).toString('hex')}`;

export interface ProtectedStore {
  root: string;
  /** Every template, newest first. */
  list(): ProtectedTemplate[];
  get(id: string): ProtectedTemplate | undefined;
  require(id: string): ProtectedTemplate;
  path(id: string, file: string): string;
  has(id: string, file: string): boolean;
  read(id: string, file: string): Buffer;
  write(id: string, file: string, bytes: Buffer): void;
  /** Removes one file no record refers to any more (never a folder). */
  discard(id: string, file: string): void;
  /** The stored files of a template whose names start with `prefix` (valid names only; template.json never). */
  files(id: string, prefix: string): string[];
  /** A new template: its files first, the listed record last. */
  create(template: ProtectedTemplate, files: Record<string, Buffer>): ProtectedTemplate;
  /** Read, change, write; refused (STALE_REVISION) when `expectedRevision` is given and is not the current one. */
  update(id: string, expectedRevision: number | undefined, change: (template: ProtectedTemplate) => void): ProtectedTemplate;
}

export function fileProtectedStore(root = DEFAULT_PROTECTED_DIR): ProtectedStore {
  const dirOf = (id: string) => { if (!validProtectedTemplateId(id)) throw new RunError('NOT_FOUND', 'Protected template not found.'); return join(root, id); };
  const path = (id: string, file: string) => { if (!validProtectedFile(file)) throw new RunError('NOT_FOUND', 'File not found.'); return join(dirOf(id), file); };
  const atomic = (target: string, value: Buffer | string) => {
    mkdirSync(dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
    writeFileSync(temp, value); renameSync(temp, target);
  };
  const get = (id: string): ProtectedTemplate | undefined => {
    if (!validProtectedTemplateId(id)) return undefined;
    const file = join(root, id, 'template.json');
    if (!existsSync(file)) return undefined;
    // Every record is read in the current schema (an older one is migrated in memory and saved as current on its next change).
    try { return migrateProtectedTemplate(JSON.parse(readFileSync(file, 'utf8'))); }
    catch (error) { if (error instanceof ProtectedSchemaError) console.warn(`protected template ${id}: ${error.message}`); return undefined; }
  };
  const store: ProtectedStore = {
    root,
    list: () => (existsSync(root) ? readdirSync(root) : []).map(get).filter((t): t is ProtectedTemplate => !!t).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    get,
    require: id => { const t = get(id); if (!t) throw new RunError('NOT_FOUND', 'Protected template not found.'); return t; },
    path,
    has: (id, file) => validProtectedFile(file) && existsSync(path(id, file)),
    read: (id, file) => { const p = path(id, file); if (!existsSync(p)) throw new RunError('FILE_MISSING', `The stored file ${file} is missing.`); return readFileSync(p); },
    write: (id, file, bytes) => atomic(path(id, file), bytes),
    discard: (id, file) => { if (file === 'template.json') return; const p = path(id, file); if (existsSync(p)) unlinkSync(p); },
    files: (id, prefix) => { const dir = dirOf(id); return existsSync(dir) ? readdirSync(dir).filter(f => f.startsWith(prefix) && validProtectedFile(f) && f !== 'template.json').sort() : []; },
    create(template, files) {
      if (existsSync(join(dirOf(template.id), 'template.json'))) throw new RunError('CONFLICT', 'That template already exists.');
      for (const [file, bytes] of Object.entries(files)) atomic(path(template.id, file), bytes);
      atomic(join(dirOf(template.id), 'template.json'), JSON.stringify(template, null, 2));
      return template;
    },
    update(id, expectedRevision, change) {
      const current = store.require(id);
      if (expectedRevision !== undefined && expectedRevision !== current.revision)
        throw new RunError('STALE_REVISION', `This template changed since you opened it (revision ${current.revision}, yours ${expectedRevision}). Reload it and make your change again.`, { revision: current.revision });
      const next = structuredClone(current);
      change(next);
      next.revision = current.revision + 1; next.updatedAt = new Date().toISOString();
      atomic(join(dirOf(id), 'template.json'), JSON.stringify(next, null, 2));
      return next;
    },
  };
  return store;
}
