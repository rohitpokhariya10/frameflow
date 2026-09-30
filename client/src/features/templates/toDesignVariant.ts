import { canvasElementsToVariant, validateCanvasSize, type CanvasElement, type CanvasSize, type DesignVariant } from '@frameflow/shared';

export interface VariantDeps {
  newId: () => string;
  /** A copy of an asset under a new id (the editor owns and may delete its own assets), or undefined when it is missing. */
  copyAsset: (assetId: string) => Promise<string | undefined>;
  deleteAsset: (assetId: string) => Promise<unknown>;
}
export interface CreativeSource { name: string; templateId: string; templateVersion: number; creativeId: string }

/**
 * A creative as a design for the existing editor. `elements` are the template's CanvasElements with the creative's
 * content in place (applyCreative): the complete elements, still normalized. The shared adapter
 * (canvasEditorAdapter.ts) turns them into the editor's format with every shared property kept: one order across text,
 * images and shapes, rotation, the raw text with its overflow rules, image fit and focal point. Nothing is flattened.
 *
 * The design is independent from then on: it gets its own copy of each picture and shares no data with the template or
 * the creative, so editing it in the editor changes neither. Pictures are copied first; on any failure the copies are
 * removed and nothing is returned.
 */
export async function creativeToVariant(elements: readonly CanvasElement[], canvas: CanvasSize, source: CreativeSource, deps: VariantDeps): Promise<DesignVariant> {
  if (!validateCanvasSize(canvas.width, canvas.height).valid) throw new Error(`A ${canvas.width} × ${canvas.height} canvas cannot be opened in the editor.`);
  const copies: Record<string, string> = {};
  try {
    for (const element of elements) {
      const assetId = element.type === 'image' || element.type === 'background' ? element.defaultContent.assetId : null;
      if (!assetId || copies[assetId]) continue;
      const copy = await deps.copyAsset(assetId);
      if (!copy) throw new Error(`The picture of "${element.name}" is missing from this browser. Replace it, then open the creative in the editor.`);
      copies[assetId] = copy;
    }
    return canvasElementsToVariant(elements, canvas, { id: `template-${deps.newId()}`, name: source.name.slice(0, 200) || 'Creative', assets: copies,
      template: { templateId: source.templateId, templateVersion: source.templateVersion, creativeId: source.creativeId } });
  } catch (error) {
    await Promise.all(Object.values(copies).map(id => deps.deleteAsset(id).catch(() => undefined)));
    throw error instanceof Error ? error : new Error('The creative could not be opened in the editor.');
  }
}
