/**
 * A creative of a master sent to decomposition: an ordinary decomposition run made from what the creative already knows,
 * locally (no planner, no Seedream, no OCR, no cost). It is written with createComposedRun, so the run dashboard, Saved
 * Runs, layer previews, the artifacts download and the editor read it like any other run.
 *
 *   layers   back to front by the creative's own order: the background artwork in its objects (the base, then a border,
 *            corner illustrations, ornaments: artworkObjects.ts, locally; or a decomposed master's own layers), then every
 *            shape, every logo or picture and every text group, each its own layer at its saved place (canvas pixels, the
 *            creative's own canvas)
 *   editor   every layer opens: the background and the pictures as image layers, text and shapes as editable text and
 *            shapes from the run's `creative` record (their pictures in the run are for its previews and reconstruction only).
 *            Hidden texts and shapes come back hidden; a hidden picture is not part of the run.
 *
 * The artwork's objects keep their exact pixels; what is behind them in the base is continued (an estimate). Touching
 * objects stay one layer (the flower on its leaves): telling them apart is image decomposition (Seedream, paid), which the
 * master's own optional decomposition offers; a master decomposed that way gives its layers here. One run per creative
 * revision: asking again returns it. The creative and its master are only read.
 */
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import sharp from 'sharp';
import type { CreativeInstance, MasterSnapshot } from '@frameflow/shared';
import { createComposedRun, type VariantRunLayer } from '../../creativeTemplates/composedRun.js';
import { readRun, saveRunRecord, type RunRecord } from '../../layerizeExperiment.js';
import type { ProtectedStore } from '../store.js';
import { imageSvg, shapeSvg, svgPng, textInk, textSvg } from '../../../templateStudio/masterCreatives/render.js';
import { decodeRgba, sha256 } from '../pixels.js';
import { splitArtwork, splitByLayers, type ArtworkSplit } from './artworkObjects.js';
import type { ArtworkJob } from './artworkWorker.js';

export type CreativeRunLayer = NonNullable<RunRecord['creative']>['layers'][number];
/**
 * How runs are made (2: the background artwork in objects; 3: its base rebuilt from the template's structure, the border made
 * whole, objects with transparent rims); a run made by an earlier version is not reused (it stays).
 */
export const CREATIVE_RUN_VERSION = 3;
/** Splits by picture (the creatives of one master share one background): a few kept, so a second creative is quick. */
const splits = new Map<string, Promise<ArtworkSplit>>();
type LayerMask = { name: string; mask: Uint8Array };
function splitOf(png: Buffer, how: { layers?: { key: string; masks: () => Promise<LayerMask[]> }; region?: Box; ground?: string }): Promise<ArtworkSplit> {
  const { layers, region, ground } = how, key = `${sha256(png)}${layers ? `:${layers.key}` : ''}${region ? `:${JSON.stringify(region)}:${ground}` : ''}`, known = splits.get(key);
  if (known) return known;
  const made = (async () => {
    const job: ArtworkJob = { png, ...(layers ? { layers: await layers.masks() } : { options: { ...(region ? { region } : {}), ...(ground ? { grounds: [ground] } : {}) } }) };
    // Off the main thread when a worker can start (the built server, the dev server); else here, the same split.
    return offThread(job).catch(async () => { const source = await decodeRgba(png); return job.layers ? splitByLayers(source, job.layers) : splitArtwork(source, job.options); });
  })();
  splits.set(key, made); made.catch(() => splits.delete(key));
  while (splits.size > 6) splits.delete(splits.keys().next().value!);
  return made;
}
type Box = { x: number; y: number; width: number; height: number };
/** A box grown to whole pixels and clipped to the canvas (a layer's placement), or null when nothing of it is on the canvas. */
function placed(b: Box, c: { width: number; height: number }): Box | null {
  const x = Math.max(0, Math.floor(b.x)), y = Math.max(0, Math.floor(b.y)), r = Math.min(c.width, Math.ceil(b.x + b.width)), d = Math.min(c.height, Math.ceil(b.y + b.height));
  return r > x && d > y ? { x, y, width: r - x, height: d - y } : null;
}
/** The rotated outline's bounds of a box rotated about its centre. */
function turned(b: Box & { rotation: number }): Box {
  if (!b.rotation) return b;
  const a = (b.rotation * Math.PI) / 180, w = Math.abs(b.width * Math.cos(a)) + Math.abs(b.height * Math.sin(a)), h = Math.abs(b.width * Math.sin(a)) + Math.abs(b.height * Math.cos(a));
  return { x: b.x + b.width / 2 - w / 2, y: b.y + b.height / 2 - h / 2, width: w, height: h };
}

