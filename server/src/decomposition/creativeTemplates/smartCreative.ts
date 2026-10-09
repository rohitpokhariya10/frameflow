/**
 * Smart edits and "Generate creative template", on top of the creative template wizard:
 *
 *   analyze     the actual uploaded image → its validated scene (one call), bound to image sha256 + template version +
 *               analysis configuration; the same binding is answered from the saved scene with no call
 *   resolve     scene + the user's explicit edits (+ product photo) → a change plan: rules first, then (only when it can
 *               add something) one resolver call, validated; persisted and bound to the exact draft and photo
 *   generate    (service.ts) only from a ready, clear resolution whose binding the server checks again; the prompt is
 *               recompiled and must equal the persisted one
 *   verify      an optional AI vision check after generation: pass / fail / uncertain, never a silent pass
 *   variants    a validated mask → the subject's exact source pixels → N masked scene generations → composites;
 *               per-variant status, no automatic retry, and a chosen variant continues as a reviewed execution
 *
 * Every paid call is an explicit user action, counted on its own record. Nothing here retries a paid request.
 */
import { readFileSync } from 'node:fs';
import { toFile } from 'openai';
import { advertisedProducts, applySceneCorrections, basePlan, canonicalDraft, conceptScene, parseConcept, selectDiverseConcepts, VARIANT_RATIOS, cleanCorrections, cleanDraft, cleanScenePrompt, closestGenerationRatio, compileResolvedEdit, compileVariantPrompt, describeTemplateSlots, directionProblems,
  editStrategy, GENERATION_IMAGE_SIZES, holderOf, isForeground, parseResolverProposal, PLAN_RULES, sceneTarget, type ResolverProposal, lightingSentence, mapSceneToSlots, mergeResolution, needsResolver, planExpectations, protectedGroup, sanitizeEditInstruction, SCENE_SCHEMA_VERSION, sceneSimilarity, scenePromptProblems,
  SEMANTIC_NOTE, uncheckedVerification, VARIANT_LIMITS, variantExpectations, verificationStatus, type ChangePlan, type VariantRatio, type CreativeVariant, type ExecutionImage, type GenerationReview, type GenerationReviewCheck,
  type SceneDescription, type SemanticExpectation, type SemanticVerification, type TemplateExecution, type TemplateRole, type TemplateVersion, type VariantSet } from '@frameflow/shared';
import { imageFailureCode, imageFileType, responseWithoutImage, returnedImage, type ApiFailure, type GenerationConfig } from '../generationGroups.js';
import { referenceForPrompt, validateReferenceUpload } from '../imageTemplates.js';
import { RunError } from '../layerizeExperiment.js';
import type { ExecutionStore } from './executions.js';
import type { TemplateStore } from './store.js';
import type { ChangeResolver, ConceptWriter, SceneAnalyzer, SemanticVerifier } from './smartProviders.js';
import type { Segmenter } from './segmenter.js';
import { newRecordId, sha256, type ResolutionRecord, type SceneAnalysisRecord, type SceneStore, type VariantStore } from './smartStores.js';
import { checkMask, composeVariant, cutoutFiles, generationInputs, maskBox, maskPng, maskRaster, refineEdges, sourceRaster, splitMaskByBoxes, userCutoutMask, type PixelBox, type VariantSubject } from './variantCompose.js';
import { backgroundColour, canvasInputs, DEFAULT_COMPOSITION, groupBox, placeGroup, placeProducts, touchedEdges } from './variantLayout.js';

export type Upload = { bytes: Buffer; fileName?: string; mimeType?: string };
export interface SmartFeatures {
  smartEdit: { available: boolean; reason?: string; analysisModel?: string; resolverModel?: string };
  variants: { available: boolean; reason?: string; cutout?: string; maxVariants: number };
  verification: { available: boolean; reason?: string; model?: string };
}
export type SmartProviders = { analyzer?: () => SceneAnalyzer; resolver?: () => ChangeResolver; verifier?: () => SemanticVerifier; concepts?: () => ConceptWriter; segmenter?: () => Segmenter | undefined };
export type SmartServices = {
  scenes: SceneStore; variants: VariantStore; executions: ExecutionStore; templates: TemplateStore;
  generation: () => GenerationConfig; providers: SmartProviders; features: () => SmartFeatures;
  log?: (line: string) => void;
};
/**
 * Which features may run: each is on unless its flag is "0", and needs its providers configured (OpenAI for every model
 * call; fal, unless cutouts are uploaded, for masks). An unavailable feature says why instead of failing on use.
 */
export function readSmartFeatures(env: NodeJS.ProcessEnv, injected: { openai: boolean; fal: boolean; cutout: string; models: { analysis: string; resolver: string; verifier: string } }): SmartFeatures {
  const openai = injected.openai || !!env.OPENAI_API_KEY?.trim(), fal = injected.fal || !!env.FAL_KEY?.trim();
  const smart = env.CREATIVE_SMART_EDIT === '0' ? 'Turned off (CREATIVE_SMART_EDIT=0).' : !openai ? 'Image analysis is not configured: set OPENAI_API_KEY in server/.env.' : undefined;
  const variants = env.CREATIVE_VARIANTS === '0' ? 'Turned off (CREATIVE_VARIANTS=0).' : smart ? `Needs image analysis. ${smart}` : injected.cutout !== 'none' && !fal ? 'Subject cutouts are not configured: set FAL_KEY in server/.env, or set CREATIVE_CUTOUT_PROVIDER=none to upload cutouts.' : undefined;
  const verify = env.CREATIVE_SEMANTIC_VERIFY === '0' ? 'Turned off (CREATIVE_SEMANTIC_VERIFY=0).' : !openai ? 'Not configured: set OPENAI_API_KEY.' : undefined;
  return { smartEdit: { available: !smart, ...(smart ? { reason: smart } : { analysisModel: injected.models.analysis, resolverModel: injected.models.resolver }) },
    variants: { available: !variants, ...(variants ? { reason: variants } : {}), cutout: injected.cutout, maxVariants: VARIANT_LIMITS.max },
    verification: { available: !verify, ...(verify ? { reason: verify } : { model: injected.models.verifier }) } };
}
const ext = (format?: string) => format === 'jpeg' ? 'jpg' : format!;
const fail = (code: string, message: string) => new RunError(code, message);
const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
const errorCode = (error: unknown, fallback: string) => (error as { code?: unknown })?.code && typeof (error as { code: unknown }).code === 'string' && /^[A-Z_]+$/.test((error as { code: string }).code) ? (error as { code: string }).code : fallback;

