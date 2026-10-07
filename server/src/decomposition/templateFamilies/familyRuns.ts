/**
 * Template families at decomposition time.
 *
 * Before a run: a creative of an ACTIVE family is decomposed with the family's saved plan, compiled locally with this
 * creative's values and passed through the same protection and validation as a planner answer (semanticPlan): no
 * planner call, and Seedream is asked for exactly the family's editor layers. A PROVISIONAL family (new, not yet seen
 * decomposing well) and an explicit "plan from scratch" use the full planner.
 *
 * After a run: a reused plan's result must pass a quality gate (every required layer extracted, a usable background, a
 * plausible layer count); a failure is flagged on the run and counted on the family, never hidden. A provisional
 * family becomes active when a full-planner run of it agrees with its plan. Statistics only; prompts are never rewritten.
 */
import { BLUEPRINT_PROMPT_VERSION, compareSignatures, validateMatch, blueprintRefText, compileDecompositionPlan, type BlueprintRef, type MatchValidation, type RunDiagnostics, type StructuralRole, type TemplateBlueprint, type TemplateReuseRecord } from '@frameflow/shared';
import { idWords, PERSON, SCENE } from '../interactionTerms.js';
import { validatePlan } from '../layerizePlanner.js';
import type { PromptSource, RunRecord } from '../layerizeExperiment.js';
import { semanticAnalysisOf } from '../runPlan.js';
import { semanticPlan, type SemanticAnalysis } from '../semanticPlanner.js';
import type { FamilyDetection } from './familyMatcher.js';
import { hashOf, slotSchemaHash, type TemplateFamilyStore } from './store.js';
import { compareFingerprints, layoutFingerprint, signatureFromLocalMatch, visibleElements } from './layoutFingerprint.js';

/** What an image-template group of the family workflow keeps (group.json `family`). */
export interface FamilyAssignment {
  detection?: FamilyDetection;
  previousCalls?: FamilyDetection['calls'];
  /** The user's changes, by slot. Empty: keep what the reference shows. */
  slotValues: Record<string, string>;
  /** The version generation and decomposition use: the detected one, fixed when generation starts. */
  ref?: BlueprintRef;
  generation?: { ref: BlueprintRef; slotValues: Record<string, string>; prompt: string; compiledAt: string; cacheKey: string };
}

/** The values a decomposition of one image describes: what this image showed, overridden by what the user changed for it. */
export function decompositionValues(assignment: FamilyAssignment, variantId: string): Record<string, string> {
  const detected = assignment.detection?.detectedValues ?? {};
  return variantId === 'original' ? { ...detected } : { ...detected, ...(assignment.generation?.slotValues ?? assignment.slotValues) };
}

export function reuseRecord(blueprint: TemplateBlueprint, detection: FamilyDetection, input: { generated: boolean; planReused: boolean; reason?: string; imageValidation?: MatchValidation }): TemplateReuseRecord {
  const calls = detection.calls, cheap = calls.filter(c => c.tier === 'cheap').length, strong = calls.filter(c => c.tier === 'strong').length;
  return { familyId: blueprint.familyId, familyName: blueprint.name, version: blueprint.version, matchMethod: detection.method ?? 'library', matchConfidence: detection.confidence ?? 0,
    analysisReused: calls.length === 0, generationPromptTemplateReused: input.generated, decompositionPlanReused: input.planReused,
    structuralPlannerCalls: calls.length, cheapPlannerCalls: cheap, strongPlannerCalls: strong,
    // Avoided means not made: a structural analysis when the family was known without one, the planner when its plan was reused.
    avoided: { analysis: calls.length === 0 ? 1 : 0, planner: input.planReused ? 1 : 0 },
    ...(input.reason ? { planNotReusedReason: input.reason } : {}), ...(input.imageValidation ? { imageValidation: input.imageValidation } : {}) };
}

/**
 * How a family creative's image is decomposed: its family's compiled plan (blueprint prompt source, no planner call),
 * or the full planner when the family is provisional, the user asked to plan afresh, or a generated image was not
 * confirmed against the family's layout (options.imageValidation, from validateGeneratedFamily).
 */
