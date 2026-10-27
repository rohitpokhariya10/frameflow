/**
 * Reuse Template studio: a saved template revision reused with the person's own product set, copy and formats. Separate
 * from Generate AI Variations; the revision is only read.
 *
 *   draft      one file per draft (`prd-<id>.json`, optimistic revisions): every product and character of the revision
 *              (included / hidden / removed / order, replaced by an upload, or added by the person), text and logo edits,
 *              the formats, how products are placed and manual corrections per format, and what was generated and saved
 *   compose    per format: the revision's creative with the edits applied, framed for the format (reuseLayout.ts: never
 *              stretched), products placed on its stage (reusePlacement.ts: the template's own places, fixed rules, or
 *              an approved AI plan), each product's own picture composited with a soft contact shadow, manual corrections
 *              last, then checked. The template's products not standing in their own places leave no footprint: the
 *              background is the base with theirs cleaned (footprint.ts), or the empty stage. Free, on this computer.
 *   generate   each chosen format drawn as one complete poster (preview) with its checks
 *   save       each format becomes an ordinary creative of the template (its own files): Creatives, the editor and
 *              "Decompose & Edit" (the existing approved planner + Seedream route) take it from there
 */
import { randomBytes, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import {
  isOfferFont, offerWeights, REUSE_ASPECT_LABELS, REUSE_ASPECT_RATIOS, rewriteGroup, CREATIVE_SCHEMA_VERSION,
  type CreativeInstance, type OfferWeight, type ProductCreative, type ProductCreativeObject, type ProductSlot, type ProductSnapshot, type ProductVariationCheck, type ReuseAiPlan, type ReuseAspectRatio,
  type ReuseDraft, type ReuseItem, type ReuseOutput, type ReuseOverride, type ReusePlacementBox, type ReusePlacementMode, type ReuseTextEdit,
} from '@frameflow/shared';
import { RunError } from '../../layerizeExperiment.js';
import type { ProtectedStore } from '../store.js';
import { sha256 } from '../pixels.js';
import { productCreativeFromSnapshot, type ProductCreatives } from './creatives.js';
import { renderProductCreative } from './creativeRun.js';
import { cutOutUpload } from './uploadCutout.js';
import { shadowPng } from './stage.js';
import { cleanStage } from './stageCleanup.js';
import { cleanFootprints, FOOTPRINT_VERSION, type Footprint } from './footprint.js';
import { clearResidue, inkColours, textArt } from './textArt.js';
import { artworkBase } from './artworkText.js';
import { refineCluster } from './reuseCluster.js';
import { fontMeasure } from './ratioLayout.js';
import { fitGroup } from './composition.js';
import { inferAlign, restyleGroup } from './variations.js';
import { variationComposition, type VariationComposition } from './variationTemplate.js';
import { reuseCategory, shapeMismatch, sizeUnit } from './reusePlacement.js';
import { artRows, frameBackground, groupBounds, mapBox, mapCreative, mapX, planFrame, reanchor, type Box, type Decoration, type ReuseFrame } from './reuseLayout.js';
import { checkPlacement, geometryPlacement, KNOWN_KINDS, PLACEMENT_COST_USD, type PlacementInput, type ReusePlacementPlanner, type Stage } from './reusePlacement.js';

const nowIso = () => new Date().toISOString();
const hex = (n: number) => randomBytes(n).toString('hex');
function fail(code: string, message: string, details?: Record<string, unknown>): never { throw new RunError(code, message, details); }
const DRAFT_ID = /^pr-[a-f0-9]{8}$/, fileOf = (did: string) => `prd-${did.slice(3)}.json`;
const ratioKey = (r: ReuseAspectRatio) => (r === 'original' ? 'original' : r.replace(':', 'x'));
const isRatio = (r: unknown): r is ReuseAspectRatio => (REUSE_ASPECT_RATIOS as readonly string[]).includes(r as string);
const asInstance = (c: ProductCreative) => ({ ...c, schemaVersion: CREATIVE_SCHEMA_VERSION, masterId: c.templateId, masterRevision: c.templateRevision, origin: { kind: 'master' }, editor: null, exports: [], history: [] }) as unknown as CreativeInstance;
const area = (b: Box) => Math.max(0, b.width) * Math.max(0, b.height);
const inter = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const MAX_ITEMS = 40;
/** The layer of a text group's original lettering in a reuse creative. */
const letteringId = (gid: string) => `co-${sha256(Buffer.from(`lettering:${gid}`)).slice(0, 10)}`;
/**
 * A reuse creative with its editable words shown again in place of the original lettering (to edit the text itself).
 * `keep`: groups whose lettering stays (a badge's words: part of the decoration's artwork, kept exactly as designed).
 */
const withLiveText = (c: ProductCreative, keep: ReadonlySet<string> = new Set()): ProductCreative => {
  const lettered = new Set(c.groups.map(g => g.id).filter(gid => !keep.has(gid) && c.objects.some(o => o.id === letteringId(gid))));
  return { ...c, objects: c.objects.filter(o => ![...lettered].some(gid => o.id === letteringId(gid))), texts: c.texts.map(t => (lettered.has(t.groupId) ? { ...t, hidden: false } : t)) };
};
/** A group's copy as the person sees it: its lines in order, words joined by spaces. */
const copyOf = (c: ProductCreative, gid: string) => [...new Set(c.texts.filter(t => t.groupId === gid).map(t => t.line))].sort((a, b) => a - b).map(l => c.texts.filter(t => t.groupId === gid && t.line === l).sort((a, b) => a.order - b.order).map(t => t.text).join(' ')).join('\n');

/** What a template revision gives every draft (read once per revision). */
interface Context {
  snapshot: ProductSnapshot; baseFile: string; basePng: Buffer; art: { top: number; bottom: number }; decorations: Decoration[]; avoid: Box[]; stage: Stage; stageFound: boolean; template: ProductCreative;
  /** The base with the template's display stands rebuilt away (its own cached file), or why that was not reliable. */
  emptyStage: { file: string; png: Buffer } | { reason: string };
  /** What creatives are drawn on: the template's base, and the empty stage when there is one (each `Ground`). */
  grounds: { base: Ground; empty?: Ground };
}
/**
 * A background with what the template's text removal left of its letters cleared (its own cached file), and each text
 * group's own lettering cut from the original picture against it (cached files; places in template pixels).
 */
interface Ground { file: string; png: Buffer; lettering: Map<string, { file: string; sha256: string; box: Box }> }
/** Bumped when stageCleanup.ts changes what it draws (a new cached file per revision). */
const STAGE_CLEANUP_VERSION = 1, TEXT_ART_VERSION = 3;
export interface Composed {
  creative: ProductCreative; frame: ReuseFrame; mode: ReusePlacementMode;
  /** `places`: for a product standing in a template product's place, that original product's box in this format. */
  placement: { input: PlacementInput; boxes: ReusePlacementBox[]; notes: string[]; rejected: { id: string; reason: string }[]; places?: Record<string, Box> };
  checks: { status: 'ready' | 'needs-review' | 'failed'; issues: ProductVariationCheck[] };
  /** Every product stands in a place of the template's own products (slot-anchored), not arranged anew. */
  anchored: boolean;
}

/**
 * The template's product places that can hold a product: its products' slots of a comparable size to its largest (the
 * main product's place, not a small icon in the footer), the most prominent first (largest, then nearest the middle).
 */
export function productPlaces(snapshot: ProductSnapshot) {
  const placed = snapshot.objects.filter((o): o is typeof o & { slot: ProductSlot } => o.kind === 'product' && !!o.slot);
  const tallest = Math.max(0, ...placed.map(o => o.slot.targetHeight)), mid = snapshot.canvas.width / 2;
  return placed.filter(o => o.slot.targetHeight >= tallest * 0.35)
    .sort((a, b) => b.slot.box.width * b.slot.targetHeight - a.slot.box.width * a.slot.targetHeight || Math.abs(a.slot.box.x + a.slot.box.width / 2 - mid) - Math.abs(b.slot.box.x + b.slot.box.width / 2 - mid));
}

/**
 * Slot-anchored replacement: the template's own product places are the source of truth. A product of the template that
 * stays included keeps its place (a new photo of it fitted to its slot); products the person added take the places of
 * the template's products left out — the main product (or else the larger kind) the most prominent place. Undefined when
 * some added product has no place left (more products than places): those are arranged anew instead.
 */
export function slotAnchors(snapshot: ProductSnapshot, products: ReuseItem[], hero?: string | null): Map<string, { objectId: string; slot?: ProductSlot }> | undefined {
  const out = new Map<string, { objectId: string; slot?: ProductSlot }>(), taken = new Set<string>();
  for (const i of products.filter(x => x.objectId)) { out.set(i.id, { objectId: i.objectId!, slot: snapshot.objects.find(o => o.id === i.objectId)?.slot }); taken.add(i.objectId!); }
  const free = productPlaces(snapshot).filter(o => !taken.has(o.id));
  const added = products.filter(x => !x.objectId).sort((a, b) => Number(b.id === hero) - Number(a.id === hero) || sizeUnit(b.category) - sizeUnit(a.category) || a.order - b.order);
  if (added.length > free.length) return undefined;
  added.forEach((i, k) => out.set(i.id, { objectId: free[k].id, slot: free[k].slot }));
  return out;
}

/**
 * A product in a template product's slot ("contain"): as tall as the product it replaces (the slot's target height)
 * unless that makes it wider than the slot holds, centred on the slot, standing on its contact line, its proportions
 * kept. On the template's stage a wide product may use up to half again the slot's width (a washing machine where a slim
 * card reader stood), never more than the stage. Kept inside the canvas by being made smaller, never cut.
 */
export function fitInSlot(slot: ProductSlot, picture: { width: number; height: number }, canvas: { width: number; height: number }, stage?: Stage): Box {
  const cx = slot.box.x + slot.box.width / 2;
  const onStage = !!stage && Math.abs(cx - stage.cx) <= stage.a && slot.contactY >= stage.cy - stage.b * 2 && slot.contactY <= stage.cy + stage.b * 3;
  const room = onStage ? Math.max(slot.box.width, Math.min(slot.box.width * 1.5, stage!.a * 2 * 0.85)) : slot.box.width;
  const pw = Math.max(1, picture.width), ph = Math.max(1, picture.height);
  const scale = Math.min(slot.targetHeight / ph, room / pw, (slot.contactY + 1) / ph, canvas.width / pw);
  const width = Math.max(1, Math.round(pw * scale)), height = Math.max(1, Math.round(ph * scale));
  return { x: Math.round(Math.min(Math.max(0, cx - width / 2), canvas.width - width)), y: Math.round(Math.max(0, slot.contactY + 1 - height)), width, height };
}

export function createReuseStudio(deps: {
  store: ProtectedStore; creatives: ProductCreatives;
  requireProduct: (id: string) => unknown; snapshot: (id: string, revision: number) => ProductSnapshot; latestRevision: (id: string) => number | undefined;
  locked: <T>(key: string, work: () => Promise<T>) => Promise<T>;
  /** The AI placement planner (only with the person's approval of its cost). */
  placement?: () => ReusePlacementPlanner | undefined;
  /** "Decompose & Edit": a template of its own from a saved reused creative (service.createFromVariation). */
  toTemplate?: (input: { templateId: string; revision: number; jobId: string; index: number; title: string; name: string; composition: VariationComposition }) => Promise<string>;
}) {
  const { store, locked } = deps;
  const contexts = new Map<string, Promise<Context>>();
  const read = (id: string, did: string): ReuseDraft => {
    deps.requireProduct(id);
    if (!DRAFT_ID.test(did) || !store.has(id, fileOf(did))) fail('NOT_FOUND', 'That reuse draft was not found.');
    return JSON.parse(store.read(id, fileOf(did)).toString('utf8')) as ReuseDraft;
  };
  const write = (id: string, d: ReuseDraft) => { store.write(id, fileOf(d.id), Buffer.from(JSON.stringify(d, null, 2))); return d; };

  /** Why the revision must not be reused: its blocking quality issues (a product left in the background), missing files. */
  function sourceIssues(id: string, snapshot: ProductSnapshot) {
    const issues = snapshot.quality.issues.filter(i => i.blocking).map(i => i.message);
    if (!store.has(id, snapshot.editorCreative?.background?.file ?? snapshot.base.file)) issues.push('Its background file is missing.');
    return issues;
  }
  async function contextOf(id: string, revision: number): Promise<Context> {
    const key = `${id}:${revision}`;
    let ctx = contexts.get(key);
    if (!ctx) {
      ctx = (async () => {
        // A decoration's own lettering (a badge) restored from the original into the background, never set again as live
        // text (artworkText.ts; a cached file of its own, the template's are unchanged).
        const snapshot = deps.snapshot(id, revision), artwork = await artworkBase({ has: f => store.has(id, f), read: f => store.read(id, f), write: (f, b) => store.write(id, f, b) }, snapshot);
        const baseFile = artwork?.file ?? snapshot.editorCreative?.background?.file ?? snapshot.base.file, basePng = store.read(id, baseFile);
        const structure = [...(snapshot.backgroundStructure ?? []), ...snapshot.objects.filter(o => !o.cutout)];
        // (A creative's own product shadows, kept as decorations of a template made from it, are product footprints: never
        // an area to keep clear, and taken off the stage with the old products.)
        const decorations = structure.filter(o => (o.kind === 'decoration' || o.kind === 'frame') && !/^Shadow · /.test(o.label)).map(o => ({ id: o.id, label: o.label, box: o.box }));
        // The stage: the largest podium of the revision (in its background or its own layer), its top surface found in the base.
        let podium = [...structure, ...snapshot.objects].filter(o => o.kind === 'podium').sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0];
        // A template made from a creative of another (Decompose & Edit) has the same stage at the same place when its canvas
        // is that template's: its reviewed podium is taken from there (up the chain).
        for (let from = (deps.requireProduct(id) as { product?: { variation?: { templateId: string; revision: number } } }).product?.variation, hops = 0; !podium && from && hops < 4; hops++) {
          try {
            const origin = deps.snapshot(from.templateId, from.revision);
            if (origin.canvas.width !== snapshot.canvas.width || origin.canvas.height !== snapshot.canvas.height) break;
            podium = [...(origin.backgroundStructure ?? []), ...origin.objects].filter(o => o.kind === 'podium').sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0];
            from = (deps.requireProduct(from.templateId) as { product?: { variation?: { templateId: string; revision: number } } }).product?.variation;
          } catch { break; }
        }
        const { width: W, height: H } = snapshot.canvas;
        // The reviewed podium box: its top surface an ellipse in its upper part (an edge search finds its front band as often as its top).
        const stage: Stage = podium ? { cx: podium.box.x + podium.box.width / 2, cy: podium.box.y + podium.box.height * 0.27, a: podium.box.width * 0.47, b: podium.box.height * 0.2 } : { cx: W / 2, cy: H * 0.68, a: W * 0.32, b: H * 0.04 };
        const stageFound = !!podium;
        const template = productCreativeFromSnapshot(snapshot, { id: 'pc-000000', name: snapshot.name, at: snapshot.publishedAt }, artwork), art = await artRows(basePng);
        // In the artwork's rows: decorations, logos and text (where they were, the base is an estimate), never mirrored into a wider format.
        const inArt = (b: Box) => b.y + b.height > art.top && b.y < art.bottom;
        const avoid = [...decorations.map(x => x.box), ...template.images.map(i => i.box), ...template.groups.map(g => groupBounds(template, g.id)).filter((b): b is Box => !!b)].filter(inArt);
        // The empty stage: made once per revision on this computer (stageCleanup.ts) and kept as a file of its own; the
        // template's base is never changed. Not reliable: reported, and the base (with its stands) is used.
        let emptyStage: Context['emptyStage'] = { reason: 'The template has no podium with products on it.' };
        const standing = snapshot.objects.filter(o => o.kind === 'product').map(o => ({ ...o.box, contactY: o.slot?.contactY }));
        if (podium && standing.length) {
          const key = `pstage-${revision}-${sha256(Buffer.concat([basePng, Buffer.from(`v${STAGE_CLEANUP_VERSION}`)])).slice(0, 12)}`;
          if (!store.has(id, `${key}.json`)) {
            // (The old products' shadows too: what stood there is rebuilt, footprints included.)
            const r = await cleanStage(basePng, { podium: podium.box, products: [...standing, ...structure.filter(o => /^Shadow · /.test(o.label)).map(o => ({ ...o.box, contactY: o.box.y }))], avoid: decorations.map(x => x.box) });
            if (r.reliable) store.write(id, `${key}.png`, r.png);
            store.write(id, `${key}.json`, Buffer.from(JSON.stringify({ version: STAGE_CLEANUP_VERSION, baseFile, reliable: r.reliable, reason: r.reason, zone: r.zone, ellipse: r.ellipse, back: r.back, burst: r.burst, rebuilt: r.rebuilt }, null, 2)));
          }
          const meta = JSON.parse(store.read(id, `${key}.json`).toString('utf8')) as { reliable: boolean; reason?: string };
          emptyStage = meta.reliable && store.has(id, `${key}.png`) ? { file: `${key}.png`, png: store.read(id, `${key}.png`) } : { reason: meta.reason ?? 'The stage could not be emptied reliably.' };
        }
        // The template's own lettering (textArt.ts): unchanged copy is shown in its original typeface and spacing, which the
        // editable words (estimated fonts) only approximate. Not for a master saved from the editor (its copy may differ).
        const lettered = !snapshot.editorCreative && !!snapshot.source?.file && store.has(id, snapshot.source.file) && (baseFile === snapshot.base.file || baseFile === artwork?.file);
        let sourceImage: Buffer | undefined;
        const box = (w: { box: Box }) => ({ x: w.box.x, y: w.box.y, width: w.box.width, height: w.box.height });
        // (Artwork lettering stays in the background as it is: never taken out, never cut as lettering of its own.)
        const textWords = snapshot.words.filter(w => !artwork?.groups.has(w.groupId));
        const groundOf = async (file: string, png: Buffer): Promise<Ground> => {
          if (!lettered) return { file, png, lettering: new Map() };
          const key = `pground-${revision}-${sha256(Buffer.from(JSON.stringify([sha256(png), snapshot.source.sha256, textWords.map(box), TEXT_ART_VERSION]))).slice(0, 12)}.png`;
          if (!store.has(id, key)) { sourceImage ??= store.read(id, snapshot.source.file); store.write(id, key, (await clearResidue(sourceImage, png, textWords.map(box))).png); }
          const ground = store.read(id, key), lettering: Ground['lettering'] = new Map();
          for (const g of snapshot.groups) {
            const words = textWords.filter(w => w.groupId === g.id).map(box);
            if (!words.length) continue;
            const cutKey = `ptext-${revision}-${sha256(Buffer.from(JSON.stringify([key, g.id, words]))).slice(0, 12)}`;
            if (!store.has(id, `${cutKey}.json`)) {
              sourceImage ??= store.read(id, snapshot.source.file);
              const cut = await textArt(sourceImage, ground, words);
              if (cut) store.write(id, `${cutKey}.png`, cut.png);
              store.write(id, `${cutKey}.json`, Buffer.from(JSON.stringify({ version: TEXT_ART_VERSION, groupId: g.id, box: cut?.box ?? null })));
            }
            const meta = JSON.parse(store.read(id, `${cutKey}.json`).toString('utf8')) as { box: Box | null };
            if (meta.box && store.has(id, `${cutKey}.png`)) lettering.set(g.id, { file: `${cutKey}.png`, sha256: sha256(store.read(id, `${cutKey}.png`)), box: meta.box });
          }
          return { file: key, png: ground, lettering };
        };
        // The editable words in their real colours where the master's estimate is far off (a badge's word read as its panel's
        // colour): measured from the original, for when they are shown (changed copy, the editor).
        if (lettered) {
          sourceImage ??= store.read(id, snapshot.source.file);
          const inks = await inkColours(sourceImage, snapshot.words.map(box)), inkOf = new Map(snapshot.words.map((w, n) => [w.id, inks[n]] as const));
          const far = (p: string, q: string) => Math.hypot(...[1, 3, 5].map(k => parseInt(p.slice(k, k + 2), 16) - parseInt(q.slice(k, k + 2), 16))) > 80;
          template.texts = template.texts.map(t => { const ink = t.wordId ? inkOf.get(t.wordId) : undefined; return ink && far(ink, t.style.color) ? { ...t, style: { ...t.style, color: ink } } : t; });
        }
        const grounds: Context['grounds'] = { base: await groundOf(baseFile, basePng), ...('file' in emptyStage ? { empty: await groundOf(emptyStage.file, emptyStage.png) } : {}) };
        return { snapshot, baseFile, basePng, art, decorations, avoid, stage, stageFound, template, emptyStage, grounds };
      })();
      contexts.set(key, ctx);
      ctx.catch(() => contexts.delete(key));
    }
    return ctx;
  }
  /**
   * The base ground with the footprints of `gone` (the template's products not standing in their own places) cleaned
   * (footprint.ts, against the template's original picture): made once per revision and set of products and kept as a
   * file of its own beside what was found (`pfoot-*.json`); the template's own files never change. Its lettering is the
   * base ground's (text is not touched). Nothing to clean: the base ground itself.
   */
  async function cleanedGround(id: string, ctx: Context, revision: number, gone: ProductSnapshot['objects']): Promise<Ground> {
    const base = ctx.grounds.base;
    if (!gone.length) return base;
    const key = `pfoot-${revision}-${sha256(Buffer.from(JSON.stringify([base.file, sha256(base.png), gone.map(o => o.id).sort(), FOOTPRINT_VERSION]))).slice(0, 12)}`;
    if (!store.has(id, `${key}.json`)) {
      const footprints: Footprint[] = gone.map(o => ({ box: o.box, contactY: o.slot?.contactY, ...(o.cutout && store.has(id, o.cutout.file) ? { cutout: { png: store.read(id, o.cutout.file), placement: o.cutout.placement } } : {}) }));
      const original = ctx.snapshot.source?.file && store.has(id, ctx.snapshot.source.file) ? store.read(id, ctx.snapshot.source.file) : undefined;
      const r = await cleanFootprints(base.png, footprints, ctx.decorations.map(x => x.box), original);
      if (r.filled) store.write(id, `${key}.png`, r.png);
      store.write(id, `${key}.json`, Buffer.from(JSON.stringify({ version: FOOTPRINT_VERSION, from: base.file, products: gone.map(o => ({ id: o.id, label: o.label })), changed: r.filled, ...r.report }, null, 2)));
    }
    return store.has(id, `${key}.png`) ? { file: `${key}.png`, png: store.read(id, `${key}.png`), lettering: base.lettering } : base;
  }
  /** A picture's size (template cut-outs are read once). */
  const sizes = new Map<string, { width: number; height: number }>();
  async function sizeOf(id: string, file: string) {
    const key = `${id}/${file}`;
    if (!sizes.has(key)) { const m = await sharp(store.read(id, file)).metadata(); sizes.set(key, { width: m.width ?? 1, height: m.height ?? 1 }); }
    return sizes.get(key)!;
  }

  // --- Drafts -----------------------------------------------------------------------------------------------------------
  const list = (id: string) => {
    deps.requireProduct(id);
    return store.files(id, 'prd-').filter(f => /^prd-[a-f0-9]{8}\.json$/.test(f)).map(f => read(id, `pr-${f.slice(4, 12)}`))
      .map(d => ({ id: d.id, name: d.name, templateRevision: d.templateRevision, revision: d.revision, updatedAt: d.updatedAt, simple: d.simple === true, products: d.items.filter(i => i.kind === 'product' && i.included && !i.removed).length,
        ratios: d.ratios, saved: Object.values(d.outputs).filter(o => o?.creativeId).length, preview: d.outputs[d.ratios[0]]?.preview })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  };
  /** A new draft of the revision; `simple` (Upload Products → Generate My Creative): the template's own products start left out. */
  const create = (id: string, input: { revision?: unknown; name?: unknown; simple?: unknown }) => locked(`${id}:reuse`, async () => {
    deps.requireProduct(id);
    const revision = typeof input.revision === 'number' ? input.revision : deps.latestRevision(id) ?? fail('NOT_READY', 'Save the template first.');
    const { snapshot, template } = await contextOf(id, revision);
    const objects = template.objects.filter(o => (o.kind === 'product' || o.kind === 'character') && !o.hidden);
    const products = objects.filter(o => o.kind === 'product').sort((a, b) => a.box.x + a.box.width / 2 - (b.box.x + b.box.width / 2));
    const items: ReuseItem[] = [...objects.filter(o => o.kind === 'character'), ...products].map((o, order) => ({ id: o.id, objectId: o.objectId ?? o.id, kind: o.kind as 'product' | 'character', label: o.label,
      category: reuseCategory(o.label), included: o.kind === 'character' || input.simple !== true, hidden: false, removed: false, order, asset: { kind: 'template', file: o.asset.file }, original: { file: o.asset.file, label: o.label } }));
    const at = nowIso(), did = `pr-${hex(4)}`;
    return write(id, { schemaVersion: 1, id: did, templateId: id, templateRevision: snapshot.revision, name: typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 120) : `${snapshot.name} · reuse`,
      createdAt: at, updatedAt: at, revision: 1, items, texts: {}, logos: {}, ratios: ['original'], placement: { mode: input.simple === true ? 'geometry' : 'original', keepStands: true, hero: null, variant: 0 }, ...(input.simple === true ? { simple: true } : {}),
      ai: { requests: 0, costUsd: 0, plans: {}, failures: [] }, overrides: {}, outputs: {} });
  });
  /** A draft with what the studio shows beside it: the template's text groups and logos, formats and source issues. */
  async function get(id: string, did: string) {
    const d = read(id, did), ctx = await contextOf(id, d.templateRevision), t = ctx.template;
    const textOf = (gid: string) => [...new Set(t.texts.filter(x => x.groupId === gid).map(x => x.line))].sort((a, b) => a - b).map(l => t.texts.filter(x => x.groupId === gid && x.line === l).sort((a, b) => a.order - b.order).map(x => x.text).join(' ')).join('\n');
    return { draft: d, sourceIssues: sourceIssues(id, ctx.snapshot), canvas: ctx.snapshot.canvas, stageFound: ctx.stageFound,
      // (A decoration's own lettering — a badge — is its artwork, not offered for editing here.)
      texts: t.groups.filter(g => !t.texts.filter(x => x.groupId === g.id).every(x => x.hidden)).map(g => { const w = t.texts.find(x => x.groupId === g.id); return { groupId: g.id, label: g.label, category: g.category, text: textOf(g.id), style: w?.style }; }).filter(g => g.text.trim()),
      logos: t.images.map(i => ({ id: i.id, label: i.label, category: i.category, file: i.asset.file })),
      formats: REUSE_ASPECT_RATIOS.map(r => { const f = planFrame(ctx.snapshot.canvas, r, ctx.decorations, ctx.avoid); return { ratio: r, label: REUSE_ASPECT_LABELS[r], canvas: f.canvas, method: f.method, note: f.note }; }),
      // `slots`: the template's own product places; as many products as that (or fewer) stand in them, never arranged anew.
      placement: (() => { const p = deps.placement?.(); return { ai: !!p, model: p?.model ?? '', offline: p?.offline ?? true, costUsd: PLACEMENT_COST_USD, slots: productPlaces(ctx.snapshot).length }; })(), knownCategories: KNOWN_KINDS };
  }
  /** Changes to a draft (what is included, text, logos, formats, placement, corrections, name): a new draft revision. */
  const update = (id: string, did: string, input: { expectedRevision?: unknown; items?: unknown; texts?: unknown; logos?: unknown; ratios?: unknown; placement?: unknown; overrides?: unknown; name?: unknown }) => locked(`${id}:reuse:${did}`, async () => {
    const d = read(id, did);
    if (input.expectedRevision !== d.revision) fail('STALE_REVISION', `This draft changed since you opened it (revision ${d.revision}). Reload it.`, { revision: d.revision });
    const ctx = await contextOf(id, d.templateRevision), next: ReuseDraft = structuredClone(d);
    const num = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
    if (input.items !== undefined) {
      if (!Array.isArray(input.items)) fail('INVALID_REQUEST', 'Send the items as a list.');
      for (const raw of input.items as Record<string, unknown>[]) {
        const item = next.items.find(i => i.id === raw?.id) ?? fail('INVALID_REQUEST', 'An item is not in this draft.');
        for (const k of ['included', 'hidden', 'removed'] as const) if (raw[k] !== undefined) item[k] = raw[k] === true;
        if (raw.order !== undefined) item.order = num(raw.order, 0, 1000) ? Math.round(raw.order as number) : item.order;
        if (typeof raw.label === 'string' && raw.label.trim()) item.label = raw.label.trim().slice(0, 60);
        if (typeof raw.category === 'string' && raw.category.trim()) item.category = reuseCategory(raw.category.trim().slice(0, 60));
        if (raw.restore === true && item.original) { item.asset = { kind: 'template', file: item.original.file }; item.label = item.original.label; item.category = reuseCategory(item.original.label); item.removed = false; item.included = true; }
        if (item.removed) item.included = false;
      }
    }
    if (input.texts !== undefined) {
      const texts = input.texts as Record<string, ReuseTextEdit | null>;
      if (!texts || typeof texts !== 'object') fail('INVALID_REQUEST', 'Send the text edits by group.');
      for (const [gid, e] of Object.entries(texts)) {
        if (!ctx.template.groups.some(g => g.id === gid)) fail('INVALID_REQUEST', 'A text group is not in this template.');
        if (e === null) { delete next.texts[gid]; continue; }
        if (e.text !== undefined && (typeof e.text !== 'string' || e.text.length > 400)) fail('INVALID_REQUEST', 'Text is at most 400 characters.');
        if (e.fontFamily !== undefined && (!isOfferFont(e.fontFamily) || (e.fontWeight !== undefined && !offerWeights(e.fontFamily).includes(e.fontWeight as OfferWeight)))) fail('INVALID_REQUEST', 'Choose one of the offered fonts and weights.');
        if (e.color !== undefined && !/^#[\da-f]{6}$/i.test(e.color)) fail('INVALID_REQUEST', 'Colours are #rrggbb.');
        if (e.scale !== undefined && !num(e.scale, 0.4, 2.5)) fail('INVALID_REQUEST', 'Text size is 40–250 %.');
        if (e.align !== undefined && e.align !== 'left' && e.align !== 'center') fail('INVALID_REQUEST', 'Align left or centre.');
        next.texts[gid] = { ...(e.text !== undefined ? { text: e.text } : {}), ...(e.hidden !== undefined ? { hidden: e.hidden === true } : {}), ...(e.fontFamily ? { fontFamily: e.fontFamily } : {}), ...(e.fontWeight ? { fontWeight: e.fontWeight } : {}),
          ...(e.color ? { color: e.color.toLowerCase() } : {}), ...(e.scale !== undefined ? { scale: e.scale } : {}), ...(e.align ? { align: e.align } : {}) };
      }
    }
    if (input.logos !== undefined) {
      for (const [lid, e] of Object.entries(input.logos as Record<string, { hidden?: unknown; restore?: unknown }>)) {
        if (!ctx.template.images.some(i => i.id === lid)) fail('INVALID_REQUEST', 'A logo is not in this template.');
        const cur = next.logos[lid] ?? {};
        next.logos[lid] = { ...(e?.restore === true ? {} : cur), ...(e?.hidden !== undefined ? { hidden: e.hidden === true } : {}) };
      }
    }
    if (input.ratios !== undefined) {
      const ratios = Array.isArray(input.ratios) ? [...new Set(input.ratios.filter(isRatio))] : [];
      if (!ratios.length) fail('INVALID_REQUEST', `Choose at least one format (${REUSE_ASPECT_RATIOS.join(', ')}).`);
      next.ratios = REUSE_ASPECT_RATIOS.filter(r => ratios.includes(r));
    }
    if (input.placement !== undefined) {
      const p = input.placement as { mode?: unknown; keepStands?: unknown; hero?: unknown; variant?: unknown };
      if (p.mode !== undefined) { if (p.mode !== 'original' && p.mode !== 'geometry' && p.mode !== 'ai') fail('INVALID_REQUEST', 'Placement is original, geometry or ai.'); if (p.mode === 'ai' && !Object.keys(next.ai.plans).length) fail('NOT_READY', 'Run AI placement first.'); next.placement.mode = p.mode; }
      if (p.keepStands !== undefined) next.placement.keepStands = p.keepStands === true;
      if (p.hero !== undefined) { if (p.hero !== null && !next.items.some(i => i.id === p.hero && i.kind === 'product')) fail('INVALID_REQUEST', 'The main product must be one of this draft’s products.'); next.placement.hero = p.hero as string | null; }
      if (p.variant !== undefined) next.placement.variant = num(p.variant, 0, 1000) ? Math.round(p.variant as number) : 0;
    }
    // A new arrangement (another mode, layout or main product) makes earlier manual product corrections meaningless: they
    // are dropped (text and logo corrections stay), so no product is left where the old arrangement had it.
    if (input.placement !== undefined && (next.placement.mode !== d.placement.mode || (next.placement.variant ?? 0) !== (d.placement.variant ?? 0) || (next.placement.hero ?? null) !== (d.placement.hero ?? null)))
      next.overrides = dropProductFixes(next, next.overrides, REUSE_ASPECT_RATIOS);
    if (input.overrides !== undefined) {
      for (const [r, map] of Object.entries(input.overrides as Record<string, Record<string, ReuseOverride | null> | null>)) {
        if (!isRatio(r)) fail('INVALID_REQUEST', 'Unknown format.');
        if (map === null) { delete next.overrides[r]; continue; }
        const cur = { ...(next.overrides[r] ?? {}) };
        for (const [key, o] of Object.entries(map)) {
          if (!/^[ogi]:[a-z]{2}-[a-f0-9]{6,12}$/.test(key)) fail('INVALID_REQUEST', 'Unknown element.');
          if (o === null) { delete cur[key]; continue; }
          const ok = (v: unknown, min = -20000, max = 20000) => v === undefined || num(v, min, max);
          if (!ok(o.x) || !ok(o.y) || !ok(o.width, 1) || !ok(o.height, 1) || !ok(o.dx) || !ok(o.dy)) fail('INVALID_REQUEST', 'A correction is not valid.');
          cur[key] = { ...cur[key], ...o };
        }
        next.overrides[r] = cur;
      }
    }
    if (typeof input.name === 'string' && input.name.trim()) next.name = input.name.trim().slice(0, 120);
    return write(id, { ...next, revision: d.revision + 1, updatedAt: nowIso() });
  });
  /**
   * A picture from the person: a product added, a product or character replaced (`target`), or a logo replaced
   * (`target` a logo id). Products and characters are cut out on this computer (a plain backdrop removed; a photo's
   * scene kept and reported); their own pixels are never redrawn.
   */
  const upload = (id: string, did: string, input: { bytes: Buffer; filename?: string; kind?: string; target?: string; label?: string; category?: string; expectedRevision?: unknown }) => locked(`${id}:reuse:${did}`, async () => {
    const d = read(id, did);
    if (input.expectedRevision !== undefined && Number(input.expectedRevision) !== d.revision) fail('STALE_REVISION', `This draft changed since you opened it (revision ${d.revision}). Reload it.`, { revision: d.revision });
    const ctx = await contextOf(id, d.templateRevision), next: ReuseDraft = structuredClone(d), name = (input.filename ?? 'Product').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim().slice(0, 60) || 'Product';
    let note: string | undefined;
    if (input.kind === 'logo') {
      if (!ctx.template.images.some(i => i.id === input.target)) fail('NOT_FOUND', 'That logo is not in this template.');
      let png: Buffer; try { png = await sharp(input.bytes).png().toBuffer(); } catch { fail('UNSUPPORTED_IMAGE', 'That file could not be read as a picture. Use a PNG, JPEG or WebP image.'); }
      const meta = await sharp(png).metadata(), hash = sha256(png), file = `pru-${did.slice(3)}-${hash.slice(0, 12)}.png`;
      if (!store.has(id, file)) store.write(id, file, png);
      next.logos[input.target!] = { ...next.logos[input.target!], asset: { kind: 'creative', file, sha256: hash, width: meta.width ?? 1, height: meta.height ?? 1, ...(input.filename ? { originalName: input.filename.slice(0, 200) } : {}) } };
    } else {
      let cut; try { cut = await cutOutUpload(input.bytes); } catch { fail('UNSUPPORTED_IMAGE', 'That file could not be read as a picture. Use a PNG, JPEG or WebP image.'); }
      const hash = sha256(cut.png), file = `pru-${did.slice(3)}-${hash.slice(0, 12)}.png`;
      if (!store.has(id, file)) store.write(id, file, cut.png);
      const asset = { kind: 'upload' as const, file, sha256: hash, width: cut.width, height: cut.height, background: cut.background, ...(input.filename ? { originalName: input.filename.slice(0, 200) } : {}) };
      note = cut.background === 'kept' ? cut.note ?? 'Its background could not be removed on this computer; it is shown with it. Use a PNG with transparency for a clean cut-out.' : cut.background === 'removed' ? 'Its plain background was removed on this computer.' : 'Its own transparency was kept.';
      const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim().slice(0, 60) : name;
      const category = reuseCategory(typeof input.category === 'string' && input.category.trim() ? input.category.trim() : label);
      if (input.target) {
        const item = next.items.find(i => i.id === input.target) ?? fail('NOT_FOUND', 'That product is not in this draft.');
        Object.assign(item, { asset, included: true, removed: false, ...(input.label || input.category ? { label, category } : {}) });
      } else {
        if (next.items.length >= MAX_ITEMS) fail('TOO_MANY', `A draft holds at most ${MAX_ITEMS} products.`);
        next.items.push({ id: `co-${hex(5)}`, objectId: null, kind: input.kind === 'character' ? 'character' : 'product', label, category, included: true, hidden: false, removed: false, order: Math.max(0, ...next.items.map(i => i.order)) + 1, asset });
        // The template's own places cannot hold a new product: the arrangement is made again.
        if (next.placement.mode === 'original') next.placement.mode = 'geometry';
      }
    }
    return { draft: write(id, { ...next, revision: d.revision + 1, updatedAt: nowIso() }), ...(note ? { note } : {}) };
  });

  // --- Compose ----------------------------------------------------------------------------------------------------------
  /** The draft's text and logo edits applied to the revision's creative (template coordinates). */
  function edited(ctx: Context, d: ReuseDraft): ProductCreative {
    let c = structuredClone(ctx.template);
    for (const [gid, e] of Object.entries(d.texts)) {
      const group = c.groups.find(g => g.id === gid);
      // (A decoration's own lettering stays the artwork it is: an edit of it from before is not applied.)
      if (!group || c.texts.filter(t => t.groupId === gid).every(t => t.hidden)) continue;
      const before = groupBounds(c, gid);
      if (e.text !== undefined) {
        const current = [...new Set(c.texts.filter(t => t.groupId === gid).map(t => t.line))].sort((a, b) => a - b).map(l => c.texts.filter(t => t.groupId === gid && t.line === l).sort((a, b) => a.order - b.order).map(t => t.text).join(' ')).join('\n');
        if (e.text.trim() && e.text !== current) {
          const r = rewriteGroup(asInstance(c), gid, e.text, fontMeasure, { newId: () => `ct-${hex(5)}` }); c = { ...c, texts: r.texts, shapes: r.shapes };
          // The new copy set in the old copy's area: wrapped to its width, centred in its height, as large as it fits (at most a little larger).
          if (before && !e.text.includes('\n')) c = fitGroup(c, gid, before, e.align ?? (inferAlign(ctx.template, gid, fontMeasure) === 'left' ? 'left' : 'center'), 1.2, fontMeasure);
        }
      }
      if (e.fontFamily || e.color || (e.scale !== undefined && e.scale !== 1)) {
        c = restyleGroup(c, gid, s => ({ ...s, ...(e.fontFamily ? { fontFamily: e.fontFamily, fontWeight: (e.fontWeight ?? offerWeights(e.fontFamily)[0]) as OfferWeight, fontStyle: 'normal' as const } : {}), ...(e.color ? { color: e.color } : {}), fontSize: s.fontSize * (e.scale ?? 1) }), fontMeasure);
      }
      if (e.align && e.align !== group.align && before) {
        c = { ...c, groups: c.groups.map(g => (g.id === gid ? { ...g, align: e.align! } : g)) };
        c = fitGroup(c, gid, { ...before, height: before.height * 1.05 }, e.align, 1, fontMeasure);
      }
      if (e.hidden) c = { ...c, texts: c.texts.map(t => (t.groupId === gid ? { ...t, hidden: true } : t)) };
    }
    c = { ...c, images: c.images.map(i => {
      const e = d.logos[i.id];
      if (!e) return i;
      const box = e.asset ? (() => { const k = Math.min(i.box.width / e.asset.width, i.box.height / e.asset.height), w = e.asset.width * k, h = e.asset.height * k; return { ...i.box, x: i.box.x + (i.box.width - w) / 2, y: i.box.y + (i.box.height - h) / 2, width: w, height: h }; })() : i.box;
      return { ...i, hidden: e.hidden === true, box, ...(e.asset ? { asset: e.asset } : {}) };
    }) };
    return c;
  }
  /** One format of a draft composed (free, on this computer). `withoutProducts`: the stage empty (the AI planner's picture). */
  async function compose(id: string, d: ReuseDraft, ratio: ReuseAspectRatio, opts: { geometryOnly?: boolean; withoutProducts?: boolean } = {}): Promise<Composed> {
    const ctx = await contextOf(id, d.templateRevision), { snapshot } = ctx, frame = planFrame(snapshot.canvas, ratio, ctx.decorations, ctx.avoid), notes: string[] = [];
    let c = edited(ctx, d);
    const items = [...d.items].sort((a, b) => a.order - b.order), products = items.filter(i => i.kind === 'product' && i.included && !i.removed);
    const added = products.some(i => !i.objectId);
    // How products are placed in this format.
    const plan = d.ai.plans[ratio], planFresh = !!plan && plan.items.join(',') === products.map(i => i.id).sort().join(',') && (plan.hero ?? null) === (d.placement.hero ?? null);
    let mode: ReusePlacementMode = opts.geometryOnly ? 'geometry' : d.placement.mode;
    // Slot-anchored replacement first: in the template's own format, when every product has a place of the template's
    // own products, each stands in it (whatever the placement mode); neither the arrangement by rule nor an AI plan
    // moves it. (Other formats reframe the artwork — characters and text move in — so their products are arranged.)
    const anchors = opts.geometryOnly || ratio !== 'original' ? undefined : slotAnchors(snapshot, products, d.placement.hero);
    if (anchors) {
      const taking = products.filter(i => !i.objectId).length;
      if (taking) notes.push(`${taking === 1 ? 'Your product stands' : `Your ${taking} products stand`} in the template’s own product ${taking === 1 ? 'place' : 'places'}: centred on ${taking === 1 ? 'it' : 'them'}, on the same base line, at most as large as the original.`);
      if (mode === 'ai' && plan) notes.push('The AI placement is not used: products that take the template’s own places stay in them.');
      mode = 'original';
    } else {
      if (mode === 'original' && (ratio !== 'original' || added)) { mode = 'geometry'; if (!opts.geometryOnly) notes.push(added ? 'More products than the template has places for: the products were arranged again.' : 'In this format the products are arranged again on its stage.'); }
      if (mode === 'ai' && !planFresh) { mode = 'geometry'; notes.push(plan ? 'The AI placement was made for other products or another main product: arranged on this computer instead. Run AI placement again.' : 'No AI placement for this format yet: arranged on this computer.'); }
    }
    // Objects: characters and decorations of the template as they are (a replaced character fitted to its place), stands only in the template's own arrangement.
    const objects: ProductCreativeObject[] = [];
    for (const o of c.objects) {
      if (o.kind === 'product') continue;
      if (o.kind === 'podium') { if (mode === 'original' && d.placement.keepStands) objects.push(o); continue; }
      if (o.kind === 'character') {
        const item = items.find(i => i.id === o.id);
        if (item && (!item.included || item.removed)) continue;
        if (item?.asset.kind === 'upload') {
          const k = Math.min(o.box.width / item.asset.width, o.box.height / item.asset.height), w = item.asset.width * k, h = item.asset.height * k;
          objects.push({ ...o, label: item.label, hidden: item.hidden, asset: item.asset, box: { x: o.box.x + (o.box.width - w) / 2, y: o.box.y + o.box.height - h, width: w, height: h } });
        } else objects.push({ ...o, hidden: item?.hidden ?? o.hidden });
        continue;
      }
      objects.push(o);
    }
    // Characters the person added stand where the template's first character stands (or bottom-left).
    for (const i of items.filter(x => x.kind === 'character' && !x.objectId && x.included && !x.removed)) {
      const ref = c.objects.find(o => o.kind === 'character')?.box ?? { x: snapshot.canvas.width * 0.03, y: snapshot.canvas.height * 0.45, width: snapshot.canvas.width * 0.22, height: snapshot.canvas.height * 0.4 };
      const size = i.asset.kind === 'upload' ? i.asset : await sizeOf(id, i.asset.file), k = Math.min(ref.width / size.width, ref.height / size.height);
      objects.push({ id: i.id, objectId: null, kind: 'character', label: i.label, asset: i.asset, box: { x: ref.x, y: ref.y + ref.height - size.height * k, width: size.width * k, height: size.height * k }, hidden: i.hidden, z: 900 });
    }
    // The template's own places (original mode): each product where it was; a replacement — a new photo of a template
    // product, or an added product taking a template product's place — fitted to that place's slot (fitInSlot), at the
    // depth of the product it replaces.
    const places: Record<string, Box> = {};
    if (mode === 'original' && !opts.withoutProducts) for (const i of products) {
      const a = anchors?.get(i.id), slot = a?.slot ?? snapshot.objects.find(x => x.id === i.objectId)?.slot;
      const o = i.objectId ? c.objects.find(x => x.id === i.id) : c.objects.find(x => x.kind === 'product' && (x.objectId === a?.objectId || x.id === a?.objectId));
      if (!o) continue;
      const box = i.asset.kind === 'upload' ? (slot ? fitInSlot(slot, i.asset, snapshot.canvas, ctx.stageFound ? ctx.stage : undefined) : o.box) : o.box;
      objects.push({ ...o, id: i.id, objectId: i.objectId ?? null, label: i.label, asset: i.asset, hidden: i.hidden, box: { ...box } });
      places[i.id] = { ...o.box };
    }
    c = { ...c, objects, origin: { kind: 'reuse', draftId: d.id, ratio }, name: `${d.name} · ${REUSE_ASPECT_LABELS[ratio]}`.slice(0, 120) };
    // Framed for the format, then re-anchored where the format cut elements off.
    // Each text group's own area in the template (where its copy may sit), and how its lines were aligned there.
    const areas = new Map(ctx.template.groups.map(g => [g.id, groupBounds(ctx.template, g.id)] as const).filter((x): x is readonly [string, Box] => !!x[1]).map(([gid, box]) => [gid, { box, align: (d.texts[gid]?.align ?? (inferAlign(ctx.template, gid, fontMeasure) === 'left' ? 'left' : 'center')) as 'left' | 'center' }]));
    const dropped: string[] = [];
    c = reanchor(mapCreative(c, frame), frame, ctx.art, ctx.decorations, areas, dropped);
    if (dropped.length) notes.push(`Not shown in this format (outside its part of the artwork): ${[...new Set(dropped)].join(', ')}.`);
    const W = frame.canvas.width, H = frame.canvas.height, s = frame.scale;
    // The stage in this format, the room the products have and what they must not cover.
    const stage = { cx: mapX(frame, ctx.stage.cx), cy: ctx.stage.cy * s, a: ctx.stage.a * s, b: ctx.stage.b * s }, m = W * 0.03;
    const lane = { x0: Math.max(m, stage.cx - stage.a * 0.98), x1: Math.min(W - m, stage.cx + stage.a * 0.98) };
    const character = c.objects.filter(o => o.kind === 'character' && !o.hidden).map(o => o.box)[0];
    if (character && character.x < lane.x1 && character.x + character.width > lane.x0 && character.y + character.height > stage.cy - stage.b) {
      // Clear of the character's body (it stands in front): products are not hidden behind it.
      if (character.x + character.width / 2 < stage.cx) lane.x0 = Math.max(lane.x0, character.x + character.width); else lane.x1 = Math.min(lane.x1, character.x);
    }
    if (lane.x1 - lane.x0 < W * 0.2) { lane.x0 = Math.max(m, stage.cx - stage.a * 0.98); lane.x1 = Math.min(W - m, stage.cx + stage.a * 0.98); notes.push('The character stands over most of the stage: products may stand in front of it.'); }
    const keepOut = [...c.groups.map(g => ({ g, b: groupBounds(c, g.id) })).filter(x => x.b).map(x => ({ ...x.b!, label: `the text “${x.g.label.slice(0, 40)}”` })),
      ...c.images.filter(i => !i.hidden).map(i => ({ ...i.box, label: `the ${i.label}` })),
      // Decorations painted into the background (a badge beside the stage) are never covered either.
      ...ctx.decorations.filter(x => !frame.excluded.includes(x.label)).map(x => ({ ...mapBox(frame, x.box), label: `the ${x.label}` }))];
    // Something beside the stage reaching down into the products' height (a badge, its words) narrows the lane on its side.
    for (const k of keepOut) {
      const band = { top: stage.cy - stage.b - H * 0.25, bottom: stage.cy + stage.b };
      if (k.y + k.height < band.top || k.y > band.bottom || k.x >= lane.x1 || k.x + k.width <= lane.x0) continue;
      // Only what stands beside the products: something over the middle of the stage (the offer above it) sets the ceiling instead.
      const right = k.x + k.width / 2 > stage.cx, span = lane.x1 - lane.x0;
      if (right ? k.x <= lane.x0 + span * 0.55 : k.x + k.width >= lane.x0 + span * 0.45) continue;
      if (right) lane.x1 = Math.max(lane.x0 + W * 0.15, Math.min(lane.x1, k.x - W * 0.01)); else lane.x0 = Math.min(lane.x1 - W * 0.15, Math.max(lane.x0, k.x + k.width + W * 0.01));
    }
    const above = keepOut.filter(k => k.y + k.height < stage.cy && k.x < lane.x1 && k.x + k.width > lane.x0);
    const ceiling = Math.min(stage.cy - H * 0.12, Math.max(H * 0.04, ...above.map(k => k.y + k.height + H * 0.015)));
    const input: PlacementInput = { canvas: { ...frame.canvas }, stage, lane, ceiling, keepOut, ...(character ? { character } : {}), products: [], hero: d.placement.hero ?? null };
    for (const i of products) { const size = i.asset.kind === 'upload' ? i.asset : await sizeOf(id, i.asset.file); input.products.push({ id: i.id, label: i.label, category: i.category, aspect: size.width / Math.max(1, size.height), pixels: { width: size.width, height: size.height } }); }
    let boxes: ReusePlacementBox[] = [], rejected: { id: string; reason: string }[] = [];
    if (mode !== 'original' && !opts.withoutProducts) {
      const geometry = geometryPlacement(input, { hero: d.placement.hero, variant: d.placement.variant });
      notes.push(...geometry.notes);
      boxes = geometry.boxes;
      if (mode === 'ai' && plan) { boxes = plan.boxes.map(b => ({ ...b })); rejected = plan.rejected; notes.push(...plan.notes.map(n => `AI: ${n}`)); }
      // The composition pass: the products judged and corrected as one showcase group (reuseCluster.ts), whoever proposed them.
      const cluster = refineCluster(input, boxes, (mode === 'ai' ? plan?.aiHero ?? plan?.hero : undefined) ?? d.placement.hero ?? geometry.hero);
      boxes = cluster.boxes; notes.push(...cluster.notes);
      const maxZ = Math.max(0, ...c.objects.filter(o => o.kind !== 'character').map(o => o.z)) + 1;
      for (const b of [...boxes].sort((p, q) => p.z - q.z)) {
        const i = products.find(x => x.id === b.id)!;
        c.objects.push({ id: i.id, objectId: i.objectId, kind: 'product', label: i.label, asset: i.asset, box: { x: b.x, y: b.y, width: b.width, height: b.height }, hidden: i.hidden, z: maxZ + 2 + b.z / 10 });
      }
    }
    // Manual corrections of this format, last.
    const fix = d.overrides[ratio] ?? {};
    c = { ...c,
      objects: c.objects.map(o => { const f = fix[`o:${o.id}`]; return f ? { ...o, box: { ...o.box, ...(f.x !== undefined ? { x: f.x } : {}), ...(f.y !== undefined ? { y: f.y } : {}), ...(f.width !== undefined ? { width: f.width } : {}), ...(f.height !== undefined ? { height: f.height } : {}) } } : o; }),
      texts: c.texts.map(t => { const f = fix[`g:${t.groupId}`]; return f ? { ...t, x: t.x + (f.dx ?? 0), baselineY: t.baselineY + (f.dy ?? 0) } : t; }),
      images: c.images.map(i => { const f = fix[`i:${i.id}`]; return f ? { ...i, box: { ...i.box, x: i.box.x + (f.dx ?? 0), y: i.box.y + (f.dy ?? 0) } } : i; }) };
    // Soft contact shadows under the products standing on the stage (their own layers, below them): every product placed
    // anew, and every new photo standing in a template product's place (the template's own products bring their own).
    if (!opts.withoutProducts) for (const o of c.objects.filter(x => x.kind === 'product' && !x.hidden && (mode !== 'original' || x.asset.kind === 'upload'))) {
      const w = Math.max(16, Math.round(o.box.width * 1.06)), h = Math.max(8, Math.round(Math.min(o.box.width * 0.11, stage.b * 0.5 + 8)));
      const file = `prs-${Math.min(4096, Math.round(w / 8) * 8)}-${Math.min(1024, Math.round(h / 4) * 4)}.png`;
      if (!store.has(id, file)) store.write(id, file, await shadowPng(Math.min(4096, Math.round(w / 8) * 8), Math.min(1024, Math.round(h / 4) * 4)));
      c.objects.push({ id: `co-${sha256(Buffer.from(o.id)).slice(0, 10)}`, objectId: null, kind: 'decoration', label: `Shadow · ${o.label}`.slice(0, 120), asset: { kind: 'upload', file, sha256: sha256(store.read(id, file)), width: w, height: h, background: 'transparent' },
        box: { x: Math.round(o.box.x + o.box.width / 2 - w / 2), y: Math.round(o.box.y + o.box.height - h * 0.55), width: w, height: h }, hidden: false, locked: true, z: o.z - 0.5 });
    }
    // The character is nearer than the products (in front of them), as in the template.
    const front = Math.max(0, ...c.objects.filter(o => o.kind !== 'character').map(o => o.z)) + 1;
    c = { ...c, objects: c.objects.map(o => (o.kind === 'character' && o.z < front ? { ...o, z: front } : o)) };
    // Products arranged anew stand on the empty stage (the template's painted stands rebuilt away), when that was reliable.
    // Else the base, with the footprints of the template's products that do not stand in their own places cleaned
    // (left out, hidden, replaced by a photo, their place taken by the person's product, moved, or arranged anew).
    const own = (o: ProductCreativeObject) => { const t = ctx.template.objects.find(x => x.objectId === o.objectId && x.kind === 'product'); return !!t && o.asset.kind === 'template' && o.asset.file === t.asset.file && ['x', 'y', 'width', 'height'].every(k => Math.abs(o.box[k as keyof Box] - t.box[k as keyof Box]) <= 1); };
    const standing = new Set(mode === 'original' && frame.method === 'template' ? c.objects.filter(o => o.kind === 'product' && !o.hidden && o.objectId && own(o)).map(o => o.objectId!) : []);
    const ground = mode !== 'original' && ctx.grounds.empty ? ctx.grounds.empty : await cleanedGround(id, ctx, d.templateRevision, snapshot.objects.filter(o => o.kind === 'product' && !standing.has(o.id)));
    // Copy left as it is keeps the template's own lettering (a layer of its own, where its words are, scaled with them);
    // its editable words stay in the creative, hidden. Changed copy is set as live text.
    const top = Math.max(0, ...c.objects.map(o => o.z)) + 1;
    for (const g of c.groups) {
      const cut = ground.lettering.get(g.id), e = d.texts[g.id], was = groupBounds(ctx.template, g.id), now = groupBounds(c, g.id);
      const mine = c.texts.filter(t => t.groupId === g.id);
      if (!cut || !was || !now || !mine.length || mine.some(t => t.hidden)) continue;
      if (e && ((e.text !== undefined && e.text.trim() && e.text !== copyOf(ctx.template, g.id)) || e.fontFamily || e.color || (e.scale !== undefined && e.scale !== 1) || (e.align && e.align !== ctx.template.groups.find(x => x.id === g.id)?.align) || e.hidden)) continue;
      // Its lines as they are, scaled into the words' area (a narrower format wrapped the live words into other lines),
      // centred there; too small to read that way, the live words are shown instead.
      const k = Math.min(now.width / was.width, now.height / was.height);
      if (k < 0.55) continue;
      const box = { x: now.x + now.width / 2 + (cut.box.x - was.x - was.width / 2) * k, y: now.y + now.height / 2 + (cut.box.y - was.y - was.height / 2) * k, width: cut.box.width * k, height: cut.box.height * k };
      c.texts = c.texts.map(t => (t.groupId === g.id ? { ...t, hidden: true } : t));
      c.objects.push({ id: letteringId(g.id), objectId: null, kind: 'decoration', label: `Text · ${g.label}`.slice(0, 120),
        asset: { kind: 'upload', file: cut.file, sha256: cut.sha256, width: Math.round(cut.box.width), height: Math.round(cut.box.height), background: 'transparent' }, box, hidden: false, z: top + c.objects.length * 0.01 });
    }
    // The format's background: the ground as it is, or made from it (sliced / mirrored sides; cached per revision and format).
    const cleaned = ground === ctx.grounds.empty ? { stageCleaned: true } : {};
    if (frame.method !== 'template') {
      const file = `prb-${d.templateRevision}-${ratioKey(ratio)}-${sha256(Buffer.from(JSON.stringify([ground.file, frame]))).slice(0, 12)}.png`;
      if (!store.has(id, file)) store.write(id, file, await frameBackground(ground.png, frame));
      c = { ...c, background: { file, sha256: sha256(store.read(id, file)), width: W, height: H, method: frame.method, restyled: false, filledPercent: frame.filledPercent, ...cleaned } };
      delete c.backgroundSource;
    } else if (ground.file !== ctx.baseFile) {
      c = { ...c, background: { file: ground.file, sha256: sha256(ground.png), width: W, height: H, method: 'template', restyled: false, filledPercent: 0, ...cleaned } };
      delete c.backgroundSource;
    }
    const placement = { input, boxes, notes, rejected, places: Object.fromEntries(Object.entries(places).map(([pid, b]) => [pid, mapBox(frame, b)])) };
    return { creative: c, frame, mode, placement, checks: checksOf(id, ctx, c, frame, mode, placement, products.length > 0), anchored: !!anchors };
  }
  /** What to look at before using a format: blocking problems first. */
  function checksOf(id: string, ctx: Context, c: ProductCreative, frame: ReuseFrame, mode: ReusePlacementMode, placement: Composed['placement'], hadProducts: boolean): Composed['checks'] {
    const issues: ProductVariationCheck[] = [], W = c.canvas.width, H = c.canvas.height, canvasBox = { x: 0, y: 0, width: W, height: H };
    for (const m of sourceIssues(id, ctx.snapshot)) issues.push({ code: 'STAGE', message: `Source template: ${m} Repair the master template (a new revision) before using it.`, blocking: true });
    const visible = c.objects.filter(o => !o.hidden && o.kind !== 'decoration');
    for (const o of visible) if (!store.has(id, o.asset.file)) issues.push({ code: 'MISSING_ASSET', message: `${o.label}: its picture is missing.`, blocking: true });
    for (const o of visible) if (area(o.box) - inter(o.box, canvasBox) > area(o.box) * 0.03) issues.push({ code: 'OUT_OF_CANVAS', message: `${o.label} is partly outside the canvas.`, blocking: o.kind === 'product' });
    for (const g of c.groups) { const b = groupBounds(c, g.id); if (b && area(b) - inter(b, canvasBox) > area(b) * 0.02) issues.push({ code: 'OUT_OF_CANVAS', message: `The text “${g.label.slice(0, 40)}” runs off the canvas.`, blocking: true }); }
    const products = visible.filter(o => o.kind === 'product');
    // (A product in a template product's place may cover what that product covered: only more than that counts.)
    for (const p of products) for (const k of placement.input.keepOut) { const was = placement.places?.[p.id]; if (inter(p.box, k) - (was ? inter(was, k) : 0) > area(k) * 0.08) issues.push({ code: 'OVERLAP', message: `${p.label} covers ${k.label}.`, blocking: true }); }
    // In depth a nearer product may overlap a farther one (a showcase group); flagged when it hides much of it.
    products.forEach((p, n) => products.slice(n + 1).forEach(q => { const [near, far] = p.z >= q.z ? [p, q] : [q, p]; if (inter(near.box, far.box) > area(far.box) * 0.4) issues.push({ code: 'OVERLAP', message: `${near.label} hides much of ${far.label}.`, blocking: false }); }));
    // The character stands in front of the products: one it hides by a quarter or more needs moving.
    const character = c.objects.find(o => o.kind === 'character' && !o.hidden);
    if (character) for (const p of products) if (inter(p.box, character.box) > area(p.box) * 0.25) issues.push({ code: 'OVERLAP', message: `${p.label} is partly hidden behind ${character.label}.`, blocking: false });
    if (!products.length) issues.push({ code: 'EMPTY', message: 'No product is shown in this creative.', blocking: false });
    if (!ctx.stageFound && hadProducts && mode !== 'original') issues.push({ code: 'STAGE', message: 'This template has no reviewed stage, so the products stand on an estimated floor line. Check that they stand on the podium; move them under Edit Creative, or mark the podium in the master template’s review.', blocking: false });
    for (const p of placement.input.products) if (shapeMismatch(p.category, p.aspect)) issues.push({ code: 'STAGE', message: `${p.label}: its photo does not look like a ${reuseCategory(p.category)} (its shape). Choose what it is, so it gets the right size.`, blocking: false });
    for (const p of products) { const px = placement.input.products.find(x => x.id === p.id)?.pixels; if (px && p.box.height > px.height * 2.5) issues.push({ code: 'FONT', message: `${p.label} is shown much larger than its picture and may look blurry: use a larger photo.`, blocking: false }); }
    for (const g of c.groups) { const t = c.texts.find(x => x.groupId === g.id && !x.hidden && x.text.trim()); if (t && t.style.fontSize < Math.max(W, H) * 0.0065) issues.push({ code: 'FONT', message: `The text “${g.label.slice(0, 40)}” had to be set very small in this format: shorten it or hide it.`, blocking: false }); }
    if (frame.note && frame.method !== 'template') issues.push({ code: 'FILLED_MARGINS', message: frame.note, blocking: false });
    if (mode !== 'original' && hadProducts && !c.background?.stageCleaned) issues.push({ code: 'STAGE', message: `Products were arranged again, but the template’s stage could not be emptied reliably (${'reason' in ctx.emptyStage ? ctx.emptyStage.reason.replace(/\.$/, '') : 'unknown'}): check it for display stands or marks painted into the background.`, blocking: false });
    for (const r of placement.rejected) issues.push({ code: 'REQUEST_IGNORED', message: `AI placement of ${c.objects.find(o => o.id === r.id)?.label ?? 'a product'} was not used: ${r.reason} Arranged by rule instead.`, blocking: false });
    for (const n of placement.notes.filter(x => !x.startsWith('AI:'))) issues.push({ code: 'STAGE', message: n, blocking: false });
    return { status: issues.some(i => i.blocking) ? 'failed' : issues.length ? 'needs-review' : 'ready', issues: issues.slice(0, 40) };
  }
  /** The live preview of one format: the composed creative (its files are the template's), drawn by the client. */
  async function preview(id: string, did: string, ratio: unknown) {
    const d = read(id, did), r = isRatio(ratio) ? ratio : d.ratios[0], out = await compose(id, d, r);
    return { ratio: r, creative: out.creative, mode: out.mode, frame: { method: out.frame.method, canvas: out.frame.canvas, note: out.frame.note, excluded: out.frame.excluded }, checks: out.checks, notes: out.placement.notes };
  }
  /** Every chosen format drawn as one complete poster, with its checks. */
  const generate = (id: string, did: string, input: { ratios?: unknown }) => locked(`${id}:reuse:${did}`, async () => {
    const d = read(id, did), ratios = Array.isArray(input.ratios) && input.ratios.length ? d.ratios.filter(r => (input.ratios as unknown[]).includes(r)) : d.ratios;
    if (!ratios.length) fail('INVALID_REQUEST', 'Choose a format of this draft.');
    const ctx = await contextOf(id, d.templateRevision), outputs = { ...d.outputs };
    for (const r of ratios) {
      const out = await compose(id, d, r), png = await renderProductCreative(f => store.read(id, f), ctx.snapshot, out.creative, 1200), hash = sha256(png), file = `prp-${did.slice(3)}-${ratioKey(r)}-${hash.slice(0, 12)}.png`;
      if (!store.has(id, file)) store.write(id, file, png);
      const prev = d.outputs[r];
      outputs[r] = { ratio: r, generatedAt: nowIso(), draftRevision: d.revision, preview: file, previewSha256: hash, canvas: out.creative.canvas, placement: out.mode,
        background: { method: out.creative.background?.method ?? 'template', filledPercent: out.frame.filledPercent, ...(out.frame.note && out.frame.method !== 'template' ? { note: out.frame.note } : {}) }, checks: out.checks,
        ...(prev?.creativeId ? { creativeId: prev.creativeId, creativeRevision: prev.creativeRevision, savedAt: prev.savedAt, savedDraftRevision: prev.savedDraftRevision } : {}),
        ...(prev?.decomposition ? { decomposition: prev.decomposition } : {}) } as ReuseOutput;
    }
    return write(id, { ...read(id, did), outputs, updatedAt: nowIso() });
  });
  /**
   * AI placement: one approved request per format to the planner, with the composition without products and its
   * geometry. Each box is checked before use; nothing is retried; a failure keeps the arrangement made by rule.
   */
  const placeWithAi = (id: string, did: string, input: { ratios?: unknown; approveUsd?: unknown }) => locked(`${id}:reuse:${did}`, async () => {
    const d = read(id, did), planner = deps.placement?.() ?? fail('NOT_CONFIGURED', 'AI placement is not configured on this server (no OpenAI key). Products are arranged on this computer instead (free).');
    const asked = Array.isArray(input.ratios) && input.ratios.length ? d.ratios.filter(r => (input.ratios as unknown[]).includes(r)) : d.ratios;
    if (!asked.length) fail('INVALID_REQUEST', 'Choose a format of this draft.');
    // The template's own format, when its products all stand in the template's own places, is never sent (nor charged).
    const ratios: ReuseAspectRatio[] = [];
    for (const r of asked) if (!(await compose(id, d, r)).anchored) ratios.push(r);
    if (!ratios.length) return d;
    const ctx = await contextOf(id, d.templateRevision), issues = sourceIssues(id, ctx.snapshot);
    if (issues.length) fail('SOURCE_NOT_READY', `Repair the master template before any paid request: ${issues.join(' ')}`);
    const estimate = planner.offline ? 0 : Math.round(ratios.length * PLACEMENT_COST_USD * 100) / 100;
    if (estimate && !(typeof input.approveUsd === 'number' && input.approveUsd + 1e-8 >= estimate)) fail('APPROVAL_REQUIRED', `AI placement sends ${ratios.length} request(s) to ${planner.model}, about $${estimate.toFixed(2)}. Approve the cost first.`, { estimateUsd: estimate, requests: ratios.length });
    const next: ReuseDraft = structuredClone(d);
    for (const r of ratios) {
      const proposal = await compose(id, next, r, { geometryOnly: true });
      if (!proposal.placement.input.products.length) continue;
      const empty = await compose(id, next, r, { geometryOnly: true, withoutProducts: true });
      const picture = await sharp(await renderProductCreative(f => store.read(id, f), ctx.snapshot, empty.creative, 768)).flatten({ background: '#ffffff' }).jpeg({ quality: 80 }).toBuffer();
      const operationId = randomUUID(), save = (f: string, v: object) => store.write(id, `prd-${did.slice(3)}-${ratioKey(r)}-${operationId.slice(0, 8)}-${f.replace(/\.json$/i, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40)}.json`, Buffer.from(JSON.stringify(v, null, 2)));
      next.ai.requests += 1; next.ai.costUsd = Math.round((next.ai.costUsd + (planner.offline ? 0 : PLACEMENT_COST_USD)) * 100) / 100;
      try {
        const photos = await Promise.all(proposal.creative.objects.filter(o => o.kind === 'product' && !o.hidden).map(async o => ({ id: o.id, image: await sharp(store.read(id, o.asset.file)).resize(256, 256, { fit: 'inside' }).png().toBuffer() })));
        const answer = await planner.place({ ...proposal.placement.input, format: r, proposal: proposal.placement.boxes }, picture, save, operationId, photos);
        const checked = checkPlacement(answer.raw, proposal.placement.input, proposal.placement.boxes);
        next.ai.plans[r] = { ratio: r, at: nowIso(), model: planner.model, offline: planner.offline, operationId, ...(answer.responseId ? { responseId: answer.responseId } : {}),
          items: proposal.placement.input.products.map(p => p.id).sort(), hero: next.placement.hero ?? null, ...(checked.hero ? { aiHero: checked.hero } : {}), boxes: checked.boxes, notes: checked.notes, rejected: checked.rejected } satisfies ReuseAiPlan;
      } catch (error) {
        next.ai.failures.push({ at: nowIso(), operationId, message: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
        break;
      }
    }
    if (Object.keys(next.ai.plans).length) next.placement.mode = 'ai';
    // The formats AI arranged just now start without the old manual product corrections.
    next.overrides = dropProductFixes(next, next.overrides, ratios.filter(r => next.ai.plans[r]?.operationId !== d.ai.plans[r]?.operationId));
    return write(id, { ...next, revision: d.revision + 1, updatedAt: nowIso() });
  });
  /**
   * Each generated format saved as a creative of the template (a new one, or a new revision of the one saved before):
   * its pictures copied as the creative's own files, the template's untouched.
   */
  const save = (id: string, did: string, input: { ratios?: unknown }) => locked(`${id}:reuse:${did}`, async () => {
    const d = read(id, did), ratios = Array.isArray(input.ratios) && input.ratios.length ? d.ratios.filter(r => (input.ratios as unknown[]).includes(r)) : d.ratios;
    const outputs = { ...d.outputs };
    for (const r of ratios) {
      const out = await compose(id, d, r);
      if (out.checks.status === 'failed') fail('NOT_READY', `${REUSE_ASPECT_LABELS[r]} did not pass its checks: ${out.checks.issues.filter(i => i.blocking).map(i => i.message).join(' ')}`);
      const prev = d.outputs[r], cid = prev?.creativeId ?? `pc-${hex(3)}`;
      const own = (from: string) => { const bytes = store.read(id, from), ext = from.split('.').pop(), file = `pca-${cid.slice(3)}-${sha256(bytes).slice(0, 12)}.${ext}`; if (!store.has(id, file)) store.write(id, file, bytes); return { file, sha256: sha256(bytes) }; };
      const c = out.creative;
      const creative: ProductCreative = { ...c, id: cid,
        objects: c.objects.map(o => (o.asset.kind === 'upload' ? { ...o, asset: { ...o.asset, ...own(o.asset.file) } } : o)),
        images: c.images.map(i => (i.asset.kind === 'creative' ? { ...i, asset: { ...i.asset, ...own(i.asset.file) } } : i)),
        ...(c.background ? { background: { ...c.background, ...own(c.background.file) } } : {}),
        history: [{ at: nowIso(), action: 'generated', detail: `Reuse Template draft ${d.name} (revision ${d.revision}), ${REUSE_ASPECT_LABELS[r]}, products ${out.mode === 'ai' ? 'placed by the approved AI plan' : out.mode === 'geometry' ? 'arranged by rule on this computer' : 'in the template’s places'}.` }] };
      const saved = prev?.creativeId ? await deps.creatives.replaceWith(id, cid, creative) : await deps.creatives.add(id, creative);
      outputs[r] = { ...(outputs[r] ?? { ratio: r, generatedAt: nowIso(), draftRevision: d.revision, preview: '', previewSha256: '', canvas: c.canvas, placement: out.mode, background: { method: c.background?.method ?? 'template', filledPercent: out.frame.filledPercent }, checks: out.checks }),
        creativeId: saved.id, creativeRevision: saved.revision, savedAt: nowIso(), savedDraftRevision: d.revision };
    }
    return write(id, { ...read(id, did), outputs, updatedAt: nowIso() });
  });
  const savedCreative = (id: string, did: string, ratio: unknown) => {
    const d = read(id, did), r = isRatio(ratio) ? ratio : fail('NOT_FOUND', 'Unknown format.'), o = d.outputs[r];
    if (!o?.creativeId) fail('NOT_READY', 'Save this format first.');
    return { d, r, creative: deps.creatives.read(id, o.creativeId) };
  };
  /** The saved creative opened in the editor as its own layers (free, no provider). */
  const open = async (id: string, did: string, ratio: unknown) => { const { creative } = savedCreative(id, did, ratio); const opened = await deps.creatives.open(id, creative.id); return { runId: opened.runId, creativeId: creative.id }; };
  /** "Decompose & Edit": the saved creative made into a template of its own, then reviewed and decomposed with the approved planner + Seedream. */
  /**
   * Each product with its contact shadow in one picture (the shadow under the complete product): decomposed, it is one
   * layer, so moving the product in the editor takes its shadow along and leaves the stage clean behind it.
   */
  async function withShadowsJoined(id: string, c: ProductCreative): Promise<ProductCreative> {
    let objects = [...c.objects];
    for (const p of c.objects.filter(o => o.kind === 'product' && !o.hidden && !o.box.rotation)) {
      const shadow = objects.find(o => o.id === `co-${sha256(Buffer.from(p.id)).slice(0, 10)}` && o.kind === 'decoration' && !o.hidden);
      if (!shadow) continue;
      const x0 = Math.floor(Math.min(p.box.x, shadow.box.x)), y0 = Math.floor(Math.min(p.box.y, shadow.box.y)), x1 = Math.ceil(Math.max(p.box.x + p.box.width, shadow.box.x + shadow.box.width)), y1 = Math.ceil(Math.max(p.box.y + p.box.height, shadow.box.y + shadow.box.height));
      const part = async (o: ProductCreativeObject) => ({ input: await sharp(store.read(id, o.asset.file)).resize(Math.max(1, Math.round(o.box.width)), Math.max(1, Math.round(o.box.height)), { fit: 'fill' }).png().toBuffer(), left: Math.round(o.box.x - x0), top: Math.round(o.box.y - y0) });
      const png = await sharp({ create: { width: x1 - x0, height: y1 - y0, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([await part(shadow), await part(p)]).png().toBuffer(), hash = sha256(png), file = `pjs-${hash.slice(0, 12)}.png`;
      if (!store.has(id, file)) store.write(id, file, png);
      objects = objects.filter(o => o !== shadow).map(o => (o === p ? { ...p, asset: { kind: 'upload' as const, file, sha256: hash, width: x1 - x0, height: y1 - y0, background: 'transparent' as const }, box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } } : o));
    }
    return { ...c, objects };
  }
  const decompose = (id: string, did: string, ratio: unknown) => locked(`${id}:reuse:${did}`, async () => {
    const { d, r, creative } = savedCreative(id, did, ratio);
    if (!deps.toTemplate) fail('NOT_CONFIGURED', 'Decomposition is not available on this server.');
    // This saved version separated before: its layer template again (its layers, approvals and editing kept; nothing paid twice).
    const prev = d.outputs[r]?.decomposition, exists = (tid: string) => { try { deps.requireProduct(tid); return true; } catch { return false; } };
    if (prev && prev.creativeId === creative.id && prev.creativeRevision === creative.revision && exists(prev.templateId)) return { templateId: prev.templateId, creativeId: creative.id, reused: true };
    // Its text as editable words (the original lettering is a picture of them): on the creative's background, which has no
    // text, they come off exactly; the editor then shows them in the closest typefaces it has.
    // Text inside a decoration (a badge's words) keeps the template's own lettering: the editor's fonts only approximate it.
    const ctx = await contextOf(id, d.templateRevision), inside = (b: Box, k: Box) => b.x >= k.x - 4 && b.y >= k.y - 4 && b.x + b.width <= k.x + k.width + 4 && b.y + b.height <= k.y + k.height + 4;
    const badge = new Set([...(creative.background?.stageCleaned ? ctx.grounds.empty ?? ctx.grounds.base : ctx.grounds.base).lettering].filter(([, cut]) => ctx.decorations.some(dec => inside(cut.box, dec.box))).map(([gid]) => gid));
    const snapshot = deps.snapshot(id, d.templateRevision), composition = await variationComposition(f => store.read(id, f), snapshot, await withShadowsJoined(id, withLiveText(creative, badge)));
    const templateId = await deps.toTemplate({ templateId: id, revision: d.templateRevision, jobId: `reuse-${d.id}`, index: REUSE_ASPECT_RATIOS.indexOf(r), title: `${d.name} · ${REUSE_ASPECT_LABELS[r]}`, name: `${d.name} · ${REUSE_ASPECT_LABELS[r]}`, composition });
    // Recorded with the format (not a change of the draft: its revision stays, its preview stays current).
    const latest = read(id, did), out = latest.outputs[r];
    if (out) write(id, { ...latest, outputs: { ...latest.outputs, [r]: { ...out, decomposition: { templateId, creativeId: creative.id, creativeRevision: creative.revision, at: nowIso() } } } });
    return { templateId, creativeId: creative.id, reused: false };
  });
  return { list, create, get, update, upload, preview, generate, placeWithAi, save, open, decompose, compose: (id: string, did: string, ratio: ReuseAspectRatio) => compose(id, read(id, did), ratio) };
}
export type ReuseStudio = ReturnType<typeof createReuseStudio>;

/** The draft's manual corrections without those of its products in `ratios` (text, logo and character corrections kept). */
function dropProductFixes(d: ReuseDraft, overrides: ReuseDraft['overrides'], ratios: readonly ReuseAspectRatio[]): ReuseDraft['overrides'] {
  const products = new Set(d.items.filter(i => i.kind === 'product').map(i => `o:${i.id}`)), out: ReuseDraft['overrides'] = {};
  for (const [r, map] of Object.entries(overrides) as [ReuseAspectRatio, Record<string, ReuseOverride>][]) {
    out[r] = ratios.includes(r) ? Object.fromEntries(Object.entries(map).filter(([k]) => !products.has(k))) : map;
  }
  return out;
}
