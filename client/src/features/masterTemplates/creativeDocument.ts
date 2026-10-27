/**
 * A creative of a master template in the editor, and back.
 *
 *   to the editor   the master's saved artwork at the bottom (its clean background as one locked picture, or Seedream's
 *                   layers of it), then every plate as its own shape, every logo slot as its own picture (fitted in its
 *                   box), and every word as its own native text placed on its saved baseline. Ids carry the creative's own
 *                   element ids, so saving maps each editor element back to the element it came from.
 *   back            the editor's texts, pictures and shapes as the creative's elements (source pixels), new pictures uploaded
 *                   to the creative; the artwork layers are the master's and are not written back.
 *
 * COORDINATES: the creative's are source pixels; the editor canvas is the source scaled down (never up) so the largest
 * word stays within the editor's font size limit. `variant.creative.scale` records it; the export draws at 1/scale, so
 * an exported creative has the master's own size.
 */
import {
  CANVAS_LIMITS, centreRotationToOrigin, clamp, protectedEditorCanvas, TEXT_LIMITS, validWordGroupId, validWordLineId,
  type CreativeImage, type CreativeInstance, type CreativeShape, type CreativeText, type DesignLayer, type DesignVariant, type ImageLayerElement, type MasterSnapshot, type ProjectDocument, type ShapeLayerElement, type TextElement,
} from '@frameflow/shared';
import { isDesignVariant } from '../../lib/persistence/schema';
import { baselineOffset, measureAdvance } from './creativeText';

type Assets = { putAsset(id: string, blob: Blob): Promise<unknown>; deleteAsset(id: string): Promise<unknown>; getAsset?(id: string): Promise<{ blob: Blob } | null | undefined> };
export type CreativeDocumentDeps = { file: (name: string) => Promise<Blob>; assets: Assets; newId?: () => string; now?: () => string };
export const creativeResultId = (cid: string) => `creative-${cid}`;
const TEXT_PREFIX = 'text-', IMAGE_PREFIX = 'layer-', SHAPE_PREFIX = 'shape-', ART_PREFIX = 'art-';
/** The asset id a creative's picture is stored under in the browser: replaced pictures get other ids (detected on save). */
const imageAssetId = (cid: string, image: CreativeImage) => `creative-${cid.slice(3)}-${image.id}-${image.asset.file.replace(/[^a-z0-9]/gi, '').slice(-24)}`;

/** The editor scale for a master: its own size, down to the editor's limits and so the largest word fits the font limit. */
export function creativeScale(canvas: { width: number; height: number }, c: Pick<CreativeInstance, 'texts'>): number {
  const base = protectedEditorCanvas(canvas).scale.x, largest = Math.max(1, ...c.texts.map(t => t.style.fontSize));
  const fit = Math.min(base, (TEXT_LIMITS.maxFontSize - 1) / largest);
  return Math.max(fit, CANVAS_LIMITS.minSide / Math.min(canvas.width, canvas.height));
}

/** One creative text as editor text: its top from its baseline, wide enough that the word never wraps. */
export function creativeTextElement(t: CreativeText, s: number, snapshot: Pick<MasterSnapshot, 'masterId' | 'words'>, native = false): TextElement {
  const fontSize = clamp(t.style.fontSize * s, native ? 0.001 : TEXT_LIMITS.minFontSize, TEXT_LIMITS.maxFontSize), offset = baselineOffset(t.style, t.style.fontSize, 1), angle = t.rotation * Math.PI / 180;
  const advance = measureAdvance(t.text, t.style), word = t.wordId ? snapshot.words.find(w => w.id === t.wordId) : undefined;
  return {
    id: `${TEXT_PREFIX}${t.id}`, type: 'text', role: 'generic-text', name: `Text · ${t.text}`.slice(0, 200), text: t.text,
    x: (t.x + offset * Math.sin(angle)) * s, y: (t.baselineY - offset * Math.cos(angle)) * s, width: clamp((advance + t.style.fontSize * 0.6) * s, TEXT_LIMITS.minWidth, TEXT_LIMITS.maxWidth),
    fontFamily: t.style.fontFamily, fontSize, fontWeight: t.style.fontWeight, fill: t.style.color, align: 'left', lineHeight: 1, letterSpacing: t.style.letterSpacing * s,
    ...(t.style.fontStyle === 'italic' ? { fontStyle: 'italic' as const } : {}), ...(t.style.opacity < 1 ? { opacity: t.style.opacity } : {}), ...(t.rotation ? { rotation: t.rotation } : {}),
    zIndex: t.z, ...(t.hidden ? { visible: false } : {}), ...(t.locked ? { locked: true } : {}),
    ...(word && validWordGroupId(word.groupId) && validWordLineId(word.lineId) ? { protectedSlot: { templateId: snapshot.masterId, elementId: word.elementId, kind: 'text' as const, representation: 'native-text' as const, word: { id: word.id, groupId: word.groupId, lineId: word.lineId, order: t.order, role: word.role, protected: word.protected } } } : {}),
  };
}

