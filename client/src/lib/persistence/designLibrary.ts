import type { DesignVariant, ProjectDocument } from '@frameflow/shared';
import { isProjectDocument } from './schema';

/** localStorage, or a stand-in; one without removeItem leaves a forgotten design's body behind (unlisted). */
export type StorageAccess = () => Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>>;

/**
 * The designs kept on this device besides the open one. The open design stays where it always was (PROJECT_KEY, saved
 * by the project saver); every other design is one validated document under its own key, listed in an index. Opening a
 * decomposed template result creates such a design of its own, so it never adds a version to the design that was open.
 * Pictures stay in the asset store (IndexedDB); documents only reference them.
 */
export const DESIGNS_KEY = 'frameflow:designs:v1';
const bodyKey = (id: string) => `frameflow:design:v1:${id}`;
/** Where a design came from when it was opened from a decomposed template result (its one version records the same). */
export type DesignSource = NonNullable<DesignVariant['importedFrom']>;
export type DesignEntry = { id: string; name: string; updatedAt: string; versions: number; importedFrom?: DesignSource };

const isSource = (v: unknown): v is DesignSource => !!v && typeof v === 'object' && ['templateId', 'resultId', 'runId'].every(k => typeof (v as Record<string, unknown>)[k] === 'string');
const isEntry = (v: unknown): v is DesignEntry => !!v && typeof v === 'object' && typeof (v as DesignEntry).id === 'string' && typeof (v as DesignEntry).name === 'string'
  && typeof (v as DesignEntry).updatedAt === 'string' && Number.isInteger((v as DesignEntry).versions) && ((v as DesignEntry).importedFrom === undefined || isSource((v as DesignEntry).importedFrom));
/** The stored designs (not the open one), newest first. An unreadable index lists nothing; it is never thrown away. */
export function storedDesigns(storage: StorageAccess): DesignEntry[] {
  try {
    const value: unknown = JSON.parse(storage().getItem(DESIGNS_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter(isEntry) : [];
  } catch { return []; }
}
const writeIndex = (storage: StorageAccess, entries: DesignEntry[]) => storage().setItem(DESIGNS_KEY, JSON.stringify([...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))));
/** The template result a design was opened from: the source its versions record (a result design has exactly one). */
export const sourceOf = (document: ProjectDocument): DesignSource | undefined => document.variants.find(variant => variant.importedFrom)?.importedFrom;
export const sameSource = (a: DesignSource | undefined, b: DesignSource) => !!a && a.templateId === b.templateId && a.resultId === b.resultId && a.runId === b.runId;
/** Keeps a design (the one being left) under its own key and in the index. Throws when storage refuses it. */
export function storeDesign(storage: StorageAccess, document: ProjectDocument) {
  if (!isProjectDocument(document)) throw new Error('Invalid project document');
  storage().setItem(bodyKey(document.id), JSON.stringify(document));
  const source = sourceOf(document);
  writeIndex(storage, [...storedDesigns(storage).filter(entry => entry.id !== document.id),
    { id: document.id, name: document.name, updatedAt: document.updatedAt, versions: document.variants.length, ...(source ? { importedFrom: source } : {}) }]);
}
/** A stored design, validated; undefined when it is missing or damaged (its entry is then left for the user to see). */
export function readDesign(storage: StorageAccess, id: string): ProjectDocument | undefined {
  try {
    const value: unknown = JSON.parse(storage().getItem(bodyKey(id)) ?? 'null');
    return isProjectDocument(value) && value.id === id ? value : undefined;
  } catch { return undefined; }
}
/** Takes a design out of the stored list (it became the open one, or was discarded). */
export function forgetDesign(storage: StorageAccess, id: string) {
  writeIndex(storage, storedDesigns(storage).filter(entry => entry.id !== id));
  storage().removeItem?.(bodyKey(id));
}
/** Every asset a stored design references (layers, backgrounds, generation sources): never cleaned up with another design. */
export function storedAssetIds(storage: StorageAccess): Set<string> {
  const ids = new Set<string>();
  for (const entry of storedDesigns(storage)) {
    for (const variant of readDesign(storage, entry.id)?.variants ?? []) {
      if (variant.background) ids.add(variant.background.assetId);
      if (variant.generation?.sourceAssetId) ids.add(variant.generation.sourceAssetId);
      for (const layer of variant.layers ?? []) if (layer.type === 'image' && layer.assetId) ids.add(layer.assetId);
    }
  }
  return ids;
}
