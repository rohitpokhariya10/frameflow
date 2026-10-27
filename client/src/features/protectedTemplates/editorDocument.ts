/**
 * A protected template in the editor: Seedream's layers of the prepared base, back to front, and above them every
 * protected element in its own slot, restored from what was preserved (never from Seedream):
 *
 *   raster        the element's own pixels, an image layer over exactly the pixel rectangle they were cut from
 *   source-asset  the original file, fitted (contain) in the element's box, rotated with it
 *   native-text   editable text from the administrator's text and style, in the element's box
 *
 * The canvas is the source's own size (scaled down only to the editor's limits); Seedream's canvas and the source pixels
 * are both mapped onto it (protectedContent.ts), so nothing depends on how either was shown. A reuse may give any slot a
 * new picture or new text, or hide it; the slot keeps its box. Nothing here calls the server's providers: it reads the
 * stored run and template files only.
 */
import { CANVAS_TEXT_ROLES, centreRotationToOrigin, clamp, editorFontFor, mapBox, protectedEditorCanvas, PROTECTED_KIND_LABELS, sameAspect, TEMPLATE_LIMITS, TEXT_LIMITS,
  type DesignLayer, type ImageLayerElement, type ProjectDocument, type ProtectedElement, type ProtectedTemplateView, type SourceBox, type TextElement } from '@frameflow/shared';
import { isDesignVariant } from '../../lib/persistence/schema';
import { editorLayersOf, type ExperimentRun } from '../decomposition/layerizeExperiment';

type Assets = { putAsset(id: string, blob: Blob): Promise<unknown>; deleteAsset(id: string): Promise<unknown> };
/** What a reuse does with a slot. Absent: keep it as preserved. */
export type SlotReplacement = { kind: 'keep' } | { kind: 'hide' } | { kind: 'image'; blob: Blob } | { kind: 'text'; text: string };
export type ProtectedDocumentDeps = { runFile: (file: string) => Promise<Blob>; templateFile: (file: string) => Promise<Blob>; assets: Assets; newId?: () => string; now?: () => string };
const TEXT_ROLE: Record<ProtectedElement['kind'], typeof CANVAS_TEXT_ROLES[number]> = { text: 'generic-text', legal: 'paragraph', logo: 'generic-text', other: 'generic-text' };

/** Whether a slot can be given new text in a reuse: native text always; a raster only when its text style was recorded. */
export const textReplaceable = (e: ProtectedElement) => e.representation === 'native-text' || !!e.text;

/** The editor text for an element with text metadata, in its box on the editor canvas. */
export function protectedText(e: ProtectedElement, value: string, box: SourceBox, scale: { x: number; y: number }, id: string, zIndex: number, templateId: string): TextElement {
  const t = e.text!, origin = centreRotationToOrigin(box), fontSize = clamp(t.fontSize * scale.y, TEXT_LIMITS.minFontSize, TEXT_LIMITS.maxFontSize);
  return { id, type: 'text', role: TEXT_ROLE[e.kind], name: `Protected ${PROTECTED_KIND_LABELS[e.kind].toLowerCase()} · ${e.label}`.slice(0, 200), text: value.slice(0, TEXT_LIMITS.maxCharacters),
    x: origin.x, y: origin.y, width: clamp(box.width, TEXT_LIMITS.minWidth, TEXT_LIMITS.maxWidth), height: Math.max(1, box.height), ...(box.rotation ? { rotation: box.rotation } : {}),
    fontFamily: editorFontFor(t), fontSize, fontWeight: t.fontWeight, fill: t.color, align: t.align, verticalAlign: t.verticalAlign, lineHeight: t.lineHeight, letterSpacing: t.letterSpacing * scale.x,
    maxLines: TEMPLATE_LIMITS.maxLines, overflow: 'shrink', minFontSize: Math.max(TEXT_LIMITS.minFontSize, Math.min(fontSize, fontSize * 0.5)), zIndex,
    locked: e.locked, protectedSlot: { templateId, elementId: e.id, kind: e.kind, representation: 'native-text' } };
}

/**
 * The template's design: one version, the source's canvas. `replacements` (a reuse) changes slots; `importedFrom` marks
 * the approved template itself, so opening it again returns to the same design.
 */