/** The split in a worker thread (artworkWorker.ts); its pictures come back as plain bytes. */
function offThread(job: ArtworkJob): Promise<ArtworkSplit> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try { worker = new Worker(new URL('./artworkWorker.js', import.meta.url), { execArgv: process.execArgv }); } catch (error) { reject(error); return; }
    const done = () => void worker.terminate().catch(() => undefined);
    worker.once('message', (m: { split?: ArtworkSplit; error?: string }) => {
      done();
      if (!m.split) { reject(new Error(m.error ?? 'The artwork could not be split.')); return; }
      resolve({ ...m.split, base: Buffer.from(m.split.base), objects: m.split.objects.map(o => ({ ...o, png: Buffer.from(o.png) })) });
    });
    worker.once('error', error => { done(); reject(error); });
    worker.postMessage(job);
  });
}

/**
 * The shapes of a decomposed master's layers (above its base) on a creative's canvas: where its artwork is drawn (`box`, the
 * master's whole picture scaled into it), each layer's opaque pixels.
 */
async function layerMasks(snapshot: MasterSnapshot, box: Box, canvas: { width: number; height: number }, read: (file: string) => Buffer): Promise<LayerMask[]> {
  const k = box.width / snapshot.canvas.width, n = canvas.width * canvas.height, out: LayerMask[] = [];
  for (const l of [...snapshot.layers].sort((a, b) => a.zIndex - b.zIndex).slice(1)) {
    const x0 = Math.round(box.x + l.x * k), y0 = Math.round(box.y + l.y * k), w = Math.max(1, Math.round(l.width * k)), h = Math.max(1, Math.round(l.height * k));
    const alpha = await sharp(read(l.file)).ensureAlpha().resize(w, h, { fit: 'fill' }).extractChannel(3).raw().toBuffer(), mask = new Uint8Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const cx = x0 + x, cy = y0 + y; if (cx >= 0 && cy >= 0 && cx < canvas.width && cy < canvas.height && alpha[y * w + x] >= 128) mask[cy * canvas.width + cx] = 1; }
    out.push({ name: `Artwork · ${l.name}`.slice(0, 120), mask });
  }
  return out;
}

/** The run already made from this creative revision by the current version, if any. */
export function existingCreativeRun(runsDir: string, masterId: string, c: Pick<CreativeInstance, 'id' | 'revision'>): RunRecord | null {
  if (!existsSync(runsDir)) return null;
  for (const id of readdirSync(runsDir).sort().reverse()) {
    if (!existsSync(join(runsDir, id, 'run.json'))) continue;
    try { const run = readRun(join(runsDir, id)); if (run.creative?.masterId === masterId && run.creative.creativeId === c.id && run.creative.creativeRevision === c.revision && run.creative.version === CREATIVE_RUN_VERSION) return run; } catch { /* another run's unreadable record */ }
  }
  return null;
}

