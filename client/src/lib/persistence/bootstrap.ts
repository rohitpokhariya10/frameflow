import { createEditorStore } from '../../store';
import { recoveryWarningChanged, saveStatusChanged } from '../../store/saveSlice';
import { createProjectSaver, restoreProject, type StorageAccess } from './projectStorage';
import { createDocument } from '../../store/editorSlice';
import { projectReset } from '../../store/projectReset';
import { assets } from '../assets/runtimeAssets';
import { projectAssetIds } from '../assets/projectAssetIds';

export function bootstrapEditor(storage: StorageAccess, artwork = assets) {
  const restored = restoreProject(storage);
  const store = createEditorStore(restored.document);
  const saver = createProjectSaver(storage, (status) => store.dispatch(saveStatusChanged(status)));
  if (restored.warning) {
    store.dispatch(recoveryWarningChanged(restored.warning));
    store.dispatch(saveStatusChanged('error'));
  } else if (restored.document) store.dispatch(saveStatusChanged('saved'));
  else saver.schedule(store.getState().editor.document);
  let previous = store.getState().editor.document;
  const unsubscribe = store.subscribe(() => {
    const current = store.getState().editor.document;
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
