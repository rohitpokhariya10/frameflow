/**
 * Editing a saved template, and reading whether its plan still fits. Names and descriptions live on the template record
 * (mutable). Plan settings — which backdrop, decoration, prop, effect or companion layers are their own layers, whether
 * runs are refined, how many editor layers a good result has — become a NEW immutable version: executions keep the
 * version they ran with, so editing never changes a saved run. The plan is recompiled locally from the edited
 * structure (role words only); no planner call.
 *
 * Health is read from the template's own runs: a decomposition that found a backdrop shape the plan does not name
 * (backdropComponents.ts, basis "shape"), or lost a layer the plan asked for (PLANNED_LAYER_*), means the plan is
 * incomplete. Updating it is an explicit new plan of the source image (service.replan), never silent.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalStructure, SEPARABLE_ROLES, TEMPLATE_ROLE_LABELS, type TemplateExecution, type TemplateHealth, type TemplateLayer, type TemplateSettingsChange, type TemplateVersion } from '@frameflow/shared';
import { RunError } from '../layerizeExperiment.js';
import { gridFor, layerShape } from '../backgroundContamination.js';
import { backdropComponents, planRoles, type BackdropDecision } from '../backdropComponents.js';
import { classify } from '../recursiveDecomposition.js';
import { semanticAnalysisOf } from '../runPlan.js';
import type { LayerInfo } from '../layerizeArtifacts.js';
import type { RunRecord } from '../layerizeExperiment.js';
import { templateEditPrompt, templatePlanPrompt, templatePlanStrategy } from './compile.js';

export const NAME_LIMIT = 60, DESCRIPTION_LIMIT = 240, MAX_EDITOR_LAYERS = 40;
const label = (layer: TemplateLayer) => TEMPLATE_ROLE_LABELS[layer.role].toLowerCase();

/** A name or description as stored: single spaces, trimmed, within its limit (an empty name is refused). */
export function templateText(body: Record<string, unknown>): { name?: string; description?: string } {
  if (Object.keys(body).some(key => key !== 'name' && key !== 'description')) throw new RunError('INVALID_REQUEST', 'Only the name and description can be changed here.');
  const clean = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : undefined;
  const name = body.name === undefined ? undefined : clean(body.name) ?? '', description = body.description === undefined ? undefined : clean(body.description) ?? '';
  if (name !== undefined && (!name || name.length > NAME_LIMIT)) throw new RunError('INVALID_NAME', `A template name is 1–${NAME_LIMIT} characters.`);
  if (/[{}<>]/.test(`${name ?? ''}${description ?? ''}`)) throw new RunError('INVALID_REQUEST', 'Names and descriptions are plain text.');
  if (description !== undefined && description.length > DESCRIPTION_LIMIT) throw new RunError('INVALID_REQUEST', `A description is at most ${DESCRIPTION_LIMIT} characters.`);
  if (name === undefined && description === undefined) throw new RunError('NO_CHANGE', 'Change the name or the description.');
  return { ...(name !== undefined ? { name } : {}), ...(description !== undefined ? { description } : {}) };
}

/** A settings request, checked: known keys, booleans, whole layer counts, separable layers of this version only. */
export function settingsChange(body: unknown, version: TemplateVersion): TemplateSettingsChange {
  const o = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
  if (!o || Object.keys(o).some(key => !['refinement', 'expectedEditorLayers', 'separateLayers'].includes(key))) throw new RunError('INVALID_REQUEST', 'Plan settings are refinement, expectedEditorLayers and separateLayers.');
  if (o.refinement !== undefined && typeof o.refinement !== 'boolean') throw new RunError('INVALID_REQUEST', 'Refinement is on or off.');
  let expected: TemplateSettingsChange['expectedEditorLayers'];
  if (o.expectedEditorLayers !== undefined) {
    const e = o.expectedEditorLayers as Record<string, unknown> | null;
    if (!e || typeof e !== 'object' || !Number.isInteger(e.min) || !Number.isInteger(e.max) || (e.min as number) < 1 || (e.max as number) > MAX_EDITOR_LAYERS || (e.min as number) > (e.max as number))
      throw new RunError('INVALID_REQUEST', `Expected editor layers are whole numbers, 1 ≤ min ≤ max ≤ ${MAX_EDITOR_LAYERS}.`);
    expected = { min: e.min as number, max: e.max as number };
  }
  let separate: Record<string, boolean> | undefined;
  if (o.separateLayers !== undefined) {
    const map = o.separateLayers as Record<string, unknown> | null;
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw new RunError('INVALID_REQUEST', 'separateLayers maps layer ids to true or false.');
    for (const [id, value] of Object.entries(map)) {
      const layer = version.structure.layers.find(l => l.id === id);
      if (!layer) throw new RunError('INVALID_REQUEST', `This template has no layer "${id}".`);
      if (!SEPARABLE_ROLES.includes(layer.role)) throw new RunError('INVALID_REQUEST', `The ${label(layer)} layer is always decided by the template's structure.`);
      if (typeof value !== 'boolean') throw new RunError('INVALID_REQUEST', 'separateLayers maps layer ids to true or false.');
    }
    separate = map as Record<string, boolean>;
  }
  return { ...(o.refinement !== undefined ? { refinement: o.refinement as boolean } : {}), ...(expected ? { expectedEditorLayers: expected } : {}), ...(separate ? { separateLayers: separate } : {}) };
}

/**
 * The next version with these settings, or NO_CHANGE. A folded layer is kept with the background (backdrops,
 * decorations, effects) or the main product (props, companions); unfolding one removes only that fold.
 */