export async function createCreativeRun(runsDir: string, store: ProtectedStore, snapshot: MasterSnapshot, c: CreativeInstance): Promise<RunRecord> {
  const canvas = c.canvas, read = (file: string) => store.read(c.masterId, file), layers: (VariantRunLayer & { z: number; meta: CreativeRunLayer })[] = [];
  // The background: the colour around an AI creative's artwork and the artwork itself, or a manual creative's master artwork.
  const art = c.images.find(i => i.artwork), ground = c.backgroundColor ?? '#ffffff', ids = art ? [art.id] : [];
  let n = 1, artwork: NonNullable<RunRecord['creative']>['artwork'];
  const file = (kind: string) => `layer-${String(n++).padStart(2, '0')}-${kind}.png`;
  const background = (png: Buffer, name: string, description: string) => layers.push({ file: 'layer-00-background.png', name, description, png, placement: { x: 0, y: 0, ...canvas }, kind: 'full-canvas',
    semantic: { id: 'background', type: 'background' }, z: -1, meta: { file: 'layer-00-background.png', kind: 'background', elementIds: ids, hidden: false, z: -1 } });
  const object = (png: Buffer, placement: Box, name: string, description: string, type: string) => { const f = file('artwork'); layers.push({ file: f, name: name.slice(0, 120), description, png, placement, kind: 'bbox-crop',
    semantic: { id: `artwork-${n - 1}`, type }, z: -1, meta: { file: f, kind: 'artwork', elementIds: ids, hidden: false, z: -1 } }); };
  const sx = canvas.width / snapshot.canvas.width, sy = canvas.height / snapshot.canvas.height;
  if (!art && !c.backgroundColor && snapshot.layers.length) {
    // A master decomposed with Seedream: its own layers (the lowest is the base), each placed on the creative's canvas.
    const [first, ...rest] = [...snapshot.layers].sort((a, b) => a.zIndex - b.zIndex), href = async (f: string) => `data:image/png;base64,${(await sharp(read(f)).png().toBuffer()).toString('base64')}`;
    background(await svgPng(canvas.width, canvas.height, `<rect width="100%" height="100%" fill="${ground}"/><image x="${first.x * sx}" y="${first.y * sy}" width="${first.width * sx}" height="${first.height * sy}" preserveAspectRatio="none" href="${await href(first.file)}"/>`),
      'Background base', 'The template\'s base layer from its decomposition');
    for (const l of rest) {
      const p = placed({ x: l.x * sx, y: l.y * sy, width: l.width * sx, height: l.height * sy }, canvas);
      if (p) object(await svgPng(p.width, p.height, `<image x="${l.x * sx - p.x}" y="${l.y * sy - p.y}" width="${l.width * sx}" height="${l.height * sy}" preserveAspectRatio="none" href="${await href(l.file)}"/>`), p, `Artwork · ${l.name}`, 'A layer of the template\'s artwork from its decomposition', 'decoration');
    }
    artwork = { method: 'master-layers', objects: rest.length };
  } else {
    let body = `<rect width="100%" height="100%" fill="${ground}"/>`;
    if (art && !art.hidden) body += await imageSvg(art, read(art.asset.file));
    else if (!art && !c.backgroundColor) body += `<image x="0" y="0" width="${snapshot.canvas.width * sx}" height="${snapshot.canvas.height * sy}" preserveAspectRatio="none" href="data:image/png;base64,${(await sharp(read(snapshot.background.file)).png().toBuffer()).toString('base64')}"/>`;
    const flat = await svgPng(canvas.width, canvas.height, body), drawn = (art && !art.hidden) || (!art && !c.backgroundColor);
    // The artwork in its objects: along a decomposed master's layers (its own pixels cut to their shapes), else found
    // locally; the base is the field with the objects taken out and continued behind them.
    const byLayers = art && !art.hidden && snapshot.layers.length > 1 ? { key: `r${snapshot.revision}`, masks: () => layerMasks(snapshot, art.box, canvas, read) } : undefined;
    // An AI creative's artwork is measured where it is drawn; the colour around it is ground.
    const split = drawn ? await splitOf(flat, { layers: byLayers, ...(art && !art.hidden ? { region: art.box, ground } : {}) }) : undefined;
    background(split?.base ?? flat, split?.objects.length ? 'Background base' : 'Background artwork',
      split?.objects.length ? 'The template\'s page and field; behind its objects the field is continued (an estimate)' : art ? 'The template\'s artwork with its field tint, and the colour around it' : 'The template\'s clean background artwork');
    for (const o of split?.objects ?? []) object(o.png, o.placement, o.name, o.kind === 'border' ? 'The template\'s border (its repeated pieces)' : o.kind === 'ornaments' ? 'Repeated small ornaments of the template' : 'An object of the template\'s artwork (its own pixels)', o.kind === 'border' ? 'border' : 'decoration');
    if (split) artwork = { method: byLayers ? 'master-layers' : 'local', objects: split.objects.length, behindPercent: split.filledPercent, trustedPercent: split.trustedPercent, durationMs: split.durationMs,
      rebuiltPercent: split.rebuiltPercent, borderDotsAdded: split.borderDotsAdded, reconstruction: split.reconstruction };
  }
  for (const s of c.shapes.filter(x => !x.hidden)) {
    // With its outline: half of a stroke is drawn outside the box.
    const t = turned(s.box), e = s.stroke ? s.stroke.width / 2 + 1 : 0, p = placed({ x: t.x - e, y: t.y - e, width: t.width + 2 * e, height: t.height + 2 * e }, canvas);
    if (!p) continue;
    const f = file('shape');
    layers.push({ file: f, name: `Shape · ${c.groups.find(g => g.id === s.groupId)?.label.slice(0, 40) ?? 'shape'}`, description: 'An editable shape (opens as a shape)', png: await svgPng(p.width, p.height, shapeSvg(s, p.x, p.y)),
      placement: p, kind: 'bbox-crop', semantic: { id: s.id, type: 'shape' }, z: s.z, meta: { file: f, kind: 'shape', elementIds: [s.id], hidden: s.hidden, z: s.z } });
  }
  for (const i of c.images.filter(x => !x.artwork && !x.hidden)) {
    const p = placed(turned(i.box), canvas);
    if (!p) continue;
    const f = file(i.category === 'qr' ? 'qr' : i.category.endsWith('logo') ? 'logo' : 'picture');
    layers.push({ file: f, name: i.label.slice(0, 120), description: `${i.category} (its own picture, replaceable in the editor)`, png: await svgPng(p.width, p.height, await imageSvg(i, read(i.asset.file), p.x, p.y)),
      placement: p, kind: 'bbox-crop', semantic: { id: i.id, type: i.category }, z: i.z, meta: { file: f, kind: 'image', elementIds: [i.id], hidden: i.hidden, z: i.z } });
  }
  // A text of a group the creative does not list still gets its layer (with the others of that group).
  const groups = [...c.groups, ...[...new Set(c.texts.map(t => t.groupId))].filter(id => !c.groups.some(g => g.id === id)).map(id => ({ id, label: 'Text' }))];
  for (const g of groups) {
    const texts = c.texts.filter(t => t.groupId === g.id && t.text.trim() && !t.hidden), inks = texts.map(textInk).filter((b): b is Box => !!b);
    if (!inks.length) continue;
    const x0 = Math.min(...inks.map(b => b.x)), y0 = Math.min(...inks.map(b => b.y)), p = placed({ x: x0, y: y0, width: Math.max(...inks.map(b => b.x + b.width)) - x0, height: Math.max(...inks.map(b => b.y + b.height)) - y0 }, canvas);
    if (!p) continue;
    const f = file('text');
    layers.push({ file: f, name: `Text · ${g.label.slice(0, 60)}`, description: 'Editable text (opens as text, not as a picture)', png: await svgPng(p.width, p.height, texts.map(t => textSvg(t, p.x, p.y)).join('')),
      placement: p, kind: 'bbox-crop', semantic: { id: g.id, type: 'text' }, z: Math.min(...texts.map(t => t.z)), meta: { file: f, kind: 'text', elementIds: texts.map(t => t.id), hidden: false, z: Math.min(...texts.map(t => t.z)) } });
  }
  // The background's layers first (their own order), then the creative's elements in theirs.
  const own = layers.filter(l => l.meta.kind === 'background' || l.meta.kind === 'artwork'), ordered = [...own, ...layers.filter(l => !own.includes(l)).sort((a, b) => a.z - b.z)];
  // The run's original: these layers over each other, which is the creative as the editor draws it.
  const composite = await sharp(ordered[0].png).composite(ordered.slice(1).map(l => ({ input: l.png, left: l.placement.x, top: l.placement.y }))).png().toBuffer();
  const { dir } = await createComposedRun(runsDir, {
    composite, layers: ordered.map(({ z, meta, ...l }) => { void z; void meta; return l; }),
    origin: { kind: 'master-creative', generationId: c.masterId, variantId: c.id }, source: 'master-creative',
    // Every layer opens in the editor (texts and shapes as editable text and shapes, from `creative`).
    editorLayerFiles: ordered.map(l => l.file),
  });
  const run = readRun(dir);
  run.creative = { version: CREATIVE_RUN_VERSION, masterId: c.masterId, masterRevision: c.masterRevision, creativeId: c.id, creativeRevision: c.revision, name: c.name, canvas: { ...canvas },
    texts: c.texts.filter(t => t.text.trim()), shapes: c.shapes, groups: c.groups, layers: ordered.map(l => l.meta), aiGenerated: c.origin.kind === 'ai', ...(artwork ? { artwork } : {}) };
  saveRunRecord(dir, run);
  return run;
}
