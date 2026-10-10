/** Read-only projection of persisted artifacts. No provider clients, writes, or downloads. */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { AI_PRICING, avoidedPlannerCost, budgetFx, calculateStageCost, EXECUTION_POLICY, sumCosts, type DiagnosticStage, type ExecutionTelemetry, type PaidCall, type RunDiagnostics, type StageId, type StageStatus, type TemplateExecution, type UsageFacts } from '@frameflow/shared';
import { readRun, validRunId, type RunRecord } from './layerizeExperiment.js';
import type { ExecutionStore } from './creativeTemplates/executions.js';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {};
const str = (v: unknown) => typeof v === 'string' ? v : undefined;
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const safeFile = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(v) && !v.includes('..');
function json(dir: string, file: unknown): Json {
  if (!safeFile(file)) return {};
  try { return obj(JSON.parse(readFileSync(join(dir, file), 'utf8'))); } catch { return {}; }
}
export function usageFacts(value: unknown): UsageFacts | undefined {
  const u = obj(value); if (!Object.keys(u).length) return undefined;
  const input = obj(u.input_tokens_details), output = obj(u.output_tokens_details), cached = obj(input.cached_tokens_details);
  return { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens), cachedTokens: num(input.cached_tokens), cacheWriteTokens: num(input.cache_write_tokens),
    reasoningTokens: num(output.reasoning_tokens) ?? num(u.reasoning_tokens), imageInputTokens: num(input.image_tokens), textInputTokens: num(input.text_tokens),
    imageCachedTokens: num(cached.image_tokens), textCachedTokens: num(cached.text_tokens), imageOutputTokens: num(output.image_tokens), textOutputTokens: num(output.text_tokens) };
}
function recordedCall(kind: 'text' | 'image', response: Json, request: Json, fallback: Json = {}): PaidCall {
  return { kind, model: str(response.model) ?? str(request.model) ?? str(fallback.model), requestId: str(response.id) ?? str(fallback.responseId) ?? str(fallback.requestId),
    usage: usageFacts(response.usage ?? fallback.usage), quality: str(response.quality) ?? str(request.quality),
    imageCount: kind === 'image' && Array.isArray(response.data) ? response.data.length : undefined };
}
const padCalls = (calls: PaidCall[], count: number, kind: PaidCall['kind']) => {
  for (let i = calls.length; i < Math.min(100, count); i++) calls.unshift({ kind, note: 'Earlier attempt has no retained response; billing is unknown.' });
  return calls;
};
/** imageTemplatesDir: where reference creatives are kept. executions: the template executions (their image edits). */
export interface DiagnosticsOptions { imageTemplatesDir?: string; executions?: Pick<ExecutionStore, 'get' | 'path'>; fx?: string | number }
/** Generation has cost evidence before a decomposition run exists; use the same accounting as its later dashboard. */
export function executionGenerationCost(execution: TemplateExecution, executions: Pick<ExecutionStore, 'path'>, fx?: string | number) {
  const edit = execution.edit;
  const dir = dirname(executions.path(execution.id, 'execution.json'));
  const calls = execution.usage.imageGenerationCalls ? [recordedCall('image', json(dir, edit?.responseFile), json(dir, edit?.requestFile), { model: edit?.model })] : [];
  return calculateStageCost(calls, budgetFx(fx));
}
/** A template execution's run, as its dashboard reads it: the calls its mode made or skipped. */
function executionTelemetry(run: RunRecord, execution: TemplateExecution | undefined): ExecutionTelemetry | undefined {
  const own = run.templateExecution;
  if (!own) return undefined;
  const policy = EXECUTION_POLICY[own.mode], plannerCalls = run.calls?.planner ?? (run.planner ? 1 : 0);
  return { ...own, ...(execution?.template ? { template: execution.template } : {}), plannerCalled: plannerCalls > 0, promptGenerationCalled: false, imageGenerationCalled: execution?.usage.imageGenerationCalled ?? false,
    generationPromptSource: execution?.usage.generationPromptSource ?? (own.mode === 'CREATE_TEMPLATE' ? 'planner' : own.mode === 'REUSE_TEMPLATE_WITH_EDIT' ? 'saved-template' : 'none'),
    decompositionPlanSource: policy.planner ? 'planner' : 'saved-template', plannerCallsAvoided: policy.planner || plannerCalls ? 0 : 1 };
}
export async function readRunDiagnostics(dir: string, options: DiagnosticsOptions = {}): Promise<RunDiagnostics> {
  const run = readRun(dir), fx = budgetFx(options.fx), stages: DiagnosticStage[] = [], prompts: RunDiagnostics['prompts'] = [], notes: string[] = [], raw: RunDiagnostics['raw'] = [];
  const done = run.stage === 'done', failed = run.stage === 'failed', terminal = done || failed;
  const add = (id: StageId, label: string, status: StageStatus, calls: PaidCall[], result: string, callsMeasured = true) => {
    stages.push({ id, label, status, calls, callsMeasured, result, cost: calculateStageCost(calls, fx) });
  };
  const pending = (): StageStatus => terminal ? 'Skipped' : 'Pending';
  let sourceTime = 0, sourceTimeKnown = true, execution: TemplateExecution | undefined;
  if (run.origin?.kind === 'template-execution') {
    try { execution = options.executions?.get(run.origin.generationId); } catch { execution = undefined; }
    const mode = run.templateExecution?.mode;
    const edit = execution?.edit, editDir = execution && options.executions ? (file: unknown) => safeFile(file) ? json(dirname(options.executions!.path(execution!.id, file)), file) : {} : undefined;
    const inspection = execution?.inspection ?? run.templateExecution?.inspection, usage = execution?.usage;
    if (execution?.resolution && usage) {
      // A smart edit: the image's analysis (shared by every generation from that image) and its plan's resolution.
      const calls = [...padCalls(usage.analysisCalls ? [recordedCall('text', editDir?.('analysis.openai-response.json') ?? {}, editDir?.('analysis.openai-request.json') ?? {})] : [], usage.analysisCalls ?? 0, 'text'),
        ...(usage.resolutionCalls ? [recordedCall('text', editDir?.('resolution.openai-response.json') ?? {}, editDir?.('resolution.openai-request.json') ?? {})] : [])];
      add('reference', 'Image analysis & change resolution', 'Complete', calls, `${usage.analysisCalls ?? 0} analysis call(s) of this image (shared) · ${usage.resolutionCalls ?? 0} resolution call · prompt compiled locally`);
      notes.push('The image analysis is shared by every smart edit made from that image; its full retained charge is included here. Do not sum run totals as an account bill.');
    } else if (execution?.variant || execution?.variantSource) {
      const concepts = editDir?.('concepts.openai-response.json') ?? {};
      add('reference', 'Subject cutout & scene concepts', 'Complete', Object.keys(concepts).length ? [recordedCall('text', concepts, editDir?.('concepts.openai-request.json') ?? {})] : [], 'Made in the creative variant set: the subject mask (fal, priced by fal) and the scene concepts (shared by the set\'s variants)', false);
      notes.push(`This creative variant came from a set: its subject mask requests and scene concepts are shared by the set's variants. ${execution.variant ? 'The subject layer is the reference\'s own pixels.' : 'Its products were rendered into the scene from their cutouts.'}`);
    } else if (inspection?.calls) {
      const response = editDir?.(inspection.responseFile) ?? {}, request = editDir?.(inspection.requestFile) ?? {};
      add('reference', 'Structure analysis', inspection.outcome === 'uncertain' ? 'Warning' : 'Complete', padCalls([recordedCall('text', response, request, { model: inspection.model })], inspection.calls, 'text'), inspection.reason);
      sourceTime += inspection.durationMs ?? 0; sourceTimeKnown &&= inspection.durationMs !== undefined;
    } else add('reference', 'Structure analysis', 'Skipped', [], inspection?.reason ?? (mode === 'CREATE_TEMPLATE' ? 'No separate analysis: the planner call also returned the reusable template' : 'Saved template reused · no analysis call'));
    if (edit && execution?.usage.imageGenerationCalled) {
      const response = editDir?.(edit.responseFile) ?? {}, request = editDir?.(edit.requestFile) ?? {}, call = recordedCall('image', response, request, { model: edit.model });
      // A layered smart edit made two image requests: the background pass first, then the objects in their slots.
      const pass1 = editDir?.('edit-pass1.openai-response.json') ?? {}, layered = Object.keys(pass1).length > 0;
      const calls = layered ? [recordedCall('image', pass1, editDir?.('edit-pass1.openai-request.json') ?? {}, { model: edit.model }), call] : [call];
      add('generation', 'Generate image', edit.image ? 'Complete' : 'Failed', calls, edit.image ? `${layered ? '2 image edits (background, then each changed object in its own slot)' : '1 image edit of the upload'} · ${call.quality ?? 'quality not recorded'}` : 'The image edit failed');
      prompts.push({ label: 'Image edit prompt (saved template + instruction)', text: edit.prompt, model: edit.model, inputTokens: call.usage?.inputTokens });
      sourceTime += edit.durationMs ?? 0; sourceTimeKnown &&= edit.durationMs !== undefined;
    } else add('generation', 'Generate image', 'Skipped', [], 'Original upload used unchanged · no image generation');
    if (usage?.verificationCalls) {
      const semantic = edit?.review?.semantic;
      add('verification', 'AI check of the result', semantic?.status === 'contradiction' ? 'Warning' : semantic?.status === 'unchecked' ? 'Failed' : 'Complete',
        padCalls([recordedCall('text', editDir?.('verification.openai-response.json') ?? {}, editDir?.('verification.openai-request.json') ?? {}, { model: usage.verifierModel })], usage.verificationCalls, 'text'),
        semantic ? `${semantic.status}${semantic.reason ? ` · ${semantic.reason}` : ''}` : 'Recorded');
    }
    if (run.composed) notes.push(run.composed.extraction === 'none' ? 'Layers composed locally from the creative variant: no planner or Seedream call.' : 'Seedream split only the variant\'s new scenery; the exact subject and its shadow were added on top.');
  } else if (run.origin?.kind === 'image-template') {
    const root = options.imageTemplatesDir;
    const sourceDir = root && validRunId(run.origin.generationId) ? join(root, run.origin.generationId) : undefined;
    const group = sourceDir ? json(sourceDir, 'group.json') : {};
    const variants = array(group.variants).map(obj);
    const variant = variants.find(v => v.id === run.origin!.variantId) ?? {};
    const ref = obj(group.promptGeneration);
    const response = sourceDir ? json(sourceDir, ref.responseFile ?? 'prompt.openai-response.json') : {};
    const request = sourceDir ? json(sourceDir, ref.requestFile ?? 'prompt.openai-request.json') : {};
    const attempted = Object.keys(ref).length > 0 || !Object.keys(group).length;
    const analysisChanged = str(ref.finishedAt) && str(variant.startedAt) && Date.parse(String(ref.finishedAt)) > Date.parse(String(variant.startedAt));
    const calls = attempted ? analysisChanged ? [{ kind: 'text' as const, note: 'Reference analysis was regenerated after this image; original usage is unavailable.' }] : padCalls([recordedCall('text', response, request, ref)], num(ref.attempts) ?? 1, 'text') : [];
    if (analysisChanged) notes.push('The reference was analyzed again after image generation. Earlier analysis usage and call count are unavailable.');
    add('reference', 'Analyze reference', attempted ? ref.status === 'failed' ? 'Warning' : Object.keys(ref).length ? 'Complete' : 'Warning' : 'Skipped', calls,
      attempted ? 'Shared reference analysis · full saved charge attributed to this image' : 'Prompt supplied manually', (num(ref.attempts) !== undefined || !attempted) && !analysisChanged);
    if (attempted) {
      notes.push('Reference analysis is shared across variants. Its full retained charge is included here; do not sum these run totals as an account bill.');
      sourceTime += num(ref.durationMs) ?? 0; sourceTimeKnown &&= num(ref.durationMs) !== undefined && calls.length === 1 && !analysisChanged;
    }
    if (str(request.instructions)) prompts.push({ label: 'Reference instructions', text: String(request.instructions), model: calls.at(-1)?.model, inputTokens: calls.at(-1)?.usage?.inputTokens });
    const imageResponse = sourceDir ? json(sourceDir, variant.responseFile) : {}, imageRequest = sourceDir ? json(sourceDir, variant.requestFile) : {};
    const call = recordedCall('image', imageResponse, imageRequest, obj(variant.generator));
    const imageCalls = padCalls([call], num(variant.attempts) ?? 1, 'image');
    add('generation', 'Generate image', variant.status === 'done' ? 'Complete' : 'Warning', imageCalls, `${call.imageCount ?? '?'} image(s) · ${call.quality ?? 'quality not recorded'}`, num(variant.attempts) !== undefined);
    const prompt = str(imageRequest.prompt) ?? str(variant.prompt);
    if (prompt) prompts.push({ label: 'Generation prompt', text: prompt, model: call.model, inputTokens: call.usage?.inputTokens });
    sourceTime += num(variant.durationMs) ?? 0; sourceTimeKnown &&= num(variant.durationMs) !== undefined && imageCalls.length === 1;
    notes.push('Generation belongs to the linked source image and is included once in this view, even when that image has other decomposition runs.');
  } else {
    add('reference', 'Analyze reference', 'Skipped', [], 'Uploaded image; no linked reference analysis');
    add('generation', 'Generate image', 'Skipped', [], 'Uploaded image; no linked generation');
  }
  // Runs saved before the template fit check was removed may have made it: its recorded charge is still shown.
  const legacy = run as RunRecord & { templateFit?: Json; calls?: { fitCheck?: number } };
  const fit = json(dir, 'template-fit.json');
  const fitCalls = legacy.calls?.fitCheck ?? (legacy.templateFit || run.error?.code === 'FIT_CHECK_FAILED' ? 1 : 0);
  add('fit', 'Check template fit', fitCalls ? legacy.templateFit ? legacy.templateFit.fits ? 'Complete' : 'Failed' : failed ? 'Failed' : 'Running' : 'Skipped',
    fitCalls ? padCalls([recordedCall('text', obj(fit.response), obj(fit.request), obj(legacy.templateFit))], fitCalls, 'text') : [], str(legacy.templateFit?.reason) ?? (fitCalls ? 'Template suitability check' : 'Not requested'), !!run.calls || !!legacy.templateFit || !fitCalls);
  const plannerResponse = json(dir, 'openai-response.json'), plannerRequest = json(dir, 'openai-request.json');
  const plannerCalls = run.calls?.planner ?? (run.planner || Object.keys(plannerResponse).length || (run.error?.stage === 'planning' && run.error.code !== 'FIT_CHECK_FAILED' && run.error.code !== 'TEMPLATE_NOT_SUITABLE' && run.error.code !== 'PLANNER_NOT_ALLOWED') ? 1 : 0);
  const planner = recordedCall('text', plannerResponse, plannerRequest, obj(run.planner));
  const reused = run.promptSource && run.promptSource.mode !== 'generated';
  add('planner', 'Plan layers', run.planner ? 'Complete' : plannerCalls ? failed ? 'Failed' : 'Running' : reused ? 'Skipped' : pending(),
    plannerCalls ? padCalls([planner], plannerCalls, 'text') : [], run.planner ? `${run.planner.planned_layers.length} planned elements${run.planner.capture ? ' · reusable template captured in the same call' : ''}`
      : run.promptSource?.mode === 'template-plan' ? `Saved template plan reused (${run.promptSource.templateName} v${run.promptSource.version}) · no planner call` : reused ? 'Saved plan reused · no new planner call' : 'Layer planning', !!run.calls || !!run.planner || !plannerCalls);
  if (str(plannerRequest.instructions)) prompts.push({ label: 'Planner instructions', text: String(plannerRequest.instructions), model: planner.model, inputTokens: planner.usage?.inputTokens });
  if (run.finalPrompt !== undefined) prompts.push({ label: 'Seedream prompt', text: run.finalPrompt || '(Empty prompt: automatic major elements)', model: run.seedream.endpoint });
  const seedreamFacts = async (pass: number): Promise<PaidCall> => {
    const prefix = pass ? `pass-${pass}-` : '';
    const response = json(dir, `${prefix}seedream-response.json`), request = json(dir, `${prefix}seedream-request.json`);
    const saved = array(json(dir, `${prefix}raw-layers.json`).layers).map(obj);
    const layers = array(obj(response.data).layers ?? response.layers).map(obj);
    const base = saved.find(l => obj(l.placement).kind === 'base');
    const providerBase = layers.find(l => l.z_index === 0), dimensions = obj(providerBase?.image);
    let width = num(dimensions.width) ?? num(base?.pixelWidth), height = num(dimensions.height) ?? num(base?.pixelHeight);
    // Native file dimensions, never the residual's resized canvas or the curated base.
    const file = base?.file ?? (providerBase ? `${prefix}layer-${String(layers.indexOf(providerBase)).padStart(2, '0')}.png` : undefined);
    if ((!width || !height) && safeFile(file) && existsSync(join(dir, file))) {
      try { const meta = await sharp(join(dir, file)).metadata(); width = meta.width; height = meta.height; } catch { /* Missing image stays unknown. */ }
    }
    for (const l of saved) {
      if (!safeFile(l.file)) continue;
      const decision = run.refinement?.curation?.entries.find(e => e.file === l.file);
      raw.push({ file: l.file, name: str(l.name) ?? l.file, pass, disposition: decision?.disposition ?? 'unrecorded', reasons: decision?.reasons ?? ['Disposition was not recorded for this older run.'] });
    }
    return { kind: 'seedream', model: str(request.endpoint) ?? run.seedream.endpoint,
      requestId: pass ? run.refinement?.passes.find(p => p.pass === pass)?.requestId : run.seedream.requestId,
      rawLayers: layers.length || saved.length || (pass ? run.refinement?.passes.find(p => p.pass === pass)?.returnedLayers : run.layerCount?.providerReturnedLayers),
      baseWidth: width, baseHeight: height,
      noCharge: !pass && run.error?.provider?.billableUnits === '0' ? true : undefined };
  };
  const initialCalls = run.calls?.seedreamInitial ?? (run.seedream.requestId || existsSync(join(dir, 'seedream-request.json')) || existsSync(join(dir, 'seedream-response.json')) || run.error?.stage === 'submitting' ? 1 : 0);
  const initial = initialCalls ? await seedreamFacts(0) : undefined;
  const hasOutput = existsSync(join(dir, 'seedream-response.json'));
  add('seedream', 'Generate raw layers', hasOutput ? 'Complete' : initialCalls ? failed ? 'Failed' : 'Running' : pending(), initial ? padCalls([initial], initialCalls, 'seedream') : [],
    initial?.rawLayers !== undefined ? `${initial.rawLayers} billable raw layers` : initialCalls ? 'Provider output not yet available' : 'Not run', !!run.calls || !!run.seedream.requestId || !initialCalls);
  const submittedPasses = (run.refinement?.passes ?? []).filter(p => p.requestId || existsSync(join(dir, `pass-${p.pass}-seedream-request.json`)) || existsSync(join(dir, `pass-${p.pass}-seedream-response.json`)));
  const residual = await Promise.all(submittedPasses.map(p => seedreamFacts(p.pass)));
  padCalls(residual, run.calls?.seedreamResidual ?? residual.length, 'seedream');
  const ref = run.refinement;
  const stopLabels: Record<string, string> = {
    clean: 'No meaningful missed objects detected', 'below-threshold': 'Only minor background residue remained',
    'low-confidence': 'No confident missed object detected', 'not-assessable': 'No assessable background remained after extraction',
    'residue-only': 'Only shadows or background residue remained', 'max-depth': 'Configured pass limit reached',
    'no-new-layers': 'No new useful layers found', 'all-duplicates': 'Additional candidates were already extracted',
    'pass-failed': 'A residual pass failed; earlier layers were retained', 'max-total-layers': 'Configured layer limit reached',
    'resume-no-new-calls': 'Reused saved results without additional calls',
  };
  add('residual', 'Recursive cleanup', ref?.passes.some(p => p.state === 'failed') && !residual.length ? 'Warning' : residual.length ? ref?.passes.some(p => p.state === 'failed') ? 'Warning' : ref?.passes.some(p => p.state !== 'done') ? terminal ? 'Warning' : 'Running' : 'Complete' : ref?.state === 'running' ? 'Running' : terminal || !ref ? 'Skipped' : 'Pending', residual,
    (ref?.stopReason ? stopLabels[ref.stopReason] : undefined) ?? (residual.length ? 'Residual objects checked in additional passes' : ref ? 'No additional Seedream call recorded' : 'Not enabled'), !!run.calls || !residual.length);
  const rec = ref?.reconstruction, bgCalls = run.calls?.backgroundReconstruction ?? (rec ? 1 : 0);
  const bg = recordedCall('image', json(dir, 'clean-background-response.json'), json(dir, 'clean-background-request.json'), obj(rec));
  add('background', 'Background recovery', ref?.background ? ref.background.quality === 'usable' ? 'Complete' : 'Warning' : bgCalls ? rec?.state === 'failed' ? 'Warning' : terminal ? 'Warning' : 'Running' : ref && !terminal ? 'Pending' : 'Skipped',
    bgCalls ? padCalls([bg], bgCalls, 'image') : [], ref?.background ? ref.background.method.replace(/-/g, ' ') : bgCalls ? 'AI background edit' : 'No AI edit recorded', !!run.calls || !!rec || !bgCalls);
  const output = run.outputLayers ?? run.layers ?? [];
  const selected = run.editorLayerFiles;
  const validSelection = selected === undefined || new Set(selected).size === selected.length && selected.every(f => output.some(l => l.file === f));
  const editorLayers = done && validSelection ? selected?.length ?? output.length : 0;
  add('curation', 'Local curation', done && editorLayers ? 'Complete' : failed && run.error?.stage === 'refining' ? 'Failed' : pending(), [], done ? `${editorLayers} editor layers selected locally` : 'Not completed');
  add('editor', 'Editor-ready layers', done && editorLayers ? ref?.state === 'failed' || ref?.background?.contaminated || ref?.background?.status === 'fallback' || (ref?.background?.quality && ref.background.quality !== 'usable') ? 'Warning' : 'Complete' : pending(), [], done && editorLayers ? 'Ready for manual evaluation' : 'No completed editor result');
  const rawCalls = [...(initial ? [initial] : []), ...residual];
  const rawLayers = rawCalls.length && rawCalls.every(c => c.rawLayers !== undefined) ? rawCalls.reduce((sum, c) => sum + c.rawLayers!, 0) : rawCalls.length ? null : 0;
  // totalMs is persisted pipeline duration. updatedAt changes on re-render, so it is not a duration fallback.
  const decompositionMs = run.timings.totalMs ?? (run.seedream.completedAt && Date.parse(run.seedream.completedAt) - Date.parse(run.createdAt) + (run.timings.renderMs ?? 0) + (run.timings.refineMs ?? 0));
  const elapsedMs = terminal && typeof decompositionMs === 'number' && decompositionMs >= 0 && sourceTimeKnown ? decompositionMs + sourceTime : null;
  if (options.fx !== undefined && Number(options.fx) !== fx) notes.push('Invalid AI_BUDGET_USD_INR; using the documented default budgeting rate.');
  const telemetry = executionTelemetry(run, execution);
  // An estimate only, labelled so: the planner call a reuse did not make, at typical usage. Never subtracted from the run's cost.
  const saving = telemetry?.plannerCallsAvoided ? avoidedPlannerCost(telemetry.plannerCallsAvoided, fx) : undefined;
  return { ...(saving ? { reuseSaving: saving } : {}), ...(telemetry ? { execution: telemetry } : {}), runId: run.id, updatedAt: run.updatedAt, fx, pricingVersion: AI_PRICING.version, sources: AI_PRICING.sources, stages,
    total: sumCosts(stages.map(s => s.cost), fx), calls: stages.reduce((n, s) => n + s.calls.length, 0), callsMeasured: stages.every(s => s.callsMeasured), rawLayers, editorLayers, elapsedMs, prompts, raw, notes };
}
