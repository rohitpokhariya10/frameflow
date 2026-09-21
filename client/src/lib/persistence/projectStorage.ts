import type { ProjectDocument } from '@frameflow/shared';
import { isProjectDocument } from './schema';

export const PROJECT_KEY = 'frameflow:project:v1';
export type StorageAccess = () => Pick<Storage, 'getItem' | 'setItem'>;
export type RestoreResult = { document?: ProjectDocument; warning?: string };
export function restoreProject(storage: StorageAccess): RestoreResult {
  try {
    const raw = storage().getItem(PROJECT_KEY);
    if (raw === null) return {};
    const value: unknown = JSON.parse(raw);
    if (!isProjectDocument(value)) return { warning: 'Saved design is invalid or from an unsupported version. A blank design is open; your saved data has not been changed.' };
    return { document: value };
  } catch {
    return { warning: 'Could not recover the saved design. Browser storage may be unavailable or the saved data damaged.' };
  }
}
export function saveProject(storage: StorageAccess, document: ProjectDocument) {
  if (!isProjectDocument(document)) throw new Error('Invalid project document');
  storage().setItem(PROJECT_KEY, JSON.stringify(document));
}

export type SaveStatus = 'saving' | 'saved' | 'error';
/** Synchronous localStorage writes cannot complete out of order. Tokens invalidate old timers. */
export function createProjectSaver(storage: StorageAccess, onStatus: (status: SaveStatus) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: ProjectDocument | undefined;
  let request = 0;
  const flush = () => {
    clearTimeout(timer);
    if (!pending) return;
    const document = pending;
    pending = undefined;
    const token = request;
    try { saveProject(storage, document); if (token === request) onStatus('saved'); }
    catch { if (token === request) onStatus('error'); }
  };
  return {
    schedule(document: ProjectDocument) {
      pending = document;
      const token = ++request;
      clearTimeout(timer);
      onStatus('saving');
      timer = setTimeout(() => { if (token === request) flush(); }, 500);
    },
    flush,
    dispose() { clearTimeout(timer); pending = undefined; request++; },
  };
}
