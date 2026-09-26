import { createEditorStore } from '../../store';
import { recoveryWarningChanged, saveStatusChanged } from '../../store/saveSlice';
import { createProjectSaver, restoreProject, type StorageAccess } from './projectStorage';
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
  const pendingCleanup = new Set<string>();
  async function cleanupArtwork() {
    const results = await Promise.allSettled([...pendingCleanup].map(async (id) => {
      await artwork.deleteAsset(id); pendingCleanup.delete(id);
    }));
    return results.every((result) => result.status === 'fulfilled');
  }
  return { store, flush: saver.flush, cleanupArtwork,
    async newDesign() {
      const ids = projectAssetIds(store.getState());
      const fresh = createDocument(crypto.randomUUID(), new Date().toISOString());
      saver.replace(fresh);
      previous = fresh; // The subscription must not schedule another old-document write.
      store.dispatch(projectReset(fresh));
      for (const id of ids) pendingCleanup.add(id);
      return cleanupArtwork();
    },
    dispose() { unsubscribe(); saver.dispose(); } };
}
