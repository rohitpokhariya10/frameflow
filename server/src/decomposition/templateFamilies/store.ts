/**
 * The template family library: families, their immutable blueprint versions, exemplars, statistics, and a prompt /
 * analysis cache. One small storage interface (JsonBackend) with a file implementation for development and Render's
 * disk, and a memory implementation for tests; a database can implement the same three methods later.
 *
 * Layout under the root:
 *   families/<familyId>/family.json        the family: status, versions, exemplars, stats (rewritten)
 *   families/<familyId>/v<N>.json          one blueprint version (written once, never changed)
 *   cache/<sha256>.json                    one cache entry (structured key, see cacheKey)
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAMILY_SEEDS, seedBlueprint, type BlueprintRef, type FamilyStats, type FamilyStatus, type TemplateBlueprint, type TemplateFamily } from '@frameflow/shared';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TEMPLATE_FAMILIES_DIR = resolve(here, '../../../../artifacts/decomposition/template-families');

/** Three operations a backend must provide. Keys are relative paths of safe segments. */
export interface JsonBackend {
  read<T>(key: string): T | undefined;
  /** createOnly: refuse to replace an existing value (immutable blueprint versions). */
  write(key: string, value: unknown, options?: { createOnly?: boolean }): void;
  /** The names directly under a prefix ("families" → the family ids). */
  list(prefix: string): string[];
}
const KEY = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/i;
const checkKey = (key: string) => { if (!KEY.test(key) || key.includes('..')) throw new Error(`Invalid storage key: ${key}`); return key; };
export class ImmutableVersionError extends Error { constructor(key: string) { super(`${key} already exists and is never replaced.`); this.name = 'ImmutableVersionError'; } }

export function fileBackend(root: string): JsonBackend {
  const path = (key: string) => join(root, ...checkKey(key).split('/'));
  return {
    read: <T>(key: string) => { const file = path(key); if (!existsSync(file)) return undefined; try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return undefined; } },
    write: (key, value, options) => {
      const file = path(key);
      if (options?.createOnly && existsSync(file)) throw new ImmutableVersionError(key);
      mkdirSync(dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
      writeFileSync(temp, JSON.stringify(value, null, 2));
      renameSync(temp, file);
    },
    list: (prefix) => { const dir = path(prefix); return existsSync(dir) ? readdirSync(dir).filter(name => KEY.test(name) && !name.endsWith('.tmp')) : []; },
  };
}
export function memoryBackend(): JsonBackend {
  const data = new Map<string, string>();
  return {
    read: <T>(key: string) => { const v = data.get(checkKey(key)); return v === undefined ? undefined : JSON.parse(v) as T; },
    write: (key, value, options) => { if (options?.createOnly && data.has(checkKey(key))) throw new ImmutableVersionError(key); data.set(checkKey(key), JSON.stringify(value)); },
    list: (prefix) => [...new Set([...data.keys()].filter(k => k.startsWith(`${prefix}/`)).map(k => k.slice(prefix.length + 1).split('/')[0]))],
  };
}

/** A structured cache identity: never a raw prompt string. Compiled entries include the values, so one creative's prompt is never served for another. */
export interface CacheKey {
  purpose: 'structure-analysis' | 'generation-prompt' | 'decomposition-plan';
  promptVersion: number;
  model?: string; blueprint?: string; slotSchema?: string; image?: string; values?: string;
}
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(value);
export const hashOf = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export const cacheKey = (key: CacheKey) => hashOf(key);
/** The slot schema a compiled prompt depends on: ids, kinds and limits (not labels). */
export const slotSchemaHash = (blueprint: Pick<TemplateBlueprint, 'slots'>) => hashOf(blueprint.slots.map(s => [s.id, s.kind, s.maxLength, s.nativeEditable]));
export interface PromptCache {
  get<T>(key: CacheKey): T | undefined;
  put(key: CacheKey, value: unknown): void;
}

export const emptyStats = (): FamilyStats => ({ matches: 0, rejectedMatches: 0, confidenceSum: 0, created: 0, generationSuccess: 0, generationFailure: 0, decompositionSuccess: 0, decompositionFailure: 0,
  reuseValidationFailures: 0, manualReplans: 0, rawLayers: 0, editorLayers: 0, decompositionsMeasured: 0, residualCalls: 0, backgroundEditCalls: 0, totalUsd: 0, costedRuns: 0,
  observed: { analysis: { calls: 0, usd: 0 }, planner: { calls: 0, usd: 0 } } });

