import type { DesignVariant } from '@frameflow/shared';
import type { RootState } from '../../store';

/** Include undo/redo and uncommitted previews; never enumerate unrelated assets. */
export function projectAssetIds(state: RootState) {
  const ids = new Set<string>();
  function visit(variant: DesignVariant) {
    if (variant.background) ids.add(variant.background.assetId);
    if (variant.generation?.sourceAssetId) ids.add(variant.generation.sourceAssetId);
  }
  for (const document of [state.editor.document, ...state.editor.past, ...state.editor.future]) {
    for (const variant of document.variants) visit(variant);
  }
  if (state.ai.preview) {
    visit(state.ai.preview.variant);
    if (state.ai.preview.adaptation) visit(state.ai.preview.adaptation.source);
  }
  return ids;
}
