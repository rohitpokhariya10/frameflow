/** Read-only projection of persisted artifacts. No provider clients, writes, or downloads. */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { AI_PRICING, reuseBaseline, reuseSaving, budgetFx, calculateStageCost, sumCosts, type DiagnosticStage, type PaidCall, type RunDiagnostics, type StageId, type StageStatus, type UsageFacts } from '@frameflow/shared';
import { readRun, validRunId } from './layerizeExperiment.js';

import type { TemplateFamilyStore } from './templateFamilies/store.js';

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
export interface DiagnosticsOptions { families?: TemplateFamilyStore; imageTemplatesDir?: string; generationDirs?: Record<string, string>; fx?: string | number }
export async function readRunDiagnostics(dir: string, options: DiagnosticsOptions = {}): Promise<RunDiagnostics> {
  const run = readRun(dir), fx = budgetFx(options.fx), stages: DiagnosticStage[] = [], prompts: RunDiagnostics['prompts'] = [], notes: string[] = [], raw: RunDiagnostics['raw'] = [];
  const done = run.stage === 'done', failed = run.stage === 'failed', terminal = done || failed;
  const add = (id: StageId, label: string, status: StageStatus, calls: PaidCall[], result: string, callsMeasured = true) => {
    stages.push({ id, label, status, calls, callsMeasured, result, cost: calculateStageCost(calls, fx) });
  };
  const pending = (): StageStatus => terminal ? 'Skipped' : 'Pending';
  let sourceTime = 0, sourceTimeKnown = true;
  if (run.origin) {
    const root = run.origin.kind === 'image-template' ? options.imageTemplatesDir : options.generationDirs?.[run.origin.kind.replace(/-generation$/, '')];
    const sourceDir = root && validRunId(run.origin.generationId) ? join(root, run.origin.generationId) : undefined;
    const group = sourceDir ? json(sourceDir, 'group.json') : {};
    const variants = array(group.variants).map(obj);
    const variant = variants.find(v => v.id === (run.origin!.variantId ?? 'single')) ?? {};
    if (run.origin.kind === 'image-template' && group.workflow === 'template-family') {
      const detection = obj(obj(group.family).detection);
      const records = [...array(obj(group.family).previousCalls), ...array(detection.calls)].map(obj);
      const calls = records.map(c => recordedCall('text', sourceDir ? json(sourceDir, c.responseFile) : {}, sourceDir ? json(sourceDir, c.requestFile) : {}, c));
      add('reference', 'Identify reusable layout', detection.status === 'done' ? 'Complete' : 'Warning', calls,
        calls.length ? `${calls.length} structure call(s); shared reference cost included` : 'Saved structure reused locally · no API call', detection.status === 'done');
      sourceTime += records.reduce((sum, c) => sum + (num(c.durationMs) ?? 0), 0);
      sourceTimeKnown &&= records.every(c => num(c.durationMs) !== undefined);
      if (calls.length) notes.push('Structure analysis is shared across variants; do not sum these totals as an account bill.');
    } else if (run.origin.kind === 'image-template') {
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
    } else add('reference', 'Analyze reference', 'Skipped', [], 'Template fields supplied locally');
    const response = sourceDir ? json(sourceDir, variant.responseFile) : {}, request = sourceDir ? json(sourceDir, variant.requestFile) : {};
    const call = recordedCall('image', response, request, obj(variant.generator));
    const original = variant.source === 'reference';
    const calls = original ? [] : padCalls([call], num(variant.attempts) ?? 1, 'image');
    add('generation', 'Generate image', original ? 'Skipped' : variant.status === 'done' ? 'Complete' : 'Warning', calls, original ? 'Original upload used unchanged · no image generation' : `${call.imageCount ?? '?'} image(s) · ${call.quality ?? 'quality not recorded'}`, original || num(variant.attempts) !== undefined);
    const prompt = str(request.prompt) ?? str(variant.prompt);
    if (prompt) prompts.push({ label: 'Generation prompt', text: prompt, model: call.model, inputTokens: call.usage?.inputTokens });
    sourceTime += num(variant.durationMs) ?? 0; sourceTimeKnown &&= original || num(variant.durationMs) !== undefined && calls.length === 1;
    notes.push('Generation belongs to the linked source image and is included once in this view, even when that image has other decomposition runs.');
  } else {
    add('reference', 'Analyze reference', 'Skipped', [], 'Uploaded image; no linked reference analysis');
    add('generation', 'Generate image', 'Skipped', [], 'Uploaded image; no linked generation');
  }
  const fit = json(dir, 'template-fit.json');
  const fitCalls = run.calls?.fitCheck ?? (run.templateFit || run.error?.code === 'FIT_CHECK_FAILED' ? 1 : 0);
  add('fit', 'Check template fit', fitCalls ? run.templateFit ? run.templateFit.fits ? 'Complete' : 'Failed' : failed ? 'Failed' : 'Running' : 'Skipped',
    fitCalls ? padCalls([recordedCall('text', obj(fit.response), obj(fit.request), obj(run.templateFit))], fitCalls, 'text') : [], run.templateFit?.reason ?? (fitCalls ? 'Template suitability check' : 'Not requested'), !!run.calls || !!run.templateFit || !fitCalls);
  const plannerResponse = json(dir, 'openai-response.json'), plannerRequest = json(dir, 'openai-request.json');
  const plannerCalls = run.calls?.planner ?? (run.planner || Object.keys(plannerResponse).length || (run.error?.stage === 'planning' && run.error.code !== 'FIT_CHECK_FAILED' && run.error.code !== 'TEMPLATE_NOT_SUITABLE') ? 1 : 0);
  const planner = recordedCall('text', plannerResponse, plannerRequest, obj(run.planner));
  const reused = run.promptSource && run.promptSource.mode !== 'generated';
  add('planner', 'Plan layers', run.planner ? 'Complete' : plannerCalls ? failed ? 'Failed' : 'Running' : reused ? 'Skipped' : pending(),
    plannerCalls ? padCalls([planner], plannerCalls, 'text') : [], run.planner ? `${run.planner.planned_layers.length} planned elements` : reused ? 'Saved prompt or automatic layerization; no new planner call' : 'Layer planning', !!run.calls || !!run.planner || !plannerCalls);
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
  const observed = run.blueprint && options.families?.get(run.blueprint.familyId)?.stats;
  const avoided = run.templateReuse?.avoided;
  // A counterfactual is always an estimate. Display one only with observed baselines for every avoided stage.
  const saving = avoided && observed && (!avoided.analysis || observed.observed.analysis.calls > 0) && (!avoided.planner || observed.observed.planner.calls > 0)
    ? reuseSaving(avoided, reuseBaseline(observed), fx) : undefined;
  return { ...(saving ? { reuseSaving: saving } : {}), ...(run.templateReuse ? { reuse: run.templateReuse } : {}), runId: run.id, updatedAt: run.updatedAt, fx, pricingVersion: AI_PRICING.version, sources: AI_PRICING.sources, stages,
    total: sumCosts(stages.map(s => s.cost), fx), calls: stages.reduce((n, s) => n + s.calls.length, 0), callsMeasured: stages.every(s => s.callsMeasured), rawLayers, editorLayers, elapsedMs, prompts, raw, notes };
}
