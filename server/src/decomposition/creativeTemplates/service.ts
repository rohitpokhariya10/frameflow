/**
 * Automatic uploads first inspect exact-image evidence or one structure-only response, then resolve an execution mode.
 * This service enforces which planner/image calls that mode may make; inspection has separate persisted telemetry.
 *
 *   CREATE_TEMPLATE            upload → GPT planner (it also returns the template capture) → Seedream + refinement
 *                              → template v1 saved (only now: a failure leaves no template)
 *   REUSE_TEMPLATE_ORIGINAL    upload → the template's saved plan (no planner, no analysis, no generation) → Seedream + refinement
 *   REUSE_TEMPLATE_WITH_EDIT   upload → ONE image edit (saved prompt + the user's change) → saved plan → Seedream + refinement
 *
 * Guards, three deep: the deps a reuse run gets have no planner (calling it throws PlannerNotAllowedError), and
 * createRun and executeRun refuse planning for a reuse execution's run on their own (layerizeExperiment.ts). Image
 * generation is reached only in REUSE_TEMPLATE_WITH_EDIT. Every decision is logged: [TEMPLATE] [PLANNER] [GENERATION] [DECOMPOSE].
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { join } from 'node:path';
import { compileResolvedEdit, layeredPlans, SEEDREAM_PLANS, sameTemplateStructure, compileEditPrompt, compileSlotInstruction, compileTemplateEdit, GENERATE_UNCHANGED_INSTRUCTION, editInstructionProblems, EXECUTION_POLICY, EXTRACTION_PLANS, isExecutionMode, sanitizeEditInstruction, type CompiledTemplateEdit, type ExecutionMode, type ExecutionState, type ExecutionImage, type ExtractionPlan, type GenerationReview, type SmartEditStrategyRecord, type TemplateEditOptions, type TemplateExecution, type TemplateStructure, type TemplateVersion, type TemplateInspection, type SceneObject } from '@frameflow/shared';
import type { GenerationConfig } from '../generationGroups.js';
import { validateReferenceUpload } from '../imageTemplates.js';
import { createRun, executeRun, saveRunRecord, PlannerNotAllowedError, readRun, resumeRun, RunError, SEEDREAM_ENDPOINT, type RunnerDeps, type RunRecord, type Stage } from '../layerizeExperiment.js';
import type { Planner } from '../layerizePlanner.js';
import { captureTemplateVersion } from './capture.js';
import { compileSimpleTemplatePlan, compileTemplatePlan, templatePlanPrompt, templatePlanStrategy, withoutSlots } from './compile.js';
import { QWEN_ENDPOINT, qwenEditorLayers, requestQwenLayers, type QwenLayerLabel } from './qwenLayers.js';
import { addVariantLayers, createComposedRun, type VariantRunLayer } from './composedRun.js';
import type { SmartCreative } from './smartCreative.js';
import { reviewGeneration } from './review.js';
import type { ExecutionStore } from './executions.js';
import { ImageEditError } from './imageEdit.js';
import { smartEditImage } from './smartEditImage.js';
import { maskPose } from './slotPose.js';
import { continueScenery, maskBox, refineEdges, sourceRaster, type VariantSubject } from './variantCompose.js';
import { classifySeedreamRejection } from '../providerImage.js';
import type { TemplateStore } from './store.js';
import type { StructureInspector } from './inspect.js';

export type TemplateServices = {
  templates: TemplateStore; executions: ExecutionStore; runsDir: string;
  deps: () => RunnerDeps; generation: () => GenerationConfig;
  inspector?: () => StructureInspector;
  /** Smart edits (resolved change plans) and creative variants: their binding checks, review inputs and AI check. */
  smart?: SmartCreative;
  /** Runs work when no other decomposition is active, one at a time, in the order asked (the router's turn). */
  inTurn: (label: string, work: () => Promise<unknown>) => void;
  log?: (line: string) => void;
};
export type StartRequest = { mode: unknown; values?: unknown; analysisId?: unknown; resolutionId?: unknown; draft?: unknown; options?: unknown;
  /** Nothing to change, and the user explicitly asks for a new image anyway (otherwise the original is reviewed, no call). */
  regenerateUnchanged?: boolean; updatesTemplate?: TemplateExecution['updatesTemplate']; productReference?: { bytes: Buffer; fileName?: string; mimeType?: string }; reviewBeforeDecompose?: boolean; templateVersion?: number; allowMismatch?: boolean; inspect?: boolean; planFresh?: boolean; idempotencyKey: unknown; templateId?: unknown; editInstruction?: unknown; upload: { bytes: Buffer; fileName?: string; mimeType?: string } };
/** Run stages, as the execution shows them. */
const STATE_OF: Partial<Record<Stage, ExecutionState>> = { planning: 'planning', planned: 'decomposing', uploading: 'decomposing', submitting: 'decomposing', queued: 'decomposing', in_progress: 'decomposing', downloading: 'decomposing', refining: 'decomposing' };
/** fal's stored answer for these is final: resuming would read the same error. */
const FINAL_RUN_ERRORS = new Set(['PROVIDER_DECOMPOSITION_REJECTED', 'PROVIDER_SAFETY_REJECTED']);
/** A creative variant's new scenery, as a template version: what its scenery-only extraction asks for (no planner). */
function sceneryVersion(version: TemplateVersion): TemplateVersion {
  const structure: TemplateStructure = { layers: [{ id: 'background', role: 'background', order: 0, independent: true, required: true, zone: 'full-canvas' },
    { id: 'backdrop', role: 'backdrop', order: 1, independent: true, required: false, zone: 'center' }, { id: 'decoration', role: 'decoration', order: 2, independent: true, required: false }], relationships: [] };
  return { ...version, name: `${version.name} · new scenery`, description: 'New scenery around a subject that is added back as its own exact layer.', structure,
    plan: { strategy: templatePlanStrategy(structure), prompt: templatePlanPrompt(structure, true), recommendedLayers: 3, occlusionWording: true } };
}
/** Plans a creative variant may be extracted with: its own composed layers, or its new scenery split (simply, or with a fresh plan). */
const VARIANT_PLANS: readonly ExtractionPlan[] = ['composed', 'simple', 'refresh'];