export function createSmartCreative(services: SmartServices) {
  const { scenes, variants, executions, templates } = services, log = services.log ?? ((line: string) => console.info(line));
  const active = new Set<string>();
  /** Resolutions being made now, by their exact binding: a repeated request (two tabs, a retry) waits for the same one. */
  const resolving = new Map<string, Promise<{ resolution: ResolutionRecord; created: boolean }>>();
  let line: Promise<unknown> = Promise.resolve();
  /** Paid work runs one item at a time, in the order asked; `active` tells live work from work a restart left behind. */
  const schedule = (id: string, work: () => Promise<unknown>) => { active.add(id); line = line.then(work).catch(error => console.error('[SMART]', id, error)).finally(() => active.delete(id)); };
  const analyzer = () => { const f = services.features().smartEdit; if (!f.available) throw fail('SMART_EDIT_UNAVAILABLE', f.reason ?? 'Smart edits are unavailable.'); return services.providers.analyzer!(); };
  const configOf = (model: string) => `${SCENE_SCHEMA_VERSION}|${model}`;
  /** The pinned template version a request names: active, current, complete. */
  const versionFor = (templateId: unknown, templateVersion: unknown): TemplateVersion => {
    const found = typeof templateId === 'string' ? templates.get(templateId) : undefined;
    if (!found || found.status !== 'active') throw fail('TEMPLATE_NOT_FOUND', 'Template not found.');
    const number = Number(templateVersion);
    if (!Number.isSafeInteger(number) || number !== found.currentVersion) throw fail('STALE_TEMPLATE_VERSION', 'This template has changed. Reload its current version, then analyze the image again.');
    const version = templates.version(found.id, number);
    if (!version) throw fail('STALE_TEMPLATE_VERSION', 'This template has no current version.');
    return version;
  };
  const validUpload = async (upload: Upload) => {
    const meta = await validateReferenceUpload(upload.bytes, { checkExtension: true, ...(upload.fileName ? { originalName: upload.fileName } : {}), ...(upload.mimeType ? { mimeType: upload.mimeType } : {}) });
    const turned = (meta.orientation ?? 1) >= 5;
    return { format: meta.format!, width: (turned ? meta.height : meta.width)!, height: (turned ? meta.width : meta.height)! };
  };
  const slotRoles = (version: TemplateVersion) => Object.fromEntries(describeTemplateSlots(version).map(s => [s.id, s.role])) as Record<string, TemplateRole>;
  /** An analysis as shown: one a stopped server left half-done is shown as interrupted, never as still running. */
  const shownAnalysis = (record: SceneAnalysisRecord): SceneAnalysisRecord => record.state === 'analyzing' && !active.has(record.id)
    ? { ...record, state: 'failed', error: { code: 'INTERRUPTED', message: 'The server stopped before the analysis finished. Analyze again (one new call).' } } : record;
  const readyAnalysis = (id: string) => {
    const record = shownAnalysis(scenes.get(id));
    if (record.state !== 'ready' || !record.scene) throw fail('ANALYSIS_NOT_READY', record.state === 'failed' ? `The analysis failed: ${record.error?.message ?? ''} Analyze the image again.` : 'The image is still being analyzed.');
    return record;
  };
  const runAnalysis = async (id: string) => {
    const record = scenes.get(id), started = Date.now(), a = analyzer();
    scenes.update(id, r => { r.calls += 1; r.requestFile = 'scene.openai-request.json'; });
    try {
      const prompt = await referenceForPrompt(readFileSync(scenes.path(id, record.upload.file)));
      const scene = await a.analyze(prompt.bytes, prompt.mime, (file, value) => scenes.writeFile(id, file, value));
      const version = templates.version(record.binding.templateId, record.binding.templateVersion);
      scenes.update(id, r => { r.state = 'ready'; r.scene = scene; r.responseFile = 'scene.openai-response.json'; r.durationMs = Date.now() - started; if (version) r.mapping = mapSceneToSlots(scene, version); delete r.error; });
      log(`[SMART] analyzed analysis=${id} objects=${scene.objects.length} marks=${scene.marks.length} overlays=${scene.overlays.length}`);
    } catch (error) {
      scenes.update(id, r => { r.state = 'failed'; r.durationMs = Date.now() - started; r.error = { code: error instanceof Error && error.name === 'SceneValidationError' ? 'ANALYSIS_INVALID' : errorCode(error, 'ANALYSIS_FAILED'), message: describe(error) }; });
      log(`[SMART] analysis failed analysis=${id}: ${describe(error)}`);
    }
  };
  /** A plan's template context: which saved field each detected object fills. */
  const contextOf = (record: SceneAnalysisRecord) => { const version = templates.version(record.binding.templateId, record.binding.templateVersion); return { slots: record.mapping?.slots ?? {}, slotRoles: version ? slotRoles(version) : {} }; };
  const checked = <T>(work: () => T): T => { try { return work(); } catch (error) { if (error instanceof RunError) throw error; throw fail('INVALID_DRAFT', describe(error)); } };

  const verifier = () => { const f = services.features().verification; return f.available ? services.providers.verifier?.() : undefined; };
  /** The vision check of a result against its expectations: a checker that cannot run is unchecked, never passed. */
  async function verify(original: Buffer, result: Buffer, expectations: SemanticExpectation[], save: (file: string, value: object) => void, prefix = ''): Promise<{ verification: SemanticVerification; called: boolean }> {
    const v = verifier();
    if (!v) return { verification: uncheckedVerification(services.features().verification.reason ?? 'The AI check is not configured.'), called: false };
    const started = Date.now();
    try {
      const [a, b] = await Promise.all([referenceForPrompt(original), referenceForPrompt(result)]);
      const checks = await v.verify({ original: { bytes: a.bytes, mime: a.mime }, result: { bytes: b.bytes, mime: b.mime }, expectations }, (file, value) => save(`${prefix}${file}`, value));
      return { verification: { status: verificationStatus(checks), checks, model: v.model, requestFile: `${prefix}verification.openai-request.json`, responseFile: `${prefix}verification.openai-response.json`, durationMs: Date.now() - started, note: SEMANTIC_NOTE }, called: true };
    } catch (error) {
      return { verification: { ...uncheckedVerification(`The AI check failed: ${describe(error)}`), model: v.model, durationMs: Date.now() - started }, called: true };
    }
  }
  /** A verification as review checks: a confirmed contradiction is a warning a person must accept; uncertainty is a hint. */
  const semanticChecks = (v: SemanticVerification): GenerationReviewCheck[] => v.status === 'unchecked'
    ? [{ id: 'semantic', severity: 'info', message: `AI check not run: ${v.reason ?? 'unavailable'}. Nothing about the content was verified automatically.`, evidence: {} }]
    : v.checks.filter(c => c.status !== 'pass').map(c => ({ id: 'semantic', severity: c.status === 'fail' ? 'warning' : 'info', message: `${c.status === 'fail' ? 'AI check found a problem' : 'AI check could not tell'} (${c.id}): ${c.message}`, evidence: {} }));

  // ── Creative variants ─────────────────────────────────────────────────────────────────────────────────────────────
  const shownSet = (set: VariantSet): VariantSet => {
    const stopped = !active.has(set.id);
    // Stopped while cutting out: no mask was saved, so the set waits for an uploaded cutout (or a new set) instead of hanging.
    if (stopped && (set.cutout.status === 'segmenting' || (set.cutout.status === 'pending' && set.state === 'cutout')))
      return { ...set, state: 'needs-cutout', cutout: { ...set.cutout, status: 'needs-cutout', error: { code: 'INTERRUPTED', message: 'The server stopped while cutting out the subject. Upload a cutout PNG exported from this image, or start a new set.' } } };
    return { ...set, ...(stopped && ['cutout', 'concepts', 'generating'].includes(set.state) ? { state: 'failed' as const, error: { code: 'INTERRUPTED', message: 'The server stopped before this finished. Finished variants are kept; regenerate the others explicitly.' } } : {}),
      variants: set.variants.map(v => stopped && v.status === 'generating' ? { ...v, status: 'failed' as const, error: { code: 'INTERRUPTED', message: 'The server stopped during this request. It is not resent automatically.' } } : v) };
  };
  const setFile = (set: VariantSet, file: string) => readFileSync(variants.path(set.id, file));
  /** The protected product an attached part belongs to, when that product is protected too (a part is not its own layer). */
  const partParent = (scene: SceneDescription, id: string, protectedIds: string[]) => scene.relations.find(r => (r.relation === 'part_of' || r.relation === 'attached_to') && r.source === id && protectedIds.includes(r.target) && !holderOf(scene, id))?.target;
  /** A product's region including its attached parts (the box a mask request and a split use). */
  const regionOf = (scene: SceneDescription, o: SceneDescription['objects'][number], protectedIds: string[], px: (b: SceneDescription['objects'][number]['box']) => PixelBox): PixelBox => {
    const boxes = [o, ...scene.objects.filter(x => partParent(scene, x.id, protectedIds) === o.id)].map(x => px(x.box)), x0 = Math.min(...boxes.map(b => b.x)), y0 = Math.min(...boxes.map(b => b.y));
    return { x: x0, y: y0, width: Math.max(...boxes.map(b => b.x + b.width)) - x0, height: Math.max(...boxes.map(b => b.y + b.height)) - y0 };
  };
  /** What is cut out: every protected product except attached parts, which go inside their product. */
  const cutoutTargets = (scene: SceneDescription, protectedIds: string[]) => protectedIds.filter(id => !partParent(scene, id, protectedIds)).map(id => scene.objects.find(o => o.id === id)!).filter(Boolean);
  /** Each protected product's own mask, saved beside the set's combined one (an empty one is left out: nothing of it was found). */
  async function saveSubjectMasks(setId: string, subjects: SceneDescription['objects'], masks: Uint8Array[], source: { width: number; height: number }) {
    const saved: NonNullable<VariantSet['cutout']['masks']> = [];
    for (const [k, o] of subjects.entries()) {
      if (!masks[k] || !maskBox(masks[k], source.width, source.height).box) continue;
      const file = `mask-${k + 1}.png`;
      variants.writeFile(setId, file, await maskPng(masks[k], source.width, source.height));
      saved.push({ subjectId: o.id, label: o.label, file });
    }
    return saved;
  }
  /**
   * The products to compose, back to front: a held, worn or attached product in front of what holds it, the others by
   * where they stand (lower in the frame is nearer). A product gets a contact shadow when it stands on its own: not held
   * or attached to another protected product, and not cut off by the bottom edge of the frame. A set made before
   * products were separated composes its combined mask as one subject, as it always did.
   */
  async function variantSubjects(set: VariantSet, scene: SceneDescription, source: { width: number; height: number }): Promise<VariantSubject[]> {
    if (!set.cutout.masks?.length) return [{ id: 'subject', label: set.protectedLabels.join(' + ') || 'Subject', mask: await maskRaster(setFile(set, 'mask.png'), source.width, source.height), shadow: true }];
    return orderSubjects(scene, await Promise.all(set.cutout.masks.map(async m => ({ id: m.subjectId, label: m.label, mask: await maskRaster(setFile(set, m.file), source.width, source.height) }))), source);
  }
  /** Cut-out products in compose order (back to front), each with its shadow rule (see variantSubjects). */
  function orderSubjects(scene: SceneDescription, items: { id: string; label: string; mask: Uint8Array }[], source: { width: number; height: number }): VariantSubject[] {
    const ids = new Set(items.map(m => m.id));
    const carried = (id: string) => { const holder = holderOf(scene, id); return (!!holder && ids.has(holder)) || scene.relations.some(r => (r.relation === 'attached_to' || r.relation === 'part_of') && r.source === id && ids.has(r.target)); };
    const loaded = items.map(m => { const box = maskBox(m.mask, source.width, source.height).box!; return { ...m, bottom: box.y + box.height, shadow: !carried(m.id) && box.y + box.height < source.height * 0.985 }; });
    const depth = (id: string): number => { const holder = holderOf(scene, id) ?? scene.relations.find(r => (r.relation === 'attached_to' || r.relation === 'part_of') && r.source === id && ids.has(r.target))?.target; return holder && ids.has(holder) ? 1 + depth(holder) : 0; };
    return loaded.sort((a, b) => depth(a.id) - depth(b.id) || a.bottom - b.bottom).map(({ id, label, mask, shadow }) => ({ id, label, mask, shadow }));
  }
  /**
   * The products a background restyle keeps, cut out of the edit's own image (one mask request per product, as variants
   * do) and checked the same way. An unreliable or failed cutout is reported, never replaced by a guess: the edit then
   * says why it paints the whole image instead.
   */
  async function editCutout(input: { scene: SceneDescription; protectIds: string[]; image: Buffer; save: (file: string, value: object) => void }):
    Promise<{ subjects: VariantSubject[]; provider: string; calls: number; masks: Buffer[]; limitations: string[] } | { failure: string; provider?: string; calls: number }> {
    const segmenter = services.providers.segmenter?.();
    if (!segmenter) return { failure: 'No mask provider is configured, so the products could not be cut out.', calls: 0 };
    const source = await sourceRaster(input.image), scene = input.scene;
    const px = (b: SceneDescription['objects'][number]['box']): PixelBox => ({ x: Math.round(b.x * source.width), y: Math.round(b.y * source.height), width: Math.max(1, Math.round(b.w * source.width)), height: Math.max(1, Math.round(b.h * source.height)) });
    const subjects = cutoutTargets(scene, input.protectIds), region = (o: SceneDescription['objects'][number]) => regionOf(scene, o, input.protectIds, px);
    const calls = segmenter.provider === 'birefnet' ? 1 : subjects.length;
    try {
      const { mask: png, masks: pngs } = await segmenter.segment({ image: input.image, width: source.width, height: source.height, targets: subjects.map(o => ({ label: o.category, box: region(o) })) }, (file, value) => input.save(`edit-${file}`, value));
      const mask = await maskRaster(png, source.width, source.height);
      const own = pngs?.length === subjects.length ? await Promise.all(pngs.map(p => maskRaster(p, source.width, source.height))) : splitMaskByBoxes(mask, source.width, source.height, subjects.map(region));
      const overlaps = [...scene.overlays.map(t => ({ label: `${t.label} ${t.zone.replace('-', ' ')}`, box: px(t.box) })), ...scene.marks.filter(m => m.overlay).map(m => ({ label: m.label, box: px(m.box) }))];
      const check = checkMask(mask, source.width, source.height, subjects.map(o => ({ label: o.label, box: region(o) })), overlaps);
      if (!check.ok) return { failure: `The automatic cutout is not reliable: ${check.problems.join(' ')}`, provider: segmenter.provider, calls };
      const found = subjects.map((o, k) => ({ id: o.id, label: o.label, mask: own[k] })).filter(x => x.mask && maskBox(x.mask, source.width, source.height).box);
      if (!found.length) return { failure: 'The cutout found none of the products.', provider: segmenter.provider, calls };
      return { subjects: orderSubjects(scene, found, source), provider: segmenter.provider, calls, masks: await Promise.all(found.map(x => maskPng(x.mask, source.width, source.height))), limitations: check.limitations };
    } catch (error) {
      return { failure: `The product cutout failed: ${describe(error)}`, provider: segmenter.provider, calls };
    }
  }
  async function cutout(setId: string, scene: SceneDescription) {
    const set = variants.get(setId), source = await sourceRaster(setFile(set, set.source.file)), segmenter = services.providers.segmenter?.();
    if (!segmenter) { variants.update(setId, s => { s.state = 'needs-cutout'; s.cutout = { ...s.cutout, status: 'needs-cutout', checks: [], limitations: [], error: { code: 'CUTOUT_REQUIRED', message: 'No mask provider is configured: upload a cutout PNG exported from this image (transparent background).' } }; }); return false; }
    const px = (b: SceneDescription['objects'][number]['box']): PixelBox => ({ x: Math.round(b.x * source.width), y: Math.round(b.y * source.height), width: Math.max(1, Math.round(b.w * source.width)), height: Math.max(1, Math.round(b.h * source.height)) });
    // An attached part (a control panel, a lid) is cut out inside its product: one mask request and one layer for both.
    const subjects = cutoutTargets(scene, set.protectedIds), region = (o: SceneDescription['objects'][number]) => regionOf(scene, o, set.protectedIds, px);
    variants.update(setId, s => { s.state = 'cutout'; s.cutout.status = 'segmenting'; s.cutout.provider = segmenter.provider; s.usage.segmentationCalls += segmenter.provider === 'birefnet' ? 1 : subjects.length; });
    try {
      const { mask: png, masks: pngs, requestIds } = await segmenter.segment({ image: setFile(set, set.source.file), width: source.width, height: source.height, targets: subjects.map(o => ({ label: o.category, box: region(o) })) }, (file, value) => variants.writeFile(setId, file, value));
      const mask = await maskRaster(png, source.width, source.height);
      const own = pngs?.length === subjects.length ? await Promise.all(pngs.map(p => maskRaster(p, source.width, source.height))) : splitMaskByBoxes(mask, source.width, source.height, subjects.map(region));
      const overlaps = [...scene.overlays.map(t => ({ label: `${t.label} ${t.zone.replace('-', ' ')}`, box: px(t.box) })), ...scene.marks.filter(m => m.overlay).map(m => ({ label: m.label, box: px(m.box) }))];
      const check = checkMask(mask, source.width, source.height, subjects.map(o => ({ label: o.label, box: region(o) })), overlaps);
      if (!check.ok) {
        variants.update(setId, s => { s.state = 'needs-cutout'; s.cutout = { ...s.cutout, status: 'needs-cutout', requestIds, checks: check.checks, limitations: check.limitations, coveragePercent: check.coveragePercent, error: { code: 'CUTOUT_UNRELIABLE', message: `The automatic cutout is not reliable: ${check.problems.join(' ')} Upload a cutout PNG exported from this image to continue; nothing is redrawn instead.` } }; });
        return false;
      }
      const files = await cutoutFiles(source, mask), masks = await saveSubjectMasks(setId, subjects, own, source);
      variants.writeFile(setId, 'mask.png', files.mask); variants.writeFile(setId, 'subject.png', files.subject);
      variants.update(setId, s => { s.cutout = { status: 'ready', provider: segmenter.provider, mask: 'mask.png', subject: 'subject.png', masks, requestIds, checks: check.checks, limitations: check.limitations, coveragePercent: check.coveragePercent, ...(check.box ? { box: check.box } : {}) }; });
      return true;
    } catch (error) {
      variants.update(setId, s => { s.state = 'needs-cutout'; s.cutout = { ...s.cutout, status: 'needs-cutout', checks: [], limitations: [], error: { code: errorCode(error, 'SEGMENTATION_FAILED'), message: `${describe(error)} Upload a cutout PNG exported from this image to continue.` } }; });
      return false;
    }
  }
  /** Codes of a variant that has no usable scene yet: none was written, it was refused, or the concept call failed. */
  const SCENE_CODES = ['CONCEPT_REJECTED', 'CONCEPT_MISSING', 'CONCEPTS_FAILED'];
  /** A variant still waiting for a scene idea (a finished, running or user-edited one keeps its own). */
  const needsScene = (v: CreativeVariant) => v.status !== 'done' && v.status !== 'generating' && (!v.scene.trim() || SCENE_CODES.includes(v.error?.code ?? ''));
  /**
   * One scene-concept call for every variant still without a usable scene. Fewer concepts than asked are used as they
   * come; a variant left without one, or whose concept asks for text or repeats another, waits (failed, with a reason)
   * for an explicit second call or the user's own scene.
   */
  async function concepts(setId: string, scene: SceneDescription) {
    const set = variants.get(setId), open = set.variants.filter(needsScene);
    if (!open.length) return;
    if (set.count === 1 && set.direction && !set.concepts) { variants.update(setId, s => { s.concepts = { status: 'skipped' }; s.variants[0].scene = s.direction!; s.variants[0].title = 'Your direction'; }); return; }
    const writer = services.providers.concepts?.();
    if (!writer) { variants.update(setId, s => { s.state = 'failed'; s.concepts = { status: 'failed', error: { code: 'CONCEPTS_UNAVAILABLE', message: 'The concept writer is not configured.' } }; }); return; }
    variants.update(setId, s => { s.state = 'concepts'; s.usage.conceptCalls += 1; s.usage.models.concepts = writer.model; });
    try {
      const kept = cutoutTargets(scene, set.protectedIds);
      // What a creative director needs about the products: what they are, their visible brands and how they look.
      const brands = [...new Set(kept.map(o => o.identity?.brand).filter((b): b is string => !!b && b.length > 0))];
      const details = kept.flatMap(o => o.properties.filter(p => ['color', 'material', 'finish', 'style'].includes(p.key)).map(p => `${o.category}: ${p.value}`)).slice(0, 12);
      // A few more concepts than needed, so the most different ones can be chosen.
      const asked = Math.min(7, open.length + 2);
      const written = await writer.write({ subjects: kept.map(o => o.category), summary: scene.summary, lighting: lightingSentence(scene.lighting), ...(set.direction ? { direction: set.direction } : {}), count: asked,
        ...(set.aspectRatio ? { ratio: set.aspectRatio } : {}), brands, details }, (file, value) => variants.writeFile(setId, file, value));
      variants.update(setId, s => {
        s.concepts = { status: 'done', model: writer.model, requestFile: 'concepts.openai-request.json', responseFile: 'concepts.openai-response.json' };
        const structured = written.some(c => typeof (c as { environment?: unknown }).environment === 'string');
        if (structured) {
          // Each concept checked (text-free, bounded), then the most different ones chosen: near-copies are left out.
          const parsed = written.map(c => ({ title: sanitizeEditInstruction(c.title ?? '').slice(0, VARIANT_LIMITS.title), ...parseConcept(c) }));
          const valid = parsed.filter(c => c.concept).map(c => c.concept!), existing = s.variants.filter(v => !needsScene(v) && v.concept).map(v => v.concept!);
          const { chosen, rejected, minDistance } = selectDiverseConcepts(valid, open.length, existing);
          s.conceptReport = { candidates: written.length, chosen: chosen.length, minDistance, rejected: [...parsed.filter(c => !c.concept).map(c => ({ title: c.title || 'Untitled', reason: c.problems[0] })), ...rejected] };
          let next = 0;
          s.variants.forEach((v, i) => {
            if (!needsScene(v)) return;
            const c = chosen[next++];
            if (!c) { v.status = 'failed'; v.error = { code: 'CONCEPT_MISSING', message: 'No scene idea different enough from the others was written for this variant. Write scene ideas again (one call), or describe a scene and regenerate.' }; return; }
            v.concept = c; v.title = c.title || `Variant ${i + 1}`; v.scene = conceptScene(c); v.status = 'pending'; delete v.error;
          });
          return;
        }
        // A writer of plain scene descriptions (one per variant).
        const keptScenes: string[] = s.variants.filter(v => !needsScene(v) && v.scene.trim()).map(v => v.scene);
        let next = 0;
        s.variants.forEach((v, i) => {
          if (!needsScene(v)) return;
          const c = written[next++];
          if (!c) { v.status = 'failed'; v.error = { code: 'CONCEPT_MISSING', message: 'No scene idea was written for this variant. Write scene ideas again (one call), or describe a scene and regenerate.' }; return; }
          const text = cleanScenePrompt(c.scene ?? ''), problems = scenePromptProblems(text);
          v.title = sanitizeEditInstruction(c.title ?? '').slice(0, VARIANT_LIMITS.title) || `Variant ${i + 1}`; v.scene = text;
          // A concept that asks for text, or repeats another, is not sent: the user writes or edits it, or asks for new ideas.
          const repeat = keptScenes.find(k => sceneSimilarity(k, text) >= 0.7);
          if (problems.length || repeat) { v.status = 'failed'; v.error = { code: 'CONCEPT_REJECTED', message: problems.length ? `This concept was not sent: ${problems[0]} Edit the scene and regenerate, or write scene ideas again.` : 'This concept nearly repeats another one and was not sent. Edit the scene and regenerate, or write scene ideas again.' }; }
          else { v.status = 'pending'; delete v.error; keptScenes.push(text); }
        });
      });
    } catch (error) {
      variants.update(setId, s => {
        s.state = 'failed'; s.concepts = { status: 'failed', model: writer.model, error: { code: errorCode(error, 'CONCEPTS_FAILED'), message: describe(error) } };
        s.error = { code: 'CONCEPTS_FAILED', message: `No concepts were written: ${describe(error)} No image was generated. The cutout is kept: write scene ideas again (one call) when ready.` };
        for (const v of s.variants) if (needsScene(v)) { v.status = 'failed'; v.error = { code: 'CONCEPTS_FAILED', message: 'No scene idea yet: the concept call failed. Write scene ideas again (one call), or describe a scene and regenerate.' }; }
      });
    }
  }
  async function generateVariant(setId: string, variantId: string) {
    const set = variants.get(setId), analysis = scenes.get(set.analysisId), scene = applySceneCorrections(analysis.scene!, set.corrections ?? {});
    const attempt = set.variants.find(v => v.id === variantId)!.attempts + 1, prefix = `${variantId}-a${attempt}`, config = services.generation(), started = Date.now();
    variants.update(setId, s => { const v = s.variants.find(x => x.id === variantId)!; v.status = 'generating'; v.attempts = attempt; v.startedAt = new Date().toISOString(); delete v.error; s.usage.imageGenerationCalls += 1; s.usage.models.image = config.model; });
    try {
      const v = variants.get(setId).variants.find(x => x.id === variantId)!;
      const people = set.protectedIds.some(id => ['person', 'character'].includes(scene.objects.find(o => o.id === id)?.kind ?? ''));
      const prompt = compileVariantPrompt({ protectedLabels: set.protectedLabels, lighting: scene.lighting, scene: v.scene, people, placed: !!set.aspectRatio });
      const source = await sourceRaster(setFile(set, set.source.file)), subjects = await variantSubjects(set, scene, source);
      // Soft edges refined from their colours: no old background tints them (opaque product pixels never change).
      const refined = refineEdges(source, subjects.map(x => x.mask)), own = subjects.map((x, k) => ({ ...x, mask: refined.masks[k] }));
      let size: { width: number; height: number }, inputs: { image: Buffer; mask: Buffer; placement: PixelBox }, reference = refined.reference, composeSubjects = own, layout: CreativeVariant['layout'];
      if (set.aspectRatio) {
        // The variant's own canvas: the product group placed as one unit where its concept puts it, never enlarged.
        size = GENERATION_IMAGE_SIZES[set.aspectRatio];
        const group = groupBox(refined.masks, source.width, source.height), placement = placeGroup(group, size, v.concept?.composition ?? DEFAULT_COMPOSITION, touchedEdges(group, source));
        const placed = await placeProducts(refined.reference, refined.masks, group, placement, size, backgroundColour(source, refined.union));
        inputs = await canvasInputs(placed.reference, placed.union); reference = placed.reference; layout = { scale: placement.scale, box: placement.box };
        composeSubjects = own.map((x, k) => ({ ...x, mask: placed.masks[k] }));
      } else {
        size = GENERATION_IMAGE_SIZES[closestGenerationRatio(source.width, source.height)];
        inputs = await generationInputs(refined.reference, refined.union, size);
      }
      const sizeText = `${size.width}x${size.height}`;
      variants.writeFile(setId, `${prefix}.openai-request.json`, { method: 'images.edit', model: config.model, prompt, size: sizeText, n: 1, output_format: 'png',
        image: set.aspectRatio ? `<the products placed on a ${set.aspectRatio} canvas${layout && layout.scale < 1 ? `, scaled to ${Math.round(layout.scale * 100)}%` : ''}>` : '<the reference, contained in the canvas>', mask: '<transparent everywhere but the protected products>' });
      variants.update(setId, s => { const x = s.variants.find(y => y.id === variantId)!; x.prompt = prompt; x.model = config.model; x.size = sizeText; x.requestFile = `${prefix}.openai-request.json`; });
      let response: { data?: { b64_json?: string }[] | null };
      try {
        const images = config.client().images;
        response = await images.edit({ model: config.model, prompt, size: sizeText as never, n: 1, output_format: 'png', image: await toFile(inputs.image, 'reference.png', { type: imageFileType('reference.png') }), mask: await toFile(inputs.mask, 'mask.png', { type: 'image/png' }) } as never) as unknown as { data?: { b64_json?: string }[] | null };
      } catch (error) {
        const api: ApiFailure = error instanceof RunError ? {} : error as ApiFailure;
        if (api.status !== undefined) variants.writeFile(setId, `${prefix}.provider-error.json`, { requestId: api.requestID ?? null, capturedAt: new Date().toISOString(), status: api.status, body: api.error ?? null });
        throw Object.assign(new Error(`The image request failed: ${describe(error)}`), { code: imageFailureCode(error) });
      }
      variants.writeFile(setId, `${prefix}.openai-response.json`, responseWithoutImage(response));
      const generated = await returnedImage(response.data?.[0]?.b64_json);
      if (generated.width !== size.width || generated.height !== size.height) throw Object.assign(new Error(`The image model returned ${generated.width}×${generated.height}, not ${sizeText}; nothing was composed.`), { code: 'UNEXPECTED_SIZE' });
      variants.writeFile(setId, `${prefix}-generated.png`, generated.bytes);
      const composed = await composeVariant(generated.bytes, inputs.placement, reference, composeSubjects), W = reference.width, H = reference.height;
      const image = (file: string, bytes: Buffer, width: number, height: number): ExecutionImage => { variants.writeFile(setId, file, bytes); return { file, mimeType: 'image/png', width, height, bytes: bytes.length, sha256: sha256(bytes) }; };
      const composite = image(`${prefix}-composite.png`, composed.composite, W, H);
      const layers: NonNullable<CreativeVariant['layers']> = {
        scenery: image(`${prefix}-scenery.png`, composed.scenery, W, H), plate: image(`${prefix}-plate.png`, composed.plate, W, H),
        ...(composed.shadow ? { shadow: { ...image(`${prefix}-shadow.png`, composed.shadow.png, composed.shadow.placement.width, composed.shadow.placement.height), placement: composed.shadow.placement } } : {}),
        subject: { ...image(`${prefix}-subject.png`, composed.subject.png, composed.subject.placement.width, composed.subject.placement.height), placement: composed.subject.placement } };
      // Each product as its own layer and shadow (a set made before products were separated has only the combined one).
      if (set.cutout.masks?.length) {
        layers.subjects = composed.subjects.map((l, k) => ({ ...image(`${prefix}-subject-${k + 1}.png`, l.png, l.placement.width, l.placement.height), placement: l.placement, subjectId: l.id, label: l.label }));
        layers.shadows = composed.shadows.map((l, k) => ({ ...image(`${prefix}-shadow-${k + 1}.png`, l.png, l.placement.width, l.placement.height), placement: l.placement, subjectId: l.id, label: l.label }));
      }
      const p = composed.preservation;
      if (!p.ok) throw Object.assign(new Error(`The products' source pixels did not survive the composite exactly (opaque pixels: max difference ${p.maxDifference}; soft edges: max error ${p.edgeMaxError}; pixels outside the masks: ${p.outsideAlphaPixels}). The result was not used.`), { code: 'PRESERVATION_FAILED' });
      let verification: SemanticVerification | undefined;
      if (set.verify) {
        const checkedOnce = await verify(setFile(set, set.source.file), composed.composite, variantExpectations(scene, set.protectedIds), (file, value) => variants.writeFile(setId, file, value), `${prefix}-`);
        verification = checkedOnce.verification;
        if (checkedOnce.called) variants.update(setId, s => { s.usage.verificationCalls += 1; s.usage.models.verifier = verification!.model ?? ''; });
      }
      variants.update(setId, s => { const x = s.variants.find(y => y.id === variantId)!; Object.assign(x, { status: 'done', image: composite, layers, preservation: { method: layout && layout.scale < 1 ? 'resampled-source-pixels' : 'exact-source-pixels', checkedPixels: p.checkedPixels, maxDifference: p.maxDifference, edgePixels: p.edgePixels, edgeMaxError: p.edgeMaxError, outsideAlphaPixels: p.outsideAlphaPixels, ...(layout ? { scale: layout.scale } : {}) }, ...(layout ? { layout } : {}), responseFile: `${prefix}.openai-response.json`, durationMs: Date.now() - started, finishedAt: new Date().toISOString(), ...(verification ? { verification } : {}) }); });
      log(`[SMART] variant done set=${setId} ${variantId} attempt=${attempt} preserved=${p.checkedPixels}px edges=${p.edgePixels}px products=${subjects.length}`);
    } catch (error) {
      variants.update(setId, s => { const x = s.variants.find(y => y.id === variantId)!; x.status = 'failed'; x.error = { code: errorCode(error, 'GENERATION_FAILED'), message: describe(error) }; x.durationMs = Date.now() - started; x.finishedAt = new Date().toISOString(); });
      log(`[SMART] variant failed set=${setId} ${variantId}: ${describe(error)}`);
    }
  }
  /** A set's state from its variants, once its cutout and concepts are through. */
  const settle = (setId: string) => variants.update(setId, s => {
    if (s.state === 'needs-cutout' || (s.state === 'failed' && s.concepts?.status === 'failed')) return;
    s.state = s.variants.some(v => v.status === 'pending' || v.status === 'generating') ? 'generating' : 'ready';
  });
  async function runSet(setId: string, from: 'cutout' | 'concepts') {
    const set = variants.get(setId), scene = applySceneCorrections(scenes.get(set.analysisId).scene!, set.corrections ?? {});
    if (from === 'cutout' && !await cutout(setId, scene)) return;
    await concepts(setId, scene);
    if (variants.get(setId).state === 'failed') return;
    variants.update(setId, s => { s.state = 'generating'; });
    for (const v of variants.get(setId).variants) if (v.status === 'pending') await generateVariant(setId, v.id);
    settle(setId);
  }

  /** The resolver's saved answer of a resolution, parsed again (undefined when it was never saved or cannot be read). */
  function savedProposal(analysisId: string, file: string | undefined): ResolverProposal | undefined {
    if (!file) return undefined;
    try {
      const response = JSON.parse(readFileSync(scenes.path(analysisId, file), 'utf8')) as { output_text?: string; output?: { content?: { type?: string; text?: string }[] }[] };
      const text = response.output_text ?? response.output?.flatMap(o => o.content ?? []).filter(c => c.type === 'output_text').map(c => c.text ?? '').join('');
      return text ? parseResolverProposal(JSON.parse(text)) : undefined;
    } catch { return undefined; }
  }
  /**
   * A resolution made under older plan rules, made again under the current ones as a new record (the old one stays for
   * the executions that used it): the rules run again and its saved resolver answer is merged again, with no new call.
   * Undefined when its resolver answer cannot be read: it is then resolved like a new draft.
   */
  async function rebuildResolution(analysisId: string, record: SceneAnalysisRecord, corrected: SceneDescription, draft: ReturnType<typeof cleanDraft>, old: ResolutionRecord): Promise<ResolutionRecord | undefined> {
    const proposal = old.resolver.called ? savedProposal(analysisId, old.resolver.responseFile) : undefined;
    if (old.resolver.called && !proposal) return undefined;
    const referenceBytes = old.reference ? readFileSync(scenes.resolutionFile(analysisId, old.reference.file)) : undefined;
    const fresh = scenes.createResolution(analysisId, { binding: old.binding, draft, ...(old.reference && referenceBytes ? { reference: old.reference, referenceBytes, referenceExt: old.reference.file.split('.').pop()! } : {}) });
    const base = basePlan(corrected, draft, contextOf(record)), merged = proposal ? mergeResolution(corrected, draft, base, proposal) : { plan: base, rejected: [] };
    try {
      const compiled = merged.plan.status === 'needs-input' ? undefined : compileResolvedEdit(corrected, merged.plan, { productReference: !!old.binding.referenceSha256 });
      log(`[SMART] resolution ${old.id} rebuilt under ${PLAN_RULES} as ${fresh.id} (${proposal ? 'saved resolver answer merged again' : 'rules only'}; no call)`);
      return scenes.updateResolution(analysisId, fresh.id, r => { r.state = 'ready'; r.plan = merged.plan; r.rejected = merged.rejected; r.rules = PLAN_RULES; r.resolver = { ...old.resolver, reusedFrom: old.id }; if (compiled) { r.prompt = compiled.text; r.summary = compiled.summary; } });
    } catch (error) {
      return scenes.updateResolution(analysisId, fresh.id, r => { r.state = 'failed'; r.rules = PLAN_RULES; r.resolver = { ...old.resolver, reusedFrom: old.id }; r.error = { code: errorCode(error, 'RESOLUTION_FAILED'), message: describe(error) }; });
    }
  }

  return {
    features: () => services.features(),
    isActive: (id: string) => active.has(id),
    /** The saved scene for exactly this image (by its sha256), template version and configuration, if any: a read, no call. */
    lookup(input: { imageSha256: unknown; templateId: unknown; templateVersion: unknown }) {
      const version = versionFor(input.templateId, input.templateVersion);
      if (typeof input.imageSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.imageSha256)) throw fail('INVALID_REQUEST', 'Name the image by its sha256.');
      if (!services.features().smartEdit.available) return undefined;
      const found = scenes.find({ imageSha256: input.imageSha256, templateId: version.templateId, templateVersion: version.version, config: configOf(services.providers.analyzer!().model) }, id => active.has(id));
      return found && shownAnalysis(found);
    },
    /** An explicit analysis: the saved scene for this binding (no call), or one new call. */
    async analyze(input: { upload: Upload; templateId: unknown; templateVersion: unknown; idempotencyKey: unknown; fresh?: boolean }): Promise<{ analysis: SceneAnalysisRecord; created: boolean }> {
      const a = analyzer(), version = versionFor(input.templateId, input.templateVersion), meta = await validUpload(input.upload);
      const binding = { imageSha256: sha256(input.upload.bytes), templateId: version.templateId, templateVersion: version.version, config: configOf(a.model) };
      const { record, created } = scenes.create({ idempotencyKey: String(input.idempotencyKey ?? ''), binding, model: a.model, ...(input.fresh ? { fresh: true } : {}),
        upload: { bytes: input.upload.bytes, ext: ext(meta.format), mimeType: `image/${meta.format}`, width: meta.width, height: meta.height, ...(input.upload.fileName ? { originalName: input.upload.fileName } : {}) } }, id => active.has(id));
      if (created) schedule(record.id, () => runAnalysis(record.id));
      else log(`[SMART] analysis reused analysis=${record.id} (no call)`);
      return { analysis: shownAnalysis(scenes.get(record.id)), created };
    },
    analysis: (id: string) => shownAnalysis(scenes.get(id)),
    sourcePath: (id: string) => scenes.path(id, scenes.get(id).upload.file),
    /**
     * Resolves a draft against an analysis: rules always, the resolver only when it can add something (or never, with
     * rulesOnly). The same draft and photo for the same analysis return the saved resolution (no second call).
     */
    async resolve(analysisId: string, input: { draft: unknown; reference?: Upload; rulesOnly?: boolean }): Promise<{ resolution: ResolutionRecord; created: boolean }> {
      const record = readyAnalysis(analysisId), version = versionFor(record.binding.templateId, record.binding.templateVersion);
      const raw = input.draft && typeof input.draft === 'object' ? input.draft as Record<string, unknown> : {};
      const corrected = checked(() => applySceneCorrections(record.scene!, cleanCorrections(record.scene!, raw.corrections)));
      const draft = checked(() => cleanDraft(corrected, input.draft, { hasReference: !!input.reference }));
      const referenceMeta = input.reference ? await validUpload(input.reference) : undefined;
      const binding: ResolutionRecord['binding'] = { ...record.binding, templateVersion: version.version, draft: canonicalDraft(draft), ...(input.reference ? { referenceSha256: sha256(input.reference.bytes) } : {}) };
      const cached = scenes.findResolution(analysisId, binding);
      // A resolution made under older plan rules is rebuilt (rules again, and its saved resolver answer merged again: no call).
      if (cached && cached.rules !== PLAN_RULES) { const rebuilt = await rebuildResolution(analysisId, record, corrected, draft, cached); if (rebuilt) return { resolution: rebuilt, created: true }; }
      else if (cached && !(cached.resolver.called === false && needsResolver(corrected, draft) && !input.rulesOnly)) return { resolution: cached, created: false };
      const flight = `${analysisId}|${JSON.stringify(binding)}|${input.rulesOnly ? 'rules' : 'ai'}`, pending = resolving.get(flight);
      if (pending) return { resolution: (await pending).resolution, created: false };
      const work = this.resolveNew(analysisId, { record, corrected, draft, binding, ...(input.reference ? { reference: input.reference } : {}), ...(referenceMeta ? { referenceMeta } : {}), rulesOnly: !!input.rulesOnly });
      resolving.set(flight, work);
      try { return await work; } finally { resolving.delete(flight); }
    },
    /** One new resolution (rules, then at most one resolver call), persisted as it goes. */
    async resolveNew(analysisId: string, input: { record: SceneAnalysisRecord; corrected: SceneDescription; draft: ReturnType<typeof cleanDraft>; binding: ResolutionRecord['binding']; reference?: Upload; referenceMeta?: { format: string; width: number; height: number }; rulesOnly: boolean }): Promise<{ resolution: ResolutionRecord; created: boolean }> {
      const { record, corrected, draft, binding, referenceMeta } = input;
      const resolution = scenes.createResolution(analysisId, { binding, draft, ...(input.reference && referenceMeta ? { reference: { file: '', mimeType: `image/${referenceMeta.format}`, width: referenceMeta.width, height: referenceMeta.height, bytes: input.reference.bytes.length, sha256: binding.referenceSha256! },
        referenceBytes: input.reference.bytes, referenceExt: ext(referenceMeta.format) } : {}) });
      const finishWith = (plan: ChangePlan, rejected: string[], resolver: ResolutionRecord['resolver']) => {
        const compiled = plan.status === 'needs-input' ? undefined : compileResolvedEdit(corrected, plan, { productReference: !!input.reference });
        return scenes.updateResolution(analysisId, resolution.id, r => { r.state = 'ready'; r.plan = plan; r.rejected = rejected; r.resolver = resolver; r.rules = PLAN_RULES; if (compiled) { r.prompt = compiled.text; r.summary = compiled.summary; } });
      };
      try {
        const base = basePlan(corrected, draft, contextOf(record));
        const resolverFactory = services.providers.resolver;
        if (base.status === 'unchanged' || input.rulesOnly || !needsResolver(corrected, draft) || !resolverFactory) {
          const note = input.rulesOnly && needsResolver(corrected, draft) ? ['Resolved by rules only, at your request: brands and identity from your words were not checked by AI.'] : [];
          return { resolution: finishWith({ ...base, notes: [...base.notes, ...note] }, [], { called: false }), created: true };
        }
        const resolver = resolverFactory(), started = Date.now(), prefix = `res-${resolution.id.toLowerCase()}`;
        scenes.updateResolution(analysisId, resolution.id, r => { r.resolver = { called: true, model: resolver.model, requestFile: `${prefix}-resolution.openai-request.json` }; });
        let proposal;
        try {
          const reference = input.reference ? await referenceForPrompt(input.reference.bytes) : undefined;
          proposal = await resolver.resolve({ scene: corrected, draft, base, ...(reference ? { reference } : {}) }, (file, value) => scenes.writeFile(analysisId, `${prefix}-${file}`, value));
        } catch (error) {
          const updated = scenes.updateResolution(analysisId, resolution.id, r => { r.state = 'failed'; r.resolver = { ...r.resolver, durationMs: Date.now() - started, error: describe(error) };
            r.error = { code: error instanceof Error && error.name === 'ResolverValidationError' ? 'RESOLUTION_INVALID' : errorCode(error, 'RESOLUTION_FAILED'), message: `The changes could not be resolved: ${describe(error)} Try again (one new call), or continue with rules only.` }; });
          return { resolution: updated, created: true };
        }
        const merged = mergeResolution(corrected, draft, base, proposal);
        return { resolution: finishWith(merged.plan, merged.rejected, { called: true, model: resolver.model, requestFile: `${prefix}-resolution.openai-request.json`, responseFile: `${prefix}-resolution.openai-response.json`, durationMs: Date.now() - started }), created: true };
      } catch (error) {
        const updated = scenes.updateResolution(analysisId, resolution.id, r => { r.state = 'failed'; r.error = { code: errorCode(error, 'RESOLUTION_FAILED'), message: describe(error) }; });
        return { resolution: updated, created: true };
      }
    },
    resolution: (analysisId: string, id: string) => scenes.getResolution(analysisId, id),
    /**
     * What generation may use, checked against the exact request: the analysis is ready and bound to this image, this
     * template version and the current analysis configuration; the resolution is ready, clear and bound to this draft and
     * product photo; and its prompt recompiles to exactly the persisted one. Any mismatch is STALE_RESOLUTION.
     */
    forGeneration(input: { analysisId: unknown; resolutionId: unknown; draft: unknown; uploadSha256: string; referenceSha256?: string; template: { id: string; version: number } }) {
      if (typeof input.analysisId !== 'string' || typeof input.resolutionId !== 'string') throw fail('INVALID_REQUEST', 'A smart edit names its analysis and resolution.');
      const stale = (why: string) => fail('STALE_RESOLUTION', `${why} Resolve the changes again before generating.`);
      const record = readyAnalysis(input.analysisId);
      if (record.binding.imageSha256 !== input.uploadSha256) throw stale('The image changed since it was analyzed.');
      if (record.binding.templateId !== input.template.id || record.binding.templateVersion !== input.template.version) throw stale('The template version changed since the image was analyzed.');
      if (services.providers.analyzer && record.binding.config !== configOf(services.providers.analyzer().model)) throw stale('The analysis configuration changed.');
      let resolution: ResolutionRecord;
      try { resolution = scenes.getResolution(record.id, input.resolutionId); } catch { throw stale('That resolution does not exist.'); }
      if (resolution.state !== 'ready' || !resolution.plan) throw stale('That resolution is not ready.');
      if (resolution.plan.status === 'needs-input') throw fail('RESOLUTION_NEEDS_INPUT', 'Answer the open questions about your changes first.');
      const corrected = checked(() => applySceneCorrections(record.scene!, cleanCorrections(record.scene!, (input.draft as Record<string, unknown> | undefined)?.corrections)));
      const draft = checked(() => cleanDraft(corrected, input.draft, { hasReference: !!input.referenceSha256 }));
      if (canonicalDraft(draft) !== resolution.binding.draft) throw stale('Your changes differ from the resolved ones.');
      if ((input.referenceSha256 ?? '') !== (resolution.binding.referenceSha256 ?? '')) throw stale('The product photo differs from the resolved one.');
      const compiled = compileResolvedEdit(corrected, resolution.plan, { productReference: !!input.referenceSha256 });
      if (compiled.text !== resolution.prompt) throw stale('The resolved prompt no longer compiles to the same text.');
      // The calls before generation, as recorded (their usage prices them in the run's diagnostics).
      const callFiles: Record<string, object> = {}, copy = (from: string | undefined, to: string) => { try { if (from) callFiles[to] = JSON.parse(readFileSync(scenes.path(record.id, from), 'utf8')); } catch { /* an older or missing file: its usage stays unknown */ } };
      copy(record.requestFile, 'analysis.openai-request.json'); copy(record.responseFile, 'analysis.openai-response.json');
      copy(resolution.resolver.requestFile, 'resolution.openai-request.json'); copy(resolution.resolver.responseFile, 'resolution.openai-response.json');
      return { analysis: record, resolution, scene: corrected, compiled, callFiles };
    },
    /** The local review's changes and the AI check's expectations for a smart edit execution. */
    reviewInputs(execution: TemplateExecution) {
      const r = execution.resolution!, record = scenes.get(r.analysisId), resolution = scenes.getResolution(r.analysisId, r.id);
      const scene = applySceneCorrections(record.scene!, cleanCorrections(record.scene!, resolution.draft.corrections)), plan = resolution.plan!;
      // Where each change is, by the analysis's own boxes (the review's regions where the template has none of its own).
      const regions: Record<string, { x: number; y: number; w: number; h: number }> = {};
      for (const e of plan.entries.filter(x => x.operation !== 'keep')) { const t = sceneTarget(scene, e.targetId); if (t) regions[e.slotId ?? e.targetId] = t.item.box; }
      return { scene, compiled: compileResolvedEdit(scene, plan, { productReference: !!resolution.binding.referenceSha256 }), expectations: planExpectations(scene, plan),
        strategy: editStrategy(scene, plan), regions,
        // A replaced or removed object (asked or inferred) can never be confirmed by pixels: a person looks at it.
        objectChange: plan.entries.some(e => e.operation === 'replace' || e.operation === 'remove') };
    },
    editCutout,
    verify, semanticChecks,

    // ── Variant sets ──
    async startVariants(input: { analysisId: unknown; templateId: unknown; templateVersion: unknown; protectedIds?: unknown; aspectRatio?: unknown; corrections?: unknown; direction?: unknown; surprise?: unknown; count?: unknown; verify?: unknown; idempotencyKey: unknown }) {
      const f = services.features().variants;
      if (!f.available) throw fail('VARIANTS_UNAVAILABLE', f.reason ?? 'Creative variants are unavailable.');
      if (typeof input.analysisId !== 'string') throw fail('INVALID_REQUEST', 'Analyze the image first.');
      const record = readyAnalysis(input.analysisId), version = versionFor(input.templateId, input.templateVersion);
      if (record.binding.templateId !== version.templateId || record.binding.templateVersion !== version.version) throw fail('STALE_RESOLUTION', 'The template changed since the image was analyzed. Analyze it again.');
      const corrections = checked(() => cleanCorrections(record.scene!, input.corrections)), scene = applySceneCorrections(record.scene!, corrections);
      // What stays exactly as it is: chosen automatically (the advertised product or group) unless the request names it.
      const manual = Array.isArray(input.protectedIds) && input.protectedIds.length > 0;
      if (input.protectedIds !== undefined && !Array.isArray(input.protectedIds)) throw fail('PROTECTED_REQUIRED', 'protectedIds lists detected products or subjects.');
      if (manual && ((input.protectedIds as unknown[]).length > 8 || (input.protectedIds as unknown[]).some(id => typeof id !== 'string' || !scene.objects.some(o => o.id === id && isForeground(o) && !o.ignored))))
        throw fail('PROTECTED_REQUIRED', 'Confirm which detected products or subjects must stay exactly as they are.');
      const auto = manual ? undefined : advertisedProducts(scene);
      if (auto && !auto.ids.length) throw fail('PROTECTED_REQUIRED', 'No advertised product was found in this image. Choose what must stay exactly as it is under Advanced.');
      const chosen = manual ? input.protectedIds as string[] : auto!.ids;
      const group = protectedGroup(scene, chosen);
      const selection: NonNullable<VariantSet['selection']> = auto ? { ids: auto.ids, reasons: auto.reasons, basis: auto.basis, fallback: auto.fallback } : { ids: chosen, reasons: {}, basis: 'user', fallback: false };
      const count = input.count === undefined ? 3 : Number(input.count);
      if (!Number.isSafeInteger(count) || count < VARIANT_LIMITS.min || count > VARIANT_LIMITS.max) throw fail('INVALID_REQUEST', `Choose ${VARIANT_LIMITS.min}–${VARIANT_LIMITS.max} variants.`);
      if (input.aspectRatio !== undefined && !(VARIANT_RATIOS as readonly unknown[]).includes(input.aspectRatio)) throw fail('INVALID_REQUEST', `Choose an aspect ratio: ${VARIANT_RATIOS.join(', ')}.`);
      const aspectRatio = input.aspectRatio as VariantRatio | undefined;
      const direction = input.direction === undefined ? '' : typeof input.direction === 'string' ? sanitizeEditInstruction(input.direction) : '\u0000';
      if (direction === '\u0000' || directionProblems(direction).length) throw fail('INVALID_DIRECTION', directionProblems(direction)[0] ?? 'A direction is plain text.');
      // No direction: the concept writer decides (the one-click default).
      const surprise = input.surprise === true || !direction;
      if (input.verify !== undefined && typeof input.verify !== 'boolean') throw fail('INVALID_REQUEST', 'verify is true or false.');
      const wantsVerify = input.verify !== false && services.features().verification.available;
      const now = new Date().toISOString(), labels = cutoutTargets(scene, group.ids).map(o => o.label);
      const signature = JSON.stringify({ analysisId: record.id, ids: [...group.ids].sort(), direction, surprise, count, ...(aspectRatio ? { aspectRatio } : {}) });
      const { set, created } = variants.create(id => {
        const file = `source.${record.upload.file.split('.').at(-1)}`;
        variants.writeFile(id, file, readFileSync(scenes.path(record.id, record.upload.file)));
        return { id, createdAt: now, updatedAt: now, idempotencyKey: String(input.idempotencyKey), template: { id: version.templateId, name: version.name, version: version.version }, analysisId: record.id,
          source: { ...record.upload, file }, protectedIds: group.ids, protectedLabels: labels, ...(direction ? { direction } : {}), surprise, count, state: 'cutout', verify: wantsVerify,
          cutout: { status: 'pending', checks: [], limitations: [] }, variants: Array.from({ length: count }, (_, i): CreativeVariant => ({ id: `v${i + 1}`, title: `Variant ${i + 1}`, scene: '', status: 'pending', attempts: 0, history: [] })),
          usage: { segmentationCalls: 0, conceptCalls: 0, imageGenerationCalls: 0, verificationCalls: 0, models: {} }, signature, selection, ...(aspectRatio ? { aspectRatio } : {}), ...(Object.keys(corrections).length ? { corrections } : {}) } as VariantSet;
      }, String(input.idempotencyKey ?? ''), existing => (existing as VariantSet & { signature?: string }).signature === signature);
      if (created) { log(`[SMART] variant set=${set.id} protected=${group.ids.join(',')} (${selection.basis}) count=${count}${aspectRatio ? ` ratio=${aspectRatio}` : ''}`); schedule(set.id, () => runSet(set.id, 'cutout')); }
      return { set: shownSet(variants.get(set.id)), created };
    },
    set: (id: string) => shownSet(variants.get(id)),
    setFilePath: (id: string, file: string) => variants.path(id, file),
    /** A cutout the user exported from this same image, accepted only if its opaque pixels are the source's own. */
    async uploadCutout(setId: string, png: Buffer) {
      const set = shownSet(variants.get(setId));
      if (active.has(setId)) throw fail('BUSY', 'This set is still working.');
      if (set.cutout.status !== 'needs-cutout') throw fail('NOT_NEEDED', 'This set already has its cutout.');
      const source = await sourceRaster(setFile(set, set.source.file));
      let mask: Uint8Array;
      try { mask = await userCutoutMask(png, source); } catch (error) { throw fail('CUTOUT_REJECTED', describe(error)); }
      const scene = applySceneCorrections(scenes.get(set.analysisId).scene!, set.corrections ?? {}), px = (b: SceneDescription['objects'][number]['box']): PixelBox => ({ x: Math.round(b.x * source.width), y: Math.round(b.y * source.height), width: Math.max(1, Math.round(b.w * source.width)), height: Math.max(1, Math.round(b.h * source.height)) });
      const targets = cutoutTargets(scene, set.protectedIds);
      const check = checkMask(mask, source.width, source.height, targets.map(o => ({ label: o.label, box: regionOf(scene, o, set.protectedIds, px) })),
        [...scene.overlays.map(t => ({ label: t.label, box: px(t.box) })), ...scene.marks.filter(m => m.overlay).map(m => ({ label: m.label, box: px(m.box) }))]);
      const files = await cutoutFiles(source, mask);
      const masks = await saveSubjectMasks(setId, targets, splitMaskByBoxes(mask, source.width, source.height, targets.map(o => regionOf(scene, o, set.protectedIds, px))), source);
      variants.writeFile(setId, 'mask.png', files.mask); variants.writeFile(setId, 'subject.png', files.subject);
      variants.update(setId, s => { s.state = 'concepts'; delete s.error; s.cutout = { status: 'ready', provider: 'user', mask: 'mask.png', subject: 'subject.png', masks, checks: ['Every opaque pixel equals the reference image.', ...check.checks], limitations: [...check.limitations, ...check.problems.map(p => `Your cutout: ${p}`)], coveragePercent: check.coveragePercent, ...(check.box ? { box: check.box } : {}) }; });
      schedule(setId, () => runSet(setId, 'concepts'));
      return shownSet(variants.get(setId));
    },
    /**
     * One more scene-concept call for the variants without a usable scene (after a failed or short answer), then their
     * images. The cutout is kept: no new mask request. Never sent automatically.
     */
    rewriteConcepts(setId: string, input: { idempotencyKey: unknown }) {
      const set = shownSet(variants.get(setId)), key = String(input.idempotencyKey ?? '');
      if (!/^[A-Za-z0-9_-]{8,80}$/.test(key)) throw fail('INVALID_IDEMPOTENCY_KEY', 'Each submission needs an idempotency key.');
      if ((set as VariantSet & { conceptsKey?: string }).conceptsKey === key) return set;
      if (active.has(setId)) throw fail('BUSY', 'This set is still working. Wait for it to finish.');
      if (set.cutout.status !== 'ready') throw fail('CUTOUT_REQUIRED', 'This set needs its cutout first.');
      if (!set.variants.some(needsScene)) throw fail('NOT_NEEDED', 'Every variant already has a scene: regenerate one to change it.');
      variants.update(setId, s => {
        (s as VariantSet & { conceptsKey?: string }).conceptsKey = key; s.state = 'concepts'; delete s.error;
        for (const v of s.variants) if (needsScene(v)) { v.scene = ''; v.status = 'pending'; delete v.error; }
      });
      schedule(setId, () => runSet(setId, 'concepts'));
      return shownSet(variants.get(setId));
    },
    /** One more paid image request for one variant, with its (edited) scene; the previous image stays in its history. */
    regenerate(setId: string, variantId: string, input: { scene: unknown; idempotencyKey: unknown }) {
      const set = shownSet(variants.get(setId)), variant = set.variants.find(v => v.id === variantId);
      if (!variant) throw fail('NOT_FOUND', 'Variant not found.');
      const key = String(input.idempotencyKey ?? '');
      if (!/^[A-Za-z0-9_-]{8,80}$/.test(key)) throw fail('INVALID_IDEMPOTENCY_KEY', 'Each submission needs an idempotency key.');
      if ((variant as CreativeVariant & { lastKey?: string }).lastKey === key) return set;
      if (active.has(setId) || variant.status === 'generating') throw fail('BUSY', 'This set is still generating. Wait for it to finish.');
      if (set.cutout.status !== 'ready') throw fail('CUTOUT_REQUIRED', 'This set needs its cutout first.');
      const scene = cleanScenePrompt(input.scene), problems = scenePromptProblems(scene);
      if (problems.length) throw fail('INVALID_SCENE', problems[0]);
      variants.update(setId, s => {
        const v = s.variants.find(x => x.id === variantId)! as CreativeVariant & { lastKey?: string };
        if (v.image || v.error) v.history.push({ at: new Date().toISOString(), scene: v.scene, ...(v.prompt ? { prompt: v.prompt } : {}), ...(v.image ? { image: v.image } : {}), ...(v.error ? { error: v.error } : {}) });
        v.scene = scene; v.status = 'pending'; v.lastKey = key; delete v.error; delete v.image; delete v.layers; delete v.verification; delete v.preservation; delete v.executionId;
        s.state = 'generating'; delete s.error;
      });
      schedule(setId, async () => { await generateVariant(setId, variantId); settle(setId); });
      return shownSet(variants.get(setId));
    },
    /** The chosen variant as a reviewed execution: no new call; it continues through review, plan choice and decomposition. */
    selectVariant(setId: string, variantId: string, input: { idempotencyKey: unknown }): { execution: TemplateExecution; created: boolean } {
      const set = variants.get(setId), v = set.variants.find(x => x.id === variantId);
      if (!v) throw fail('NOT_FOUND', 'Variant not found.');
      if (v.executionId) { try { return { execution: executions.get(v.executionId), created: false }; } catch { /* its execution is gone: make a new one */ } }
      if (v.status !== 'done' || !v.image || !v.layers) throw fail('NOT_READY', 'Only a finished variant can be used.');
      const bytes = readFileSync(variants.path(setId, v.image.file));
      if (sha256(bytes) !== v.image.sha256) throw fail('INPUT_IDENTITY_MISMATCH', 'The saved variant image changed on disk; regenerate it.');
      const limitations = set.cutout.limitations, verification = v.verification ?? uncheckedVerification('The AI check was not asked for.');
      const review: GenerationReview = { method: 'creative-variant', semantic: verification,
        checks: [...limitations.map((message): GenerationReviewCheck => ({ id: 'cutout-limitation', severity: 'warning', message, evidence: {} })), ...semanticChecks(verification)],
        requiresAcknowledgement: !!limitations.length || verification.status === 'contradiction',
        note: `The protected ${set.protectedLabels.length > 1 ? 'products are' : 'product is'} the reference's own pixels${v.preservation?.scale !== undefined && v.preservation.scale < 1 ? `, scaled once to ${Math.round(v.preservation.scale * 100)}% (never redrawn)` : ''} (measured: ${v.preservation?.checkedPixels ?? 0} opaque pixels identical${v.preservation?.edgePixels !== undefined ? `, ${v.preservation.edgePixels} soft edge pixels blended as expected, none outside the cutout` : ''}). The scenery around ${set.protectedLabels.length > 1 ? 'them' : 'it'} is new: check it, the edges and the light.` };
      const files: Record<string, Buffer | object> = {};
      for (const layer of [v.layers.scenery, v.layers.plate, v.layers.shadow, v.layers.subject, ...(v.layers.subjects ?? []), ...(v.layers.shadows ?? [])]) if (layer) files[`variant-${layer.file}`] = readFileSync(variants.path(setId, layer.file));
      if (v.responseFile) files['edit.openai-response.json'] = JSON.parse(readFileSync(variants.path(setId, v.responseFile), 'utf8'));
      if (v.requestFile) files['edit.openai-request.json'] = JSON.parse(readFileSync(variants.path(setId, v.requestFile), 'utf8'));
      // The set's own calls that led to this image, for its diagnostics: its AI check, and the shared scene concepts.
      for (const [from, to] of [[v.verification?.requestFile, 'verification.openai-request.json'], [v.verification?.responseFile, 'verification.openai-response.json'], [set.concepts?.requestFile, 'concepts.openai-request.json'], [set.concepts?.responseFile, 'concepts.openai-response.json']] as const) {
        try { if (from) files[to] = JSON.parse(readFileSync(variants.path(setId, from), 'utf8')); } catch { /* missing: its usage stays unknown */ }
      }
      const rename = <T extends ExecutionImage>(l: T): T => ({ ...l, file: `variant-${l.file}` });
      const result = executions.create({ mode: 'REUSE_TEMPLATE_WITH_EDIT', reviewBeforeDecompose: true, idempotencyKey: String(input.idempotencyKey ?? ''), template: set.template,
        editInstruction: `creative variant ${setId} ${variantId} attempt ${v.attempts}`, upload: { bytes: readFileSync(variants.path(setId, set.source.file)), ext: set.source.file.split('.').at(-1)!, mimeType: set.source.mimeType, width: set.source.width, height: set.source.height, ...(set.source.originalName ? { originalName: set.source.originalName } : {}) },
        compatibility: { status: 'structural-change', changedSlots: [], reasons: ['The scenery is new: the template\'s saved plan describes the original scene.'] },
        prepared: { image: { bytes, ext: 'png', mimeType: 'image/png', width: v.image.width, height: v.image.height }, prompt: v.prompt ?? '', model: v.model ?? '', size: v.size ?? '', review, files,
          requestFile: v.requestFile ? 'edit.openai-request.json' : undefined, responseFile: v.responseFile ? 'edit.openai-response.json' : undefined, durationMs: v.durationMs,
          variant: { setId, variantId, layers: { scenery: rename(v.layers.scenery), plate: rename(v.layers.plate), ...(v.layers.shadow ? { shadow: rename(v.layers.shadow) } : {}), subject: rename(v.layers.subject),
            ...(v.layers.subjects ? { subjects: v.layers.subjects.map(rename) } : {}), ...(v.layers.shadows ? { shadows: v.layers.shadows.map(rename) } : {}) }, protectedLabels: set.protectedLabels,
            ...(set.aspectRatio ? { aspectRatio: set.aspectRatio, scale: v.layout?.scale ?? 1 } : {}) },
          verificationCalls: v.verification && v.verification.status !== 'unchecked' ? 1 : 0, verifierModel: v.verification?.model } });
      variants.update(setId, s => { s.variants.find(x => x.id === variantId)!.executionId = result.execution.id; });
      return result;
    },
  };
}
export type SmartCreative = ReturnType<typeof createSmartCreative>;
export const newSmartId = newRecordId;
