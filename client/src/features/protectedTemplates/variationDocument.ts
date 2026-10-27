/**
 * A style variation in the editor: its artwork as one locked image layer at the bottom, each logo slot as its own image
 * layer (the source's exact pixels or the uploaded replacement, fitted inside its variant box), and each word of the
 * template as its own native text, at its variant box and baseline, in its variant style.
 *
 * The canvas keeps the template's aspect; it is scaled down (never up) so the largest word fits the editor's font-size
 * limit. Coordinates are the variation's VARIANT ones; the template's original boxes are not read or changed here.
 * Nothing here calls a provider: it reads stored files only.
 */
import {
  CANVAS_LIMITS, catalogFont, centreRotationToOrigin, clamp, PROVENANCE_LABELS, protectedEditorCanvas, TEXT_LIMITS, textTopForBaseline,
  type DesignLayer, type ProjectDocument, type ProtectedTemplateView, type StyleVariationView, type TextElement, type VariantWordPlacement,
} from '@frameflow/shared';
import { isDesignVariant } from '../../lib/persistence/schema';

type Assets = { putAsset(id: string, blob: Blob): Promise<unknown>; deleteAsset(id: string): Promise<unknown> };
export type VariationDocumentDeps = { file: (url: string) => Promise<Blob>; templateFileUrl: (file: string) => string; assets: Assets; newId?: () => string; now?: () => string };
/** Every word is one line of text: one element per word, its box wide enough that a slightly wider font never wraps it. */
const WORD_LINE_HEIGHT = 1;
export const variationResultId = (v: Pick<StyleVariationView, 'id'>) => `variation-${v.id}`;

/** The editor canvas for a variation: the template's own size, scaled so its largest word stays within the font limit. */
export function variationCanvas(source: { width: number; height: number }, words: Pick<VariantWordPlacement, 'style'>[]) {
  const base = protectedEditorCanvas(source), largest = Math.max(0, ...words.map(w => w.style.fontSize));
  const fit = largest * base.scale.x > TEXT_LIMITS.maxFontSize ? TEXT_LIMITS.maxFontSize / largest : base.scale.x;
  const s = Math.max(fit, CANVAS_LIMITS.minSide / Math.min(source.width, source.height));
  const width = Math.floor(source.width * s), height = Math.floor(source.height * s);
  return { width, height, scale: { x: width / source.width, y: height / source.height } };
}

/** One word as editor text: the top of its text box from its baseline, so the drawn word sits where the slot is. */
export function wordText(w: VariantWordPlacement, scale: { x: number; y: number }, templateId: string, elementId: string, kind: ProtectedTemplateView['elements'][number]['kind'], id: string, zIndex: number, locked: boolean): TextElement {
  const fontSize = clamp(w.style.fontSize * scale.y, TEXT_LIMITS.minFontSize, TEXT_LIMITS.maxFontSize);
  const box = { x: w.box.x * scale.x, y: w.box.y * scale.y, width: w.box.width * scale.x, height: w.box.height * scale.y, rotation: w.box.rotation };
  const top = textTopForBaseline((w.box.y + w.style.baseline) * scale.y, fontSize, WORD_LINE_HEIGHT);
  // A rotated word turns about its box centre; the editor turns text about its own origin.
  const origin = box.rotation ? centreRotationToOrigin({ ...box, y: top, height: box.height + (box.y - top) }) : { x: box.x, y: top };
  return {
    id, type: 'text', role: 'generic-text', name: `Word · ${w.text}`.slice(0, 200), text: w.text.slice(0, TEXT_LIMITS.maxCharacters),
    x: origin.x, y: origin.y, width: clamp(box.width * 1.3 + fontSize, TEXT_LIMITS.minWidth, TEXT_LIMITS.maxWidth), ...(box.rotation ? { rotation: box.rotation } : {}),
    fontFamily: w.style.fontFamily, fontSize, fontWeight: w.style.fontWeight, fill: w.style.color, align: 'left', lineHeight: WORD_LINE_HEIGHT, letterSpacing: w.style.letterSpacing * scale.x,
    ...(w.style.fontStyle === 'italic' ? { fontStyle: 'italic' as const } : {}), ...(w.style.opacity < 1 ? { opacity: w.style.opacity } : {}),
    zIndex, locked, ...(w.hidden ? { visible: false } : {}),
    protectedSlot: { templateId, elementId, kind, representation: 'native-text', word: { id: w.wordId, groupId: w.groupId, lineId: w.lineId, order: w.order, role: w.role, protected: w.protected } },
  };
}

/**
 * The variation's design. Opening the same variation again returns to it (importedFrom marks it); the design is from then
 * on independent: editing it changes neither the variation nor the template.
 */
