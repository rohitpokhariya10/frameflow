/**
 * Which family is this creative? Cheapest evidence first, and a family is only reused when a validation gate agrees:
 *
 *   1. this exact image was analyzed before            → that saved analysis          (0 calls)
 *   2. local layout fingerprint vs analyzed exemplars  → high + validated: reuse      (0 calls)
 *   3. low-cost structural analysis                    → valid and sure: use it       (1 call)
 *   4. … invalid or unsure                              → ONE strong analysis          (+1 call, never more)
 *   5. structure vs every family's blueprint           → high + validated: reuse; otherwise a new family (deduplicated
 *                                                        by the same gate), saved for the next creative.
 *
 * A failed detection changes no family. Rejected candidates are recorded on the family as statistics.
 */
import { blueprintFromAnalysis, calculateCallCost, compareSignatures, decide, instanceSlotValues, type BlueprintRef, type LayoutFingerprint, type MatchCandidate, type MatchMethod, type MatchThresholds,
  type MatchValidation, type StructuralSignature, type StructureAnalysis, type TemplateBlueprint, type TemplateFamily, validateMatch } from '@frameflow/shared';
import type { PlannerUsage } from '../layerizePlanner.js';
import { usageFacts } from '../runDiagnostics.js';
import { compareFingerprints, labelRegions, layoutFingerprint, signatureFromLocalMatch } from './layoutFingerprint.js';
import { ensureSeedFamilies, newFamilyId, type TemplateFamilyStore } from './store.js';
import { STRUCTURE_PROMPT_VERSION, StructurePlannerError, type StructurePlanner, type StructurePlanners, type StructureTier } from './structurePlanner.js';

export interface FamilyServices { store: TemplateFamilyStore; planners: () => StructurePlanners; thresholds: MatchThresholds }
/** One structural analysis call actually made. usd: its budget estimate at configured rates (diagnostics recompute it from the saved response). */
export type DetectionCall = { tier: StructureTier; model: string; status: 'ok' | 'invalid' | 'failed'; responseId?: string; usage?: PlannerUsage; usd?: number; durationMs: number; requestFile?: string; responseFile?: string; error?: { code: string; message: string } };
/** One creative's family detection, saved with its image-template group. */
export interface FamilyDetection {
  status: 'detecting' | 'done' | 'failed';
  startedAt: string; finishedAt?: string; durationMs?: number;
  outcome?: 'reused' | 'created';
  method?: MatchMethod; confidence?: number;
  ref?: BlueprintRef; familyName?: string;
  candidates: MatchCandidate[];
  validation?: MatchValidation;
  calls: DetectionCall[];
  /** Why the strong model was asked. */
  escalation?: string;
  /** This image's own current values per slot, from its own analysis; empty after a local or library match. */
  detectedValues: Record<string, string>;
  /** Where the creative's structure came from. */
  structureSource?: 'analysis' | 'local-fingerprint' | 'library';
  signature?: StructuralSignature;
  error?: { code: string; message: string };
}

const requiredIds = (b: TemplateBlueprint) => b.slots.filter(s => s.required && s.elementId).map(s => s.elementId!);
const usdOf = (call: DetectionCall, raw: unknown) => {
  const facts = usageFacts((raw as { usage?: unknown } | undefined)?.usage) ?? (call.usage ? { inputTokens: call.usage.input_tokens, outputTokens: call.usage.output_tokens } : undefined);
  return calculateCallCost({ kind: 'text', model: call.model, usage: facts }, 1).usd ?? undefined;
};

type DetectionInput = { image: Buffer; sha256: string; services: FamilyServices; groupId?: string; artifactPrefix?: string; save?: (file: string, value: unknown) => void };
const turns = new WeakMap<TemplateFamilyStore, Promise<unknown>>();
/**
 * Detections against one library run one at a time: a second creative of a new layout then finds the family the first
 * one created (0 calls) instead of paying for its own analysis and saving a duplicate family.
 */