export function familyDecomposition(store: TemplateFamilyStore, assignment: FamilyAssignment, variant: { id: string }, options: { planFresh?: boolean; imageValidation?: MatchValidation } = {}): { promptSource: PromptSource; templateReuse: TemplateReuseRecord; blueprint: TemplateBlueprint; templateKey: string } {
  const ref = assignment.generation?.ref ?? assignment.ref ?? assignment.detection?.ref, detection = assignment.detection && { ...assignment.detection, calls: [...(assignment.previousCalls ?? []), ...assignment.detection.calls] };
  const blueprint = ref && store.blueprint(ref), family = ref && store.get(ref.familyId);
  if (!ref || !blueprint || !family || !detection) throw new Error('This creative has no template family yet. Detect its layout first.');
  const generated = variant.id !== 'original';
  const signature = detection.signature;
  const compatible = detection.status === 'done' && detection.validation?.passed && signature &&
    validateMatch(blueprint.signature, signature, blueprint.slots.filter(s => s.required && s.elementId).map(s => s.elementId!), compareSignatures(blueprint.signature, signature)).passed;
  // A generated image may have moved, added or dropped elements: its plan is reused only once its own layout was
  // confirmed against the family (validateGeneratedFamily). The uploaded original is the detected image itself.
  const imageValidation = generated ? options.imageValidation : undefined, imageConfirmed = !generated || imageValidation?.passed === true;
  if (options.planFresh || family.status !== 'active' || !compatible || !imageConfirmed) {
    const reason = options.planFresh ? 'plan-fresh' : family.status !== 'active' ? 'provisional-family' : !compatible ? 'incompatible-evidence' : imageValidation ? 'generated-image-drift' : 'generated-image-unchecked';
    return { promptSource: { mode: 'generated' }, templateReuse: reuseRecord(blueprint, detection, { generated, planReused: false, reason, imageValidation }), blueprint, templateKey: blueprint.decompositionRecipe };
  }
  const values = decompositionValues(assignment, variant.id);
  const key = { purpose: 'decomposition-plan' as const, promptVersion: BLUEPRINT_PROMPT_VERSION, blueprint: blueprintRefText(ref), slotSchema: slotSchemaHash(blueprint), values: hashOf(values) };
  type Cached = { plan: ReturnType<typeof semanticPlan>; requiredElements: string[] };
  let cached = store.cache.get<Cached>(key);
  if (!cached) {
    const compiled = compileDecompositionPlan(blueprint, values);
    cached = { plan: semanticPlan(compiled.plan), requiredElements: compiled.requiredElements };
    validatePlan(cached.plan);
    store.cache.put(key, cached);
  }
  return { promptSource: { mode: 'blueprint', familyId: ref.familyId, familyName: blueprint.name, version: ref.version, compiledAt: new Date().toISOString(), slotValues: values, requiredElements: cached.requiredElements, ...cached.plan },
    templateReuse: reuseRecord(blueprint, detection, { generated, planReused: true, imageValidation }), blueprint, templateKey: blueprint.decompositionRecipe };
}

/**
 * Image generation may move, add or drop elements. Confirms the generated image's own layout locally (no call) against
 * an analyzed example of its family before its planner is skipped: a close fingerprint, nothing large unexplained, every
 * element the example visibly showed still found, and the structural validation of a match. Failing, the closest
 * example's problems say why.
 */
export async function validateGeneratedFamily(store: TemplateFamilyStore, assignment: FamilyAssignment, image: Buffer, localHigh: number): Promise<MatchValidation> {
  const ref = assignment.generation?.ref ?? assignment.ref;
  const blueprint = ref && store.blueprint(ref), family = ref && store.get(ref.familyId);
  if (!blueprint || !family) return { passed: false, problems: ['No pinned blueprint.'] };
  const fingerprint = await layoutFingerprint(image).catch(() => undefined);
  if (!fingerprint) return { passed: false, problems: ['The generated image could not be read for a layout check.'] };
  const required = blueprint.slots.filter(s => s.required && s.elementId).map(s => s.elementId!), requiredRoles = new Set(blueprint.slots.filter(s => s.required).map(s => s.role));
  const percent = (n: number) => `${Math.round(n * 100)}%`;
  let closest: { score: number; problems: string[] } | undefined;
  for (const exemplar of family.exemplars) {
    if (!exemplar.fingerprint) continue;
    const comparison = compareFingerprints(exemplar.fingerprint, fingerprint), problems: string[] = [];
    if (comparison.score < localHigh) problems.push(`Its layout matches the saved one at ${percent(comparison.score)}; reusing the plan needs ${percent(localHigh)}.`);
    if (comparison.unexplained.length) problems.push(`It has ${comparison.unexplained.length} large element${comparison.unexplained.length > 1 ? 's' : ''} the saved layout does not have.`);
    if (!problems.length) {
      const derived = signatureFromLocalMatch({ signature: exemplar.signature, fingerprint: exemplar.fingerprint }, fingerprint, comparison), visible = visibleElements(exemplar.fingerprint);
      const role = (id: string) => exemplar.signature.elements.find(e => e.id === id)!.role;
      for (const id of derived.unverified.filter(id => visible.has(id) || requiredRoles.has(role(id)))) problems.push(`The ${role(id)} of the saved layout was not found in place.`);
      if (!problems.length) {
        const validation = validateMatch(blueprint.signature, derived.signature, required);
        if (validation.passed) return validation;
        problems.push(...validation.problems);
      }
    }
    if (!closest || comparison.score > closest.score) closest = { score: comparison.score, problems };
  }
  return { passed: false, problems: closest?.problems ?? ['No analyzed example of this layout can be compared locally.'] };
}