export async function variationDocument(t: ProtectedTemplateView, v: StyleVariationView, deps: VariationDocumentDeps): Promise<ProjectDocument> {
  const analysis = t.textAnalysis ?? (() => { throw new Error('The template has no word analysis.'); })();
  if (!v.artwork) throw new Error('This variation has no artwork yet.');
  const newId = deps.newId ?? (() => crypto.randomUUID()), at = deps.now?.() ?? new Date().toISOString();
  const source = { width: t.source.width, height: t.source.height }, canvas = variationCanvas(source, v.layout.words), s = canvas.scale;
  const stored: string[] = [];
  const store = async (blob: Blob, prefix: string) => { const id = `${prefix}-${newId()}`; await deps.assets.putAsset(id, blob); stored.push(id); return id; };
  try {
    let z = 0;
    const layers: DesignLayer[] = [{ id: `layer-${newId()}`, type: 'image', assetId: await store(await deps.file(v.artwork.url), 'variation'), name: `Artwork · ${v.preset.name} · ${PROVENANCE_LABELS[v.provenance]}`.slice(0, 200),
      x: 0, y: 0, width: canvas.width, height: canvas.height, rotation: 0, opacity: 1, visible: true, locked: true, zIndex: z++, role: 'generic-image' }];
    for (const placement of v.layout.logos) {
      const slot = analysis.logoSlots.find(l => l.id === placement.slotId), element = slot && t.elements.find(e => e.id === slot.elementId);
      if (!slot || !element) continue;
      const file = placement.asset === 'replacement' && slot.replacement ? slot.replacement.file : slot.original.file, origin = centreRotationToOrigin({ ...placement.box, x: placement.box.x * s.x, y: placement.box.y * s.y, width: placement.box.width * s.x, height: placement.box.height * s.y });
      layers.push({ id: `layer-${newId()}`, type: 'image', assetId: await store(await deps.file(deps.templateFileUrl(file)), 'protected'), name: `Logo · ${slot.label}${slot.replacement && placement.asset === 'replacement' ? ' (replaced)' : ''}`.slice(0, 200), role: 'logo',
        x: origin.x, y: origin.y, width: Math.max(1, placement.box.width * s.x), height: Math.max(1, placement.box.height * s.y), rotation: placement.box.rotation, opacity: 1, visible: !placement.hidden, locked: slot.locked, zIndex: z++,
        fit: 'contain', focalPoint: { x: 0.5, y: 0.5 }, protectedSlot: { templateId: t.id, elementId: element.id, kind: element.kind, representation: placement.asset === 'replacement' && slot.replacement ? 'source-asset' : 'raster', logoSlotId: slot.id } });
    }
    const words = [...v.layout.words].sort((a, b) => a.order - b.order), original = new Map(analysis.words.map(w => [w.id, w]));
    if (words.length > TEXT_LIMITS.maxElements) throw new Error(`This template has ${words.length} words; the editor holds at most ${TEXT_LIMITS.maxElements} texts per design.`);
    const elements: TextElement[] = words.map(w => {
      const element = t.elements.find(e => e.id === original.get(w.wordId)?.elementId);
      if (!element) throw new Error(`“${w.text}”: its protected region is missing.`);
      // A family without an italic is drawn upright here (the browser would slant it artificially).
      const placed = { ...w, style: { ...w.style, fontStyle: w.style.fontStyle === 'italic' && catalogFont(w.style.fontFamily)?.italic ? 'italic' as const : 'normal' as const } };
      return wordText(placed, s, t.id, element.id, element.kind, `text-${newId()}`, z++, original.get(w.wordId)?.locked ?? false);
    });
    const name = `${t.name} · ${v.preset.name}`.slice(0, 120);
    const variant = { id: `variation-${newId()}`, name, revision: 0, canvas: { width: canvas.width, height: canvas.height, backgroundColor: '#FFFFFF' }, elements, layers,
      importedFrom: { templateId: t.id, resultId: variationResultId(v), runId: v.id },
      styleVariation: { variationId: v.id, templateId: t.id, presetId: v.preset.id, provenance: v.provenance, typographyMode: v.layout.typographyMode } };
    if (!isDesignVariant(variant)) throw new Error('The variation did not pass the editor\'s checks; nothing was opened.');
    return { schemaVersion: 1, id: `design-${newId()}`, name, createdAt: at, updatedAt: at, variants: [variant] };
  } catch (error) {
    await Promise.all(stored.map(id => deps.assets.deleteAsset(id).catch(() => undefined)));
    throw error instanceof Error ? error : new Error('The variation could not be opened.');
  }
}