export function detectTemplateFamily(input: DetectionInput): Promise<FamilyDetection> {
  const turn = (turns.get(input.services.store) ?? Promise.resolve()).then(() => detectOnce(input));
  turns.set(input.services.store, turn.catch(() => undefined));
  return turn;
}
async function detectOnce(input: DetectionInput): Promise<FamilyDetection> {
  const { store, thresholds } = input.services, started = Date.now(), startedAt = new Date(started).toISOString();
  ensureSeedFamilies(store);
  const families = store.list().filter(f => f.status !== 'retired');
  const blueprints = new Map(families.map(f => [f.id, store.current(f.id)]).filter((e): e is [string, TemplateBlueprint] => !!e[1]));
  const fingerprint = await layoutFingerprint(input.image).catch(() => undefined);
  const detection: FamilyDetection = { status: 'done', startedAt, candidates: [], calls: [], detectedValues: {} };
  const finish = (d: FamilyDetection) => ({ ...d, finishedAt: new Date().toISOString(), durationMs: Date.now() - started });
  const reuse = (family: TemplateFamily, blueprint: TemplateBlueprint, method: MatchMethod, confidence: number, validation: MatchValidation, extra: Partial<FamilyDetection> = {}) => {
    store.update(family.id, (f) => {
      f.stats.matches++; f.stats.confidenceSum += confidence; f.stats.lastUsedAt = new Date().toISOString();
      if (input.groupId) f.examples = [...f.examples, { groupId: input.groupId, at: new Date().toISOString(), method, confidence }].slice(-50);
    });
    return finish({ ...detection, ...extra, outcome: 'reused', method, confidence, validation, ref: { familyId: family.id, version: blueprint.version }, familyName: blueprint.name });
  };
  const reject = (familyId: string, reason: string) => store.update(familyId, (f) => {
    f.stats.rejectedMatches++;
    f.failures = [...f.failures, { at: new Date().toISOString(), ...(input.groupId ? { groupId: input.groupId } : {}), reason }].slice(-30);
  });

  // 1. This exact image, analyzed before: its validated structure is reused as it was.
  const analysisKey = { purpose: 'structure-analysis' as const, promptVersion: STRUCTURE_PROMPT_VERSION, image: input.sha256 };
  let analysis = store.cache.get<{ analysis: StructureAnalysis }>(analysisKey)?.analysis, method: MatchMethod | undefined = analysis ? 'cached-analysis' : undefined;

  // 2. The free local fingerprint against exemplars whose structure was analyzed.
  if (!analysis && fingerprint) {
    const local = families.flatMap(f => f.exemplars.filter(e => e.source === 'analysis' && e.fingerprint).map(e => ({ f, e, c: compareFingerprints(e.fingerprint!, fingerprint) })))
      .sort((a, b) => b.c.score - a.c.score);
    const bestPer = new Map<string, typeof local[number]>();
    for (const item of local) if (!bestPer.has(item.f.id)) bestPer.set(item.f.id, item);
    for (const { f, c } of bestPer.values()) detection.candidates.push({ familyId: f.id, name: f.name, version: f.currentVersion, score: c.score, stage: 'local', problems: [] });
    const best = local[0], blueprint = best && blueprints.get(best.f.id);
    if (best && blueprint && decide(best.c.score, thresholds, thresholds.localHigh) === 'high') {
      const derived = signatureFromLocalMatch({ signature: best.e.signature, fingerprint: best.e.fingerprint! }, fingerprint, best.c);
      const roles = new Set(blueprint.slots.filter(s => s.required).map(s => s.role));
      const problems = [
        ...derived.unverified.map(id => best.e.signature.elements.find(e => e.id === id)!).filter(e => roles.has(e.role)).map(e => `The ${e.role} could not be confirmed locally.`),
        ...best.c.unexplained.map(i => `An unexplained region (${Math.round(fingerprint.regions[i].area * 100)}% of the canvas) is not part of this layout.`),
      ];
      const validation = problems.length ? { passed: false, problems } : validateMatch(blueprint.signature, derived.signature, requiredIds(blueprint));
      detection.candidates.find(c => c.familyId === best.f.id)!.problems = validation.problems;
      if (validation.passed) return reuse(best.f, blueprint, 'local-fingerprint', best.c.score, validation, { structureSource: 'local-fingerprint', signature: derived.signature });
    }
  }

  // 3–4. Structural analysis: the low-cost model once; the strong model once, only when that answer is unusable.
  if (!analysis) {
    const planners = input.services.planners();
    const attempt = async (planner: StructurePlanner | undefined): Promise<StructureAnalysis | undefined> => {
      if (!planner) return undefined;
      const files = { requestFile: `${input.artifactPrefix ?? ''}structure-${planner.tier}.openai-request.json`, responseFile: `${input.artifactPrefix ?? ''}structure-${planner.tier}.openai-response.json` };
      const t = Date.now();
      try {
        const result = await planner.analyze(input.image, 'image/png');
        input.save?.(files.requestFile, result.request); input.save?.(files.responseFile, result.raw);
        const ok = result.analysis.confidence >= thresholds.minPlannerConfidence;
        const call: DetectionCall = { tier: planner.tier, model: result.model, status: ok ? 'ok' : 'invalid', ...(result.responseId ? { responseId: result.responseId } : {}), ...(result.usage ? { usage: result.usage } : {}), durationMs: result.durationMs, ...files,
          ...(ok ? {} : { error: { code: 'STRUCTURE_UNSURE', message: `Confidence ${result.analysis.confidence} is below ${thresholds.minPlannerConfidence}.` } }) };
        call.usd = usdOf(call, result.raw);
        detection.calls.push(call);
        return ok ? result.analysis : undefined;
      } catch (error) {
        const failure = error instanceof StructurePlannerError ? error : undefined;
        if (failure?.raw !== undefined) input.save?.(files.responseFile, failure.raw);
        detection.calls.push({ tier: planner.tier, model: planner.model, status: failure?.code === 'STRUCTURE_INVALID' ? 'invalid' : 'failed', durationMs: Date.now() - t, ...(failure?.raw !== undefined ? { responseFile: files.responseFile } : {}),
          error: { code: failure?.code ?? 'STRUCTURE_FAILED', message: error instanceof Error ? error.message : String(error) } });
        return undefined;
      }
    };
    analysis = await attempt(planners.cheap);
    if (analysis) method = 'cheap-planner';
    else if (planners.strong) {
      detection.escalation = planners.cheap ? `Low-cost analysis unusable: ${detection.calls.at(-1)?.error?.message ?? 'no answer'}` : 'No low-cost planner configured.';
      analysis = await attempt(planners.strong);
      if (analysis) method = 'strong-planner';
    }
    if (!analysis) {
      const last = detection.calls.at(-1);
      return finish({ ...detection, status: 'failed', error: last?.error ?? { code: 'STRUCTURE_NOT_CONFIGURED', message: 'No structural planner is configured.' } });
    }
    store.cache.put(analysisKey, { analysis, tier: method === 'cheap-planner' ? 'cheap' : 'strong' });
  }

  // 5. The creative's structure against every family's current blueprint.
  const scored = [...blueprints.entries()].map(([id, blueprint]) => ({ family: families.find(f => f.id === id)!, blueprint, comparison: compareSignatures(blueprint.signature, analysis!.signature) }))
    .sort((a, b) => b.comparison.score - a.comparison.score);
  for (const s of scored.slice(0, 4)) detection.candidates.push({ familyId: s.family.id, name: s.blueprint.name, version: s.blueprint.version, score: s.comparison.score, stage: 'structure', problems: s.comparison.hardMismatch ? [s.comparison.hardMismatch] : [] });
  const observe = (familyId: string) => {
    const priced = detection.calls.filter(c => c.usd !== undefined), spent = priced.reduce((sum, c) => sum + c.usd!, 0);
    if (priced.length) store.update(familyId, (f) => { f.stats.observed.analysis.calls += priced.length; f.stats.observed.analysis.usd += spent; });
  };
  const exemplar = (familyId: string, signature: StructuralSignature) => store.update(familyId, (f) => {
    if (f.exemplars.some(e => e.sha256 === input.sha256)) return;
    const labelled: LayoutFingerprint | undefined = fingerprint && labelRegions(fingerprint, signature);
    f.exemplars = [...f.exemplars, { id: input.sha256.slice(0, 12), addedAt: new Date().toISOString(), sha256: input.sha256, source: 'analysis' as const, ...(input.groupId ? { groupId: input.groupId } : {}), signature, ...(labelled ? { fingerprint: labelled } : {}) }].slice(-8);
  });
  const best = scored[0];
  if (best && decide(best.comparison.score, thresholds) === 'high') {
    const validation = validateMatch(best.blueprint.signature, analysis.signature, requiredIds(best.blueprint), best.comparison);
    detection.candidates.find(c => c.familyId === best.family.id && c.stage === 'structure')!.problems = validation.problems;
    if (validation.passed) {
      observe(best.family.id); exemplar(best.family.id, analysis.signature);
      return reuse(best.family, best.blueprint, method!, best.comparison.score, validation, { structureSource: 'analysis', signature: analysis.signature,
        detectedValues: instanceSlotValues(best.blueprint, analysis.instance, best.comparison.mapping) });
    }
    reject(best.family.id, `Rejected for ${input.groupId ?? 'a creative'}: ${validation.problems.join(' ')}`);
  }

  // A new family, saved for the next structurally equivalent creative. (A close family that failed validation is not merged.)
  const id = newFamilyId(analysis.layoutName || 'layout');
  const blueprint = blueprintFromAnalysis(analysis, { familyId: id, origin: `detected (${method})` });
  store.create(blueprint, { status: 'provisional' });
  store.update(id, (f) => { f.stats.created++; f.stats.lastUsedAt = new Date().toISOString(); if (input.groupId) f.examples = [{ groupId: input.groupId, at: new Date().toISOString(), method: method!, confidence: analysis!.confidence }]; });
  observe(id); exemplar(id, blueprint.signature);
  return finish({ ...detection, outcome: 'created', method, confidence: analysis.confidence, validation: { passed: true, problems: [] }, ref: { familyId: id, version: 1 }, familyName: blueprint.name,
    structureSource: 'analysis', signature: analysis.signature, detectedValues: instanceSlotValues(blueprint, analysis.instance) });
}

/** A family chosen from the library for one of its own exemplar creatives: no detection, no call. */
export function libraryDetection(store: TemplateFamilyStore, familyId: string): FamilyDetection {
  const family = store.get(familyId), blueprint = family && store.current(familyId);
  if (!family || !blueprint) throw new Error('Family not found.');
  const now = new Date().toISOString();
  store.update(familyId, (f) => { f.stats.matches++; f.stats.confidenceSum += 1; f.stats.lastUsedAt = now; });
  return { status: 'done', startedAt: now, finishedAt: now, durationMs: 0, outcome: 'reused', method: 'library', confidence: 1, validation: { passed: true, problems: [] },
    ref: { familyId, version: blueprint.version }, familyName: blueprint.name, candidates: [], calls: [], detectedValues: {}, structureSource: 'library', signature: blueprint.signature };
}
