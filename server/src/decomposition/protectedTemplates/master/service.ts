/**
 * Text & Graphics MASTER templates (shared masterTemplates.ts): a protected template (../service.ts) made from an offer
 * creative, analysed once, prepared once and published as immutable revisions; and the CREATIVES made from them.
 *
 *   create      the source creative; its scan starts at once
 *   scan        local OCR of the whole poster and pixel analysis (scan.ts, analysis.ts): words, logo slots, plates, the
 *               regions that hold them. Once per source: asking again returns the saved result without reading anything
 *   rescan      "Scan again": the upload read again into a proposal kept in its own file; nothing changes until the
 *               administrator applies chosen fonts or replaces everything (published revisions and creatives never)
 *   review      corrections, additions, removals, categories and approvals (words.ts correctAnalysis does the checking)
 *   prepare     the regions follow the reviewed content, and the clean background is made locally (patternFill.ts); or
 *               the administrator uploads a clean background. Either is approved explicitly (a local one is an estimate)
 *   artwork     the clean background as one picture, or Seedream's layers of it (the protected template's own paid,
 *               confirmed decomposition, which never sees the text or logos)
 *   publish     an immutable snapshot (master-r<n>.json) of everything a creative needs
 *   creatives   made from a revision's snapshot: every word, logo slot and plate as its own element, edited and saved
 *               on their own (creative-<id>.json). Reading stored files only: no OCR, no decomposition, no AI call
 *
 * The master is never changed by a creative.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  addRescanFindings, analysisReviewed, applyRescanFonts, CREATIVE_LIMITS, CREATIVE_SCHEMA_VERSION, creativeFromSnapshot, isMasterCategory, isOfferFont, LOW_WORD_CONFIDENCE, mapBox, MASTER_CLEANUP_VERSION, MASTER_SCHEMA_VERSION, normalizeBox, offerWeights,
  rescanChanges, validCreativeElementId, validCreativeId, validPlateId, withHistory, type MasterRescanProposal, type RescanChanges,
  type CreativeAsset, type CreativeEvent, type CreativeImage, type CreativeInstance, type CreativeShape, type CreativeText, type MasterArtworkLayer, type MasterInfo, type MasterRevisionRef, type MasterSnapshot, type MasterStage,
  type ProtectedElement, type ProtectedSourceOrigin, type ProtectedTemplate, type ProtectedTemplateView, type SourceBox, type TextAnalysis, type TextPlate,
} from '@frameflow/shared';
import { readRun, RunError, validRunId } from '../../layerizeExperiment.js';
import { decodeRgba, ingestImage, ProtectedImageError, runEditorLayers, sha256 } from '../pixels.js';
import type { ProtectedService } from '../service.js';
import type { ProtectedStore } from '../store.js';
import { correctAnalysis } from '../words.js';
import type { WordRecognizer } from '../../../textRecognition/recognizer.js';
import { buildMasterAnalysis } from './analysis.js';
import { cleanBackground } from './patternFill.js';
import { analyseArtwork, deriveArtwork } from './artwork.js';
import { createCreativeRun, existingCreativeRun } from './creativeRun.js';
import { removalMask } from './removal.js';
import { extendLineToInk, scanPoster } from './scan.js';

const nowIso = () => new Date().toISOString();
const hexId = (prefix: string, n = 5) => `${prefix}-${randomBytes(n).toString('hex')}`;
const short = (hash: string) => hash.slice(0, 12);
function fail(code: string, message: string, details?: Record<string, unknown>): never { throw new RunError(code, message, details); }
const creativeFile = (cid: string) => `creative-${cid}.json`;

/** What the API answers for a master: the protected template's view plus everything the simple workflow shows. */
export interface MasterView {
  template: ProtectedTemplateView;
  master: MasterInfo;
  stage: MasterStage;
  /** Words and logo slots to look at: not reviewed yet, and among them those read with low confidence. */
  review: { pending: number; uncertain: number; total: number };
  /** olderCleanup: the current clean background was made by an older local clean-up (MASTER_CLEANUP_VERSION) and may keep leftovers. */
  background: { ready: boolean; approved: boolean; method?: string; reliability?: string; stale: boolean; olderCleanup: boolean };
  latestRevision: MasterRevisionRef | null;
  /** The published revision no longer matches the current analysis, background or artwork. */
  changedSincePublish: boolean;
  creatives: number;
  /** Paid decomposition requests made for this master (each was confirmed), and image generations (never). */
  activity: MasterInfo['activity'] & { seedreamRequests: number; imageGenerations: 0 };
}
export interface MasterListItem { id: string; name: string; createdAt: string; updatedAt: string; stage: MasterStage; source: ProtectedTemplate['source']; words: number; logos: number; revisions: number; latestRevision: number | null; creatives: number }
/** A finished "Scan again", compared with the current elements. */
export interface MasterRescanResult { rescan: NonNullable<MasterInfo['rescan']>; found: MasterRescanProposal['found']; analysisRevision: number; changes: RescanChanges }
export interface CreativeSummary { id: string; name: string; masterRevision: number; createdAt: string; updatedAt: string; revision: number; texts: number; images: number; editorSavedAt: string | null }

export interface MasterServiceOptions {
  store: ProtectedStore; service: ProtectedService; runsDir: string;
  /** The local OCR engine for scans (tesseract by default; tests inject one that counts its reads). */
  recognizer: () => WordRecognizer;
}
export type MasterService = ReturnType<typeof createMasterTemplates>;

