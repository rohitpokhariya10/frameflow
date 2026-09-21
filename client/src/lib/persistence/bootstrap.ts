import { createEditorStore } from '../../store';
import { recoveryWarningChanged, saveStatusChanged } from '../../store/saveSlice';
import { createProjectSaver, restoreProject, type StorageAccess } from './projectStorage';

export function bootstrapEditor(storage: StorageAccess) {
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
  return { store, flush: saver.flush, dispose() { unsubscribe(); saver.dispose(); } };
}