/** The creative's design: one version, opened as its own design (never a version of another). */
export async function creativeDocument(snapshot: MasterSnapshot, c: CreativeInstance, deps: CreativeDocumentDeps): Promise<ProjectDocument> {
  const newId = deps.newId ?? (() => crypto.randomUUID()), at = deps.now?.() ?? new Date().toISOString();
  // One exact scale for everything (the canvas is whole pixels; the artwork keeps the exact proportion, so an export at
  // 1/scale draws every source pixel onto exactly one output pixel, with no resampling).
  const width = Math.floor(c.canvas.width * creativeScale(c.canvas, c)), s = width / c.canvas.width, height = Math.floor(c.canvas.height * s);
  // Ids are the creative's own (its rebuilt design reuses them); only ids new to the browser are removed on a failure.
  const stored: string[] = [];
  const store = async (id: string, blob: Blob) => { const existed = !!(await deps.assets.getAsset?.(id).catch(() => undefined)); await deps.assets.putAsset(id, blob); if (!existed) stored.push(id); return id; };
  try {
    const layers: DesignLayer[] = [];
    // The master's artwork: never moved by accident (locked), never written back.
    if (!c.backgroundColor && snapshot.layers.length) for (const l of [...snapshot.layers].sort((a, b) => a.zIndex - b.zIndex)) {
      layers.push({ id: `${ART_PREFIX}${l.id}`, type: 'image', assetId: await store(`creative-${c.id.slice(3)}-art-${l.sha256.slice(0, 16)}`, await deps.file(l.file)), name: `Artwork · ${l.name}`.slice(0, 200),
        x: l.x * s, y: l.y * s, width: Math.max(1, l.width * s), height: Math.max(1, l.height * s), rotation: 0, opacity: 1, visible: true, locked: true, zIndex: -1000 + l.zIndex, role: 'generic-image' });
    } else if (!c.backgroundColor) layers.push({ id: `${ART_PREFIX}background`, type: 'image', assetId: await store(`creative-${c.id.slice(3)}-art-${snapshot.background.sha256.slice(0, 16)}`, await deps.file(snapshot.background.file)),
      name: 'Artwork · clean background', x: 0, y: 0, width, height: snapshot.canvas.height * s, rotation: 0, opacity: 1, visible: true, locked: true, zIndex: -1000, role: 'generic-image' });
    for (const sh of c.shapes) layers.push(shapeLayer(sh, s));
    for (const img of c.images) {
      const blob = await deps.file(img.asset.file), origin = centreRotationToOrigin({ ...img.box, x: img.box.x * s, y: img.box.y * s, width: img.box.width * s, height: img.box.height * s });
      const slot = img.slotId ? snapshot.logoSlots.find(l => l.id === img.slotId) : undefined;
      // The template's artwork placed by an AI creative: its background picture, locked like the master's artwork.
      layers.push({ id: `${IMAGE_PREFIX}${img.id}`, type: 'image', assetId: await store(imageAssetId(c.id, img), blob), name: `${img.label}`.slice(0, 200), role: img.artwork ? 'generic-image' : 'logo',
        x: origin.x, y: origin.y, width: Math.max(1, img.box.width * s), height: Math.max(1, img.box.height * s), rotation: img.box.rotation, opacity: 1, visible: !img.hidden, locked: img.locked, zIndex: img.z,
        fit: 'contain', focalPoint: { x: 0.5, y: 0.5 },
        ...(slot ? { protectedSlot: { templateId: snapshot.masterId, elementId: slot.elementId, kind: 'logo' as const, representation: img.asset.kind === 'master' ? 'raster' as const : 'source-asset' as const, logoSlotId: slot.id } } : {}) });
    }
    const elements = c.texts.filter(t => t.text.trim()).map(t => creativeTextElement(t, s, snapshot));
    if (elements.length > TEXT_LIMITS.maxElements) throw new Error(`This creative has ${elements.length} texts; the editor holds at most ${TEXT_LIMITS.maxElements} per design.`);
    const variant: DesignVariant = { id: `creative-${newId()}`, name: c.name.slice(0, 120), revision: 0, canvas: { width, height, backgroundColor: c.backgroundColor ?? '#FFFFFF' }, elements, layers,
      importedFrom: { templateId: snapshot.masterId, resultId: creativeResultId(c.id), runId: c.id },
      creative: { masterId: snapshot.masterId, masterRevision: snapshot.revision, creativeId: c.id, syncedRevision: c.revision, scale: s, size: { ...c.canvas } } };
    if (!isDesignVariant(variant)) throw new Error('The creative did not pass the editor\'s checks; nothing was opened.');
    return { schemaVersion: 1, id: `design-${newId()}`, name: c.name.slice(0, 120), createdAt: at, updatedAt: at, variants: [variant] };
  } catch (error) {
    await Promise.all(stored.map(id => deps.assets.deleteAsset(id).catch(() => undefined)));
    throw error instanceof Error ? error : new Error('The creative could not be opened.');
  }
}
export function shapeLayer(sh: CreativeShape, s: number): ShapeLayerElement {
  const origin = centreRotationToOrigin({ ...sh.box, x: sh.box.x * s, y: sh.box.y * s, width: sh.box.width * s, height: sh.box.height * s });
  return { id: `${SHAPE_PREFIX}${sh.id}`, type: 'shape', shapeType: 'rounded-rectangle', name: 'Plate', x: origin.x, y: origin.y, width: Math.max(1, sh.box.width * s), height: Math.max(1, sh.box.height * s),
    rotation: sh.box.rotation, opacity: 1, visible: !sh.hidden, locked: false, zIndex: sh.z, fill: sh.fill, radius: sh.radius * s, ...(sh.stroke ? { stroke: { color: sh.stroke.color, width: sh.stroke.width * s } } : {}) };
}

