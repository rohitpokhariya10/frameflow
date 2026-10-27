/**
 * Product with Text creatives: a saved template revision reused. A creative starts as the revision itself (every word as
 * its own editable text, every brand/bank/payment logo and QR code as its own picture, every character and product
 * as its own cut-out at its place) and is changed by replacing what is in a slot, editing text and logos
 * and moving things. Each save is a new revision file (`pcr-<id>-r<n>.json`); earlier ones stay as they were. The
 * template and its revisions are only read.
 */
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import {
  creativeFromSnapshot, fitToSlot, isMasterCategory, isOfferFont, offerWeights, PRODUCT_CREATIVE_LIMITS, PRODUCT_CREATIVE_SCHEMA_VERSION, PRODUCT_OBJECT_KINDS, validCreativeElementId,
  type CreativeImage, type CreativeShape, type CreativeText, type MasterSnapshot, type PixelRect, type ProductCreative, type ProductCreativeObject, type ProductObjectKind, type ProductSnapshot, type SourceBox,
} from '@frameflow/shared';
import { RunError } from '../../layerizeExperiment.js';
import type { ProtectedStore } from '../store.js';
import { sha256 } from '../pixels.js';
import { cutOutUpload } from './uploadCutout.js';
import { createProductCreativeRun, existingProductCreativeRun } from './creativeRun.js';
import { artworkBase } from './artworkText.js';

const nowIso = () => new Date().toISOString();
const hexId = (prefix: string, n = 5) => `${prefix}-${randomBytes(n).toString('hex')}`;
function fail(code: string, message: string, details?: Record<string, unknown>): never { throw new RunError(code, message, details); }
const fileOf = (cid: string, revision: number) => `pcr-${cid.slice(3)}-r${revision}.json`;
const CREATIVE_ID = /^pc-[a-f0-9]{6}$/, OBJECT_ID = /^(po|co)-[a-f0-9]{10}$/;

/** A product snapshot as the Text & Graphics creative builder reads one (its words, groups, logos and plates). */
export const asMasterSnapshot = (s: ProductSnapshot): MasterSnapshot => ({ schemaVersion: 1, masterId: s.templateId, revision: s.revision, publishedAt: s.publishedAt, name: s.name, canvas: s.canvas, source: s.source,
  background: { file: s.base.file, sha256: s.base.sha256, width: s.canvas.width, height: s.canvas.height, method: 'local-fill', reliability: 'uncertain', acknowledgedEstimate: true }, layers: [], decomposition: null,
  words: s.words, groups: s.groups, logoSlots: s.logoSlots, plates: s.plates, analysisRevision: 0 });

/**
 * A new creative of a revision: its text, logos and plates (as a Text & Graphics creative) and its objects. `artwork`
 * (artworkText.ts): the revision's background with a decoration's own lettering restored from the original (a badge), and
 * those groups — their words are kept, hidden, never set again over it.
 */
export function productCreativeFromSnapshot(snapshot: ProductSnapshot, input: { id: string; name: string; at: string; origin?: ProductCreative['origin'] }, artwork?: { file: string; sha256: string; groups: ReadonlySet<string> }): ProductCreative {
  if (snapshot.editorCreative) {
    const { masterEditing: _master, variation: _variation, ...saved } = structuredClone(snapshot.editorCreative); void _master; void _variation;
    return { ...saved, id: input.id, name: input.name, templateId: snapshot.templateId, templateRevision: snapshot.revision, revision: 1, createdAt: input.at, updatedAt: input.at,
      origin: input.origin ?? { kind: 'template' }, history: [{ at: input.at, action: 'created', detail: `From edited master revision ${snapshot.revision}.` }] };
  }
  const base = creativeFromSnapshot(asMasterSnapshot(snapshot), { id: input.id, name: input.name, at: input.at, newId: p => hexId(p) });
  const objects: ProductCreativeObject[] = [...snapshot.objects].sort((a, b) => a.z - b.z).filter(o => o.cutout).map((o, z) => ({ id: o.id, objectId: o.id, kind: o.kind, label: o.label,
    asset: { kind: 'template' as const, file: o.cutout!.file }, box: { ...o.cutout!.placement }, hidden: false, z }));
  return { schemaVersion: PRODUCT_CREATIVE_SCHEMA_VERSION, id: input.id, templateId: snapshot.templateId, templateRevision: snapshot.revision, name: input.name, createdAt: input.at, updatedAt: input.at, revision: 1,
    canvas: { ...snapshot.canvas }, groups: base.groups, texts: base.texts.map(t => ({ ...t, z: snapshot.words.find(w => w.id === t.wordId)?.source?.z ?? t.z, ...(artwork?.groups.has(t.groupId) ? { hidden: true } : {}) })), images: base.images, shapes: base.shapes, objects, origin: input.origin ?? { kind: 'template' },
    ...(artwork ? { background: { file: artwork.file, sha256: artwork.sha256, width: snapshot.canvas.width, height: snapshot.canvas.height, method: 'template' as const, restyled: false, filledPercent: 0 } } : {}),
    history: [{ at: input.at, action: 'created', detail: `From template revision ${snapshot.revision}.` }] };
}

