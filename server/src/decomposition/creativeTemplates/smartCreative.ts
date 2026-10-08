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
import { applySceneCorrections, basePlan, canonicalDraft, cleanCorrections, cleanDraft, cleanScenePrompt, closestGenerationRatio, compileResolvedEdit, compileVariantPrompt, describeTemplateSlots, directionProblems,
  GENERATION_IMAGE_SIZES, isForeground, lightingSentence, mapSceneToSlots, mergeResolution, needsResolver, planExpectations, protectedGroup, sanitizeEditInstruction, SCENE_SCHEMA_VERSION, sceneSimilarity, scenePromptProblems,
  SEMANTIC_NOTE, uncheckedVerification, VARIANT_LIMITS, variantExpectations, verificationStatus, type ChangePlan, type CreativeVariant, type ExecutionImage, type GenerationReview, type GenerationReviewCheck,
  type SceneDescription, type SemanticExpectation, type SemanticVerification, type TemplateExecution, type TemplateRole, type TemplateVersion, type VariantSet } from '@frameflow/shared';
import { imageFailureCode, imageFileType, responseWithoutImage, returnedImage, type ApiFailure, type GenerationConfig } from '../generationGroups.js';
import { referenceForPrompt, validateReferenceUpload } from '../imageTemplates.js';
import { RunError } from '../layerizeExperiment.js';
import type { ExecutionStore } from './executions.js';
import type { TemplateStore } from './store.js';
import type { ChangeResolver, ConceptWriter, SceneAnalyzer, SemanticVerifier } from './smartProviders.js';
import type { Segmenter } from './segmenter.js';
import { newRecordId, sha256, type ResolutionRecord, type SceneAnalysisRecord, type SceneStore, type VariantStore } from './smartStores.js';
import { checkMask, composeVariant, cutoutFiles, generationInputs, maskRaster, sourceRaster, userCutoutMask, type PixelBox } from './variantCompose.js';

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
  async function cutout(setId: string, scene: SceneDescription) {
    const set = variants.get(setId), source = await sourceRaster(setFile(set, set.source.file)), segmenter = services.providers.segmenter?.();
    if (!segmenter) { variants.update(setId, s => { s.state = 'needs-cutout'; s.cutout = { ...s.cutout, status: 'needs-cutout', checks: [], limitations: [], error: { code: 'CUTOUT_REQUIRED', message: 'No mask provider is configured: upload a cutout PNG exported from this image (transparent background).' } }; }); return false; }
    const px = (b: SceneDescription['objects'][number]['box']): PixelBox => ({ x: Math.round(b.x * source.width), y: Math.round(b.y * source.height), width: Math.max(1, Math.round(b.w * source.width)), height: Math.max(1, Math.round(b.h * source.height)) });
    const subjects = set.protectedIds.map(id => scene.objects.find(o => o.id === id)!).filter(Boolean);
    variants.update(setId, s => { s.state = 'cutout'; s.cutout.status = 'segmenting'; s.cutout.provider = segmenter.provider; s.usage.segmentationCalls += segmenter.provider === 'birefnet' ? 1 : subjects.length; });
    try {
      const { mask: png, requestIds } = await segmenter.segment({ image: setFile(set, set.source.file), width: source.width, height: source.height, targets: subjects.map(o => ({ label: o.category, box: px(o.box) })) }, (file, value) => variants.writeFile(setId, file, value));
      const mask = await maskRaster(png, source.width, source.height);
      const overlaps = [...scene.overlays.map(t => ({ label: `${t.label} ${t.zone.replace('-', ' ')}`, box: px(t.box) })), ...scene.marks.filter(m => m.overlay).map(m => ({ label: m.label, box: px(m.box) }))];
      const check = checkMask(mask, source.width, source.height, subjects.map(o => ({ label: o.label, box: px(o.box) })), overlaps);
      if (!check.ok) {
        variants.update(setId, s => { s.state = 'needs-cutout'; s.cutout = { ...s.cutout, status: 'needs-cutout', requestIds, checks: check.checks, limitations: check.limitations, coveragePercent: check.coveragePercent, error: { code: 'CUTOUT_UNRELIABLE', message: `The automatic cutout is not reliable: ${check.problems.join(' ')} Upload a cutout PNG exported from this image to continue; nothing is redrawn instead.` } }; });
        return false;
      }
      const files = await cutoutFiles(source, mask);
      variants.writeFile(setId, 'mask.png', files.mask); variants.writeFile(setId, 'subject.png', files.subject);
      variants.update(setId, s => { s.cutout = { status: 'ready', provider: segmenter.provider, mask: 'mask.png', subject: 'subject.png', requestIds, checks: check.checks, limitations: check.limitations, coveragePercent: check.coveragePercent, ...(check.box ? { box: check.box } : {}) }; });
      return true;
    } catch (error) {
      variants.update(setId, s => { s.state = 'needs-cutout'; s.cutout = { ...s.cutout, status: 'needs-cutout', checks: [], limitations: [], error: { code: errorCode(error, 'SEGMENTATION_FAILED'), message: `${describe(error)} Upload a cutout PNG exported from this image to continue.` } }; });
      return false;
    }
  }
  async function concepts(setId: string, scene: SceneDescription) {
    const set = variants.get(setId);
    if (set.variants.every(v => v.scene)) return;
    if (set.count === 1 && set.direction) { variants.update(setId, s => { s.concepts = { status: 'skipped' }; s.variants[0].scene = s.direction!; s.variants[0].title = 'Your direction'; }); return; }
    const writer = services.providers.concepts?.();
    if (!writer) { variants.update(setId, s => { s.state = 'failed'; s.concepts = { status: 'failed', error: { code: 'CONCEPTS_UNAVAILABLE', message: 'The concept writer is not configured.' } }; }); return; }
    variants.update(setId, s => { s.state = 'concepts'; s.usage.conceptCalls += 1; s.usage.models.concepts = writer.model; });
    try {
      const subjects = set.protectedIds.map(id => scene.objects.find(o => o.id === id)?.category).filter((c): c is string => !!c);
      const written = await writer.write({ subjects, summary: scene.summary, lighting: lightingSentence(scene.lighting), ...(set.direction ? { direction: set.direction } : {}), count: set.count }, (file, value) => variants.writeFile(setId, file, value));
      variants.update(setId, s => {
        s.concepts = { status: 'done', model: writer.model, requestFile: 'concepts.openai-request.json', responseFile: 'concepts.openai-response.json' };
        const kept: string[] = [];
        s.variants.forEach((v, i) => {
          const c = written[i], text = cleanScenePrompt(c?.scene ?? ''), problems = scenePromptProblems(text);
          v.title = sanitizeEditInstruction(c?.title ?? '').slice(0, VARIANT_LIMITS.title) || `Variant ${i + 1}`; v.scene = text;
          // A concept that asks for text, or repeats another, is not sent: the user writes or edits it.
          const repeat = kept.find(k => sceneSimilarity(k, text) >= 0.7);
          if (problems.length || repeat) { v.status = 'failed'; v.error = { code: 'CONCEPT_REJECTED', message: problems.length ? `This concept was not sent: ${problems[0]} Edit the scene and regenerate.` : 'This concept nearly repeats another one and was not sent. Edit the scene and regenerate.' }; }
          else kept.push(text);
        });
      });
    } catch (error) {
      variants.update(setId, s => { s.state = 'failed'; s.concepts = { status: 'failed', model: writer.model, error: { code: errorCode(error, 'CONCEPTS_FAILED'), message: describe(error) } }; s.error = { code: 'CONCEPTS_FAILED', message: `No concepts were written: ${describe(error)} No image was generated.` }; });
    }
  }
  async function generateVariant(setId: string, variantId: string) {
    const set = variants.get(setId), analysis = scenes.get(set.analysisId), scene = applySceneCorrections(analysis.scene!, set.corrections ?? {});
    const attempt = set.variants.find(v => v.id === variantId)!.attempts + 1, prefix = `${variantId}-a${attempt}`, config = services.generation(), started = Date.now();
    variants.update(setId, s => { const v = s.variants.find(x => x.id === variantId)!; v.status = 'generating'; v.attempts = attempt; v.startedAt = new Date().toISOString(); delete v.error; s.usage.imageGenerationCalls += 1; s.usage.models.image = config.model; });
    try {
      const v = variants.get(setId).variants.find(x => x.id === variantId)!;
      const people = set.protectedIds.some(id => ['person', 'character'].includes(scene.objects.find(o => o.id === id)?.kind ?? ''));
      const prompt = compileVariantPrompt({ protectedLabels: set.protectedLabels, lighting: scene.lighting, scene: v.scene, people });
      const source = await sourceRaster(setFile(set, set.source.file)), mask = await maskRaster(setFile(set, 'mask.png'), source.width, source.height);
      const size = GENERATION_IMAGE_SIZES[closestGenerationRatio(source.width, source.height)], inputs = await generationInputs(source, mask, size), sizeText = `${size.width}x${size.height}`;
      variants.writeFile(setId, `${prefix}.openai-request.json`, { method: 'images.edit', model: config.model, prompt, size: sizeText, n: 1, output_format: 'png', image: '<the reference, contained in the canvas>', mask: '<transparent everywhere but the protected subject>' });
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
      const composed = await composeVariant(generated.bytes, inputs.placement, source, mask);
      const image = (file: string, bytes: Buffer, width: number, height: number): ExecutionImage => { variants.writeFile(setId, file, bytes); return { file, mimeType: 'image/png', width, height, bytes: bytes.length, sha256: sha256(bytes) }; };
      const composite = image(`${prefix}-composite.png`, composed.composite, source.width, source.height);
      const layers: NonNullable<CreativeVariant['layers']> = {
        scenery: image(`${prefix}-scenery.png`, composed.scenery, source.width, source.height), plate: image(`${prefix}-plate.png`, composed.plate, source.width, source.height),
        ...(composed.shadow ? { shadow: { ...image(`${prefix}-shadow.png`, composed.shadow.png, composed.shadow.placement.width, composed.shadow.placement.height), placement: composed.shadow.placement } } : {}),
        subject: { ...image(`${prefix}-subject.png`, composed.subject.png, composed.subject.placement.width, composed.subject.placement.height), placement: composed.subject.placement } };
      if (composed.preservation.maxDifference > 0) throw Object.assign(new Error(`The subject's source pixels changed in the composite (max difference ${composed.preservation.maxDifference}); the result was not used.`), { code: 'PRESERVATION_FAILED' });
      let verification: SemanticVerification | undefined;
      if (set.verify) {
        const checkedOnce = await verify(setFile(set, set.source.file), composed.composite, variantExpectations(scene, set.protectedIds), (file, value) => variants.writeFile(setId, file, value), `${prefix}-`);
        verification = checkedOnce.verification;
        if (checkedOnce.called) variants.update(setId, s => { s.usage.verificationCalls += 1; s.usage.models.verifier = verification!.model ?? ''; });
      }
      variants.update(setId, s => { const x = s.variants.find(y => y.id === variantId)!; Object.assign(x, { status: 'done', image: composite, layers, preservation: { method: 'exact-source-pixels', ...composed.preservation }, responseFile: `${prefix}.openai-response.json`, durationMs: Date.now() - started, finishedAt: new Date().toISOString(), ...(verification ? { verification } : {}) }); });
      log(`[SMART] variant done set=${setId} ${variantId} attempt=${attempt} preserved=${composed.preservation.checkedPixels}px`);
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
      if (cached && !(cached.resolver.called === false && needsResolver(corrected, draft) && !input.rulesOnly)) return { resolution: cached, created: false };
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
        return scenes.updateResolution(analysisId, resolution.id, r => { r.state = 'ready'; r.plan = plan; r.rejected = rejected; r.resolver = resolver; if (compiled) { r.prompt = compiled.text; r.summary = compiled.summary; } });
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
      const scene = applySceneCorrections(record.scene!, cleanCorrections(record.scene!, resolution.draft.corrections));
      return { scene, compiled: compileResolvedEdit(scene, resolution.plan!, { productReference: !!resolution.binding.referenceSha256 }), expectations: planExpectations(scene, resolution.plan!),
        // A replaced or removed object (asked or inferred) can never be confirmed by pixels: a person looks at it.
        objectChange: resolution.plan!.entries.some(e => e.operation === 'replace' || e.operation === 'remove') };
    },
    verify, semanticChecks,

    // ── Variant sets ──
    async startVariants(input: { analysisId: unknown; templateId: unknown; templateVersion: unknown; protectedIds: unknown; corrections?: unknown; direction?: unknown; surprise?: unknown; count?: unknown; verify?: unknown; idempotencyKey: unknown }) {
      const f = services.features().variants;
      if (!f.available) throw fail('VARIANTS_UNAVAILABLE', f.reason ?? 'Creative variants are unavailable.');
      if (typeof input.analysisId !== 'string') throw fail('INVALID_REQUEST', 'Analyze the image first.');
      const record = readyAnalysis(input.analysisId), version = versionFor(input.templateId, input.templateVersion);
      if (record.binding.templateId !== version.templateId || record.binding.templateVersion !== version.version) throw fail('STALE_RESOLUTION', 'The template changed since the image was analyzed. Analyze it again.');
      const corrections = checked(() => cleanCorrections(record.scene!, input.corrections)), scene = applySceneCorrections(record.scene!, corrections);
      if (!Array.isArray(input.protectedIds) || !input.protectedIds.length || input.protectedIds.length > 8 || input.protectedIds.some(id => typeof id !== 'string' || !scene.objects.some(o => o.id === id && isForeground(o) && !o.ignored)))
        throw fail('PROTECTED_REQUIRED', 'Confirm which detected products or subjects must stay exactly as they are.');
      const group = protectedGroup(scene, input.protectedIds as string[]);
      const count = input.count === undefined ? 3 : Number(input.count);
      if (!Number.isSafeInteger(count) || count < VARIANT_LIMITS.min || count > VARIANT_LIMITS.max) throw fail('INVALID_REQUEST', `Choose ${VARIANT_LIMITS.min}–${VARIANT_LIMITS.max} variants.`);
      const direction = input.direction === undefined ? '' : typeof input.direction === 'string' ? sanitizeEditInstruction(input.direction) : '\u0000';
      if (direction === '\u0000' || directionProblems(direction).length) throw fail('INVALID_DIRECTION', directionProblems(direction)[0] ?? 'A direction is plain text.');
      const surprise = input.surprise === true;
      if (!direction && !surprise) throw fail('INVALID_DIRECTION', 'Describe a direction, or choose Surprise me.');
      if (input.verify !== undefined && typeof input.verify !== 'boolean') throw fail('INVALID_REQUEST', 'verify is true or false.');
      const wantsVerify = input.verify !== false && services.features().verification.available;
      const now = new Date().toISOString(), labels = group.ids.map(id => scene.objects.find(o => o.id === id)!.label);
      const signature = JSON.stringify({ analysisId: record.id, ids: [...group.ids].sort(), direction, surprise, count });
      const { set, created } = variants.create(id => {
        const file = `source.${record.upload.file.split('.').at(-1)}`;
        variants.writeFile(id, file, readFileSync(scenes.path(record.id, record.upload.file)));
        return { id, createdAt: now, updatedAt: now, idempotencyKey: String(input.idempotencyKey), template: { id: version.templateId, name: version.name, version: version.version }, analysisId: record.id,
          source: { ...record.upload, file }, protectedIds: group.ids, protectedLabels: labels, ...(direction ? { direction } : {}), surprise, count, state: 'cutout', verify: wantsVerify,
          cutout: { status: 'pending', checks: [], limitations: [] }, variants: Array.from({ length: count }, (_, i): CreativeVariant => ({ id: `v${i + 1}`, title: `Variant ${i + 1}`, scene: '', status: 'pending', attempts: 0, history: [] })),
          usage: { segmentationCalls: 0, conceptCalls: 0, imageGenerationCalls: 0, verificationCalls: 0, models: {} }, signature, ...(Object.keys(corrections).length ? { corrections } : {}) } as VariantSet;
      }, String(input.idempotencyKey ?? ''), existing => (existing as VariantSet & { signature?: string }).signature === signature);
      if (created) { log(`[SMART] variant set=${set.id} protected=${group.ids.join(',')} count=${count}`); schedule(set.id, () => runSet(set.id, 'cutout')); }
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
      const check = checkMask(mask, source.width, source.height, set.protectedIds.map(id => scene.objects.find(o => o.id === id)!).map(o => ({ label: o.label, box: px(o.box) })),
        [...scene.overlays.map(t => ({ label: t.label, box: px(t.box) })), ...scene.marks.filter(m => m.overlay).map(m => ({ label: m.label, box: px(m.box) }))]);
      const files = await cutoutFiles(source, mask);
      variants.writeFile(setId, 'mask.png', files.mask); variants.writeFile(setId, 'subject.png', files.subject);
      variants.update(setId, s => { s.state = 'concepts'; delete s.error; s.cutout = { status: 'ready', provider: 'user', mask: 'mask.png', subject: 'subject.png', checks: ['Every opaque pixel equals the reference image.', ...check.checks], limitations: [...check.limitations, ...check.problems.map(p => `Your cutout: ${p}`)], coveragePercent: check.coveragePercent, ...(check.box ? { box: check.box } : {}) }; });
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
        note: `The protected subject is the reference's own pixels (measured: ${v.preservation?.checkedPixels ?? 0} fully opaque pixels identical). The scenery around it is new: check it, its edges and its light.` };
      const files: Record<string, Buffer | object> = {};
      for (const layer of [v.layers.scenery, v.layers.plate, v.layers.shadow, v.layers.subject]) if (layer) files[`variant-${layer.file}`] = readFileSync(variants.path(setId, layer.file));
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
          variant: { setId, variantId, layers: { scenery: rename(v.layers.scenery), plate: rename(v.layers.plate), ...(v.layers.shadow ? { shadow: rename(v.layers.shadow) } : {}), subject: rename(v.layers.subject) }, protectedLabels: set.protectedLabels },
          verificationCalls: v.verification && v.verification.status !== 'unchecked' ? 1 : 0, verifierModel: v.verification?.model } });
      variants.update(setId, s => { s.variants.find(x => x.id === variantId)!.executionId = result.execution.id; });
      return result;
    },
  };
}
export type SmartCreative = ReturnType<typeof createSmartCreative>;
export const newSmartId = newRecordId;