/** The quality gate of a decomposition made with a reused plan. */
export function validateReusedDecomposition(run: RunRecord, blueprint: TemplateBlueprint): MatchValidation & { rawLayers?: number; editorLayers: number } {
  const problems: string[] = [], source = run.promptSource;
  const editorLayers = run.stage === 'done' ? run.editorLayerFiles?.length ?? (run.outputLayers ?? run.layers ?? []).length : 0;
  const rawLayers = run.layerCount?.providerReturnedLayers;
  if (run.stage !== 'done') problems.push(`The decomposition did not finish (${run.error?.code ?? run.stage}).`);
  else {
    const coverage = run.refinement?.planCoverage;
    const required = source?.mode === 'blueprint' ? source.requiredElements : [];
    if (!coverage) problems.push('Whether every expected layer was extracted could not be measured.');
    else for (const id of required.filter(id => blueprint.decompositionPlanTemplate.elements.find(e => e.id === id)?.role !== 'background' && (!coverage.planned.includes(id) || !coverage.matched[id]))) problems.push(`The expected ${idWords(id)} layer was not extracted.`);
    const { min, max } = blueprint.curationPolicy.expectedEditorLayers;
    if (editorLayers < min) problems.push(`Only ${editorLayers} editor layers; this layout needs at least ${min}.`);
    if (editorLayers > max + 2) problems.push(`${editorLayers} editor layers; this layout expects at most ${max}.`);
    const background = run.refinement?.background;
    if (background && (background.contaminated || (background.quality && background.quality !== 'usable'))) problems.push('The background is not clean.');
  }
  return { passed: problems.length === 0, problems, editorLayers, ...(rawLayers !== undefined ? { rawLayers } : {}) };
}

/** Rough semantic category of a planner element, by the words the existing protection code reads. */
function category(type: string, id: string): StructuralRole | 'text' | 'other' {
  const words = idWords(`${id} ${type}`);
  if (/\b(?:button|cta|call to action)\b/i.test(words)) return 'cta';
  if (/\b(?:badge|sticker|tag|seal)\b/i.test(words)) return 'badge';
  if (/\b(?:logo|wordmark|brand mark)\b/i.test(words)) return 'logo';
  if (/\b(?:frame|border|arch)\b/i.test(words)) return 'frame';
  if (/\b(?:text|headline|heading|title|price|offer|caption|copy)\b/i.test(words)) return 'text';
  if (PERSON.test(words)) return 'person';
  if (SCENE.test(words)) return 'background';
  if (/\b(?:product|device|phone|bottle|box|pack|shoe|bag|watch|headphones?|earbuds?|laptop|item|object)\b/i.test(words)) return 'product';
  return 'other';
}
/** Whether a full plan of a creative agrees with the family's saved plan: every required role present, and a similar layer count. */
export function planAgreement(blueprint: TemplateBlueprint, semantic: SemanticAnalysis | undefined): MatchValidation {
  if (!semantic) return { passed: false, problems: ['No semantic plan to compare.'] };
  const independent = semantic.elements.filter(e => e.editable_independently), found = new Set(independent.map(e => category(e.type, e.id)));
  const problems: string[] = [];
  for (const e of blueprint.decompositionPlanTemplate.elements.filter(x => x.required && !x.attachment && x.role !== 'background')) {
    const want = ['headline', 'subheadline', 'body', 'price', 'offer'].includes(e.role) ? 'text' : e.role;
    if (!found.has(want as StructuralRole | 'text') && !(want === 'product' && found.has('other'))) problems.push(`The planner found no ${e.role}.`);
  }
  const expected = blueprint.decompositionPlanTemplate.elements.filter(e => !e.attachment).length;
  if (Math.abs(independent.length - expected) > 3) problems.push(`The planner made ${independent.length} layers; the layout expects about ${expected}.`);
  return { passed: problems.length === 0, problems };
}

