import { createEditorStore } from '../../store';
import { recoveryWarningChanged, saveStatusChanged } from '../../store/saveSlice';
import type { ProjectDocument } from '@frameflow/shared';
import { createProjectSaver, restoreProject } from './projectStorage';
import { forgetDesign, readDesign, storedAssetIds, storedDesigns, storeDesign, type StorageAccess } from './designLibrary';
import { isProjectDocument } from './schema';
import { createDocument } from '../../store/editorSlice';
import { projectReset } from '../../store/projectReset';
import { assets } from '../assets/runtimeAssets';
import { projectAssetIds } from '../assets/projectAssetIds';
import { variantSelected } from '../../store/uiSlice';

/** Which version was open, per project, so a reload returns to it (e.g. a design opened from Image to layers). */
const ACTIVE_VERSION_KEY = 'frameflow:active-version:v1';

export function bootstrapEditor(storage: StorageAccess, artwork = assets) {
  const restored = restoreProject(storage);
  const store = createEditorStore(restored.document);
  const saver = createProjectSaver(storage, (status) => store.dispatch(saveStatusChanged(status)));
  if (restored.warning) {
    store.dispatch(recoveryWarningChanged(restored.warning));
    store.dispatch(saveStatusChanged('error'));
  } else if (restored.document) store.dispatch(saveStatusChanged('saved'));
  else saver.schedule(store.getState().editor.document);
  try {
    const remembered = JSON.parse(storage().getItem(ACTIVE_VERSION_KEY) || 'null') as { projectId?: string; variantId?: string } | null;
    // The store ignores a version that no longer exists in this document.
    if (remembered?.variantId && remembered.projectId === store.getState().editor.document.id) store.dispatch(variantSelected(remembered.variantId));
  } catch { /* optional */ }
  let previous = store.getState().editor.document;
  let active = store.getState().ui.activeVariantId;
  const unsubscribe = store.subscribe(() => {
    const state = store.getState();
    if (state.ui.activeVariantId !== active) {
      active = state.ui.activeVariantId;
      try { storage().setItem(ACTIVE_VERSION_KEY, JSON.stringify({ projectId: state.editor.document.id, variantId: active })); } catch { /* optional */ }
    }
    const current = state.editor.document;
    if (current === previous) return;
    previous = current;
    saver.schedule(current);
  });
  /**
   * Opens `next` in place of the open design, which is kept exactly as it is among the stored designs (designLibrary.ts):
   * nothing is added to either. Storage refusing any step leaves the open design open and unchanged.
   */
  function activate(next: ProjectDocument) {
    if (!isProjectDocument(next)) throw new Error('This design cannot be opened.');
    const current = store.getState().editor.document;
    if (next.id === current.id) return;
    saver.flush();
    storeDesign(storage, current);
    try { saver.replace(next); }
    catch (error) { forgetDesign(storage, current.id); throw error; }
    forgetDesign(storage, next.id);
    previous = next; // The subscription must not schedule another write of what is already saved.
    store.dispatch(projectReset(next));
  }
  const pendingCleanup = new Set<string>();
  async function cleanupArtwork() {
    const results = await Promise.allSettled([...pendingCleanup].map(async (id) => {
      await artwork.deleteAsset(id); pendingCleanup.delete(id);
    }));
    return results.every((result) => result.status === 'fulfilled');
  }
  return { store, flush: saver.flush, cleanupArtwork,
    /** The other designs on this device (never the open one), newest first. */
    designs: () => storedDesigns(storage).filter((entry) => entry.id !== store.getState().editor.document.id),
    /** Switches to a stored design; the open one is kept. */
    openDesign(id: string) {
      const document = readDesign(storage, id);
      if (!document) throw new Error('This design could not be read from this device.');
      activate(document);
    },
    /** Opens a new design (e.g. a decomposed template result) in place of the open one, which is kept. */
    openNewDesign: (document: ProjectDocument) => activate(document),
    async newDesign() {
      // Pictures another stored design still shows are never removed with this one.
      const kept = storedAssetIds(storage), ids = [...projectAssetIds(store.getState())].filter((id) => !kept.has(id));
      const fresh = createDocument(crypto.randomUUID(), new Date().toISOString());
      saver.replace(fresh);
      previous = fresh; // The subscription must not schedule another old-document write.
      store.dispatch(projectReset(fresh));
      for (const id of ids) pendingCleanup.add(id);
      return cleanupArtwork();
    },
    dispose() { unsubscribe(); saver.dispose(); } };
}