export interface TemplateFamilyStore {
  list(): TemplateFamily[];
  get(id: string): TemplateFamily | undefined;
  /** One exact version; a run's recorded version stays readable after newer ones exist. */
  blueprint(ref: BlueprintRef): TemplateBlueprint | undefined;
  current(id: string): TemplateBlueprint | undefined;
  /** A new family at v1 (its id comes from the blueprint). */
  create(blueprint: TemplateBlueprint, options?: { status?: FamilyStatus; seed?: TemplateFamily['seed']; activatedBy?: string }): TemplateFamily;
  /** A new immutable version; earlier versions are left exactly as they were. */
  addVersion(familyId: string, build: (version: number) => TemplateBlueprint): TemplateBlueprint;
  /** Read, change, write a family's mutable record (status, exemplars, stats). Never its versions. */
  update(familyId: string, change: (family: TemplateFamily) => void): TemplateFamily;
  cache: PromptCache;
}
const FAMILY_ID = /^fam-[a-z0-9-]{1,60}$/;
export const validFamilyId = (id: string) => FAMILY_ID.test(id);
export const newFamilyId = (name: string) => `fam-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'layout'}-${randomBytes(3).toString('hex')}`;

export function createFamilyStore(backend: JsonBackend): TemplateFamilyStore {
  const familyKey = (id: string) => `families/${id}/family.json`, versionKey = (ref: BlueprintRef) => `families/${ref.familyId}/v${ref.version}.json`;
  const get = (id: string) => validFamilyId(id) ? backend.read<TemplateFamily>(familyKey(id)) : undefined;
  return {
    list: () => backend.list('families').filter(validFamilyId).map(get).filter((f): f is TemplateFamily => !!f).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    get,
    blueprint: ref => validFamilyId(ref.familyId) && Number.isSafeInteger(ref.version) && ref.version > 0 ? backend.read<TemplateBlueprint>(versionKey(ref)) : undefined,
    current(id) { const family = get(id); return family ? this.blueprint({ familyId: id, version: family.currentVersion }) : undefined; },
    create(blueprint, options = {}) {
      if (!validFamilyId(blueprint.familyId) || blueprint.version !== 1) throw new Error('A new family starts at version 1 with a valid id.');
      if (get(blueprint.familyId)) throw new Error(`Family ${blueprint.familyId} already exists.`);
      backend.write(versionKey(blueprint), blueprint, { createOnly: true });
      const now = blueprint.createdAt;
      const family: TemplateFamily = { id: blueprint.familyId, name: blueprint.name, status: options.status ?? 'provisional', currentVersion: 1, versions: [1], createdAt: now, updatedAt: now,
        ...(options.seed ? { seed: options.seed } : {}), ...(options.activatedBy ? { activatedBy: options.activatedBy } : {}), exemplars: [], examples: [], stats: emptyStats(), failures: [] };
      backend.write(familyKey(family.id), family);
      return family;
    },
    addVersion(familyId, build) {
      const family = get(familyId);
      if (!family) throw new Error(`Family ${familyId} not found.`);
      const version = Math.max(...family.versions) + 1, blueprint = build(version);
      if (blueprint.familyId !== familyId || blueprint.version !== version) throw new Error('A new version must keep the family id and take the next number.');
      backend.write(versionKey(blueprint), blueprint, { createOnly: true });
      backend.write(familyKey(familyId), { ...family, name: blueprint.name, currentVersion: version, versions: [...family.versions, version], updatedAt: new Date().toISOString() });
      return blueprint;
    },
    update(familyId, change) {
      const family = get(familyId);
      if (!family) throw new Error(`Family ${familyId} not found.`);
      const { versions, currentVersion } = family;
      change(family);
      // Versions are append-only through addVersion; a stats update can never move them.
      Object.assign(family, { versions, currentVersion, updatedAt: new Date().toISOString() });
      backend.write(familyKey(familyId), family);
      return family;
    },
    cache: {
      get: <T>(key: CacheKey) => backend.read<{ key: CacheKey; value: T }>(`cache/${cacheKey(key)}.json`)?.value,
      put: (key, value) => backend.write(`cache/${cacheKey(key)}.json`, { key, value, at: new Date().toISOString() }),
    },
  };
}
export const fileFamilyStore = (root = DEFAULT_TEMPLATE_FAMILIES_DIR) => createFamilyStore(fileBackend(root));
export const memoryFamilyStore = () => createFamilyStore(memoryBackend());

/**
 * The legacy Templates A, B and C as the library's first families, in the same blueprint format as detected ones.
 * Idempotent: a missing seed is created at v1 (active); a seed whose revision rose gets a new version.
 */
export function ensureSeedFamilies(store: TemplateFamilyStore, now = new Date().toISOString()): void {
  for (const seed of FAMILY_SEEDS) {
    const family = store.get(seed.id);
    if (!family) { store.create(seedBlueprint(seed, 1, now), { status: 'active', seed: { key: seed.key, revision: seed.revision }, activatedBy: 'seed' }); continue; }
    if ((family.seed?.revision ?? 0) < seed.revision) {
      store.addVersion(seed.id, version => seedBlueprint(seed, version, now));
      store.update(seed.id, f => { f.seed = { key: seed.key, revision: seed.revision }; });
    }
  }
}
