import { emptyLibrary, parseLibrary, serializeLibrary, type TemplateLibrary } from '@frameflow/shared';
import type { StorageAccess } from '../../lib/persistence/projectStorage';

/** Templates and creatives live in this browser's localStorage, like the design itself; their pictures are in the asset store. */
export const TEMPLATE_LIBRARY_KEY = 'frameflow:design-templates:v1';
/** Stored text that could not be read at all is moved here before a new library is started, so it is never overwritten. */
export const TEMPLATE_LIBRARY_UNREADABLE_KEY = `${TEMPLATE_LIBRARY_KEY}:unreadable`;

export function loadTemplateLibrary(storage: StorageAccess): { library: TemplateLibrary; warning?: string } {
  let raw: string | null;
  try { raw = storage().getItem(TEMPLATE_LIBRARY_KEY); }
  catch { return { library: emptyLibrary(), warning: 'Browser storage is unavailable, so templates cannot be loaded or saved in this session.' }; }
  if (raw === null) return { library: emptyLibrary() };
  try {
    const library = parseLibrary(raw), rejected = library.rejected ?? [];
    return rejected.length ? { library, warning: `${rejected.length} saved ${rejected.length === 1 ? 'item' : 'items'} could not be read and ${rejected.length === 1 ? 'is' : 'are'} left untouched in storage: ${rejected.map(entry => `${entry.kind} (${entry.problems[0]})`).join('; ')}` } : { library };
  } catch {
    try { storage().setItem(TEMPLATE_LIBRARY_UNREADABLE_KEY, raw); } catch { /* the original key still holds it until the next save */ }
    return { library: emptyLibrary(), warning: 'The saved templates could not be read. They were set aside unchanged and an empty library is open.' };
  }
}
/** Throws when the browser refuses the write (storage full or unavailable); the caller keeps its previous library. */
export function saveTemplateLibrary(storage: StorageAccess, library: TemplateLibrary) {
  storage().setItem(TEMPLATE_LIBRARY_KEY, serializeLibrary(library));
}