export async function protectedTemplateDocument(template: ProtectedTemplateView, run: Pick<ExperimentRun, 'id' | 'canvas' | 'layers' | 'outputLayers' | 'editorLayerFiles'>, deps: ProtectedDocumentDeps,
  options: { replacements?: Record<string, SlotReplacement>; name?: string; importedFrom?: boolean } = {}): Promise<ProjectDocument> {
  const newId = deps.newId ?? (() => crypto.randomUUID()), at = deps.now?.() ?? new Date().toISOString();
  const source = { width: template.source.width, height: template.source.height }, canvas = protectedEditorCanvas(source);
  const seedream = editorLayersOf(run);
  if (!run.canvas || !seedream?.length) throw new Error('This run has no layers to open.');
  if (!sameAspect(run.canvas, source, 0.01)) throw new Error(`Seedream's canvas (${run.canvas.width}×${run.canvas.height}) does not match the source (${source.width}×${source.height}); the layers would not line up.`);
  const k = { x: canvas.width / run.canvas.width, y: canvas.height / run.canvas.height };
  const stored: string[] = [];
  const store = async (blob: Blob, prefix: string) => { const id = `${prefix}-${newId()}`; await deps.assets.putAsset(id, blob); stored.push(id); return id; };
  try {
    const layers: DesignLayer[] = [], elements: TextElement[] = [];
    let z = 0;
    for (const layer of [...seedream].sort((a, b) => a.zIndex - b.zIndex)) {
      const p = layer.placement;
      layers.push({ id: `layer-${newId()}`, type: 'image', assetId: await store(await deps.runFile(layer.file), 'layerize'), name: `${p.kind === 'base' ? 'Seedream base' : layer.name || 'Layer'} (z${layer.zIndex})`.slice(0, 200),
        x: p.x * k.x, y: p.y * k.y, width: Math.max(1, p.width * k.x), height: Math.max(1, p.height * k.y), rotation: 0, opacity: 1, visible: true, locked: false, zIndex: z++ });
    }
    for (const e of [...template.elements].sort((a, b) => a.zIndex - b.zIndex)) {
      const change = options.replacements?.[e.id] ?? { kind: 'keep' as const }, zIndex = z++, slot = { templateId: template.id, elementId: e.id, kind: e.kind } as const;
      const box = mapBox(e.box, source, canvas), visible = change.kind !== 'hide';
      const asText = change.kind === 'text' || (change.kind !== 'image' && e.representation === 'native-text');
      if (asText) {
        if (!e.text) throw new Error(`${e.label} has no recorded text style, so it cannot become text.`);
        elements.push({ ...protectedText(e, change.kind === 'text' ? change.text : e.text.value, box, canvas.scale, `text-${newId()}`, zIndex, template.id), visible });
        continue;
      }
      const role: ImageLayerElement['role'] = e.kind === 'logo' ? 'logo' : 'generic-image', name = `Protected ${PROTECTED_KIND_LABELS[e.kind].toLowerCase()} · ${e.label}`;
      const fitted = { fit: 'contain' as const, focalPoint: { x: 0.5, y: 0.5 } };
      if (change.kind === 'image' || e.representation === 'source-asset') {
        // A picture in the slot's box, rotated with it, never stretched.
        const blob = change.kind === 'image' ? change.blob : await deps.templateFile(e.sourceAsset?.file ?? (() => { throw new Error(`${e.label}: its original file is missing.`); })());
        const origin = centreRotationToOrigin(box);
        layers.push({ id: `layer-${newId()}`, type: 'image', assetId: await store(blob, 'protected'), name: `${name}${change.kind === 'image' ? ' (replaced)' : ' (original file)'}`.slice(0, 200), role,
          x: origin.x, y: origin.y, width: Math.max(1, box.width), height: Math.max(1, box.height), rotation: box.rotation, opacity: 1, visible, locked: e.locked, zIndex, ...fitted,
          protectedSlot: { ...slot, representation: change.kind === 'image' ? 'source-asset' : e.representation } });
        continue;
      }
      // The element's own pixels, over the pixel rectangle they were cut from (unrotated: the rotation is in the pixels).
      const raster = e.raster ?? (() => { throw new Error(`${e.label}: its preserved pixels are missing. Prepare the base again.`); })();
      const r = raster.placement, sx = canvas.scale.x, sy = canvas.scale.y;
      layers.push({ id: `layer-${newId()}`, type: 'image', assetId: await store(await deps.templateFile(raster.file), 'protected'), name: `${name} (original pixels)`.slice(0, 200), role,
        x: r.x * sx, y: r.y * sy, width: Math.max(1, r.width * sx), height: Math.max(1, r.height * sy), rotation: 0, opacity: 1, visible, locked: e.locked, zIndex, ...fitted,
        protectedSlot: { ...slot, representation: 'raster' },
        ...(e.text?.value ? { textSuggestion: { text: e.text.value, confidence: 'provided' as const, fill: e.text.color, fontSize: clamp(e.text.fontSize * sy, TEXT_LIMITS.minFontSize, TEXT_LIMITS.maxFontSize), fontWeight: e.text.fontWeight } } : {}) });
    }
    const name = (options.name ?? template.name).slice(0, 120);
    const variant = { id: `protected-${newId()}`, name, revision: 0, canvas: { width: canvas.width, height: canvas.height, backgroundColor: '#FFFFFF', transparent: true }, elements, layers,
      ...(options.importedFrom ? { importedFrom: { templateId: template.id, resultId: `approved-r${template.elementsRevision}`, runId: run.id } } : {}) };
    if (!isDesignVariant(variant)) throw new Error('The protected template did not pass the editor\'s checks; nothing was opened.');
    return { schemaVersion: 1, id: `design-${newId()}`, name, createdAt: at, updatedAt: at, variants: [variant] };
  } catch (error) {
    await Promise.all(stored.map(id => deps.assets.deleteAsset(id).catch(() => undefined)));
    throw error instanceof Error ? error : new Error('The template could not be opened.');
  }
}