export interface ProductCreativeDeps {
  store: ProtectedStore; runsDir: string;
  requireProduct: (id: string) => unknown;
  snapshot: (id: string, revision: number) => ProductSnapshot;
  latestRevision: (id: string) => number | undefined;
  locked: <T>(key: string, work: () => Promise<T>) => Promise<T>;
}

export function createProductCreatives(deps: ProductCreativeDeps) {
  const { store, locked } = deps;
  const validId = (cid: string) => { if (!CREATIVE_ID.test(cid)) fail('NOT_FOUND', 'Creative not found.'); return cid; };
  /** Every creative's revisions, newest first. */
  const revisionsOf = (id: string, cid: string) => store.files(id, `pcr-${cid.slice(3)}-r`).map(f => Number(/-r(\d+)\.json$/.exec(f)?.[1] ?? 0)).filter(n => n > 0).sort((a, b) => b - a);
  const read = (id: string, cid: string, revision?: number): ProductCreative => {
    deps.requireProduct(id); validId(cid);
    const latest = revisionsOf(id, cid)[0] ?? fail('NOT_FOUND', 'Creative not found.'), r = revision ?? latest;
    if (!store.has(id, fileOf(cid, r))) fail('NOT_FOUND', `Revision ${r} of this creative was not found.`);
    return JSON.parse(store.read(id, fileOf(cid, r)).toString('utf8')) as ProductCreative;
  };
  const ids = (id: string) => [...new Set(store.files(id, 'pcr-').map(f => /^pcr-([a-f0-9]{6})-r\d+\.json$/.exec(f)?.[1]).filter((x): x is string => !!x))].map(h => `pc-${h}`);
  /** Writes a revision that does not exist yet (never one that does). */
  const write = (id: string, c: ProductCreative) => {
    const file = fileOf(c.id, c.revision);
    if (store.has(id, file)) fail('STALE_REVISION', `This creative changed since you opened it (revision ${c.revision} exists). Reload it and make your change again.`);
    store.write(id, file, Buffer.from(JSON.stringify(c, null, 2)));
    return c;
  };
  const next = (old: ProductCreative, change: Partial<ProductCreative>, event: ProductCreative['history'][number]): ProductCreative =>
    ({ ...old, ...change, revision: old.revision + 1, updatedAt: event.at, history: [...old.history, event].slice(-PRODUCT_CREATIVE_LIMITS.maxHistory) });
  const expect = (old: ProductCreative, expected: unknown) => { if (expected !== old.revision) fail('STALE_REVISION', `This creative changed since you opened it (revision ${old.revision}, yours ${String(expected)}). Reload it and make your change again.`, { revision: old.revision }); };

  function list(id: string) {
    deps.requireProduct(id);
    return ids(id).map(cid => read(id, cid)).map(c => ({ id: c.id, name: c.name, templateRevision: c.templateRevision, revision: c.revision, createdAt: c.createdAt, updatedAt: c.updatedAt, origin: c.origin,
      replaced: c.objects.filter(o => o.asset.kind === 'upload').length, variation: c.variation ? { kind: c.variation.kind, title: c.variation.title } : undefined })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  const create = (id: string, input: { name?: unknown; revision?: unknown; masterEditing?: boolean }) => locked(`${id}:creatives`, async () => {
    deps.requireProduct(id);
    const latest = deps.latestRevision(id) ?? fail('NOT_READY', 'Save the template first.'), revision = typeof input.revision === 'number' ? input.revision : latest;
    if (ids(id).length >= PRODUCT_CREATIVE_LIMITS.maxCreatives) fail('TOO_MANY', `This template has ${PRODUCT_CREATIVE_LIMITS.maxCreatives} creatives; remove some first.`);
    const snapshot = deps.snapshot(id, revision), name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 120) : `${snapshot.name} · creative ${ids(id).length + 1}`;
    const artwork = await artworkBase({ has: f => store.has(id, f), read: f => store.read(id, f), write: (f, b) => store.write(id, f, b) }, snapshot);
    return write(id, { ...productCreativeFromSnapshot(snapshot, { id: hexId('pc', 3), name, at: nowIso() }, artwork), ...(input.masterEditing ? { masterEditing: true as const } : {}) });
  });
  /** Adds a creative made elsewhere (a generated variation), as its first revision. */
  const add = (id: string, c: ProductCreative) => locked(`${id}:creatives`, async () => { deps.requireProduct(id); return write(id, { ...c, revision: 1 }); });
  /** A creative made again elsewhere (a reused creative saved again): its next revision, earlier ones kept. */
  const replaceWith = (id: string, cid: string, c: ProductCreative) => locked(`${id}:${cid}`, async () => {
    const old = read(id, cid);
    return write(id, next(old, { ...c, id: old.id, createdAt: old.createdAt, history: old.history }, { at: nowIso(), action: 'edited', detail: c.history.at(-1)?.detail }));
  });

  /** Saves a creative's elements (texts, logos, plates, objects, name) as a new revision. */
  const save = (id: string, cid: string, input: { expectedRevision?: unknown; creative?: unknown }) => locked(`${id}:${cid}`, async () => {
    const old = read(id, cid); expect(old, input.expectedRevision);
    const snapshot = deps.snapshot(id, old.templateRevision), at = nowIso();
    return write(id, next(old, clean(input.creative, old, snapshot, id), { at, action: 'edited' }));
  });
  /** A new picture in an object's slot: cut out locally, fitted to the slot (its height, standing on its contact line). */
  const replace = (id: string, cid: string, objectId: string, input: { expectedRevision?: unknown; bytes: Buffer; filename?: string }) => locked(`${id}:${cid}`, async () => {
    const old = read(id, cid); expect(old, input.expectedRevision);
    const o = old.objects.find(x => x.id === objectId) ?? fail('NOT_FOUND', 'That element is not in this creative.');
    const snapshot = deps.snapshot(id, old.templateRevision), template = snapshot.objects.find(x => x.id === o.objectId);
    let cut;
    try { cut = await cutOutUpload(input.bytes); } catch { fail('UNSUPPORTED_IMAGE', 'That file could not be read as a picture. Use a PNG, JPEG or WebP image.'); }
    const hash = sha256(cut.png), file = `pca-${cid.slice(3)}-${hash.slice(0, 12)}.png`;
    if (!store.has(id, file)) store.write(id, file, cut.png);
    // Fitted to the slot when the template has one; else (a decoration, the brand logo) inside where the old picture was.
    const native = !!snapshot.editorCreative || !!old.absoluteZOrder;
    const slot = !native && template?.slot ? template.slot : { box: o.box, contactY: o.box.y + o.box.height - 1, targetHeight: o.box.height, z: o.z };
    const box = { ...(template?.slot || native ? fitToSlot(slot, cut, old.canvas) : contain(o.box, cut)), ...(o.box.rotation ? { rotation: o.box.rotation } : {}) };
    const objects = old.objects.map(x => x.id === objectId ? { ...x, box, asset: { kind: 'upload' as const, file, sha256: hash, width: cut.width, height: cut.height, background: cut.background, ...(input.filename ? { originalName: input.filename.slice(0, 200) } : {}) } } : x);
    const at = nowIso(), saved = write(id, next(old, { objects }, { at, action: 'replaced', detail: `${o.label}: ${input.filename?.slice(0, 80) ?? 'a new picture'} (${cut.background === 'kept' ? 'background kept' : cut.background === 'removed' ? 'background removed' : 'transparent'}).` }));
    return { creative: saved, cutout: { background: cut.background, ...(cut.note ? { note: cut.note } : {}) } };
  });
  /** The template's own picture back in an object's slot, at its place. */
  const restore = (id: string, cid: string, objectId: string, input: { expectedRevision?: unknown }) => locked(`${id}:${cid}`, async () => {
    const old = read(id, cid); expect(old, input.expectedRevision);
    const o = old.objects.find(x => x.id === objectId) ?? fail('NOT_FOUND', 'That element is not in this creative.');
    const snapshot = deps.snapshot(id, old.templateRevision), template = snapshot.objects.find(x => x.id === o.objectId);
    const edited = snapshot.editorCreative?.objects.find(x => (x.objectId && x.objectId === o.objectId) || x.id === o.id);
    const original = edited ? { box: edited.box, file: edited.asset.file } : template?.cutout ? { box: template.cutout.placement, file: template.cutout.file } : fail('NOT_REPLACEABLE', 'This element has no picture in the template to go back to.');
    const objects = old.objects.map(x => x.id === objectId ? { ...x, box: { ...original.box }, asset: { kind: 'template' as const, file: original.file } } : x);
    return write(id, next(old, { objects }, { at: nowIso(), action: 'restored', detail: o.label }));
  });
  const duplicate = (id: string, cid: string, input: { name?: unknown }) => locked(`${id}:creatives`, async () => {
    const old = read(id, cid), at = nowIso(), copyId = hexId('pc', 3);
    const copyFile = (f: string) => { const to = f.replace(`pca-${cid.slice(3)}-`, `pca-${copyId.slice(3)}-`); if (to !== f && !store.has(id, to)) store.write(id, to, store.read(id, f)); return to; };
    const copy: ProductCreative = { ...old, id: copyId, name: typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 120) : `${old.name} (copy)`.slice(0, 120), createdAt: at, updatedAt: at, revision: 1,
      objects: old.objects.map(o => o.asset.kind === 'upload' ? { ...o, asset: { ...o.asset, file: copyFile(o.asset.file) } } : o),
      images: old.images.map(i => i.asset.kind === 'creative' ? { ...i, asset: { ...i.asset, file: copyFile(i.asset.file) } } : i),
      ...(old.background ? { background: { ...old.background, file: copyFile(old.background.file) } } : {}),
      ...(old.backgroundSource ? { backgroundSource: { ...old.backgroundSource, file: copyFile(old.backgroundSource.file) } } : {}),
      origin: { kind: 'duplicate', creativeId: cid, revision: old.revision }, history: [{ at, action: 'duplicated', detail: `Copy of ${old.name} (revision ${old.revision}).` }] };
    delete copy.masterEditing;
    return write(id, copy);
  });
  /** A picture for a creative's logo (a new bank logo, a QR code), stored byte for byte. */
  const uploadAsset = async (id: string, cid: string, bytes: Buffer, filename?: string) => {
    read(id, cid);
    let meta;
    try { meta = await sharp(bytes).metadata(); } catch { fail('UNSUPPORTED_IMAGE', 'That file could not be read as a picture. Use a PNG, JPEG or WebP image.'); }
    const ext = meta.format === 'jpeg' ? 'jpg' : meta.format === 'webp' ? 'webp' : meta.format === 'png' ? 'png' : fail('UNSUPPORTED_IMAGE', 'Use a PNG, JPEG or WebP image.');
    const hash = sha256(bytes), file = `pca-${cid.slice(3)}-${hash.slice(0, 12)}.${ext}`;
    if (!store.has(id, file)) store.write(id, file, bytes);
    return { asset: { kind: 'creative' as const, file, sha256: hash, width: meta.width ?? 1, height: meta.height ?? 1, ...(filename ? { originalName: filename.slice(0, 200) } : {}) } };
  };
  /** The creative opened in the editor: its run (made once per revision, locally and free). */
  const open = (id: string, cid: string) => locked(`${id}:${cid}:run`, async () => {
    const c = read(id, cid), existing = existingProductCreativeRun(deps.runsDir, id, c);
    const draft = (deps.requireProduct(id) as { product?: { editorDraft?: { revision: number; creativeId?: string } } }).product?.editorDraft;
    const masterRevision = c.masterEditing && draft?.creativeId === cid ? draft.revision : c.templateRevision;
    if (existing && existing.creative?.masterRevision === masterRevision) return { runId: existing.id, created: false };
    const run = await createProductCreativeRun(deps.runsDir, f => store.read(id, f), deps.snapshot(id, masterRevision), { ...c, templateRevision: masterRevision });
    return { runId: run.id, created: true };
  });

  /** A creative from a client, checked: its pictures are this template's or this creative's own files. */
  function clean(input: unknown, old: ProductCreative, snapshot: ProductSnapshot, id: string): Partial<ProductCreative> {
    const c = input as Partial<ProductCreative>;
    if (!c || typeof c !== 'object' || !Array.isArray(c.texts) || !Array.isArray(c.images) || !Array.isArray(c.shapes) || !Array.isArray(c.groups) || !Array.isArray(c.objects)) fail('INVALID_CREATIVE', 'Send the creative\'s groups, texts, logos, shapes and objects.');
    if (c.texts.length > 400 || c.images.length > 60 || c.shapes.length > 60 || c.groups.length > 100 || c.objects.length > 80) fail('INVALID_CREATIVE', 'Too many elements in one creative.');
    const num = (v: unknown, min = -1e5, max = 1e5) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max, hex = (v: unknown) => typeof v === 'string' && /^#[\da-f]{6}$/i.test(v);
    const box = (b: unknown, what: string): SourceBox => { const x = b as SourceBox; if (!x || ![x.x, x.y].every(v => num(v)) || !num(x.width, 1) || !num(x.height, 1) || !num(x.rotation ?? 0, -360, 360)) fail('INVALID_CREATIVE', `${what}: its box is not valid.`); return { x: x.x, y: x.y, width: x.width, height: x.height, rotation: x.rotation ?? 0 }; };
    const seen = new Set<string>(), unique = (v: unknown, what: string, valid: (v: unknown) => boolean) => { if (!valid(v) || seen.has(v as string)) fail('INVALID_CREATIVE', `${what}: its id is missing or used twice.`); seen.add(v as string); return v as string; };
    const groups = c.groups.map(g => {
      if (!g || typeof g.id !== 'string' || !/^(pg|cg)-[a-f0-9]{10}$/.test(g.id) || typeof g.label !== 'string' || !isMasterCategory(g.category) || !['left', 'center', 'right'].includes(g.align as string)) fail('INVALID_CREATIVE', 'A text group is malformed.');
      return { id: g.id, label: g.label.slice(0, 200), category: g.category, masterGroupId: snapshot.groups.some(x => x.id === g.masterGroupId) ? g.masterGroupId! : null, align: g.align as 'left' | 'center' | 'right' };
    });
    const groupIds = new Set(groups.map(g => g.id)), words = new Set(snapshot.words.map(w => w.id)), slots = new Set(snapshot.logoSlots.map(l => l.id)), plates = new Set(snapshot.plates.map(p => p.id));
    const templateFiles = new Set([...snapshot.logoSlots.flatMap(l => [l.original.file, l.replacement?.file]), ...snapshot.objects.map(o => o.cutout?.file),
      ...(snapshot.editorCreative?.images.map(i => i.asset.file) ?? []), ...(snapshot.editorCreative?.objects.map(o => o.asset.file) ?? [])].filter((f): f is string => !!f));
    const own = (f: unknown) => typeof f === 'string' && f.startsWith(`pca-${old.id.slice(3)}-`) && store.has(id, f);
    const texts: CreativeText[] = c.texts.map((t, k) => {
      const what = `Text ${k + 1}`, s = t?.style;
      if (!t || typeof t.text !== 'string' || t.text.length > 200 || /[\n\r]/.test(t.text) || !groupIds.has(t.groupId)) fail('INVALID_CREATIVE', `${what}: one line of text in a group, up to 200 characters.`);
      if (!s || !isOfferFont(s.fontFamily) || !offerWeights(s.fontFamily).includes(s.fontWeight) || !['normal', 'italic'].includes(s.fontStyle) || !num(s.fontSize, 0.001, 4096) || !num(s.letterSpacing, -400, 400) || !hex(s.color) || !num(s.opacity, 0, 1))
        fail('INVALID_CREATIVE', `${what} (“${t.text.slice(0, 30)}”): its style is not valid.`);
      if (![t.x, t.baselineY].every(v => num(v)) || !num(t.rotation, -360, 360) || !num(t.line, 0, 200) || !num(t.order, 0, 10000) || !num(t.z, 0, 100000)) fail('INVALID_CREATIVE', `${what}: its position is not valid.`);
      return { id: unique(t.id, what, validCreativeElementId), wordId: t.wordId && words.has(t.wordId) ? t.wordId : null, groupId: t.groupId, line: Math.round(t.line), order: Math.round(t.order), text: t.text, x: t.x, baselineY: t.baselineY, rotation: t.rotation,
        style: { fontFamily: s.fontFamily, fontWeight: s.fontWeight, fontStyle: s.fontStyle, fontSize: s.fontSize, letterSpacing: s.letterSpacing, color: s.color.toLowerCase(), opacity: s.opacity }, hidden: t.hidden === true, locked: t.locked === true, z: t.z };
    });
    const images: CreativeImage[] = c.images.map((i, k) => {
      const what = `Logo ${k + 1}`, a = i?.asset;
      if (!i || typeof i.label !== 'string' || !isMasterCategory(i.category) || !num(i.z, 0, 100000)) fail('INVALID_CREATIVE', `${what} is malformed.`);
      const asset = a && templateFiles.has(a.file) ? { kind: 'master' as const, file: a.file }
        : a?.kind === 'creative' && own(a.file) ? { kind: 'creative' as const, file: a.file, sha256: sha256(store.read(id, a.file)), width: a.width, height: a.height, ...(a.originalName ? { originalName: String(a.originalName).slice(0, 200) } : {}) }
        : fail('INVALID_CREATIVE', `${what} (${i.label}): its picture is not one of this template's or this creative's files.`);
      return { id: unique(i.id, what, validCreativeElementId), slotId: i.slotId && slots.has(i.slotId) ? i.slotId : null, category: i.category, label: i.label.slice(0, 200), box: box(i.box, what), asset, hidden: i.hidden === true, locked: i.locked === true, z: i.z };
    });
    const shapes: CreativeShape[] = c.shapes.map((s, k) => {
      const what = `Shape ${k + 1}`;
      if (!s || !hex(s.fill) || !num(s.radius, 0, 4096) || !groupIds.has(s.groupId) || !num(s.z, 0, 100000) || (s.stroke !== null && (!s.stroke || !hex(s.stroke.color) || !num(s.stroke.width, 0, 60)))) fail('INVALID_CREATIVE', `${what} is malformed.`);
      return { id: unique(s.id, what, validCreativeElementId), plateId: s.plateId && plates.has(s.plateId) ? s.plateId : null, groupId: s.groupId, box: box(s.box, what), fill: s.fill.toLowerCase(), stroke: s.stroke ? { color: s.stroke.color.toLowerCase(), width: s.stroke.width } : null, radius: s.radius, hidden: s.hidden === true, z: s.z };
    });
    const objects: ProductCreativeObject[] = c.objects.map((o, k) => {
      const what = `Element ${k + 1}`, a = o?.asset;
      if (!o || typeof o.label !== 'string' || !(PRODUCT_OBJECT_KINDS as readonly string[]).includes(o.kind) || !num(o.z, 0, 100000)) fail('INVALID_CREATIVE', `${what} is malformed.`);
      const previous = old.objects.find(x => x.id === o.id);
      const asset = a && templateFiles.has(a.file) ? { kind: 'template' as const, file: a.file }
        : a?.kind === 'upload' && own(a.file) ? (previous?.asset.kind === 'upload' && previous.asset.file === a.file ? previous.asset : { ...a, sha256: sha256(store.read(id, a.file)) })
        : fail('INVALID_CREATIVE', `${what} (${o.label}): its picture is not one of this template's or this creative's files.`);
      const b = box(o.box, what);
      return { id: unique(o.id, what, v => typeof v === 'string' && OBJECT_ID.test(v)), objectId: o.objectId && snapshot.objects.some(x => x.id === o.objectId) ? o.objectId : null, kind: o.kind as ProductObjectKind, label: o.label.slice(0, 120),
        asset, box: { ...b }, hidden: o.hidden === true, z: o.z, opacity: num(o.opacity, 0, 1) ? o.opacity : 1, locked: o.locked === true };
    });
    const name = typeof c.name === 'string' && c.name.trim() ? c.name.trim().slice(0, 120) : old.name;
    const canvas = c.canvas ?? old.canvas;
    if (![canvas.width, canvas.height].every(v => Number.isSafeInteger(v) && v >= 1 && v <= 16384) || canvas.width * canvas.height > 32_000_000) fail('INVALID_CREATIVE', 'Invalid creative canvas.');
    const background = c.background ?? old.background;
    if (background && !(own(background.file) || background.file === old.background?.file || background.file === snapshot.editorCreative?.background?.file)) fail('INVALID_CREATIVE', 'The background must be a saved asset of this creative.');
    if (background && (background.width !== canvas.width || background.height !== canvas.height)) fail('INVALID_CREATIVE', 'The background must match the saved canvas.');
    if (!background && (canvas.width !== snapshot.canvas.width || canvas.height !== snapshot.canvas.height)) fail('INVALID_CREATIVE', 'A resized canvas needs its own background.');
    const bs = c.backgroundSource;
    if (bs && !(own(bs.file) || bs.file === snapshot.base.file || bs.file === old.background?.file || bs.file === old.backgroundSource?.file || bs.file === snapshot.editorCreative?.backgroundSource?.file)) fail('INVALID_CREATIVE', 'The raw background must belong to this creative or its template.');
    if (bs && (!num(bs.opacity, 0, 1) || (bs.z !== undefined && !num(bs.z)))) fail('INVALID_CREATIVE', 'Invalid background opacity or order.');
    const canvasFill = c.canvasFill ?? old.canvasFill;
    if (canvasFill && (!hex(canvasFill.color) || typeof canvasFill.transparent !== 'boolean')) fail('INVALID_CREATIVE', 'Invalid canvas fill.');
    return { name, groups, texts, images, shapes, objects, canvas: { ...canvas }, ...(canvasFill ? { canvasFill } : {}),
      ...(bs ? { backgroundSource: { file: bs.file, box: box(bs.box, 'Background'), opacity: bs.opacity, hidden: bs.hidden === true, locked: bs.locked === true, z: bs.z ?? -1000 } } : {}),
      ...(background ? { background: { ...background, sha256: sha256(store.read(id, background.file)) } } : {}), ...(c.absoluteZOrder ? { absoluteZOrder: true as const } : {}) };
  }

  return { list, read, create, add, replaceWith, save, replace, restore, duplicate, uploadAsset, open, revisionsOf };
}
export type ProductCreatives = ReturnType<typeof createProductCreatives>;

/** A picture inside a box, its proportions kept, centred. */
function contain(box: PixelRect, picture: { width: number; height: number }): PixelRect {
  const s = Math.min(box.width / Math.max(1, picture.width), box.height / Math.max(1, picture.height)), width = Math.max(1, Math.round(picture.width * s)), height = Math.max(1, Math.round(picture.height * s));
  return { x: Math.round(box.x + (box.width - width) / 2), y: Math.round(box.y + (box.height - height) / 2), width, height };
}