/** The box (rotation about its centre) of an editor layer that rotates about its own origin, in source pixels. */
export function editorLayerBox(l: Pick<DesignLayer, 'x' | 'y' | 'width' | 'height' | 'rotation'>, s: number) {
  const a = (l.rotation * Math.PI) / 180, cx = l.x + (l.width / 2) * Math.cos(a) - (l.height / 2) * Math.sin(a), cy = l.y + (l.width / 2) * Math.sin(a) + (l.height / 2) * Math.cos(a);
  return { x: (cx - l.width / 2) / s, y: (cy - l.height / 2) / s, width: l.width / s, height: l.height / s, rotation: l.rotation };
}
const boxOf = editorLayerBox;
/** A stable creative id for an element made in the editor (FNV-1a, 40 bits): the same element maps to the same id on every save. */
const stableId = (prefix: 'ct' | 'ci' | 'cs' | 'cg', key: string) => {
  let h = 0xcbf29ce484222325n;
  for (const ch of key) { h ^= BigInt(ch.codePointAt(0)!); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
  return `${prefix}-${(h & 0xffffffffffn).toString(16).padStart(10, '0')}`;
};

export interface CreativeFromEditor { creative: CreativeInstance; uploads: { imageId: string; assetId: string; name: string }[]; problems: string[] }
/**
 * The editor's version as the creative's elements: texts (one creative text per line), pictures and shapes, mapped back by
 * id. Pictures whose image was replaced or added in the editor are listed in `uploads` (the caller uploads them and sets
 * their assets). Texts in fonts that have no offer font file are reported in `problems` (the creative refuses them).
 */
export function creativeFromEditor(variant: DesignVariant, c: CreativeInstance, isOffer: (family: string) => boolean): CreativeFromEditor {
  const s = variant.creative?.scale ?? 1, problems: string[] = [], uploads: CreativeFromEditor['uploads'] = [];
  const groups = [...c.groups], texts: CreativeText[] = [], images: CreativeImage[] = [], shapes: CreativeShape[] = [];
  const addedGroup = () => { let g = groups.find(x => x.label === 'Added in the editor' && !x.masterGroupId); if (!g) { g = { id: stableId('cg', `${c.id}:added`), label: 'Added in the editor', category: 'supporting', masterGroupId: null, align: 'left' }; groups.push(g); } return g.id; };
  let order = 0;
  for (const el of [...variant.elements].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0))) {
    const previous = c.texts.find(t => t.id === (el.id.startsWith(TEXT_PREFIX) ? el.id.slice(TEXT_PREFIX.length) : stableId('ct', `${el.id}:0`)));
    if (!isOffer(el.fontFamily)) problems.push(`“${el.text.slice(0, 40)}” uses ${el.fontFamily}, which has no offer font file: choose one of the offer fonts.`);
    const style = { fontFamily: el.fontFamily, fontWeight: el.fontWeight, fontStyle: el.fontStyle === 'italic' ? 'italic' as const : 'normal' as const, fontSize: el.fontSize / s, letterSpacing: el.letterSpacing / s, color: el.fill.toLowerCase(), opacity: el.opacity ?? 1 };
    // A text with several lines becomes one creative text per line, on its own baseline.
    el.text.split('\n').forEach((line, i) => {
      if (!line.trim() && el.text.includes('\n')) return;
      const offset = baselineOffset(style, style.fontSize, el.lineHeight) + i * el.lineHeight * style.fontSize, angle = (el.rotation ?? 0) * Math.PI / 180;
      const baselineY = el.y / s + offset * Math.cos(angle), x = el.x / s - offset * Math.sin(angle);
      const keep = i === 0 && previous;
      texts.push({ id: keep ? previous.id : stableId('ct', `${el.id}:${i}`), wordId: keep ? previous.wordId : null, groupId: previous?.groupId ?? addedGroup(), line: (previous?.line ?? 0) + i, order: keep ? previous.order : order++, text: line, x, baselineY,
        rotation: el.rotation ?? 0, style, hidden: el.visible === false, locked: el.locked === true, z: Math.max(0, el.zIndex ?? 0) });
    });
  }
  for (const layer of variant.layers ?? []) {
    if (layer.id.startsWith(ART_PREFIX)) continue;
    if (layer.type === 'shape') {
      const previous = c.shapes.find(x => x.id === (layer.id.startsWith(SHAPE_PREFIX) ? layer.id.slice(SHAPE_PREFIX.length) : stableId('cs', layer.id)));
      shapes.push({ id: previous?.id ?? stableId('cs', layer.id), plateId: previous?.plateId ?? null, groupId: previous?.groupId ?? addedGroup(), box: boxOf(layer, s), fill: layer.fill.toLowerCase(),
        stroke: layer.stroke ? { color: layer.stroke.color.toLowerCase(), width: layer.stroke.width / s } : null, radius: layer.radius / s, hidden: !layer.visible, z: Math.max(0, layer.zIndex ?? 0) });
      continue;
    }
    const img = layer as ImageLayerElement, previous = c.images.find(x => x.id === (img.id.startsWith(IMAGE_PREFIX) ? img.id.slice(IMAGE_PREFIX.length) : stableId('ci', img.id)));
    if (!img.assetId) continue;
    const id = previous?.id ?? stableId('ci', img.id), unchanged = previous && img.assetId === imageAssetId(c.id, previous);
    const next: CreativeImage = { id, slotId: previous?.slotId ?? null, category: previous?.category ?? 'graphic', label: (previous?.label ?? img.name).slice(0, 200), box: boxOf(img, s),
      asset: previous?.asset ?? { kind: 'master', file: '' }, hidden: !img.visible, locked: img.locked, z: Math.max(0, img.zIndex ?? 0), ...(previous?.artwork ? { artwork: true as const } : {}) };
    if (!unchanged) uploads.push({ imageId: id, assetId: img.assetId, name: img.name });
    images.push(next);
  }
  return { creative: { ...c, groups, texts, images, shapes, ...(c.backgroundColor ? { backgroundColor: variant.canvas.backgroundColor } : {}) }, uploads, problems };
}
export const isCreativeVariant = (v: DesignVariant | undefined): v is DesignVariant & { creative: NonNullable<DesignVariant['creative']> } => !!v?.creative;
export const creativeAssetIdOf = imageAssetId;