/**
 * Records a finished run on its family (once): success or failure, layers, calls and cost, the reused plan's quality
 * gate, and activation of a provisional family whose full plan agreed with its saved one.
 */
export function recordFamilyRun(store: TemplateFamilyStore, run: RunRecord, diagnostics?: Pick<RunDiagnostics, 'total' | 'rawLayers' | 'editorLayers' | 'stages'>): RunRecord {
  const reuse = run.templateReuse, ref = run.blueprint;
  if (!reuse || !ref || (run.stage !== 'done' && run.stage !== 'failed')) return run;
  const blueprint = store.blueprint(ref), family = store.get(ref.familyId);
  if (!blueprint || !family) return run;
  // The quality gate is checked on every finished result (a resumed run too); statistics are counted once per run.
  if (reuse.decompositionPlanReused && (run.stage === 'done' || !reuse.validation)) {
    const validation = validateReusedDecomposition(run, blueprint);
    reuse.validation = { ...validation, checkedAt: new Date().toISOString() };
    if (!validation.passed && run.stage === 'done') run.warnings = [...run.warnings.filter(w => !w.startsWith('BLUEPRINT_REUSE_UNVERIFIED')), `BLUEPRINT_REUSE_UNVERIFIED: the reused ${blueprint.name} plan gave an inconsistent result (${validation.problems.join(' ')}). Review it, or decompose again with a fresh plan (1 planner request).`];
  }
  if (reuse.statsRecorded) return run;
  const ok = run.stage === 'done' && (reuse.validation?.passed ?? true);
  const agreement = !reuse.decompositionPlanReused && run.stage === 'done' && family.status === 'provisional' ? planAgreement(blueprint, semanticAnalysisOf(run)) : undefined;
  const plannerUsd = diagnostics?.stages.find(s => s.id === 'planner')?.cost;
  store.update(ref.familyId, (f) => {
    const s = f.stats;
    if (ok) s.decompositionSuccess++; else s.decompositionFailure++;
    if (reuse.validation && !reuse.validation.passed) {
      s.reuseValidationFailures++;
      f.failures = [...f.failures, { at: new Date().toISOString(), runId: run.id, reason: `Reused plan: ${reuse.validation.problems.join(' ')}` }].slice(-30);
    }
    if (reuse.planNotReusedReason === 'plan-fresh') s.manualReplans++;
    if (run.stage === 'done') {
      s.decompositionsMeasured++; s.editorLayers += diagnostics?.editorLayers ?? reuse.validation?.editorLayers ?? 0;
      s.rawLayers += diagnostics?.rawLayers ?? run.layerCount?.providerReturnedLayers ?? 0;
    }
    s.residualCalls += run.calls?.seedreamResidual ?? 0; s.backgroundEditCalls += run.calls?.backgroundReconstruction ?? 0;
    if (diagnostics && diagnostics.total.confidence !== 'Unknown') { s.totalUsd += diagnostics.total.knownUsd; s.costedRuns++; }
    if (run.planner && plannerUsd && plannerUsd.confidence !== 'Unknown') { s.observed.planner.calls++; s.observed.planner.usd += plannerUsd.knownUsd; }
    s.lastUsedAt = new Date().toISOString();
    if (agreement?.passed && run.refinement?.background?.quality === 'usable' && !run.refinement.background.contaminated) { f.status = 'active'; f.activatedBy = run.id; }
    else if (agreement) f.failures = [...f.failures, { at: new Date().toISOString(), runId: run.id, reason: `Plan agreement: ${agreement.problems.join(' ')}` }].slice(-30);
  });
  reuse.statsRecorded = true;
  return run;
}

/** Records one finished or failed image generation of a family creative. */
export function recordFamilyGeneration(store: TemplateFamilyStore, ref: BlueprintRef | undefined, ok: boolean): void {
  if (!ref || !store.get(ref.familyId)) return;
  store.update(ref.familyId, (f) => { if (ok) f.stats.generationSuccess++; else f.stats.generationFailure++; f.stats.lastUsedAt = new Date().toISOString(); });
}