export function createMasterTemplates(options: MasterServiceOptions) {
  const { store, service } = options;
  const scanning = new Set<string>(), rescanning = new Set<string>();
  const locks = new Map<string, Promise<unknown>>();
  const locked = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const next = (locks.get(key) ?? Promise.resolve()).then(work, work);
    locks.set(key, next.catch(() => undefined));
    return next;
  };
  const requireMaster = (id: string) => { const t = store.require(id); if (!t.master) fail('NOT_FOUND', 'Master template not found.'); return t as ProtectedTemplate & { master: MasterInfo }; };
  const creatives = (id: string) => store.files(id, 'creative-').filter(f => f.endsWith('.json'));
  const readCreative = (id: string, cid: string): CreativeInstance => {
    if (!validCreativeId(cid) || !store.has(id, creativeFile(cid))) fail('NOT_FOUND', 'Creative not found.');
    return JSON.parse(store.read(id, creativeFile(cid)).toString('utf8')) as CreativeInstance;
  };
  const readSnapshot = (id: string, revision: number): MasterSnapshot => {
    const t = requireMaster(id), ref = t.master.revisions.find(r => r.revision === revision) ?? fail('NOT_FOUND', `Master revision ${revision} not found.`);
    const bytes = store.read(id, ref.file);
    if (sha256(bytes) !== ref.sha256) fail('FILE_CHANGED', `The saved master revision ${revision} changed on disk; it is not used.`);
    return JSON.parse(bytes.toString('utf8')) as MasterSnapshot;
  };

  /**
   * Every stored file a record still names: the master, its published revisions, its creatives and an unapplied rescan.
   * Cleaning up never removes one of these (a revision or creative may use a crop the current analysis no longer does).
   */
  const referencedFiles = (id: string) => {
    const t = requireMaster(id), records = [JSON.stringify(t)];
    for (const file of [...t.master.revisions.map(r => r.file), ...creatives(id), ...(t.master.rescan?.file ? [t.master.rescan.file] : [])]) if (store.has(id, file)) records.push(store.read(id, file).toString('utf8'));
    return new Set(records.flatMap(r => r.match(/"file":\s*"[^"]+"/g) ?? []).map(m => m.replace(/^"file":\s*"/, '').slice(0, -1)));
  };

  // --- State -----------------------------------------------------------------------------------------------------------
  function stageOf(t: ProtectedTemplate & { master: MasterInfo }, view: ProtectedTemplateView): { stage: MasterStage; changed: boolean } {
    const m = t.master, scan = m.scan;
    if (scanning.has(t.id) || scan?.status === 'running') return { stage: 'scanning', changed: false };
    if (!t.textAnalysis) return { stage: scan?.status === 'failed' ? 'scan-failed' : 'scanning', changed: false };
    if (!analysisReviewed(t.textAnalysis)) return { stage: 'review', changed: false };
    const latest = m.revisions[m.revisions.length - 1];
    const changed = !!latest && (latest.analysisRevision !== t.textAnalysis.revision || latest.baseSha256 !== t.base?.sha256 || (latest.runId ?? null) !== (m.artwork.mode === 'seedream' ? m.artwork.runId ?? null : null));
    const backgroundReady = !!t.base && !view.stale.base && !!t.base.approval;
    if (!backgroundReady || (m.artwork.mode === 'seedream' && !artworkRunUsable(t))) return { stage: latest ? 'changed' : 'prepare', changed };
    if (!latest) return { stage: 'prepare', changed: false };
    return { stage: changed ? 'changed' : 'ready', changed };
  }
  const artworkRunUsable = (t: ProtectedTemplate & { master: MasterInfo }) => {
    const runId = t.master.artwork.runId;
    if (!runId) return false;
    const s = service.runSummary(t.id, runId);
    return !!s && s.usable && s.current;
  };
  function view(id: string): MasterView {
    const t = requireMaster(id), v = service.view(id), { stage, changed } = stageOf(t, v);
    const a = t.textAnalysis, items = a ? [...a.words, ...a.logoSlots, ...(a.plates ?? [])] : [];
    const pending = items.filter(i => i.review.status === 'needs-review');
    const uncertain = a ? [...a.words.filter(w => w.review.status === 'needs-review' && w.confidence < LOW_WORD_CONFIDENCE), ...a.logoSlots.filter(l => l.review.status === 'needs-review' && l.confidence < 0.6), ...(a.plates ?? []).filter(p => p.review.status === 'needs-review' && p.confidence < 0.6)].length : 0;
    const latest = t.master.revisions[t.master.revisions.length - 1] ?? null;
    // Running from the moment it is asked for (before its state is saved); one the server was running when it stopped
    // never finishes: shown as failed, to be run again or discarded.
    const saved = t.master.rescan, rescan = rescanning.has(id) ? { ...(saved?.status === 'running' ? saved : { startedAt: nowIso(), basedOn: t.textAnalysis?.revision ?? 0, recognizerCalls: 0 }), status: 'running' as const }
      : saved?.status === 'running' ? { ...saved, status: 'failed' as const, error: 'Interrupted (the server restarted). Scan again.' } : saved;
    return {
      template: v, master: rescan ? { ...t.master, rescan } : t.master, stage, review: { pending: pending.length, uncertain, total: items.length },
      background: { ready: !!t.base && !v.stale.base, approved: !!t.base?.approval && !v.stale.base, method: t.base?.method, reliability: t.base?.reliability, stale: v.stale.base,
        olderCleanup: t.base?.method === 'local-fill' && (t.master.cleanup?.baseSha256 === t.base.sha256 ? t.master.cleanup.version ?? 1 : 1) < MASTER_CLEANUP_VERSION },
      latestRevision: latest, changedSincePublish: changed, creatives: creatives(id).length,
      activity: { ...t.master.activity, seedreamRequests: t.runs.filter(r => { try { const run = readRun(join(options.runsDir, r.runId)); return !!run.seedream.requestId; } catch { return false; } }).length, imageGenerations: 0 },
    };
  }
  function list(): MasterListItem[] {
    return store.list().filter(t => !!t.master).map(t => {
      const m = t as ProtectedTemplate & { master: MasterInfo }, { stage } = stageOf(m, service.view(t.id)), latest = m.master.revisions[m.master.revisions.length - 1];
      return { id: t.id, name: t.name, createdAt: t.createdAt, updatedAt: t.updatedAt, stage, source: t.source, words: t.textAnalysis?.words.filter(w => w.review.status !== 'rejected').length ?? 0,
        logos: t.textAnalysis?.logoSlots.filter(l => l.review.status !== 'rejected').length ?? 0, revisions: m.master.revisions.length, latestRevision: latest?.revision ?? null, creatives: creatives(t.id).length };
    });
  }

  // --- Phase 1 ---------------------------------------------------------------------------------------------------------
  async function create(bytes: Buffer, input: { name?: string; filename?: string; origin?: ProtectedSourceOrigin }) {
    const t = await service.create(bytes, { name: input.name, filename: input.filename, origin: input.origin });
    const master: MasterInfo = { version: MASTER_SCHEMA_VERSION, type: 'text-graphics', artwork: { mode: 'background' }, revisions: [], activity: { scans: 0, ocrReads: 0 } };
    await service.updateMaster(t.id, undefined, x => { x.master = master; });
    return t.id;
  }

  /**
   * The scan. Saved per source: when the source was scanned already (and nothing asks to read it again), the saved result
   * is returned and no OCR runs. Runs in the background; the record says when it is running, done or failed.
   */
  function startScan(id: string, input: { force?: boolean } = {}): { started: boolean } {
    const t = requireMaster(id);
    if (scanning.has(id)) return { started: false };
    if (!input.force && t.master.scan?.status === 'done' && t.master.scan.sourceSha256 === t.source.sha256 && t.textAnalysis) return { started: false };
    scanning.add(id);
    void runScan(id).catch(error => console.error('master scan', id, error)).finally(() => scanning.delete(id));
    return { started: true };
  }
  async function runScan(id: string) {
    const startedAt = nowIso(), started = Date.now();
    let calls = 0;
    const base = options.recognizer(), recognizer: WordRecognizer = { engine: base.engine, recognize: input => { calls++; return base.recognize(input); } };
    await service.updateMaster(id, undefined, x => { x.master!.scan = { status: 'running', startedAt, sourceSha256: x.source.sha256, recognizerCalls: 0 }; });
    try {
      const t = requireMaster(id), source = await decodeRgba(store.read(id, t.source.inputFile));
      const scan = await scanPoster(source, recognizer), written: string[] = [];
      const result = await buildMasterAnalysis({ template: t, source, scan, recognizer, previous: t.textAnalysis, store: (file, png) => { store.write(id, file, png); written.push(file); }, at: nowIso() });
      const a = result.analysis, now = requireMaster(id);
      await service.setMasterPrepared(id, now.revision, { elements: result.elements, analysis: a, master: x => {
        x.master!.scan = { status: 'done', startedAt, finishedAt: nowIso(), sourceSha256: x.source.sha256, engine: `${base.engine.name} ${base.engine.version}`, durationMs: Date.now() - started, recognizerCalls: calls,
          found: { words: a.words.length, groups: a.groups.length, logos: a.logoSlots.length, plates: a.plates?.length ?? 0, ignored: result.ignored } };
        x.master!.activity = { scans: x.master!.activity.scans + 1, ocrReads: x.master!.activity.ocrReads + calls };
      } });
      // Files of an earlier analysis no longer named anywhere (a re-scan of the same source makes new crops); crops a
      // published revision or a creative uses stay.
      const keep = referencedFiles(id);
      for (const f of store.files(id, 'logo-')) if (!keep.has(f) && !written.includes(f)) store.discard(id, f);
    } catch (error) {
      await service.updateMaster(id, undefined, x => {
        x.master!.scan = { status: 'failed', startedAt, finishedAt: nowIso(), sourceSha256: x.source.sha256, recognizerCalls: calls, error: error instanceof Error ? error.message : String(error) };
        x.master!.activity = { scans: x.master!.activity.scans + 1, ocrReads: x.master!.activity.ocrReads + calls };
      });
      throw error;
    }
  }

  // --- Scan again ---------------------------------------------------------------------------------------------------------
  /** Reads the upload again (local OCR and font matching, no provider) into a proposal; the master does not change. */
  function startRescan(id: string): { started: boolean } {
    const t = requireMaster(id);
    if (!t.textAnalysis || scanning.has(id) || t.master.scan?.status === 'running') fail('SCAN_RUNNING', 'The first scan has not finished yet.');
    if (rescanning.has(id)) return { started: false };
    rescanning.add(id);
    void runRescan(id).catch(error => console.error('master rescan', id, error)).finally(() => rescanning.delete(id));
    return { started: true };
  }
  /** Removes a proposal file and the logo crops only it wrote (a crop something else names stays). */
  const dropProposal = (id: string, file: string) => {
    if (!store.has(id, file)) return;
    const { written } = JSON.parse(store.read(id, file).toString('utf8')) as MasterRescanProposal;
    store.discard(id, file);
    const keep = referencedFiles(id);
    for (const f of written) if (!keep.has(f) && store.has(id, f)) store.discard(id, f);
  };
  async function runRescan(id: string) {
    const startedAt = nowIso(), started = Date.now(), written: string[] = [];
    let calls = 0;
    const base = options.recognizer(), recognizer: WordRecognizer = { engine: base.engine, recognize: input => { calls++; return base.recognize(input); } };
    const before = requireMaster(id), basedOn = before.textAnalysis!.revision, earlier = before.master.rescan?.file;
    await service.updateMaster(id, undefined, x => { x.master!.rescan = { status: 'running', startedAt, basedOn, recognizerCalls: 0 }; });
    // A newer reading replaces one not applied.
    if (earlier) dropProposal(id, earlier);
    try {
      const t = requireMaster(id), source = await decodeRgba(store.read(id, t.source.inputFile));
      const scan = await scanPoster(source, recognizer);
      // Logo crops are named by slot and content: an existing name is the same picture, never overwritten.
      const result = await buildMasterAnalysis({ template: t, source, scan, recognizer, previous: t.textAnalysis, store: (file, png) => { if (!store.has(id, file)) { store.write(id, file, png); written.push(file); } }, at: nowIso() });
      const a = result.analysis, file = `rescan-${Date.now().toString(36)}.json`;
      const proposal: MasterRescanProposal = { analysis: a, elements: result.elements, written, found: { words: a.words.length, groups: a.groups.length, logos: a.logoSlots.length, plates: a.plates?.length ?? 0, ignored: result.ignored } };
      store.write(id, file, Buffer.from(JSON.stringify(proposal)));
      await service.updateMaster(id, undefined, x => {
        x.master!.rescan = { status: 'done', startedAt, finishedAt: nowIso(), basedOn, recognizerCalls: calls, durationMs: Date.now() - started, engine: `${base.engine.name} ${base.engine.version}`, file };
        x.master!.activity = { scans: x.master!.activity.scans + 1, ocrReads: x.master!.activity.ocrReads + calls };
      });
    } catch (error) {
      const keep = referencedFiles(id);
      for (const f of written) if (!keep.has(f) && store.has(id, f)) store.discard(id, f);
      await service.updateMaster(id, undefined, x => {
        x.master!.rescan = { status: 'failed', startedAt, finishedAt: nowIso(), basedOn, recognizerCalls: calls, error: error instanceof Error ? error.message : String(error) };
        x.master!.activity = { scans: x.master!.activity.scans + 1, ocrReads: x.master!.activity.ocrReads + calls };
      });
      throw error;
    }
  }
  const readProposal = (id: string) => {
    const r = requireMaster(id).master.rescan;
    if (!r || r.status !== 'done' || !r.file || !store.has(id, r.file)) fail('NOT_FOUND', 'There is no new scan to review. Use Scan again first.');
    return { rescan: r, proposal: JSON.parse(store.read(id, r.file).toString('utf8')) as MasterRescanProposal };
  };
  /** The finished rescan compared with the current elements (what applying would change). */
  function rescanResult(id: string): MasterRescanResult {
    const t = requireMaster(id), { rescan, proposal } = readProposal(id), current = t.textAnalysis ?? fail('NO_TEXT_ANALYSIS', 'The scan has not finished yet.');
    return { rescan, found: proposal.found, analysisRevision: current.revision, changes: rescanChanges(current, proposal.analysis) };
  }
  /**
   * Applies a finished rescan, as the administrator chose: `selected` (or `fonts`) takes the new font of the words named in
   * `wordIds` (their text, box, colour, review and group stay) and adds the new text and shapes named in `addWordIds` and
   * `addPlateIds` to their current lines and phrases; `replace` takes the whole new reading (corrections and approvals are
   * replaced, the elements are reviewed again). Added content changes the regions, so the clean background is made again.
   * Published revisions and creatives are never changed; saving the master publishes.
   */
  const applyRescan = (id: string, expected: number, input: { expectedAnalysisRevision?: unknown; mode?: unknown; wordIds?: unknown; addWordIds?: unknown; addPlateIds?: unknown }) => locked(id, async () => {
    const t = requireMaster(id), current = t.textAnalysis ?? fail('NO_TEXT_ANALYSIS', 'The scan has not finished yet.');
    if (expected !== t.revision) fail('STALE_REVISION', `This template changed since you opened it (revision ${t.revision}, yours ${expected}). Reload it and make your change again.`, { revision: t.revision });
    if (input.expectedAnalysisRevision !== current.revision) fail('STALE_REVISION', 'The elements changed since you looked at the new scan. Look at it again, then apply.');
    if (rescanning.has(id)) fail('RESCAN_RUNNING', 'The new scan is still running.');
    const { rescan, proposal } = readProposal(id), at = nowIso();
    if (input.mode === 'fonts' || input.mode === 'selected') {
      const list = (v: unknown) => v === undefined ? [] : Array.isArray(v) && v.every(x => typeof x === 'string') ? v as string[] : fail('INVALID_REQUEST', 'Send the chosen changes as lists of ids.');
      const fontIds = list(input.wordIds), wordIds = list(input.addWordIds), plateIds = list(input.addPlateIds);
      if (!fontIds.length && !wordIds.length && !plateIds.length) fail('INVALID_REQUEST', 'Choose at least one change to apply.');
      const changes = rescanChanges(current, proposal.analysis);
      const offered = { fonts: new Set(changes.fonts.map(f => f.wordId)), words: new Set(changes.added.filter(a => a.lineId).map(a => a.wordId)), plates: new Set(changes.plates.filter(p => p.groupId).map(p => p.plateId)) };
      if (fontIds.some(x => !offered.fonts.has(x)) || wordIds.some(x => !offered.words.has(x)) || plateIds.some(x => !offered.plates.has(x))) fail('INVALID_REQUEST', 'A chosen change is not in this scan. Look at the new scan again.');
      const analysis = addRescanFindings(applyRescanFonts(current, proposal.analysis, fontIds, at), proposal.analysis, { wordIds, plateIds }, at);
      const size = { width: t.source.width, height: t.source.height };
      const next = wordIds.length || plateIds.length ? deriveRegions(t.elements, analysis, size) : { elements: t.elements, analysis };
      await service.setMasterPrepared(id, expected, { elements: next.elements, analysis: next.analysis, master: x => { delete x.master!.rescan; } });
      dropProposal(id, rescan.file!);
    } else if (input.mode === 'replace') {
      const analysis = { ...proposal.analysis, revision: current.revision + 1, updatedAt: at, history: withHistory(current.history, { at, action: 'analysed' as const, detail: 'Replaced by a new scan of the upload.' }) };
      await service.setMasterPrepared(id, expected, { elements: proposal.elements, analysis, master: x => {
        x.master!.scan = { status: 'done', startedAt: rescan.startedAt, finishedAt: rescan.finishedAt, sourceSha256: x.source.sha256, engine: rescan.engine, durationMs: rescan.durationMs, recognizerCalls: rescan.recognizerCalls, found: proposal.found };
        delete x.master!.rescan;
      } });
      // The proposal file goes; crops nothing names any more (not a revision, not a creative) go with it.
      store.discard(id, rescan.file!);
      const keep = referencedFiles(id);
      for (const f of store.files(id, 'logo-')) if (!keep.has(f)) store.discard(id, f);
    } else fail('INVALID_REQUEST', 'Choose to use the new fonts or to replace everything.');
    return view(id);
  });
  /** Discards a finished or failed rescan: the master stays as it is. */
  const discardRescan = (id: string, expected: number) => locked(id, async () => {
    const t = requireMaster(id);
    if (expected !== t.revision) fail('STALE_REVISION', `This template changed since you opened it (revision ${t.revision}, yours ${expected}). Reload it and make your change again.`, { revision: t.revision });
    if (rescanning.has(id)) fail('RESCAN_RUNNING', 'The new scan is still running; discard it when it has finished.');
    const file = t.master.rescan?.file;
    await service.updateMaster(id, expected, x => { delete x.master!.rescan; });
    if (file) dropProposal(id, file);
    return view(id);
  });

  /**
   * The administrator's review: the whole list of words, groups, logo slots and plates. A word or slot whose region does
   * not exist (added by hand) gets one. Categories are kept on groups and slots; plates are checked here.
   */
  const saveReview = (id: string, expected: number, input: { expectedAnalysisRevision?: unknown; words?: unknown; groups?: unknown; logoSlots?: unknown; plates?: unknown }) => locked(id, async () => {
    const t = requireMaster(id), current = t.textAnalysis ?? fail('NO_TEXT_ANALYSIS', 'The scan has not finished yet.');
    if (expected !== t.revision) fail('STALE_REVISION', `This template changed since you opened it (revision ${t.revision}, yours ${expected}). Reload it and make your change again.`, { revision: t.revision });
    if (input.expectedAnalysisRevision !== undefined && input.expectedAnalysisRevision !== current.revision) fail('STALE_REVISION', 'The elements changed since you opened them. Reload and make your change again.');
    const size = { width: t.source.width, height: t.source.height }, at = nowIso();
    // Hand-made words and slots get a region of their own (regions are re-derived from the content when preparing).
    const elements = [...t.elements], words = Array.isArray(input.words) ? input.words as Record<string, unknown>[] : fail('INVALID_TEXT_ANALYSIS', 'Send the words.');
    const groups = Array.isArray(input.groups) ? input.groups as Record<string, unknown>[] : fail('INVALID_TEXT_ANALYSIS', 'Send the groups.');
    const slots = Array.isArray(input.logoSlots) ? input.logoSlots as Record<string, unknown>[] : fail('INVALID_TEXT_ANALYSIS', 'Send the logo slots.');
    const regionFor = (kind: ProtectedElement['kind'], box: SourceBox, label: string) => {
      const e: ProtectedElement = { id: hexId('pe'), kind, label: label.slice(0, 120) || 'Added', box: { ...box }, normalized: normalizeBox(box, size), zIndex: Math.max(-1, ...elements.map(x => x.zIndex)) + 1, representation: 'raster',
        mask: { mode: 'difference', threshold: 24 }, locked: false, replaceable: true, origin: 'admin', note: 'review:added', review: { status: 'approved', at } };
      elements.push(e); return e.id;
    };
    const known = new Set(elements.map(e => e.id));
    for (const g of groups) if (!known.has(g.elementId as string)) {
      const members = words.filter(w => w.groupId === g.id), box = members[0]?.box as SourceBox | undefined;
      g.elementId = regionFor(g.category === 'legal' ? 'legal' : 'text', box ?? { x: 0, y: 0, width: 10, height: 10, rotation: 0 }, String(g.label ?? 'Text')); known.add(g.elementId as string);
    }
    for (const w of words) if (!known.has(w.elementId as string)) w.elementId = groups.find(g => g.id === w.groupId)?.elementId ?? w.elementId;
    for (const l of slots) if (!known.has(l.elementId as string)) { l.elementId = regionFor('logo', l.box as SourceBox, String(l.label ?? 'Logo')); known.add(l.elementId as string); }
    const withRegions = { ...t, elements };
    const { next, recut } = correctAnalysis(withRegions, current, { words, groups, logoSlots: slots }, at);
    // Categories (groups and slots) and plates: checked here, kept on the analysis.
    const categoryOf = (list: Record<string, unknown>[], id: string) => { const c = list.find(x => x.id === id)?.category; return isMasterCategory(c) ? c : undefined; };
    const nextGroups = next.groups.map(g => ({ ...g, ...(categoryOf(groups, g.id) ? { category: categoryOf(groups, g.id) } : current.groups.find(o => o.id === g.id)?.category ? { category: current.groups.find(o => o.id === g.id)!.category } : {}) }));
    const nextSlots = next.logoSlots.map(l => ({ ...l, ...(categoryOf(slots, l.id) ? { category: categoryOf(slots, l.id) } : current.logoSlots.find(o => o.id === l.id)?.category ? { category: current.logoSlots.find(o => o.id === l.id)!.category } : { category: 'graphic' as const }) }));
    const plates = cleanPlates(input.plates, current.plates ?? [], nextGroups.map(g => g.id), size, at);
    const written: string[] = [];
    for (const slotId of recut) {
      const slot = nextSlots.find(l => l.id === slotId)!, rect = { x: Math.max(0, Math.floor(slot.box.x)), y: Math.max(0, Math.floor(slot.box.y)), width: 0, height: 0 };
      rect.width = Math.min(size.width, Math.ceil(slot.box.x + slot.box.width)) - rect.x; rect.height = Math.min(size.height, Math.ceil(slot.box.y + slot.box.height)) - rect.y;
      if (rect.width < 2 || rect.height < 2) fail('INVALID_TEXT_ANALYSIS', `${slot.label}: its box must lie on the image.`);
      const png = await sharp(store.read(id, t.source.inputFile)).rotate().extract({ left: rect.x, top: rect.y, width: rect.width, height: rect.height }).ensureAlpha().png({ compressionLevel: 9 }).toBuffer(), hash = sha256(png);
      const file = `logo-${slotId}-${short(hash)}.png`;
      store.write(id, file, png); written.push(file);
      slot.original = { file, sha256: hash, mime: 'image/png', width: rect.width, height: rect.height, bytes: png.length, hasAlpha: true, placement: rect };
    }
    const changedPlates = JSON.stringify(plates) !== JSON.stringify(current.plates ?? []), changedMeta = JSON.stringify([nextGroups.map(g => g.category), nextSlots.map(l => l.category)]) !== JSON.stringify([current.groups.map(g => g.category), current.logoSlots.map(l => l.category)]);
    const analysis: TextAnalysis = { ...next, groups: nextGroups, logoSlots: nextSlots, plates,
      ...(next === current && (changedPlates || changedMeta) ? { revision: current.revision + 1, updatedAt: at, history: withHistory(current.history, { at, action: 'corrected', detail: 'Categories or text plates changed.' }) } : {}) };
    // Regions follow the content: each group's and slot's region covers what it holds.
    const derived = deriveRegions(elements, analysis, size);
    return service.setMasterPrepared(id, expected, { elements: derived.elements, analysis: derived.analysis }).then(() => view(id));
  });
  function cleanPlates(input: unknown, old: TextPlate[], groupIds: string[], size: { width: number; height: number }, at: string): TextPlate[] {
    if (input === undefined) return old;
    if (!Array.isArray(input) || input.length > 60) fail('INVALID_TEXT_ANALYSIS', 'Send at most 60 text plates.');
    const hex = (v: unknown) => typeof v === 'string' && /^#[\da-f]{6}$/i.test(v), num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
    return (input as Partial<TextPlate>[]).map(p => {
      const b = p.box;
      if (!validPlateId(p.id) || !groupIds.includes(p.groupId as string) || !b || ![b.x, b.y, b.width, b.height, b.rotation].every(num) || b.width < 2 || b.height < 2 || !hex(p.fill) || !num(p.radius) || p.radius! < 0
        || (p.stroke !== null && (!p.stroke || !hex(p.stroke.color) || !num(p.stroke.width) || p.stroke.width < 0 || p.stroke.width > 60)) || !['needs-review', 'approved', 'rejected'].includes(p.review?.status as string)) fail('INVALID_TEXT_ANALYSIS', 'A text plate is malformed.');
      const prev = old.find(o => o.id === p.id), box = { x: b.x, y: b.y, width: b.width, height: b.height, rotation: b.rotation };
      return { id: p.id!, groupId: p.groupId!, box, normalized: normalizeBox(box, size), fill: p.fill!.toLowerCase(), stroke: p.stroke ? { color: p.stroke.color.toLowerCase(), width: p.stroke.width } : null, radius: Math.min(p.radius!, Math.min(b.width, b.height) / 2),
        confidence: prev?.confidence ?? 1, review: p.review!.status === 'needs-review' ? { status: 'needs-review' as const } : { status: p.review!.status as 'approved' | 'rejected', at: prev?.review.status === p.review!.status ? prev.review.at ?? at : at } };
    });
  }
  /** Every region covers what it holds now (a moved word, an added logo); regions holding nothing are left out. */
  function deriveRegions(elements: ProtectedElement[], analysis: TextAnalysis, size: { width: number; height: number }): { elements: ProtectedElement[]; analysis: TextAnalysis } {
    const pad = (b: { x: number; y: number; width: number; height: number }, p: number): SourceBox => {
      const x = Math.max(0, b.x - p), y = Math.max(0, b.y - p);
      return { x, y, width: Math.min(size.width, b.x + b.width + p) - x, height: Math.min(size.height, b.y + b.height + p) - y, rotation: 0 };
    };
    const union = (boxes: SourceBox[]) => { const x0 = Math.min(...boxes.map(b => b.x)), y0 = Math.min(...boxes.map(b => b.y)), x1 = Math.max(...boxes.map(b => b.x + b.width)), y1 = Math.max(...boxes.map(b => b.y + b.height)); return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }; };
    const out: ProtectedElement[] = [];
    for (const e of elements) {
      const words = analysis.words.filter(w => w.elementId === e.id && w.review.status !== 'rejected'), slots = analysis.logoSlots.filter(l => l.elementId === e.id && l.review.status !== 'rejected');
      const plates = (analysis.plates ?? []).filter(p => p.review.status !== 'rejected' && analysis.groups.some(g => g.id === p.groupId && g.elementId === e.id));
      const boxes = [...words.map(w => w.box), ...slots.map(l => l.box), ...plates.map(p => p.box)];
      if (!boxes.length) continue;
      const box = pad(union(boxes), slots.length && !words.length ? 4 : 6);
      out.push({ ...e, box, normalized: normalizeBox(box, size), review: { status: 'approved', at: e.review.at ?? nowIso() } });
    }
    return { elements: out.map((e, i) => ({ ...e, zIndex: i })), analysis: { ...analysis, words: analysis.words.filter(w => out.some(e => e.id === w.elementId) || w.review.status === 'rejected').map(w => out.some(e => e.id === w.elementId) ? w : { ...w, elementId: out[0]?.id ?? w.elementId }) } };
  }
  /** Approves every item still waiting for review; uncertain ones only with `includeUncertain`. */
  const approveAll = (id: string, expected: number, includeUncertain: boolean) => locked(id, async () => {
    const t = requireMaster(id), a = t.textAnalysis ?? fail('NO_TEXT_ANALYSIS', 'The scan has not finished yet.'), at = nowIso();
    if (expected !== t.revision) fail('STALE_REVISION', `This template changed since you opened it (revision ${t.revision}, yours ${expected}).`, { revision: t.revision });
    const ok = (status: string, confident: boolean) => status === 'needs-review' && (confident || includeUncertain);
    let n = 0;
    const words = a.words.map(w => ok(w.review.status, w.confidence >= LOW_WORD_CONFIDENCE) ? (n++, { ...w, review: { status: 'approved' as const, at } }) : w);
    const logoSlots = a.logoSlots.map(l => ok(l.review.status, l.confidence >= 0.6) ? (n++, { ...l, review: { status: 'approved' as const, at } }) : l);
    const plates = (a.plates ?? []).map(p => ok(p.review.status, p.confidence >= 0.6) ? (n++, { ...p, review: { status: 'approved' as const, at } }) : p);
    if (!n) return view(id);
    const analysis: TextAnalysis = { ...a, words, logoSlots, plates, revision: a.revision + 1, updatedAt: at, history: withHistory(a.history, { at, action: 'approved', detail: `${n} element(s) approved together${includeUncertain ? ', uncertain ones included' : ''}.` }) };
    await service.setMasterPrepared(id, expected, { elements: t.elements, analysis });
    return view(id);
  });

  /** The removal (what the clean background leaves out) of the reviewed content: text ink by line, plates and logo slots. */
  async function removalOf(t: ProtectedTemplate, source: Awaited<ReturnType<typeof decodeRgba>>) {
    const a = t.textAnalysis!, lines: { box: { x: number; y: number; width: number; height: number }; ink: string; lineHeight: number }[] = [];
    for (const g of a.groups) for (const l of g.lines) {
      const words = l.wordIds.map(id => a.words.find(w => w.id === id)).filter((w): w is NonNullable<typeof w> => !!w && w.review.status !== 'rejected');
      if (!words.length) continue;
      const x0 = Math.min(...words.map(w => w.box.x)), y0 = Math.min(...words.map(w => w.box.y)), x1 = Math.max(...words.map(w => w.box.x + w.box.width)), y1 = Math.max(...words.map(w => w.box.y + w.box.height));
      const h = Math.max(...words.map(w => w.box.height)), ink = words[0].style.color, box = extendLineToInk(source, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, h, ink);
      lines.push({ box, ink, lineHeight: h });
    }
    const plates = (a.plates ?? []).filter(p => p.review.status !== 'rejected').map(p => ({ box: p.box, strokeWidth: p.stroke?.width ?? 0 }));
    const logos = a.logoSlots.filter(l => l.review.status !== 'rejected').map(l => ({ box: l.box, ...(l.category ? { category: l.category } : {}) }));
    return removalMask(source, { lines, plates, logos });
  }
  /**
   * What making the clean background would remove now, tinted over the poster (at most 1400 px wide): checked before
   * cleaning, so text the scan missed (left untinted, it would show behind new text) is added first.
   */
  async function removalPreview(id: string): Promise<Buffer> {
    const t = requireMaster(id), a = t.textAnalysis ?? fail('NO_TEXT_ANALYSIS', 'The scan has not finished yet.');
    const source = await decodeRgba(store.read(id, t.source.inputFile)), size = { width: t.source.width, height: t.source.height };
    const mask = await removalOf({ ...t, ...deriveRegions(t.elements, a, size) }, source), overlay = Buffer.alloc(size.width * size.height * 4);
    for (let i = 0; i < mask.length; i++) if (mask[i]) { overlay[i * 4] = 236; overlay[i * 4 + 1] = 72; overlay[i * 4 + 2] = 153; overlay[i * 4 + 3] = 165; }
    const png = await sharp(source.data, { raw: { width: size.width, height: size.height, channels: 4 } }).composite([{ input: overlay, raw: { width: size.width, height: size.height, channels: 4 }, left: 0, top: 0 }]).png().toBuffer();
    return sharp(png).resize({ width: Math.min(1400, size.width) }).png().toBuffer();
  }
  /**
   * The clean background, made here (always an estimate, reviewed and approved explicitly): the regions follow the reviewed
   * content first. Nothing leaves this machine.
   */
  const prepare = (id: string, expected: number) => locked(id, async () => {
    const t = requireMaster(id), a = t.textAnalysis ?? fail('NO_TEXT_ANALYSIS', 'The scan has not finished yet.');
    if (expected !== t.revision) fail('STALE_REVISION', `This template changed since you opened it (revision ${t.revision}, yours ${expected}).`, { revision: t.revision });
    if (!analysisReviewed(a)) fail('REVIEW_REQUIRED', 'Review the detected elements first (approve or reject each one; "Approve all" does it in one step).');
    const started = Date.now(), source = await decodeRgba(store.read(id, t.source.inputFile)), size = { width: t.source.width, height: t.source.height };
    const derived = deriveRegions(t.elements, a, size), clean = await cleanBackground(source, await removalOf({ ...t, ...derived }, source));
    await service.setMasterPrepared(id, expected, { elements: derived.elements, analysis: derived.analysis, base: { png: clean.png, maskPng: clean.maskPng, previewPng: clean.previewPng, regions: clean.regions, filledPercent: clean.filledPercent }, master: x => {
      x.master!.cleanup = { version: MASTER_CLEANUP_VERSION, baseSha256: x.base!.sha256, areas: clean.areas.map(ar => ({ box: ar.box, method: ar.method, trusted: ar.trusted, detail: ar.detail })), trustedPercent: clean.trustedPercent, filledPercent: clean.filledPercent, durationMs: Date.now() - started };
      // A new background: Seedream's layers of the old one no longer apply.
      x.master!.artwork = { mode: 'background', decidedAt: nowIso() };
    } });
    return view(id);
  });
  /** A clean background the administrator has (the artwork before text and logos), checked against the source. */
  const uploadBackground = (id: string, expected: number, bytes: Buffer, filename?: string) => locked(id, async () => {
    const t = requireMaster(id), a = t.textAnalysis ?? fail('NO_TEXT_ANALYSIS', 'The scan has not finished yet.');
    if (!analysisReviewed(a)) fail('REVIEW_REQUIRED', 'Review the detected elements first.');
    const derived = deriveRegions(t.elements, a, t.source);
    const prepared = await service.setMasterPrepared(id, expected, { elements: derived.elements, analysis: derived.analysis });
    await service.uploadBase(id, prepared.revision, bytes, 'clean-upload', filename);
    await service.updateMaster(id, undefined, x => { delete x.master!.cleanup; x.master!.artwork = { mode: 'background', decidedAt: nowIso() }; });
    return view(id);
  });
  const approveBackground = async (id: string, expected: number, acknowledgeEstimate: boolean) => { requireMaster(id); await service.approveBase(id, expected, acknowledgeEstimate); return view(id); };
  /** The artwork creatives use: the clean background as one picture, or a finished Seedream decomposition of it. */
  const chooseArtwork = (id: string, expected: number, input: { mode: unknown; runId?: unknown }) => locked(id, async () => {
    const t = requireMaster(id);
    if (input.mode === 'background') return service.updateMaster(id, expected, x => { x.master!.artwork = { mode: 'background', decidedAt: nowIso() }; }).then(() => view(id));
    if (input.mode !== 'seedream' || typeof input.runId !== 'string' || !validRunId(input.runId) || !t.runs.some(r => r.runId === input.runId)) fail('INVALID_REQUEST', 'Choose the background, or one of this master\'s decomposition runs.');
    const s = service.runSummary(id, input.runId as string);
    if (!s?.usable || !s.current) fail('NOT_READY', 'That decomposition has no usable layers of the current background.');
    return service.updateMaster(id, expected, x => { x.master!.artwork = { mode: 'seedream', runId: input.runId as string, decidedAt: nowIso() }; }).then(() => view(id));
  });

  /** A published revision: everything a creative reads, written once. */
  const publish = (id: string, expected: number) => locked(id, async () => {
    const t = requireMaster(id), v = service.view(id), a = t.textAnalysis ?? fail('NO_TEXT_ANALYSIS', 'The scan has not finished yet.');
    if (expected !== t.revision) fail('STALE_REVISION', `This template changed since you opened it (revision ${t.revision}, yours ${expected}).`, { revision: t.revision });
    if (!analysisReviewed(a)) fail('REVIEW_REQUIRED', 'Review the detected elements first.');
    if (!t.base || v.stale.base) fail('BASE_NOT_READY', 'Prepare the clean background for the reviewed elements first.');
    if (!t.base.approval) fail('BASE_NOT_READY', 'Approve the clean background first.');
    const latest = t.master.revisions[t.master.revisions.length - 1];
    if (latest && !stageOf(t, v).changed) return view(id);
    const layers: MasterArtworkLayer[] = [];
    let decomposition: MasterSnapshot['decomposition'] = null;
    if (t.master.artwork.mode === 'seedream') {
      if (!artworkRunUsable(t)) fail('NOT_READY', 'The chosen decomposition is not usable for the current background. Choose the background, or decompose it again.');
      const runId = t.master.artwork.runId!, dir = join(options.runsDir, runId), run = readRun(dir), canvas = run.canvas!;
      for (const layer of runEditorLayers(run)) {
        const bytes = readFileSync(join(dir, layer.file)), hash = sha256(bytes), file = `art-${short(hash)}.png`;
        if (!store.has(id, file)) store.write(id, file, bytes);
        const p = layer.placement as { x: number; y: number; width: number; height: number }, b = mapBox({ x: p.x, y: p.y, width: p.width, height: p.height, rotation: 0 }, canvas, t.source);
        layers.push({ id: `layer-${layers.length}`, name: layer.name || `Layer ${layers.length + 1}`, file, sha256: hash, x: b.x, y: b.y, width: b.width, height: b.height, zIndex: layers.length });
      }
      decomposition = { runId, layers: layers.length };
    }
    const revision = (latest?.revision ?? 0) + 1, at = nowIso();
    const snapshot: MasterSnapshot = { schemaVersion: MASTER_SCHEMA_VERSION, masterId: id, revision, publishedAt: at, name: t.name, canvas: { width: t.source.width, height: t.source.height },
      source: { file: t.source.inputFile, sha256: t.source.sha256 },
      background: { file: t.base.file, sha256: t.base.sha256, width: t.base.width, height: t.base.height, method: t.base.method, reliability: t.base.reliability, acknowledgedEstimate: !!t.base.approval.acknowledgedUncertain,
        ...(t.base.method === 'local-fill' ? { cleanupVersion: t.master.cleanup?.baseSha256 === t.base.sha256 ? t.master.cleanup.version ?? 1 : 1 } : {}) },
      layers, decomposition, words: a.words, groups: a.groups, logoSlots: a.logoSlots, plates: a.plates ?? [], analysisRevision: a.revision };
    const bytes = Buffer.from(JSON.stringify(snapshot, null, 2)), file = `master-r${revision}.json`;
    store.write(id, file, bytes);
    await service.updateMaster(id, expected, x => { x.master!.revisions.push({ revision, publishedAt: at, file, sha256: sha256(bytes), analysisRevision: a.revision, baseSha256: t.base!.sha256, runId: decomposition?.runId ?? null }); });
    return view(id);
  });

  // --- Phase 2: creatives ----------------------------------------------------------------------------------------------
  function listCreatives(id: string): CreativeSummary[] {
    requireMaster(id);
    return creatives(id).map(f => JSON.parse(store.read(id, f).toString('utf8')) as CreativeInstance)
      .map(c => ({ id: c.id, name: c.name, masterRevision: c.masterRevision, createdAt: c.createdAt, updatedAt: c.updatedAt, revision: c.revision, texts: c.texts.filter(t => !t.hidden).length, images: c.images.filter(i => !i.hidden).length, editorSavedAt: c.editor?.savedAt ?? null }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  /** A new creative from a published revision (the latest by default). Reads the snapshot only. */
  const createCreative = (id: string, input: { name?: unknown; revision?: unknown }) => locked(`${id}:creatives`, async () => {
    const t = requireMaster(id), latest = t.master.revisions[t.master.revisions.length - 1] ?? fail('NOT_READY', 'Publish the master first ("Save master").');
    const revision = typeof input.revision === 'number' ? input.revision : latest.revision, snapshot = readSnapshot(id, revision);
    if (creatives(id).length >= 500) fail('TOO_MANY', 'This master has 500 creatives; remove some first.');
    const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, CREATIVE_LIMITS.maxName) : `${t.name} · creative ${creatives(id).length + 1}`;
    const creative = creativeFromSnapshot(snapshot, { id: hexId('cr', 6), name, at: nowIso(), newId: p => hexId(p) });
    store.write(id, creativeFile(creative.id), Buffer.from(JSON.stringify(creative, null, 2)));
    return creative;
  });
  const getCreative = (id: string, cid: string) => { requireMaster(id); return readCreative(id, cid); };
  /** Saves a creative's elements (from the content panel or the editor). Its master is read, never written. */
  const saveCreative = (id: string, cid: string, input: { expectedRevision?: unknown; creative?: unknown; from?: unknown; designId?: unknown }) => locked(`${id}:${cid}`, async () => {
    requireMaster(id);
    const old = readCreative(id, cid);
    if (input.expectedRevision !== old.revision) fail('STALE_REVISION', `This creative changed since you opened it (revision ${old.revision}, yours ${String(input.expectedRevision)}). Reload it and make your change again.`, { revision: old.revision });
    const snapshot = readSnapshot(id, old.masterRevision), at = nowIso(), next = cleanCreative(input.creative, old, snapshot, id);
    const from = input.from === 'editor' ? 'editor' : 'content', designId = typeof input.designId === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(input.designId) ? input.designId : undefined;
    const event: CreativeEvent = { at, action: from === 'editor' ? 'saved-from-editor' : 'edited' };
    const saved: CreativeInstance = { ...next, revision: old.revision + 1, updatedAt: at, ...(from === 'editor' && designId ? { editor: { designId, savedAt: at } } : {}), history: [...old.history, event].slice(-CREATIVE_LIMITS.maxHistory) };
    // Uploaded pictures stay stored while the creative exists (an open editor or another tab may still refer to one).
    store.write(id, creativeFile(cid), Buffer.from(JSON.stringify(saved, null, 2)));
    return saved;
  });
  function cleanCreative(input: unknown, old: CreativeInstance, snapshot: MasterSnapshot, id: string): CreativeInstance {
    const c = input as Partial<CreativeInstance>;
    if (!c || typeof c !== 'object' || !Array.isArray(c.texts) || !Array.isArray(c.images) || !Array.isArray(c.shapes) || !Array.isArray(c.groups)) fail('INVALID_CREATIVE', 'Send the creative\'s groups, texts, images and shapes.');
    if (c.texts.length > CREATIVE_LIMITS.maxTexts || c.images.length > CREATIVE_LIMITS.maxImages || c.shapes.length > CREATIVE_LIMITS.maxShapes || c.groups.length > CREATIVE_LIMITS.maxGroups) fail('INVALID_CREATIVE', 'Too many elements in one creative.');
    const num = (v: unknown, min = -1e5, max = 1e5) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max, hex = (v: unknown) => typeof v === 'string' && /^#[\da-f]{6}$/i.test(v);
    const box = (b: unknown, what: string): SourceBox => { const x = b as SourceBox; if (!x || ![x.x, x.y].every(v => num(v)) || !num(x.width, 1) || !num(x.height, 1) || !num(x.rotation, -360, 360)) fail('INVALID_CREATIVE', `${what}: its box is not valid.`); return { x: x.x, y: x.y, width: x.width, height: x.height, rotation: x.rotation }; };
    const ids = new Set<string>();
    const unique = (v: unknown, what: string) => { if (!validCreativeElementId(v) || ids.has(v as string)) fail('INVALID_CREATIVE', `${what}: its id is missing or used twice.`); ids.add(v as string); return v as string; };
    const groups = c.groups.map(g => {
      if (!g || typeof g.id !== 'string' || !/^(pg|cg)-[a-f0-9]{10}$/.test(g.id) || typeof g.label !== 'string' || g.label.length > 200 || !isMasterCategory(g.category) || !['left', 'center', 'right'].includes(g.align as string)) fail('INVALID_CREATIVE', 'A text group is malformed.');
      return { id: g.id, label: g.label.slice(0, 200), category: g.category, masterGroupId: snapshot.groups.some(x => x.id === g.masterGroupId) ? g.masterGroupId! : null, align: g.align as 'left' | 'center' | 'right' };
    });
    const groupIds = new Set(groups.map(g => g.id));
    const masterWords = new Set(snapshot.words.map(w => w.id)), masterSlots = new Set(snapshot.logoSlots.map(l => l.id)), masterPlates = new Set(snapshot.plates.map(p => p.id));
    const masterFiles = new Set(snapshot.logoSlots.flatMap(l => [l.original.file, l.replacement?.file]).filter((f): f is string => !!f));
    const texts: CreativeText[] = c.texts.map((t, k) => {
      const what = `Text ${k + 1}`, s = t?.style;
      if (!t || typeof t.text !== 'string' || t.text.length > CREATIVE_LIMITS.maxText || /[\n\r]/.test(t.text)) fail('INVALID_CREATIVE', `${what}: one line of text, up to ${CREATIVE_LIMITS.maxText} characters.`);
      if (!groupIds.has(t.groupId)) fail('INVALID_CREATIVE', `${what}: its group does not exist.`);
      if (!s || !isOfferFont(s.fontFamily) || !offerWeights(s.fontFamily).includes(s.fontWeight) || !['normal', 'italic'].includes(s.fontStyle) || !num(s.fontSize, 1, 4096) || !num(s.letterSpacing, -400, 400) || !hex(s.color) || !num(s.opacity, 0, 1))
        fail('INVALID_CREATIVE', `${what} (“${t.text.slice(0, 30)}”): its style is not valid (fonts must be offer fonts, in a weight they have).`);
      if (![t.x, t.baselineY].every(v => num(v)) || !num(t.rotation, -360, 360) || !num(t.line, 0, 200) || !num(t.order, 0, 10000) || !num(t.z, 0, 100000)) fail('INVALID_CREATIVE', `${what}: its position is not valid.`);
      return { id: unique(t.id, what), wordId: t.wordId && masterWords.has(t.wordId) ? t.wordId : null, groupId: t.groupId, line: Math.round(t.line), order: Math.round(t.order), text: t.text, x: t.x, baselineY: t.baselineY, rotation: t.rotation,
        style: { fontFamily: s.fontFamily, fontWeight: s.fontWeight, fontStyle: s.fontStyle, fontSize: s.fontSize, letterSpacing: s.letterSpacing, color: s.color.toLowerCase(), opacity: s.opacity }, hidden: t.hidden === true, locked: t.locked === true, z: t.z };
    });
    const images: CreativeImage[] = c.images.map((i, k) => {
      const what = `Picture ${k + 1}`;
      if (!i || typeof i.label !== 'string' || i.label.length > 200 || !isMasterCategory(i.category) || !num(i.z, 0, 100000)) fail('INVALID_CREATIVE', `${what} is malformed.`);
      const a = i.asset as CreativeAsset;
      let asset: CreativeAsset;
      if (a?.kind === 'master' && masterFiles.has(a.file)) asset = { kind: 'master', file: a.file };
      else if (a?.kind === 'creative' && typeof a.file === 'string' && a.file.startsWith(`cra-${old.id.slice(3)}-`) && store.has(id, a.file)) asset = { kind: 'creative', file: a.file, sha256: sha256(store.read(id, a.file)), width: a.width, height: a.height, ...(a.originalName ? { originalName: String(a.originalName).slice(0, 200) } : {}) };
      else fail('INVALID_CREATIVE', `${what} (${i.label}): its picture is not one of this master's or this creative's stored files.`);
      return { id: unique(i.id, what), slotId: i.slotId && masterSlots.has(i.slotId) ? i.slotId : null, category: i.category, label: i.label, box: box(i.box, what), asset, hidden: i.hidden === true, locked: i.locked === true, z: i.z,
        ...(i.artwork === true && old.images.some(o => o.id === i.id && o.artwork) ? { artwork: true as const } : {}) };
    });
    const shapes: CreativeShape[] = c.shapes.map((s, k) => {
      const what = `Shape ${k + 1}`;
      if (!s || !hex(s.fill) || !num(s.radius, 0, 4096) || !groupIds.has(s.groupId) || !num(s.z, 0, 100000) || (s.stroke !== null && (!s.stroke || !hex(s.stroke.color) || !num(s.stroke.width, 0, 60)))) fail('INVALID_CREATIVE', `${what} is malformed.`);
      return { id: unique(s.id, what), plateId: s.plateId && masterPlates.has(s.plateId) ? s.plateId : null, groupId: s.groupId, box: box(s.box, what), fill: s.fill.toLowerCase(), stroke: s.stroke ? { color: s.stroke.color.toLowerCase(), width: s.stroke.width } : null, radius: s.radius, hidden: s.hidden === true, z: s.z };
    });
    const name = typeof c.name === 'string' && c.name.trim() ? c.name.trim().slice(0, CREATIVE_LIMITS.maxName) : old.name;
    if (old.backgroundColor && c.backgroundColor !== undefined && !hex(c.backgroundColor)) fail('INVALID_CREATIVE', 'Choose a valid background colour.');
    return { ...old, schemaVersion: CREATIVE_SCHEMA_VERSION, name, groups, texts, images, shapes, ...(old.backgroundColor && c.backgroundColor ? { backgroundColor: c.backgroundColor.toLowerCase() } : {}) };
  }
  /**
   * A creative moved to the newest published revision when only the background changed between the two (the same words,
   * logo slots and plates): a repaired clean background reaches it without touching its content. An AI style variation's
   * artwork is made again from the new background with its own tint (its recipe), locally. Explicit only: the creative's
   * revision goes up, its earlier files stay, and a newer revision that changes text or logos is refused (the creative
   * would lose or duplicate content); make a new creative from it instead.
   */
  const rebaseCreative = (id: string, cid: string, input: { expectedRevision?: unknown }) => locked(`${id}:${cid}`, async () => {
    const t = requireMaster(id), old = readCreative(id, cid);
    if (input.expectedRevision !== old.revision) fail('STALE_REVISION', `This creative changed since you opened it (revision ${old.revision}, yours ${String(input.expectedRevision)}). Reload it and try again.`, { revision: old.revision });
    const latest = t.master.revisions[t.master.revisions.length - 1] ?? fail('NOT_READY', 'Publish the master first ("Save master").');
    if (latest.revision === old.masterRevision) return old;
    const from = readSnapshot(id, old.masterRevision), to = readSnapshot(id, latest.revision);
    const live = <T extends { review: { status: string } }>(x: T[]) => x.filter(e => e.review.status !== 'rejected');
    const words = (s: MasterSnapshot) => live(s.words).map(w => `${w.id}:${w.text}`).sort().join('|'), slots = (s: MasterSnapshot) => live(s.logoSlots).map(l => `${l.id}:${l.replacement?.file ?? l.original.file}`).sort().join('|');
    const plates = (s: MasterSnapshot) => live(s.plates).map(p => p.id).sort().join('|');
    if (words(from) !== words(to) || slots(from) !== slots(to) || plates(from) !== plates(to)) fail('NOT_BACKGROUND_ONLY', `Revision ${to.revision} changes the template's text, logos or shapes, not only its background. Make a new creative from it instead; this creative stays as it is.`);
    let images = old.images;
    const art = old.images.findIndex(i => i.artwork);
    if (old.origin.kind === 'ai' && art >= 0 && old.generation) {
      const recipe = store.has(id, old.generation.recipeFile) ? JSON.parse(store.read(id, old.generation.recipeFile).toString('utf8')) as { plan?: { variations?: { field?: string }[] } } : null;
      const bytes = store.read(id, to.background.file), info = await analyseArtwork(bytes, to), tint = recipe?.plan?.variations?.[old.origin.index]?.field ?? info.grounds[0]?.color ?? '#ffffff';
      const made = await deriveArtwork(bytes, info, old.canvas, 'center', tint, 'contain'), hash = sha256(made.png), file = `cra-${cid.slice(3)}-art-${short(hash)}.png`;
      if (!store.has(id, file)) store.write(id, file, made.png);
      images = old.images.map((im, i) => i === art ? { ...im, box: { ...made.box, rotation: 0 }, asset: { kind: 'creative' as const, file, sha256: hash, width: made.box.width, height: made.box.height, originalName: made.recoloured ? 'Template artwork (recoloured)' : 'Template artwork' } } : im);
    }
    const at = nowIso(), next: CreativeInstance = { ...old, masterRevision: to.revision, images, revision: old.revision + 1, updatedAt: at,
      history: [...old.history, { at, action: 'edited' as const, detail: `Background updated from master revision ${old.masterRevision} to ${to.revision} (only the background changed).` }].slice(-CREATIVE_LIMITS.maxHistory) };
    store.write(id, creativeFile(cid), Buffer.from(JSON.stringify(next, null, 2)));
    return next;
  });
  /**
   * A creative sent to decomposition: an ordinary decomposition run built from its own layers (creativeRun.ts), locally and
   * free. One run per creative revision: asking again (a double click, a retry, a reload) returns the same run; a later
   * revision gets its own. The creative and the master are only read.
   */
  const decomposeCreative = (id: string, cid: string) => locked(`${id}:${cid}:decomposition`, async () => {
    requireMaster(id);
    const c = readCreative(id, cid), existing = existingCreativeRun(options.runsDir, id, c);
    if (existing) return { runId: existing.id, created: false };
    const run = await createCreativeRun(options.runsDir, store, readSnapshot(id, c.masterRevision), c);
    return { runId: run.id, created: true };
  });
  /** A picture for a creative (a new bank logo, a QR code, a badge), stored byte for byte; an element then refers to it. */
  const uploadCreativeAsset = async (id: string, cid: string, bytes: Buffer, filename?: string) => {
    requireMaster(id); readCreative(id, cid);
    let img;
    try { img = await ingestImage(bytes, 'picture'); } catch (error) { if (error instanceof ProtectedImageError) fail(error.code === 'UPLOAD_TOO_LARGE' ? 'UPLOAD_TOO_LARGE' : error.code, error.message); throw error; }
    if (img.orientationNormalized) fail('UNSUPPORTED_IMAGE', 'Upload the picture without an EXIF rotation, so its pixels are used exactly as stored.');
    const file = `cra-${cid.slice(3)}-${short(img.sha256)}.${img.ext}`;
    store.write(id, file, bytes);
    const asset: CreativeAsset = { kind: 'creative', file, sha256: img.sha256, width: img.width, height: img.height, ...(filename ? { originalName: filename.slice(0, 200) } : {}) };
    return { asset, hasAlpha: img.hasAlpha };
  };
  const duplicateCreative = (id: string, cid: string, name?: unknown) => locked(`${id}:creatives`, async () => {
    requireMaster(id);
    const old = readCreative(id, cid), at = nowIso(), copyId = hexId('cr', 6);
    const copyFile = (f: string) => { const next = f.replace(`cra-${cid.slice(3)}-`, `cra-${copyId.slice(3)}-`); if (!store.has(id, next)) store.write(id, next, store.read(id, f)); return next; };
    const copy: CreativeInstance = { ...old, id: copyId, name: typeof name === 'string' && name.trim() ? name.trim().slice(0, CREATIVE_LIMITS.maxName) : `${old.name} (copy)`.slice(0, CREATIVE_LIMITS.maxName), createdAt: at, updatedAt: at, revision: 1,
      images: old.images.map(i => i.asset.kind === 'creative' ? { ...i, asset: { ...i.asset, file: copyFile(i.asset.file) } } : i), origin: { kind: 'duplicate', creativeId: cid }, editor: null, exports: [],
      history: [{ at, action: 'duplicated', detail: `Copy of ${old.name} (revision ${old.revision}).` }] };
    store.write(id, creativeFile(copyId), Buffer.from(JSON.stringify(copy, null, 2)));
    return copy;
  });
  const recordExport = (id: string, cid: string, input: { width?: unknown; height?: unknown }) => locked(`${id}:${cid}`, async () => {
    const c = readCreative(id, cid), at = nowIso();
    const width = Number(input.width), height = Number(input.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) fail('INVALID_REQUEST', 'Send the exported width and height.');
    const next: CreativeInstance = { ...c, exports: [...c.exports, { at, width, height }].slice(-50), history: [...c.history, { at, action: 'exported' as const, detail: `${width}×${height} PNG.` }].slice(-CREATIVE_LIMITS.maxHistory) };
    store.write(id, creativeFile(cid), Buffer.from(JSON.stringify(next, null, 2)));
    return next;
  });
  const deleteCreative = (id: string, cid: string) => locked(`${id}:${cid}`, async () => {
    requireMaster(id); readCreative(id, cid);
    for (const f of store.files(id, `cra-${cid.slice(3)}-`)) store.discard(id, f);
    store.discard(id, creativeFile(cid));
    return { deleted: cid };
  });
  const rename = async (id: string, expected: number, name: unknown) => { requireMaster(id); await service.setDetails(id, expected, { name }); return view(id); };

  return { create, startScan, startRescan, rescanResult, applyRescan, discardRescan, removalPreview, view, list, saveReview, approveAll, prepare, uploadBackground, approveBackground, chooseArtwork, publish, rename, readSnapshot,
    listCreatives, createCreative, getCreative, saveCreative, rebaseCreative, decomposeCreative, uploadCreativeAsset, duplicateCreative, recordExport, deleteCreative, isScanning: (id: string) => scanning.has(id) };
}