export function versionWithSettings(current: TemplateVersion, change: TemplateSettingsChange, next: { version: number; name: string; description: string; at?: string }): TemplateVersion {
  const layers = current.structure.layers, changes: string[] = [];
  const background = layers.find(l => l.role === 'background'), main = layers.find(l => l.role === 'main_product' && l.independent);
  const edited = layers.map((l): TemplateLayer => {
    const own = change.separateLayers?.[l.id];
    if (own === undefined || own === l.independent) return l;
    changes.push(`${l.id}: ${own ? 'its own layer' : 'kept with another layer'}`);
    if (own) { const { attachment, ...rest } = l; return { ...rest, independent: true, ...(attachment && attachment.relation !== 'part_of_object' ? { attachment } : {}) }; }
    const parent = ['prop', 'supporting_product'].includes(l.role) && main ? main : background;
    if (!parent || parent.id === l.id) throw new RunError('INVALID_REQUEST', `The ${label(l)} layer has nothing to be kept with.`);
    return { ...l, independent: false, required: false, attachment: { relation: 'part_of_object', parent: parent.id, keepWithParent: true, separationRisk: 'low' } };
  });
  if (!edited.some(l => l.independent && !['background', 'backdrop', 'decoration', 'effect'].includes(l.role))) throw new RunError('INVALID_REQUEST', 'A template keeps at least one foreground element as its own layer.');
  const refinement = change.refinement ?? current.decomposition.refinement, expected = change.expectedEditorLayers ?? current.decomposition.expectedEditorLayers;
  if (refinement !== current.decomposition.refinement) changes.push(`refinement ${refinement ? 'on' : 'off'}`);
  if (expected.min !== current.decomposition.expectedEditorLayers.min || expected.max !== current.decomposition.expectedEditorLayers.max) changes.push(`expected editor layers ${expected.min}–${expected.max}`);
  if (!changes.length) throw new RunError('NO_CHANGE', 'These are already the template\'s settings.');
  const structure = canonicalStructure({ layers: edited, relationships: current.structure.relationships });
  return { ...current, version: next.version, createdAt: next.at ?? new Date().toISOString(), name: next.name, description: next.description, structure,
    plan: { strategy: templatePlanStrategy(structure), prompt: templatePlanPrompt(structure, true), recommendedLayers: structure.layers.filter(l => l.independent).length, occlusionWording: true },
    generationPrompt: { text: templateEditPrompt(structure) }, decomposition: { refinement, expectedEditorLayers: expected },
    derivedFrom: { version: current.version, reason: 'settings', at: next.at ?? new Date().toISOString(), change: changes.join('; ') } };
}

/** The backdrop decisions of a finished run: recorded by runs since backdrop separation, else re-read from its layers. */
export async function runBackdrops(runDir: string): Promise<BackdropDecision[] | undefined> {
  if (!existsSync(join(runDir, 'run.json'))) return undefined;
  const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as RunRecord;
  const recorded = (run.refinement as { backdrops?: BackdropDecision[] } | undefined)?.backdrops;
  if (recorded) return recorded;
  const debugFile = join(runDir, 'decomposition-debug.json');
  if (!run.canvas || !existsSync(debugFile)) return undefined;
  const debug = JSON.parse(readFileSync(debugFile, 'utf8')) as { rawLayers?: LayerInfo[]; layerPlan?: { dropped?: { file: string; reason?: string }[] } };
  // Layers the run itself found invisible or invented are no evidence of a design element.
  const ignored = new Set((debug.layerPlan?.dropped ?? []).filter(d => ['hidden', 'duplicate', 'not-in-original', 'faint-remnant', 'unexplained-generic', 'filler-behind-subject'].includes(d.reason ?? '')).map(d => d.file));
  const grid = gridFor(run.canvas, 640), items = [];
  for (const layer of debug.rawLayers ?? []) {
    if (layer.placement?.kind === 'base' || ignored.has(layer.file) || !existsSync(join(runDir, layer.file))) continue;
    const shape = await layerShape(readFileSync(join(runDir, layer.file)), layer, grid);
    items.push({ layer, shape, kind: classify(layer, shape, grid).kind });
  }
  return backdropComponents(items, grid, planRoles(semanticAnalysisOf(run), run.planner?.capture?.roles));
}

/** Whether the plan names every layer the template's runs show: its source run and its recent finished executions. */
export async function templateHealth(version: TemplateVersion, runsDir: string, executions: TemplateExecution[]): Promise<TemplateHealth> {
  const issues: string[] = [];
  let checkedRuns = 0;
  const unnamed = (decisions: BackdropDecision[] | undefined) => (decisions ?? []).filter(d => d.component && d.basis === 'shape').map(d => `"${d.name ?? d.file}"`);
  const source = await runBackdrops(join(runsDir, version.source.runId));
  if (source) { checkedRuns++; const names = unnamed(source); if (names.length) issues.push(`Its source creative has ${names.join(', ')}, which the plan does not name as a layer of its own.`); }
  // The template's own creating execution is the source run, already read.
  for (const e of executions.filter(e => e.state === 'done' && e.runId && e.runId !== version.source.runId && e.template?.version === version.version).slice(0, 5)) {
    checkedRuns++;
    const lost = e.warnings.filter(w => /^(PLANNED_LAYER_|TEMPLATE_PLAN_INCOMPLETE)/.test(w)).map(w => w.replace(/^[A-Z_]+: /, ''));
    if (lost.length) issues.push(`Run of ${e.createdAt.slice(0, 10)}: ${lost.join(' ')}`);
  }
  return { status: issues.length ? 'plan-incomplete' : checkedRuns ? 'ok' : 'unknown', issues, checkedRuns };
}