export function createTemplateExecutions(services: TemplateServices) {
  const { templates, executions, runsDir } = services, log = services.log ?? ((line: string) => console.info(line));
  /** Executions this process is working on or has queued; any other non-final one was interrupted by a restart. */
  const active = new Set<string>();
  // A match must have both a compatible structure and a usable saved blueprint/prompt.
  const usableVersion = (id: string, number: number) => {
    try {
      if (templates.get(id)?.status !== 'active') return undefined;
      const version = templates.version(id, number);
      if (!version) return undefined;
      compileTemplatePlan(version); compileEditPrompt(version.generationPrompt, 'Keep the composition.');
      return version;
    } catch { return undefined; }
  };
  /** The canonical edit of a template's fields (shared with the wizard's preview): the prompt sent is the prompt shown. */
  const compileEdit = (version: TemplateVersion, values: unknown, options: TemplateEditOptions, productReference: boolean): CompiledTemplateEdit => {
    try { return compileTemplateEdit(version, values, { ...options, productReference }); }
    catch (error) { throw new RunError('INVALID_EDIT_INSTRUCTION', error instanceof Error ? error.message : 'Invalid template fields.'); }
  };
  const editOptionsOf = (value: unknown): TemplateEditOptions => {
    if (value === undefined) return {};
    const o = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined, main = o?.mainProduct as Record<string, unknown> | undefined;
    const decisions = o?.textDecisions as Record<string, unknown> | undefined;
    if (!o || Object.keys(o).some(k => k !== 'mainProduct' && k !== 'textDecisions') || (main !== undefined && (typeof main !== 'object' || Array.isArray(main) || Object.keys(main).some(k => !['mode', 'brand', 'keepSupporting'].includes(k))))
      || (decisions !== undefined && (!decisions || typeof decisions !== 'object' || Array.isArray(decisions) || Object.values(decisions).some(v => v !== 'keep' && v !== 'remove'))))
      throw new RunError('INVALID_REQUEST', 'Edit options may only say how the main product changes, and keep or remove for text fields.');
    if (main?.mode !== undefined && main.mode !== 'replace' && main.mode !== 'details') throw new RunError('INVALID_REQUEST', 'The main product is either replaced or changed in detail.');
    if (main?.brand !== undefined && typeof main.brand !== 'string') throw new RunError('INVALID_REQUEST', 'A brand is plain text.');
    if (main?.keepSupporting !== undefined && typeof main.keepSupporting !== 'boolean') throw new RunError('INVALID_REQUEST', 'keepSupporting is true or false.');
    const textDecisions = decisions && Object.keys(decisions).length ? { textDecisions: decisions as Record<string, 'keep' | 'remove'> } : {};
    return main ? { ...textDecisions, mainProduct: { ...(main.mode ? { mode: main.mode as 'replace' | 'details' } : {}), ...(typeof main.brand === 'string' && main.brand.trim() ? { brand: sanitizeEditInstruction(main.brand) } : {}), ...(main.keepSupporting !== undefined ? { keepSupporting: main.keepSupporting as boolean } : {}) } } : textDecisions;
  };
  /** The template's own source creative: its run holds exact layer shapes for the local review. */
  const sourceRunFor = (version: TemplateVersion, uploadSha: string) => {
    try { return executions.get(version.source.executionId).upload.sha256 === uploadSha ? join(runsDir, version.source.runId) : undefined; } catch { return undefined; }
  };
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const slotInstruction = (version: TemplateVersion | undefined, values: unknown): string => {
    try { return compileSlotInstruction(version, values); }
    catch (error) { throw new RunError('INVALID_EDIT_INSTRUCTION', error instanceof Error ? error.message : 'Invalid template fields.'); }
  };
  /** No AI: warn only from saved evidence or a substantial canvas-shape change. Never choose a replacement. */
  const localFitWarnings = (version: TemplateVersion, bytes: Buffer, width: number, height: number): string[] => {
    const warnings: string[] = [], hash = createHash('sha256').update(bytes).digest('hex');
    const known = executions.list({ limit: Number.MAX_SAFE_INTEGER }).find(e => e.state === 'done' && !e.warnings.length && e.upload.sha256 === hash && e.template);
    const prior = known?.template && templates.version(known.template.id, known.template.version);
    // Evidence from this same template is never a mismatch (a structure without zones never proves sameness, even to itself).
    if (prior && prior.templateId !== version.templateId && !sameTemplateStructure(version.structure, prior.structure)) warnings.push('TEMPLATE_FIT_WARNING: Saved evidence for this exact upload has different roles or positions from the selected template.');
    try {
      const source = executions.get(version.source.executionId).upload;
      if (Math.abs(Math.log((width / height) / (source.width / source.height))) > Math.log(1.35)) warnings.push('TEMPLATE_FIT_WARNING: The canvas shape differs substantially from the selected template example.');
    } catch { /* Older imported versions may have no source execution; missing evidence is not a mismatch. */ }
    return warnings;
  };
  const inspect = async (id: string) => {
    const execution = executions.get(id), started = Date.now();
    const evidence: TemplateInspection = { outcome: 'new', reason: 'New layout detected. The planner will run once to create a reusable template.', currentValues: {}, calls: 0 };
    let selected: TemplateExecution['template'];
    try {
      const exact = executions.list({ limit: Number.MAX_SAFE_INTEGER }).find(e => e.state === 'done' && !e.warnings.length && e.upload.sha256 === execution.upload.sha256 && e.template && usableVersion(e.template.id, e.template.version));
      if (exact?.template) {
        selected = exact.template;
        Object.assign(evidence, { outcome: 'exact', confidence: 1, currentValues: exact.inspection?.currentValues ?? {}, reason: 'Exact upload found. Its saved prompt and decomposition blueprint can be reused.' });
      } else if (templates.list().length) {
        const inspector = services.inspector?.();
        if (!inspector) throw new Error('Structure inspection is unavailable.');
        Object.assign(evidence, { calls: 1, model: inspector.model, requestFile: 'structure.openai-request.json' });
        executions.update(id, x => { x.inspection = { ...evidence }; }); // Record the attempt before making it.
        const answer = await inspector.inspect(readFileSync(executions.path(id, execution.upload.file)), execution.upload.mimeType, (file, value) => {
          executions.writeFile(id, file, value);
          if (file === 'structure.openai-response.json') evidence.responseFile = file;
        });
        Object.assign(evidence, { structure: answer.structure, confidence: answer.confidence, responseFile: 'structure.openai-response.json' });
        const structural = templates.list().filter(t => { const v = templates.current(t.id); return v && sameTemplateStructure(v.structure, answer.structure); });
        const compatible = structural.map(t => usableVersion(t.id, t.currentVersion)).filter((v): v is TemplateVersion => !!v);
        if (answer.confidence < 0.85) Object.assign(evidence, { outcome: 'uncertain', reason: 'Low structural confidence. A fresh planner will validate the layout once.' });
        else if (compatible.length > 1) Object.assign(evidence, { outcome: 'uncertain', reason: 'Multiple compatible layouts found. A fresh planner will validate the layout once.' });
        else if (compatible.length === 1) {
          const version = compatible[0];
          selected = { id: version.templateId, name: version.name, version: version.version };
          Object.assign(evidence, { outcome: answer.confidence >= 0.9 ? 'strong' : 'compatible', reason: 'Roles, positions and attachments match. The saved blueprint and prompt passed local validation.' });
          const unused = [...answer.structure.layers];
          for (const slot of version.structure.layers) {
            const index = unused.findIndex(l => l.role === slot.role && l.zone === slot.zone);
            if (index >= 0) evidence.currentValues[slot.id] = answer.values[unused.splice(index, 1)[0].id] ?? '';
          }
        }
        else if (structural.length) Object.assign(evidence, { outcome: 'uncertain', reason: 'Template validation failed. A fresh planner will create a usable blueprint.' });
      }
    } catch {
      Object.assign(evidence, { outcome: 'uncertain', reason: 'Structure analysis could not be validated. A fresh planner will run once; no template has been selected.' });
    }
    evidence.durationMs = Date.now() - started;
    return executions.update(id, x => {
      x.inspection = evidence; x.state = 'ready'; x.template = selected;
      if (selected) { x.mode = 'REUSE_TEMPLATE_ORIGINAL'; delete x.plannerReason; x.usage.generationPromptSource = 'saved-template'; x.usage.decompositionPlanSource = 'saved-template'; }
    });
  };
  const failed = (id: string, code: string, message: string, state: ExecutionState, started: number) => executions.update(id, (x) => {
    x.state = 'failed'; x.error = { code, message, state }; x.finishedAt = new Date().toISOString(); x.usage.timings.totalMs = Date.now() - started;
  });
  /** The run's deps for this mode: a reuse has no planner at all, and every run stage is mirrored on the execution. */
  const depsFor = (execution: TemplateExecution): RunnerDeps => {
    const base = services.deps(), mode = execution.mode;
    const planner: Planner = EXECUTION_POLICY[mode].planner || execution.planDecision?.choice === 'refresh' ? base.planner : async () => { throw new PlannerNotAllowedError({ executionId: execution.id, mode }); };
    return { ...base, planner, onUpdate: (run) => {
      base.onUpdate?.(run);
      const state = STATE_OF[run.stage];
      if (state) executions.update(execution.id, (x) => { if (x.state !== 'failed' && x.state !== 'done') x.state = state; });
    } };
  };

  /**
   * A chosen variant's layers as run layers, back to front: the clean scenery plate, the contact shadows, and the exact
   * products — each product its own layer when the variant has them (one product keeps the earlier single-layer names).
   */
  const variantLayers = (execution: TemplateExecution, withPlate: boolean): VariantRunLayer[] => {
    const v = execution.variant!, read = (file: string) => readFileSync(executions.path(execution.id, file)), subjectName = v.protectedLabels.join(' + ') || 'Subject';
    const plate = withPlate ? [{ file: 'layer-1-new-scenery.png', name: 'New scenery', description: 'The generated scenery, with the products\' area filled locally', png: read(v.layers.plate.file), kind: 'full-canvas' as const, placement: { x: 0, y: 0, width: v.layers.plate.width, height: v.layers.plate.height }, semantic: { id: 'new_scenery', type: 'background' } }] : [];
    // A variant on its own ratio canvas: the generated scene is one flattened picture; each product is its own exact layer.
    const ratio = !!v.aspectRatio, scaled = v.scale !== undefined && v.scale < 1 ? `original pixels, scaled to ${Math.round(v.scale * 100)}%` : 'exact source pixels';
    if (v.layers.subjects && (v.layers.subjects.length > 1 || ratio)) {
      const slug = (k: number) => `${k + 1}`;
      return [...plate.map(l => ratio ? { ...l, name: 'Generated scene (flattened)', description: 'The AI-generated scene as one flattened picture; the products\' area is filled locally' } : l),
        ...(v.layers.shadows ?? []).map((l, k) => ({ file: `layer-2-shadow-${slug(k)}.png`, name: `Contact shadow · ${l.label}`, description: `A soft shadow under ${l.label} (editable)`, png: read(l.file), kind: 'bbox-crop' as const, placement: l.placement, semantic: { id: `contact_shadow_${slug(k)}`, type: 'effect' } })),
        ...v.layers.subjects.map((l, k) => ({ file: `layer-3-subject-${slug(k)}.png`, name: `${l.label} (${scaled})`, description: `${l.label}: the reference image's own pixels${v.scale !== undefined && v.scale < 1 ? ', resampled once, never redrawn' : ''}`, png: read(l.file), kind: 'bbox-crop' as const, placement: l.placement, semantic: { id: `protected_subject_${slug(k)}`, type: 'product' } }))];
    }
    // One combined product layer (an uploaded cutout, or a set made before products were separated).
    return [...plate.map(l => ratio ? { ...l, name: 'Generated scene (flattened)', description: 'The AI-generated scene as one flattened picture; the products\' area is filled locally' } : l),
      ...(v.layers.shadow ? [{ file: 'layer-2-contact-shadow.png', name: 'Contact shadow', description: 'A soft shadow under the subject (editable)', png: read(v.layers.shadow.file), kind: 'bbox-crop' as const, placement: v.layers.shadow.placement, semantic: { id: 'contact_shadow', type: 'effect' } }] : []),
      { file: 'layer-3-subject.png', name: `${subjectName} (${scaled})`, description: `The protected subject: the reference image's own pixels${v.scale !== undefined && v.scale < 1 ? ', resampled once, never redrawn' : ''}`, png: read(v.layers.subject.file), kind: 'bbox-crop', placement: v.layers.subject.placement, semantic: { id: 'protected_subject', type: 'product' } }];
  };
  /** What a finished run means for its execution: a saved template (create), reuse statistics (reuse), or a failure. */
  const finish = (id: string, run: RunRecord, started: number, decompositionStarted: number): TemplateExecution => {
    const plannerCalls = run.calls?.planner ?? (run.planner ? 1 : 0);
    let execution = executions.update(id, (x) => {
      x.runId = run.id;
      Object.assign(x.usage, { plannerCalls, plannerCalled: plannerCalls > 0, ...(run.planner ? { plannerModel: run.planner.model } : {}) });
      x.usage.timings.decompositionMs = Date.now() - decompositionStarted;
    });
    if (run.stage !== 'done') return failed(id, run.error?.code ?? 'DECOMPOSITION_FAILED', run.error?.message ?? 'The decomposition did not finish.', run.error?.stage === 'planning' ? 'planning' : 'decomposing', started);
    // A layer the plan asked for that the editor does not get is a quality issue the user sees, never a silent success.
    const lostLayers = run.warnings.filter(w => w.startsWith('PLANNED_LAYER_'));
    if (run.composed?.source === 'single-layer' || run.composed?.source === 'product-cutouts' || run.composed?.source === 'qwen-layers') {
      // A recovery without Seedream: its layers are what it says, not the template's plan (no coverage or count check applies).
      execution = executions.update(id, (x) => { x.warnings = [run.composed!.source === 'single-layer' ? 'LAYERS_NOT_SPLIT: a flat preview, not a decomposition: the creative is one image layer and no objects were separated.'
        : run.composed!.source === 'qwen-layers' ? 'LAYERS_QWEN: extracted with the alternative provider (Qwen-Image-Layered) after Seedream refused the image. The model chose how objects are grouped; what is visible is the creative\'s own pixels, and what was hidden behind objects is AI-generated.'
        : 'LAYERS_CUTOUTS_ONLY: only the products were cut out (SAM-3 masks); everything else is one background layer whose areas behind the products are a local fill, not a reconstruction.'] });
    } else if (execution.variant) {
      // A variant's layers are its own: the template's saved plan and layer counts do not describe its new scenery.
      execution = executions.update(id, (x) => { x.warnings = [...lostLayers]; });
    } else if (execution.mode === 'CREATE_TEMPLATE') {
      if (lostLayers.length) execution = executions.update(id, x => { x.warnings = [...x.warnings.filter(w => !w.startsWith('PLANNED_LAYER_')), ...lostLayers]; });
      executions.update(id, (x) => { x.state = 'saving'; });
      const upload = execution.upload, ext = upload.file.split('.').at(-1)!;
      let saved: { template: { id: string; name: string }; version: TemplateVersion };
      try {
        const candidate = captureTemplateVersion(run, { templateId: 'candidate', executionId: id }), updating = execution.updatesTemplate;
        if (updating) {
          // An explicit new plan of a saved template's source: its next version, under the name the user gave it.
          const record = templates.get(updating.id);
          if (!record || record.status !== 'active') throw new RunError('TEMPLATE_NOT_FOUND', 'The template to update was deleted.');
          const version = templates.addVersion(updating.id, n => ({ ...candidate, templateId: updating.id, version: n, name: record.name, description: record.description,
            derivedFrom: { version: updating.fromVersion, reason: 'replan', at: new Date().toISOString(), change: 'a new plan of the source creative' } }));
          saved = { template: templates.get(updating.id)!, version };
        } else {
          const existing = templates.list().find(t => { const v = usableVersion(t.id, t.currentVersion); return v && sameTemplateStructure(v.structure, candidate.structure); });
          saved = existing ? { template: existing, version: templates.current(existing.id)! } : templates.create(templateId => ({ ...candidate, templateId }), { bytes: readFileSync(executions.path(id, upload.file)), ext });
        }
      }
      catch (error) { return failed(id, error instanceof RunError ? error.code : 'TEMPLATE_SAVE_FAILED', `The template was not saved: ${error instanceof Error ? error.message : String(error)}`, 'saving', started); }
      log(`[TEMPLATE] saved template=${saved.template.id} v${saved.version.version} "${saved.version.name}" from run=${run.id}`);
      execution = executions.update(id, (x) => { x.template = { id: saved.template.id, name: saved.version.name, version: saved.version.version }; });
      if (run.templateExecution) { run.templateExecution.template = execution.template; saveRunRecord(join(runsDir, run.id), run); }
    } else {
      const version = templates.version(execution.template!.id, execution.template!.version), warnings: string[] = execution.warnings.filter(w => w.startsWith('TEMPLATE_FIT_WARNING'));
      // The reused plan's quality, as far as it can be read without a call: its layers found, and a plausible count.
      const coverage = run.refinement?.planCoverage, editorLayers = run.editorLayerFiles?.length ?? run.outputLayers?.length ?? 0, expected = version?.decomposition.expectedEditorLayers;
      if (!coverage) warnings.push('TEMPLATE_COVERAGE_UNVERIFIED: role coverage was not measured. Review the layers.');
      if (run.refinement?.background?.quality !== 'usable' || run.refinement?.background?.contaminated) warnings.push('TEMPLATE_BACKGROUND_UNVERIFIED: background quality needs review.');
      if (coverage && !coverage.complete) warnings.push(`TEMPLATE_LAYERS_MISSING: Selected template may not fit this image. No layer matched ${coverage.planned.filter(p => !coverage.matched[p]).join(', ')}. If this image does not have the template's structure, create a new template from it.`);
      if (expected && (editorLayers < expected.min || editorLayers > expected.max)) warnings.push(`TEMPLATE_LAYER_COUNT: ${editorLayers} editor layers; this template expects ${expected.min}–${expected.max}.`);
      // A backdrop shape the saved plan does not name was found by its shape alone: kept as a layer, and the plan flagged.
      const unnamed = (run.refinement as { backdrops?: { component: boolean; basis: string; name?: string; file: string }[] } | undefined)?.backdrops?.filter(d => d.component && d.basis === 'shape') ?? [];
      if (unnamed.length) warnings.push(`TEMPLATE_PLAN_INCOMPLETE: the saved plan does not name ${unnamed.map(d => `"${d.name ?? d.file}"`).join(', ')}; ${unnamed.length > 1 ? 'they were' : 'it was'} kept as a separate layer. Update the template's plan to name ${unnamed.length > 1 ? 'them' : 'it'} (one planner call).`);
      if (templates.get(execution.template!.id)) templates.update(execution.template!.id, (t) => { t.stats.reuses++; if (execution.mode === 'REUSE_TEMPLATE_WITH_EDIT') t.stats.edits++; t.stats.lastUsedAt = new Date().toISOString(); });
      execution = executions.update(id, (x) => { x.warnings = [...warnings, ...lostLayers]; });
      run.warnings = [...run.warnings.filter(w => !w.startsWith('TEMPLATE_')), ...warnings];
      saveRunRecord(join(runsDir, run.id), run);
    }
    log(`[TEMPLATE] done execution=${id} mode=${execution.mode} planner=${execution.usage.plannerCalls} imageGeneration=${execution.usage.imageGenerationCalls} run=${run.id}`);
    return executions.update(id, (x) => { x.state = 'done'; x.finishedAt = new Date().toISOString(); x.usage.timings.totalMs = Date.now() - started; delete x.error; });
  };

  /** The image an execution extracts: its approved generated creative, or its upload. */
  const imageShaOf = (e: TemplateExecution) => e.edit?.image?.sha256 ?? e.upload.sha256;
  /**
   * Every Seedream request fal received for this exact image (by sha256), accepted or refused by fal's own category,
   * from the saved runs: what a retry can expect is read from evidence, never assumed.
   */
  function extractionHistory(execution: TemplateExecution) {
    const sha = imageShaOf(execution), attempts: { runId: string; at: string; accepted: boolean; category?: string; plan?: string; billableUnits?: string }[] = [];
    for (const runId of existsSync(runsDir) ? readdirSync(runsDir).sort() : []) {
      let r: RunRecord;
      try { r = readRun(join(runsDir, runId)); } catch { continue; }
      if (!r.seedream?.requestId || (r.templateExecution?.input?.sha256 !== sha && r.providerImage?.source.sha256 !== sha)) continue;
      const accepted = r.stage === 'done', rejection = r.rejection ?? (r.error?.provider ? classifySeedreamRejection(r.error.provider, { endpoint: SEEDREAM_ENDPOINT }) : undefined);
      if (!accepted && !rejection && r.stage !== 'failed') continue; // still running
      attempts.push({ runId: r.id, at: r.createdAt, accepted, ...(accepted ? {} : { category: rejection?.category ?? r.error?.code ?? 'unknown' }), ...(r.templateExecution?.plan ? { plan: r.templateExecution.plan } : {}),
        ...(rejection?.billableUnits ? { billableUnits: rejection.billableUnits } : {}) });
    }
    const refused: Record<string, number> = {};
    for (const a of attempts) if (!a.accepted) refused[a.category!] = (refused[a.category!] ?? 0) + 1;
    return { imageSha256: sha, attempts, accepted: attempts.filter(a => a.accepted).length, refused, billedZero: attempts.filter(a => !a.accepted && a.billableUnits === '0').length };
  }
  /** The products of a smart edit, cut out of the image it made (SAM-3, one mask request each), over a background filled locally. */
  async function productCutoutLayers(id: string, execution: TemplateExecution, png: Buffer): Promise<VariantRunLayer[] | { failure: string }> {
    if (!execution.resolution || !services.smart) return { failure: 'Products can be cut out only from a creative made from its image analysis.' };
    const { scene, plan } = services.smart.reviewInputs(execution);
    const removed = new Set(plan.entries.filter(e => e.operation === 'remove').map(e => e.targetId));
    const ids = scene.objects.filter(o => !o.ignored && !removed.has(o.id) && (o.kind === 'product' || (o.kind === 'object' && o.importance === 'main'))).map(o => o.id);
    if (!ids.length) return { failure: 'No product was found in this creative to cut out.' };
    const cut = await services.smart.editCutout({ scene, protectIds: ids, image: png, save: (file, value) => executions.writeFile(id, `recovery-${file}`, value) });
    executions.update(id, x => { x.usage.segmentationCalls = (x.usage.segmentationCalls ?? 0) + cut.calls; if (cut.provider) x.usage.segmentationProvider = cut.provider; });
    if ('failure' in cut) return { failure: cut.failure };
    const source = await sourceRaster(png), { width: W, height: H } = source, refined = refineEdges(source, cut.subjects.map(x => x.mask));
    // Behind the products: the surrounding scene continued into their area (a local fill, said so in the layer's name).
    const hole = new Uint8Array(W * H);
    for (const m of refined.masks) for (let i = 0; i < hole.length; i++) if (m[i] >= 24) hole[i] = 1;
    const plate = await sharp(continueScenery(source.rgb, hole, W, H), { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
    const layers: VariantRunLayer[] = [{ file: 'layer-1-background.png', name: 'Background (filled locally behind the products)', description: 'The creative without its products; the areas behind them are a local fill', png: plate, kind: 'full-canvas', placement: { x: 0, y: 0, width: W, height: H }, semantic: { id: 'background', type: 'background' } }];
    for (const [k, subject] of cut.subjects.entries()) {
      const box = maskBox(refined.masks[k], W, H, 8).box;
      if (!box) continue;
      const rgba = Buffer.alloc(box.width * box.height * 4);
      for (let y = 0; y < box.height; y++) for (let x = 0; x < box.width; x++) {
        const s = (box.y + y) * W + box.x + x, i = (y * box.width + x) * 4;
        for (let c = 0; c < 3; c++) rgba[i + c] = refined.reference.rgb[s * 3 + c];
        rgba[i + 3] = refined.masks[k][s];
      }
      layers.push({ file: `layer-${k + 2}-product-${k + 1}.png`, name: `${subject.label} (cut out)`, description: `${subject.label}, cut out of the creative with its SAM-3 mask`, png: await sharp(rgba, { raw: { width: box.width, height: box.height, channels: 4 } }).png().toBuffer(),
        kind: 'bbox-crop', placement: box, semantic: { id: `product_${k + 1}`, type: 'product' } });
    }
    return layers;
  }
  /**
   * What a Qwen request is told about this creative, from its analysis when it has one: the kinds of objects that remain
   * (category words, never brands or text), a layer count for them plus the background, and their regions to name the
   * layers by. Without an analysis, a plain caption and Qwen's default of four layers.
   */
  function qwenRequestFor(execution: TemplateExecution, width: number, height: number): { caption: string; numLayers: number; labels: QwenLayerLabel[] } {
    let objects: SceneObject[] = [];
    try {
      if (execution.resolution && services.smart) {
        const { scene, plan } = services.smart.reviewInputs(execution), removed = new Set(plan.entries.filter(e => e.operation === 'remove').map(e => e.targetId));
        objects = scene.objects.filter(o => !o.ignored && !removed.has(o.id) && o.kind !== 'scenery' && o.importance !== 'background');
      }
    } catch { objects = []; }
    const counts = new Map<string, number>();
    for (const o of objects) counts.set(o.category, (counts.get(o.category) ?? 0) + 1);
    const kinds = [...counts].map(([category, n]) => n > 1 ? `${category} (×${n})` : category);
    return { caption: kinds.length ? `An advertising image: ${kinds.join(', ')}, in front of a background.` : 'An advertising image: its objects in front of a background.',
      numLayers: Math.min(6, Math.max(4, objects.length + 1)),
      labels: objects.map(o => ({ label: o.label, box: { x: o.box.x * width, y: o.box.y * height, width: o.box.w * width, height: o.box.h * height } })) };
  }
  /** Template slots this execution's edit removed: the saved plan's layers for them have nothing left to extract. */
  function removedSlots(execution: TemplateExecution, version: TemplateVersion): string[] {
    try {
      if (execution.resolution && services.smart) return services.smart.reviewInputs(execution).plan.entries.filter(e => e.operation === 'remove' && e.slotId).map(e => e.slotId!);
      if (execution.slotValues) return compileEdit(version, execution.slotValues, execution.editOptions ?? {}, !!execution.edit?.reference).changes.filter(c => c.operation === 'remove').map(c => c.slotId);
    } catch { /* an edit that no longer compiles leaves the saved plan as it is */ }
    return [];
  }

  /** Everything an execution does, in its mode's order. A failure at any step is recorded, never thrown. */
  const run = async (id: string): Promise<TemplateExecution> => {
    const started = Date.now();
    let execution = executions.get(id);
    const policy = EXECUTION_POLICY[execution.mode];
    log(execution.mode === 'CREATE_TEMPLATE' ? `[TEMPLATE] creating new template execution=${id}` : `[TEMPLATE] reuse template=${execution.template!.id} v${execution.template!.version} mode=${execution.mode} execution=${id}`);
    try {
      let bytes: Buffer = readFileSync(executions.path(id, execution.upload.file));
      let version: TemplateVersion | undefined;
      if (execution.mode !== 'CREATE_TEMPLATE') {
        version = usableVersion(execution.template!.id, execution.template!.version);
        if (!version) return failed(id, 'STALE_TEMPLATE_VERSION', `Template ${execution.template!.name} v${execution.template!.version} is no longer available. Start again with the template's current version.`, 'queued', started);
      }
      // 1. The image to decompose: the upload itself, or its one edit.
      if (policy.imageGeneration && execution.edit?.image) {
        bytes = readFileSync(executions.path(id, execution.edit.image.file));
      } else if (policy.imageGeneration && execution.edit?.original) {
        // Nothing was asked to change: the image to review is the original upload, exactly, at its own size (no image request).
        const { originalName: _name, ...image } = execution.upload; void _name;
        execution = executions.update(id, x => { x.edit = { ...x.edit!, image, size: `${image.width}x${image.height}`,
          review: { method: 'whole-image', checks: [], requiresAcknowledgement: false, note: 'Nothing was asked to change: this is your original image, exactly as uploaded. No image request was made.' },
          ...(x.resolution ? { strategy: { kind: 'none', regions: [], areaPercent: 0, protectIds: [], reasons: ['Nothing changes: your original image is used, with no image request.'] } } : {}) }; });
        log(`[GENERATION] skipped: nothing to change, the original image is reviewed execution=${id}`);
      } else if (policy.imageGeneration) {
        const config = services.generation(), reference = execution.edit?.reference;
        const compiled = execution.slotValues ? compileEdit(version!, execution.slotValues, execution.editOptions ?? {}, !!reference) : undefined;
        // A smart edit recompiles its persisted resolution: it must be exactly the prompt bound when it was submitted.
        const smart = execution.resolution ? services.smart?.reviewInputs(execution) : undefined;
        if (execution.resolution && (!smart || smart.compiled.text !== execution.edit!.prompt)) return failed(id, 'STALE_RESOLUTION', 'The resolved prompt no longer matches what was submitted; nothing was sent. Resolve the changes again.', 'generating', started);
        const prompt = smart ? smart.compiled.text : compiled ? compiled.text : compileEditPrompt(version!.generationPrompt, execution.edit!.instruction);
        execution = executions.update(id, (x) => { x.state = 'generating'; x.edit = { ...x.edit!, prompt, model: config.model }; Object.assign(x.usage, { imageGenerationCalled: true, imageGenerationCalls: 1, imageModel: config.model }); });
        log(`[GENERATION] invoked: one image edit (saved template prompt + edit instruction) execution=${id}`);
        try {
          const referenceBytes = reference ? readFileSync(executions.path(id, reference.file)) : undefined;
          if (reference && sha(referenceBytes!) !== reference.sha256) throw new RunError('INPUT_IDENTITY_MISMATCH', 'The saved product reference image has changed. Upload it again.');
          const save = (file: string, value: Buffer | object) => executions.writeFile(id, file, value);
          let edited: { image: ExecutionImage; bytes: Buffer; size: string; requestFile: string; responseFile: string; durationMs: number }, scope: SmartEditStrategyRecord['regions'] | undefined, fallback: string | undefined, edgeContact: string[] = [];
          if (smart) {
            // A smart edit is made the way its plan's strategy says: only the changed regions, the background around the
            // products it keeps (cut out first), or the whole image; always at the source's own size.
            let strategy = smart.strategy, subjects: VariantSubject[] | undefined;
            if (strategy.kind === 'none') {
              if (!execution.edit?.regenerate) return failed(id, 'NO_CHANGES', 'Nothing changes in this smart edit: use the original image (no image request).', 'generating', started);
              strategy = { ...strategy, kind: 'global', reasons: ['Nothing changes, and you asked for a new image anyway: the whole image is regenerated, at its own size.'] };
            }
            let editPrompt: string | { background: string; objects: string } = prompt;
            if (strategy.kind === 'background' || strategy.kind === 'layered') {
              const cut = await services.smart!.editCutout({ scene: smart.scene, protectIds: strategy.protectIds, image: bytes, save });
              executions.update(id, x => { x.usage.segmentationCalls = (x.usage.segmentationCalls ?? 0) + cut.calls; if (cut.provider) x.usage.segmentationProvider = cut.provider; });
              if ('failure' in cut) { fallback = `${cut.failure} The whole image was edited instead, so the products may have been redrawn or moved: check them and the layout.`; strategy = { ...strategy, kind: 'global', protectIds: [] }; }
              else {
                subjects = cut.subjects; cut.masks.forEach((m, k) => save(`edit-cutout-${k + 1}.png`, m));
                if (strategy.kind === 'layered') {
                  // Two passes of the same plan: the background around every product (kept in place), then each changed
                  // object in its own slot, its tilt read from its own cutout where the shape shows one clearly.
                  const passes = layeredPlans(smart.scene, smart.plan), poses: Record<string, string> = {};
                  for (const x of cut.subjects) { const pose = maskPose(x.mask, execution.upload.width, execution.upload.height); if (pose) poses[x.id] = pose; }
                  editPrompt = { background: compileResolvedEdit(smart.scene, passes.background).text, objects: compileResolvedEdit(smart.scene, { ...passes.objects, poses }, { productReference: !!reference }).text };
                }
              }
            }
            const record: SmartEditStrategyRecord = { kind: strategy.kind as SmartEditStrategyRecord['kind'], regions: strategy.regions, areaPercent: strategy.areaPercent, protectIds: strategy.protectIds, reasons: strategy.reasons, ...(fallback ? { fallback } : {}) };
            execution = executions.update(id, x => { x.edit = { ...x.edit!, strategy: record }; });
            log(`[GENERATION] smart edit strategy=${record.kind}${record.kind === 'local' ? ` regions=${record.regions.length} area=${record.areaPercent}%` : ''}${fallback ? ' (cutout failed: whole image)' : ''} execution=${id}`);
            const made = await smartEditImage(config, { bytes, file: execution.upload.file }, editPrompt, strategy, save, { ...(reference ? { reference: { bytes: referenceBytes!, file: reference.file } } : {}), ...(subjects ? { subjects } : {}) });
            edited = made; edgeContact = made.edgeContact;
            if (record.kind === 'local' || record.kind === 'layered') scope = record.regions;
            execution = executions.update(id, (x) => { x.edit = { ...x.edit!, size: made.size, image: made.image, generated: made.generated, preservation: made.preservation, requestFile: made.requestFile, responseFile: made.responseFile, durationMs: made.durationMs };
              x.usage.timings.generationMs = made.durationMs; x.usage.imageGenerationCalls = made.calls; });
          } else {
            // Template fields without an image analysis: one whole-image edit, contained in the model's canvas and mapped
            // back, so the result keeps the source's own size and aspect.
            const made = await smartEditImage(config, { bytes, file: execution.upload.file }, prompt, { kind: 'global', regions: [] }, save, reference ? { reference: { bytes: referenceBytes!, file: reference.file } } : {});
            edited = made;
            const record: SmartEditStrategyRecord = { kind: 'global', regions: [], areaPercent: 100, protectIds: [], reasons: ['Edited as one whole image from the template\'s fields, at the image\'s own size.'] };
            execution = executions.update(id, (x) => { x.edit = { ...x.edit!, size: made.size, image: made.image, generated: made.generated, strategy: record, requestFile: made.requestFile, responseFile: made.responseFile, durationMs: made.durationMs }; x.usage.timings.generationMs = made.durationMs; });
          }
          bytes = edited.bytes;
          // The local review (pixel comparisons; never a semantic judgment): what it found waits for the user.
          let review: GenerationReview | undefined;
          const changes = compiled?.changes ?? smart?.compiled.changes;
          if (changes) {
            try { review = await reviewGeneration({ source: readFileSync(executions.path(id, execution.upload.file)), generated: edited.bytes, version: version!, changes, sourceRunDir: sourceRunFor(version!, execution.upload.sha256), ...(smart ? { regions: smart.regions } : {}), ...(scope ? { scope: scope.map(r => r.box) } : {}) }); }
            catch (error) { review = { method: 'whole-image', checks: [{ id: 'region-unknown', severity: 'info', message: `The local review could not run (${error instanceof Error ? error.message : String(error)}).`, evidence: {} }], requiresAcknowledgement: false, note: 'Review the image before using it.' }; }
            if (fallback) review = { ...review, checks: [...review.checks, { id: 'cutout-limitation', severity: 'warning', message: fallback, evidence: {} }], requiresAcknowledgement: true };
            // A new object that runs into its slot's edge may be cut there: the layout held, but a person looks at it.
            if (edgeContact.length) review = { ...review, checks: [...review.checks, ...edgeContact.map(label => ({ id: 'slot-edge' as const, severity: 'warning' as const, message: `${label}: the new content reaches the edge of its slot and may be cut there. Check it before using the image.`, evidence: {} }))], requiresAcknowledgement: true };
            // A replaced or removed object can never be confirmed by pixels: a person checks it, whatever the review found.
            const objectChange = compiled ? compiled.changes.some(c => c.operation === 'replace' || c.operation === 'remove') : smart!.objectChange;
            if (objectChange) review = { ...review, requiresAcknowledgement: true };
            // The AI check of a smart edit: its own status; a contradiction waits for a person, a failed checker is never a pass.
            if (smart && services.smart) {
              const { verification, called } = await services.smart.verify(readFileSync(executions.path(id, execution.upload.file)), edited.bytes, smart.expectations, (file, value) => executions.writeFile(id, file, value));
              if (called) executions.update(id, x => { x.usage.verificationCalls = (x.usage.verificationCalls ?? 0) + 1; if (verification.model) x.usage.verifierModel = verification.model; });
              review = { ...review, semantic: verification, checks: [...review.checks, ...services.smart.semanticChecks(verification)], requiresAcknowledgement: review.requiresAcknowledgement || verification.status === 'contradiction' };
            }
            const found = review;
            execution = executions.update(id, x => { x.edit = { ...x.edit!, review: found }; });
          }
        } catch (error) {
          if (error instanceof ImageEditError) executions.update(id, (x) => { x.edit = { ...x.edit!, requestFile: error.requestFile, durationMs: error.durationMs }; x.usage.timings.generationMs = error.durationMs; });
          return failed(id, error instanceof RunError ? error.code : 'GENERATION_FAILED', error instanceof Error ? error.message : String(error), 'generating', started);
        }
      } else log(`[GENERATION] skipped: ${execution.mode === 'CREATE_TEMPLATE' ? 'template creation decomposes the upload' : 'no edit requested'}`);
      if (execution.reviewBeforeDecompose && !execution.imageAcceptedAt) {
        return executions.update(id, x => { x.state = 'generated'; x.usage.timings.totalMs = Date.now() - started; });
      }
      // 2. Exactly the approved image: the persisted generated creative (or the upload), checked before anything is sent.
      const input = policy.imageGeneration ? { source: 'approved-generated' as const, sha256: execution.edit!.image!.sha256 } : { source: 'original-upload' as const, sha256: execution.upload.sha256 };
      if (sha(bytes) !== input.sha256) return failed(id, 'INPUT_IDENTITY_MISMATCH', `The image to decompose is not the ${input.source === 'approved-generated' ? 'approved generated creative' : 'uploaded image'} on record; nothing was sent. Generate or upload it again.`, 'decomposing', started);
      // 3. The decomposition run: the planner when a template is created, or when the user chose to refresh the plan.
      const choice: ExtractionPlan = policy.planner ? 'refresh' : execution.planDecision?.choice ?? (execution.variant ? 'composed' : 'saved');
      if (choice === 'flat' || choice === 'cutouts') {
        // Recovery without Seedream, chosen explicitly: the whole image as one layer (no request), or its products cut out
        // with SAM-3 masks (one mask request each) over a background filled locally behind them. Never a crude crop.
        const origin = { kind: 'template-execution' as const, generationId: id }, own = { executionId: id, mode: execution.mode, ...(execution.template ? { template: execution.template } : {}), plan: choice, input };
        const png = await sharp(bytes).rotate().png().toBuffer();
        const layers = choice === 'flat' ? [{ file: 'layer-1-creative.png', name: 'Flat preview (not split into layers)', description: 'The whole creative as one flat image: no objects were separated', png, kind: 'full-canvas' as const,
          placement: { x: 0, y: 0, width: (await sharp(png).metadata()).width!, height: (await sharp(png).metadata()).height! }, semantic: { id: 'creative', type: 'background' } }] : await productCutoutLayers(id, execution, png);
        if (!Array.isArray(layers)) return failed(id, 'CUTOUT_FAILED', `${layers.failure} The creative is kept; nothing else was sent.`, 'decomposing', started);
        const created = await createComposedRun(runsDir, { composite: png, layers, origin, templateExecution: own, source: choice === 'flat' ? 'single-layer' : 'product-cutouts' });
        log(`[DECOMPOSE] recovery without Seedream (${choice}) run=${created.run.id}`);
        execution = executions.update(id, (x) => { x.runId = created.run.id; x.state = 'decomposing'; });
        return finish(id, created.run, started, Date.now());
      }
      if (choice === 'qwen') {
        // The alternative provider, chosen by a person after Seedream refused this image (retryExtraction): one
        // Qwen-Image-Layered request, its layers placed on the creative's own canvas (qwenLayers.ts). Never retried.
        const origin = { kind: 'template-execution' as const, generationId: id }, own = { executionId: id, mode: execution.mode, ...(execution.template ? { template: execution.template } : {}), plan: choice, input };
        const png = await sharp(bytes).rotate().png().toBuffer(), meta = await sharp(png).metadata(), ask = qwenRequestFor(execution, meta.width!, meta.height!), deps = services.deps();
        execution = executions.update(id, (x) => { x.state = 'decomposing'; });
        const decompositionStarted = Date.now();
        try {
          const qwen = await requestQwenLayers(deps.transport(), png, { caption: ask.caption, numLayers: ask.numLayers, sleep: deps.sleep, save: (file, value) => executions.writeFile(id, `qwen-${file}`, value),
            onSubmitted: () => executions.update(id, x => { x.usage.qwenLayerCalls = (x.usage.qwenLayerCalls ?? 0) + 1; }) });
          qwen.images.forEach((layer, i) => executions.writeFile(id, `qwen-layer-${i}.png`, layer));
          const { layers, report } = await qwenEditorLayers(png, qwen.images, { labels: ask.labels });
          const created = await createComposedRun(runsDir, { composite: png, layers, origin, templateExecution: own, source: 'qwen-layers' });
          writeFileSync(join(created.dir, 'qwen-layers.json'), JSON.stringify({ endpoint: QWEN_ENDPOINT, requestId: qwen.requestId, seed: qwen.seed, caption: ask.caption, numLayers: ask.numLayers, ...report }, null, 2));
          log(`[DECOMPOSE] alternative provider Qwen-Image-Layered request=${qwen.requestId} run=${created.run.id} layers=${layers.length}`);
          execution = executions.update(id, (x) => { x.runId = created.run.id; });
          return finish(id, created.run, started, decompositionStarted);
        } catch (error) {
          // The refused Seedream run is the execution's run again, so every other choice stays open.
          const refused = execution.extractionAttempts?.at(-1)?.runId;
          if (refused) executions.update(id, (x) => { x.runId = refused; });
          return failed(id, 'QWEN_LAYERS_FAILED', `${error instanceof Error ? error.message : String(error)} The creative is kept; nothing was retried.`, 'decomposing', started);
        }
      }
      if (execution.variant) {
        const origin = { kind: 'template-execution' as const, generationId: id }, variant = { setId: execution.variant.setId, variantId: execution.variant.variantId }, plateSize = execution.variant.layers.plate;
        const own = { executionId: id, mode: execution.mode, ...(execution.template ? { template: execution.template } : {}), plan: choice };
        if (choice === 'composed') {
          // Its own layers, composed locally: no planner, no Seedream, nothing flattened and decomposed again.
          const created = await createComposedRun(runsDir, { composite: bytes, layers: variantLayers(execution, true), origin, variant, templateExecution: { ...own, input } });
          log(`[DECOMPOSE] composed creative variant layers locally run=${created.run.id} (no provider call)`);
          execution = executions.update(id, (x) => { x.runId = created.run.id; x.state = 'decomposing'; x.usage.decompositionPlanSource = 'saved-template'; });
          return finish(id, created.run, started, Date.now());
        }
        // Only the new scenery is split; the exact subject and its shadow go back on top, never re-rendered.
        const plate = readFileSync(executions.path(id, execution.variant.layers.plate.file));
        if (sha(plate) !== execution.variant.layers.plate.sha256) return failed(id, 'INPUT_IDENTITY_MISMATCH', 'The variant\'s scenery plate changed on disk; nothing was sent. Choose the variant again.', 'decomposing', started);
        const sceneryInput = { source: 'variant-scenery' as const, sha256: execution.variant.layers.plate.sha256 };
        const created = choice === 'refresh' ? await createRun(runsDir, plate, { mode: 'generated' }, { refinement: false, origin, templateExecution: { ...own, planRefresh: true, input: sceneryInput } })
          : await createRun(runsDir, plate, compileTemplatePlan(sceneryVersion(version!)), { refinement: false, origin, templateExecution: { ...own, input: sceneryInput } });
        if (choice === 'refresh') executions.update(id, x => { x.usage.decompositionPlanSource = 'planner'; });
        log(`[DECOMPOSE] creative variant: ${choice === 'refresh' ? 'planner + ' : ''}Seedream on the new scenery only run=${created.run.id}`);
        execution = executions.update(id, (x) => { x.runId = created.run.id; x.state = choice === 'refresh' ? 'planning' : 'decomposing'; });
        const decompositionStarted = Date.now(), done = await executeRun(created.dir, depsFor(execution));
        return finish(id, done.stage === 'done' ? await addVariantLayers(created.dir, variantLayers(execution, false), variant, plateSize) : done, started, decompositionStarted);
      }
      const origin = { kind: 'template-execution' as const, generationId: id }, templateExecution = { executionId: id, mode: execution.mode, inspection: execution.inspection, plannerReason: execution.plannerReason,
        ...(execution.template ? { template: execution.template } : {}), plan: choice, ...(choice === 'refresh' && !policy.planner ? { planRefresh: true } : {}), input };
      // The saved plan never asks for the layers of objects this edit removed (Seedream has refused plans that did).
      const removed = policy.planner || choice === 'refresh' ? [] : removedSlots(execution, version!), planVersion = removed.length ? withoutSlots(version!, removed) : version!;
      if (planVersion !== version) log(`[PLANNER] saved plan without the layers of removed objects: ${removed.join(', ')} (${version!.plan.recommendedLayers} → ${planVersion.plan.recommendedLayers} layers)`);
      const created = policy.planner
        ? await createRun(runsDir, bytes, { mode: 'generated' }, { refinement: true, origin, templateExecution, templateCapture: true })
        : choice === 'refresh' ? await createRun(runsDir, bytes, { mode: 'generated' }, { refinement: true, origin, templateExecution })
        : await createRun(runsDir, bytes, choice === 'simple' ? compileSimpleTemplatePlan(planVersion) : compileTemplatePlan(planVersion), { refinement: version!.decomposition.refinement, origin, templateExecution });
      if (choice === 'refresh' && !policy.planner) executions.update(id, x => { x.usage.decompositionPlanSource = 'planner'; });
      log(policy.planner ? `[PLANNER] invoked: template creation (one call: decomposition plan + reusable template) run=${created.run.id}` : choice === 'refresh' ? `[PLANNER] invoked: user chose to refresh the decomposition plan run=${created.run.id}` : `[PLANNER] skipped: existing reusable plan template=${version!.templateId} v${version!.version} run=${created.run.id}`);
      log(`[DECOMPOSE] using ${policy.decomposes === 'upload' ? 'original uploaded image' : 'edited image'} run=${created.run.id}`);
      execution = executions.update(id, (x) => { x.runId = created.run.id; x.state = choice === 'refresh' ? 'planning' : 'decomposing'; });
      const decompositionStarted = Date.now();
      return finish(id, await executeRun(created.dir, depsFor(execution)), started, decompositionStarted);
    } catch (error) {
      return failed(id, error instanceof RunError ? error.code : 'EXECUTION_FAILED', error instanceof Error ? error.message : String(error), executions.get(id).state, started);
    }
  };
  const schedule = (id: string, work: () => Promise<unknown>) => {
    active.add(id);
    services.inTurn(id, () => work().catch(error => console.error('[TEMPLATE] execution', id, error)).finally(() => active.delete(id)));
  };

  return {
    /** Whether this process is working on (or has queued) the execution. */
    isActive: (id: string) => active.has(id),
    /**
     * Validates and stores a new execution (or returns the one this submission already started), then queues its work.
     * Everything that can be refused is refused here, before any call.
     */
    async start(request: StartRequest): Promise<{ execution: TemplateExecution; created: boolean }> {
      if (!isExecutionMode(request.mode)) throw new RunError('INVALID_MODE', 'mode must be CREATE_TEMPLATE, REUSE_TEMPLATE_ORIGINAL or REUSE_TEMPLATE_WITH_EDIT.');
      const mode: ExecutionMode = request.mode;
      if (request.reviewBeforeDecompose && (mode !== 'REUSE_TEMPLATE_WITH_EDIT' || request.inspect)) throw new RunError('INVALID_REQUEST', 'Only a generated creative can wait for image approval.');
      let template: TemplateExecution['template'];
      if (mode === 'CREATE_TEMPLATE') {
        if (request.templateId !== undefined) throw new RunError('INVALID_REQUEST', 'Creating a template takes no template id.');
      } else {
        const found = typeof request.templateId === 'string' ? templates.get(request.templateId) : undefined;
        if (!found || found.status !== 'active') throw new RunError('TEMPLATE_NOT_FOUND', 'Template not found.');
        if (request.templateVersion !== undefined && request.templateVersion !== found.currentVersion) throw new RunError('STALE_TEMPLATE_VERSION', 'This template has changed. Reload its current version before starting.');
        if (!templates.version(found.id, found.currentVersion)) throw new RunError('STALE_TEMPLATE_VERSION', 'This template has no current version.');
        // The version is pinned now: a later version never changes this execution.
        template = { id: found.id, name: found.name, version: found.currentVersion };
      }
      const version = template ? usableVersion(template.id, template.version) : undefined;
      if (template && !version) throw new RunError('STALE_TEMPLATE_VERSION', 'The selected template is incomplete or unavailable. Choose another template or create a new one.');
      let compiled: CompiledTemplateEdit | undefined, editOptions: TemplateEditOptions | undefined, smartPlan: ReturnType<SmartCreative['forGeneration']> | undefined, editIntent: 'original' | 'regenerate' | undefined;
      if (request.regenerateUnchanged !== undefined && typeof request.regenerateUnchanged !== 'boolean') throw new RunError('INVALID_REQUEST', 'regenerateUnchanged is true or false.');
      if (request.resolutionId !== undefined) {
        // A smart edit: generated only from a ready, clear resolution whose binding to these exact inputs is checked here.
        if (!services.smart) throw new RunError('SMART_EDIT_UNAVAILABLE', 'Smart edits are not available on this server.');
        if (mode !== 'REUSE_TEMPLATE_WITH_EDIT' || !request.reviewBeforeDecompose) throw new RunError('INVALID_REQUEST', 'A smart edit is generated for review first.');
        if (request.values !== undefined || request.editInstruction !== undefined || request.options !== undefined) throw new RunError('INVALID_REQUEST', 'Use either a resolved smart edit or template fields, not both.');
        smartPlan = services.smart.forGeneration({ analysisId: request.analysisId, resolutionId: request.resolutionId, draft: request.draft, uploadSha256: sha(request.upload.bytes),
          ...(request.productReference ? { referenceSha256: sha(request.productReference.bytes) } : {}), template: { id: template!.id, version: template!.version } });
        // Nothing to change: the original is reviewed as it is (no image request that could only redraw it), unless the
        // user explicitly asks for a new image anyway.
        if (smartPlan.resolution.plan!.status === 'unchanged') editIntent = request.regenerateUnchanged ? 'regenerate' : 'original';
        request.editInstruction = `${smartPlan.compiled.summary.slice(0, 420)} · resolution ${smartPlan.resolution.id}${editIntent ? ` · ${editIntent}` : ''}`;
      } else if (request.analysisId !== undefined || request.draft !== undefined) throw new RunError('INVALID_REQUEST', 'A smart edit names its resolution.');
      if (smartPlan) { /* resolved above */ } else if (request.values !== undefined) {
        if (request.editInstruction) throw new RunError('INVALID_REQUEST', 'Use either dynamic fields or an edit instruction.');
        if (!version) { slotInstruction(version, request.values); throw new RunError('INVALID_REQUEST', 'Fields belong to a selected template.'); }
        editOptions = editOptionsOf(request.options);
        compiled = compileEdit(version, request.values, editOptions, !!request.productReference);
        // Without an image analysis, text or a logo that may name a replaced product is the user's decision: never kept by guess.
        if (compiled.questions.length) throw new RunError('DECISION_REQUIRED', `Decide first: ${compiled.questions.map(q => q.message).join(' ')}`, { questions: compiled.questions });
        // The summary names every change (and the reference image), so an identical submission is recognised as one.
        // A product photo shows the new main product: it goes only with a replaced one, never with unrelated edits.
        if (request.productReference && !compiled.changes.some(c => c.role === 'main_product' && c.operation === 'replace')) throw new RunError('INVALID_REQUEST', 'A product photo goes with a replaced main product. Fill in the new product, or remove the photo.');
        // A structural change is decomposed only after the user has seen the image and chosen a plan for it.
        if (compiled.compatibility.status === 'structural-change' && !request.reviewBeforeDecompose) throw new RunError('PLAN_DECISION_REQUIRED',
          `${compiled.compatibility.reasons.join(' ')} Generate the creative for review first, then choose how to extract its layers.`);
        request.editInstruction = compiled.changes.length ? `${compiled.summary}${request.productReference ? ` · product reference ${sha(request.productReference.bytes).slice(0, 12)}` : ''}` : '';
        // No field changes anything: the original is reviewed as it is, unless the user explicitly asks for a new image.
        if (!compiled.changes.length && request.reviewBeforeDecompose) { editIntent = request.regenerateUnchanged ? 'regenerate' : 'original'; if (editIntent === 'original') request.editInstruction = 'No changes: the original image'; }
      } else if (request.options !== undefined || request.productReference) throw new RunError('INVALID_REQUEST', 'Edit options and a product reference go with template fields.');
      if (request.reviewBeforeDecompose && !request.editInstruction) request.editInstruction = GENERATE_UNCHANGED_INSTRUCTION;
      const editing = EXECUTION_POLICY[mode].imageGeneration;
      if (!editing && request.editInstruction !== undefined && request.editInstruction !== '') throw new RunError('INVALID_REQUEST', `${mode} takes no edit instruction.`);
      // Fields are checked one by one by the compiler; a free-text instruction as a whole.
      if (editing && !compiled?.changes.length && !smartPlan) { const problems = editInstructionProblems(request.editInstruction); if (problems.length) throw new RunError('INVALID_EDIT_INSTRUCTION', problems.join(' ')); }
      const reference = request.productReference ? await validateReferenceUpload(request.productReference.bytes, { checkExtension: true, ...(request.productReference.fileName ? { originalName: request.productReference.fileName } : {}), ...(request.productReference.mimeType ? { mimeType: request.productReference.mimeType } : {}) }) : undefined;
      if (request.productReference && !EXECUTION_POLICY[mode].imageGeneration) throw new RunError('INVALID_REQUEST', 'A product reference is used only when a creative is generated.');
      const meta = await validateReferenceUpload(request.upload.bytes, { checkExtension: true, ...(request.upload.fileName ? { originalName: request.upload.fileName } : {}), ...(request.upload.mimeType ? { mimeType: request.upload.mimeType } : {}) });
      const turned = (meta.orientation ?? 1) >= 5;
      const width = (turned ? meta.height : meta.width)!, height = (turned ? meta.width : meta.height)!;
      const fitWarnings = version ? localFitWarnings(version, request.upload.bytes, width, height) : [];
      if (fitWarnings.length && !request.allowMismatch) throw new RunError('TEMPLATE_MAY_NOT_FIT', 'Selected template may not fit this image.', { warnings: fitWarnings });
      if (request.inspect && (mode !== 'CREATE_TEMPLATE' || request.planFresh)) throw new RunError('INVALID_REQUEST', 'Automatic detection takes an upload only.');
      const smartFields = smartPlan ? { resolution: { id: smartPlan.resolution.id, analysisId: smartPlan.analysis.id, summary: smartPlan.compiled.summary, changes: smartPlan.resolution.plan!.entries.filter(e => e.operation !== 'keep').length,
        inferred: smartPlan.resolution.plan!.entries.filter(e => e.operation !== 'keep' && e.source === 'inferred').length }, editPrompt: smartPlan.compiled.text, generationPromptSource: 'resolved-plan' as const, compatibility: smartPlan.compiled.compatibility } : {};
      const result = executions.create({ live: id => active.has(id), ...smartFields, ...(editIntent ? { editIntent } : {}), ...(request.updatesTemplate ? { updatesTemplate: request.updatesTemplate } : {}), ...(editOptions && Object.keys(editOptions).length ? { editOptions } : {}), ...(compiled ? { compatibility: compiled.compatibility } : {}),
        ...(request.productReference && reference ? { productReference: { bytes: request.productReference.bytes, ext: reference.format === 'jpeg' ? 'jpg' : reference.format!, mimeType: `image/${reference.format}`, width: reference.width!, height: reference.height! } } : {}),
        inspect: request.inspect, reviewBeforeDecompose: request.reviewBeforeDecompose, ...(request.values ? { slotValues: Object.fromEntries(Object.entries(request.values).map(([key, value]) => [key, sanitizeEditInstruction(value)])) } : {}), mode, plannerReason: mode === 'CREATE_TEMPLATE' ? request.planFresh ? 'plan-fresh' : 'new-structure' : undefined, idempotencyKey: String(request.idempotencyKey ?? ''), ...(template ? { template } : {}), ...(editing ? { editInstruction: sanitizeEditInstruction(request.editInstruction) } : {}),
        upload: { bytes: request.upload.bytes, ext: meta.format === 'jpeg' ? 'jpg' : meta.format!, mimeType: `image/${meta.format}`, width: (turned ? meta.height : meta.width)!, height: (turned ? meta.width : meta.height)!, ...(request.upload.fileName ? { originalName: request.upload.fileName } : {}) } });
      if (result.created && fitWarnings.length) {
        result.execution = executions.update(result.execution.id, x => { x.warnings = fitWarnings; });
      }
      // The calls that came before this generation, counted apart: the image's analysis and the plan's resolution.
      if (result.created && smartPlan) {
        for (const [file, value] of Object.entries(smartPlan.callFiles)) executions.writeFile(result.execution.id, file, value);
        result.execution = executions.update(result.execution.id, x => { x.usage.analysisCalls = smartPlan!.analysis.calls; x.usage.resolutionCalls = smartPlan!.resolution.resolver.called ? 1 : 0; });
      }
      if (result.created) schedule(result.execution.id, () => request.inspect ? inspect(result.execution.id) : run(result.execution.id));
      else log(`[TEMPLATE] duplicate submission: returning execution=${result.execution.id}`);
      return result;
    },
    /** Start the reviewed upload. Dynamic slot edits compile locally into the saved prompt. */
    proceed(id: string, request: { values?: unknown; planFresh?: unknown } = {}): TemplateExecution {
      const execution = executions.get(id);
      if (active.has(id)) throw new RunError('BUSY', 'This execution is still running.');
      if (!execution.automatic || execution.state !== 'ready') throw new RunError('NOT_READY', 'Detect the upload before starting it. This execution may already have started.');
      if (request.planFresh !== undefined && typeof request.planFresh !== 'boolean') throw new RunError('INVALID_REQUEST', 'planFresh must be a boolean.');
      const version = execution.template && !request.planFresh ? usableVersion(execution.template.id, execution.template.version) : undefined;
      if (execution.template && !request.planFresh && !version) throw new RunError('STALE_TEMPLATE_VERSION', 'The detected template is unavailable. Upload again, or choose Plan fresh.');
      const instruction = slotInstruction(version, request.values ?? {});
      const started = executions.update(id, x => {
        x.mode = !version ? 'CREATE_TEMPLATE' : instruction ? 'REUSE_TEMPLATE_WITH_EDIT' : 'REUSE_TEMPLATE_ORIGINAL';
        x.plannerReason = !version ? request.planFresh ? 'plan-fresh' : 'new-structure' : undefined;
        if (!version) delete x.template;
        if (request.planFresh && x.inspection) x.inspection.reason = 'User forced Plan fresh. The decomposition planner will run once.';
        if (instruction) x.edit = { instruction, prompt: compileEditPrompt(version!.generationPrompt, instruction), model: '', size: '' };
        x.usage.generationPromptSource = version ? 'saved-template' : 'planner';
        x.usage.decompositionPlanSource = version ? 'saved-template' : 'planner';
        x.state = 'queued';
      });
      schedule(id, () => run(id));
      return started;
    },
    /** Explicit acceptance of the persisted generated image. Repeated requests cannot generate or decompose twice. */
    decompose(id: string, request: { plan?: unknown; acknowledgeReview?: unknown } = {}): TemplateExecution {
      const execution = executions.get(id);
      if (!execution.reviewBeforeDecompose || !execution.edit?.image) throw new RunError('NOT_GENERATED', 'Generate and review a creative first.');
      if (active.has(id) || execution.runId || execution.state === 'done') return execution;
      if (execution.state !== 'generated' && !(execution.state === 'queued' && execution.imageAcceptedAt)) throw new RunError('NOT_READY', 'This creative is not ready for decomposition.');
      if (!execution.template || !usableVersion(execution.template.id, execution.template.version)) throw new RunError('STALE_TEMPLATE_VERSION', 'This saved template version is unavailable. Choose another template.');
      if (request.plan !== undefined && !EXTRACTION_PLANS.includes(request.plan as ExtractionPlan)) throw new RunError('INVALID_REQUEST', 'Choose the saved plan, a simpler grouping or a refreshed plan.');
      if (request.plan !== undefined && execution.variant && !VARIANT_PLANS.includes(request.plan as ExtractionPlan)) throw new RunError('INVALID_REQUEST', 'A creative variant has new scenery that the saved plan does not describe: use its own layers, or split only the new scenery.');
      if (request.plan === 'composed' && !execution.variant) throw new RunError('INVALID_REQUEST', 'Only a creative variant has its own composed layers.');
      if (request.plan === 'qwen') throw new RunError('INVALID_REQUEST', 'Seedream extracts the layers first; Qwen layers are an alternative offered only after Seedream refuses the image.');
      if (request.acknowledgeReview !== undefined && typeof request.acknowledgeReview !== 'boolean') throw new RunError('INVALID_REQUEST', 'acknowledgeReview is true or false.');
      // Explicit decisions, never assumed: a creative whose review needs a person, and a plan that may no longer fit.
      const review = execution.edit.review;
      if (review?.requiresAcknowledgement && !review.acknowledgedAt && request.acknowledgeReview !== true) throw new RunError('REVIEW_REQUIRED',
        `Check the generated image before it is decomposed: ${review.checks.filter(c => c.severity === 'warning').map(c => c.message).join(' ') || 'a requested object change cannot be confirmed automatically.'}`);
      const plan = request.plan as ExtractionPlan | undefined;
      if (execution.compatibility?.status === 'structural-change' && !plan) throw new RunError('PLAN_DECISION_REQUIRED',
        `This creative changed objects the saved decomposition plan expects (${execution.compatibility.reasons.join(' ')}). Choose the saved plan anyway, a simpler grouping, or a refreshed plan (one planner call) before extraction.`);
      const accepted = executions.update(id, x => {
        const now = new Date().toISOString();
        x.imageAcceptedAt ??= now; x.state = 'queued';
        if (request.acknowledgeReview === true && x.edit?.review) x.edit.review.acknowledgedAt ??= now;
        if (plan) x.planDecision = { choice: plan, at: now, ...(x.compatibility?.reasons.length ? { reasons: x.compatibility.reasons } : {}) };
      });
      schedule(id, () => run(id));
      return accepted;
    },
    /** A failed execution whose run stopped after fal accepted it: its saved result is read again (no new paid call). */
    resume(id: string): TemplateExecution {
      const execution = executions.get(id);
      if (active.has(id)) throw new RunError('BUSY', 'This execution is still running.');
      const dir = execution.runId ? join(runsDir, execution.runId) : undefined, record = dir ? readRun(dir) : undefined;
      if (!dir || !record?.seedream.requestId || record.stage === 'done' || FINAL_RUN_ERRORS.has(record.error?.code ?? '')) throw new RunError('NOT_RESUMABLE', 'This execution cannot be resumed; start it again.');
      const resumed = executions.update(id, (x) => { x.state = 'decomposing'; delete x.error; delete x.finishedAt; });
      log(`[DECOMPOSE] resume run=${record.id} execution=${id} (saved fal request; no new call)`);
      schedule(id, async () => {
        const started = Date.now(), done = await resumeRun(dir, depsFor(resumed));
        // A creative variant's scenery run gets its exact subject back on top, as a first finish would have.
        const v = resumed.variant, withLayers = v && done.stage === 'done' && record.templateExecution?.input?.source === 'variant-scenery' ? await addVariantLayers(dir, variantLayers(resumed, false), { setId: v.setId, variantId: v.variantId }, v.layers.plate) : done;
        return finish(id, withLayers, started, started);
      });
      return resumed;
    },
    /**
     * An explicit, user-chosen new extraction of an execution whose extraction failed (a provider rejection, for one):
     * the same persisted image — never regenerated — with the saved plan, a simpler grouping, or a refreshed plan. Each is
     * a new Seedream request (refresh: one planner call too); never sent automatically.
     */
    /** What fal did with this execution's exact image so far (a read; no call). */
    extractionHistory: (id: string) => extractionHistory(executions.get(id)),
    retryExtraction(id: string, request: { plan?: unknown; confirmRepeat?: unknown } = {}): TemplateExecution {
      const execution = executions.get(id);
      if (active.has(id)) throw new RunError('BUSY', 'This execution is already being extracted.');
      if (!EXTRACTION_PLANS.includes(request.plan as ExtractionPlan)) throw new RunError('INVALID_REQUEST', 'Choose the saved plan, a simpler grouping or a refreshed plan.');
      if (execution.variant ? !VARIANT_PLANS.includes(request.plan as ExtractionPlan) : request.plan === 'composed') throw new RunError('INVALID_REQUEST', execution.variant ? 'A creative variant uses its own layers, or splits only its new scenery.' : 'Only a creative variant has its own composed layers.');
      if (execution.mode === 'CREATE_TEMPLATE') throw new RunError('NOT_RETRYABLE', 'A template that was not created is created again from Create New Template.');
      if (execution.state !== 'failed' || !execution.runId || !execution.error || execution.error.state === 'generating') throw new RunError('NOT_RETRYABLE', 'Only a failed extraction of a saved image can be retried.');
      if (!execution.template || !usableVersion(execution.template.id, execution.template.version)) throw new RunError('STALE_TEMPLATE_VERSION', 'This saved template version is unavailable. Choose another template.');
      const plan = request.plan as ExtractionPlan;
      if ((plan === 'flat' || plan === 'cutouts' || plan === 'qwen') && execution.variant) throw new RunError('INVALID_REQUEST', 'A creative variant already has its own layers: use them instead.');
      if (plan === 'qwen') {
        // The alternative provider only for an image Seedream refused; a Qwen attempt that failed is repeated only when confirmed.
        const h = extractionHistory(execution);
        if (!Object.keys(h.refused).length) throw new RunError('INVALID_REQUEST', 'Qwen layers are an alternative only for an image Seedream refused.');
        if ((execution.error?.code === 'QWEN_LAYERS_FAILED' || execution.extractionAttempts?.some(a => a.plan === 'qwen')) && request.confirmRepeat !== true)
          throw new RunError('REPEAT_REQUIRES_CONFIRMATION', 'A Qwen extraction of this image already failed. Another try is one more fal request (about $0.05) and may fail the same way.', { history: h });
      }
      if (plan === 'cutouts' && !execution.resolution) throw new RunError('INVALID_REQUEST', 'Products can be cut out only from a creative made from its image analysis.');
      // A repeat fal has already refused is never sent without an explicit confirmation: the same plan on the same image,
      // or an image fal's partner check refused at least twice and never accepted. (Refusals so far were billed 0 units.)
      if (SEEDREAM_PLANS.includes(plan) && request.confirmRepeat !== true) {
        const h = extractionHistory(execution), partner = h.refused['partner-content'] ?? 0;
        const same = (plan === 'saved' || plan === 'simple') && h.attempts.some(a => !a.accepted && a.plan === plan);
        if (same || (partner >= 2 && h.accepted === 0)) throw new RunError('REPEAT_REQUIRES_CONFIRMATION', same
          ? `fal already refused this exact request (this image with the ${plan === 'saved' ? 'saved plan' : 'simpler grouping'}). Another try may be refused again; it is billed only if fal accepts it.`
          : `fal's partner check has refused this exact image ${partner} times and never accepted it; its reason is not disclosed. Another try sends the same image and may be refused again; it is billed only if fal accepts it.`, { history: h });
      }
      const retried = executions.update(id, x => {
        const now = new Date().toISOString();
        x.extractionAttempts = [...(x.extractionAttempts ?? []), { runId: x.runId!, plan: x.planDecision?.choice ?? 'saved', ...(x.error ? { error: { code: x.error.code, message: x.error.message } } : {}), at: now }];
        delete x.runId; delete x.error; delete x.finishedAt;
        x.planDecision = { choice: plan, at: now, reasons: ['Explicit retry after a failed extraction.'] };
        x.state = 'queued';
      });
      log(`[DECOMPOSE] explicit retry execution=${id} plan=${plan} (a new provider request)`);
      schedule(id, () => run(id));
      return retried;
    },
    /**
     * An explicit new plan of a saved template's own source creative (one planner call, plus extraction), saved as the
     * template's next version. Earlier versions, and every run that used them, stay as they are.
     */
    async replan(templateId: string, idempotencyKey: unknown): Promise<{ execution: TemplateExecution; created: boolean }> {
      const record = templates.get(templateId), version = record && record.status === 'active' ? templates.current(templateId) : undefined;
      if (!record || !version) throw new RunError('TEMPLATE_NOT_FOUND', 'Template not found.');
      let source: TemplateExecution;
      try { source = executions.get(version.source.executionId); } catch { throw new RunError('SOURCE_UNAVAILABLE', 'This template\'s source creative is no longer stored, so it cannot be planned again. Create a new template from the image instead.'); }
      const bytes = readFileSync(executions.path(source.id, source.upload.file));
      return this.start({ mode: 'CREATE_TEMPLATE', planFresh: true, idempotencyKey, updatesTemplate: { id: templateId, fromVersion: version.version },
        upload: { bytes, fileName: source.upload.originalName ?? source.upload.file, mimeType: source.upload.mimeType } });
    },
    /** Records that the finished decomposition was opened in the editor. */
    opened(id: string, runId: string): TemplateExecution {
      const execution = executions.get(id);
      if (execution.state !== 'done' || execution.runId !== runId) throw new RunError('NOT_DECOMPOSED', 'Only a finished decomposition of this execution can be opened in the editor.');
      return executions.update(id, (x) => { x.editor = { runId, openedAt: new Date().toISOString() }; });
    },
  };
}
export type TemplateExecutions = ReturnType<typeof createTemplateExecutions>;
