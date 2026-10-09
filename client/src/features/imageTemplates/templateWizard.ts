/**
 * The creative template wizard's decisions, without React: which step a saved execution reopens at, what the footer's
 * primary action does, what a draft restores, and the cost lines shown. The component only renders these.
 *
 *   Template → Customize → Generate → Decompose
 *
 * Changed content can reach decomposition only through a generated image the user accepted; the original image is used
 * only while every content field is empty.
 */
import { AI_PRICING, avoidedPlannerCost, describeTemplateSlots, TEMPLATE_ROLE_LABELS, type CostAmount, type CreativeTemplate, type ExecutionState, type ExtractionPlan, type RunDiagnostics, type SceneDraft, type SlotGroup, type TemplateEditOptions, type TemplateExecution, type TemplateRole, type TemplateSlot, type TemplateVersion } from '@frameflow/shared';
import type { DecompositionState } from './imageTemplates';

export type ShownExecution = TemplateExecution & { decomposition?: DecompositionState; generationCost?: CostAmount };
export const WIZARD_STEPS = ['Template', 'Customize', 'Generate', 'Decompose'] as const;
export type WizardStep = 0 | 1 | 2 | 3;
const RESTING: readonly ExecutionState[] = ['done', 'failed', 'ready', 'generated'];
/** Nothing is in flight: the execution waits for the user (or has finished). */
export const isResting = (e: Pick<TemplateExecution, 'state'>) => RESTING.includes(e.state);
type Phase = Pick<TemplateExecution, 'mode' | 'state' | 'runId' | 'imageAcceptedAt' | 'reviewBeforeDecompose'>;
/** A generate-first execution before its image was accepted: generating, awaiting review, or failed while generating. */
export const inGenerationPhase = (e: Phase) => e.mode === 'REUSE_TEMPLATE_WITH_EDIT' && !e.runId && !e.imageAcceptedAt && !['planning', 'decomposing', 'saving', 'done'].includes(e.state);
/** The step a saved execution reopens at: its image review, or its decomposition and result. */
export const reopenStep = (e: Phase): WizardStep => inGenerationPhase(e) ? 2 : 3;
export const hasContentChanges = (values: Record<string, string>) => Object.values(values).some(value => value.trim() !== '');
export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

export interface WizardView {
  step: WizardStep;
  creating: boolean;
  /** A saved template is chosen and its exact version is loaded (fields, prompt). */
  templateReady: boolean;
  hasReference: boolean;
  hasChanges: boolean;
  promptError: boolean;
  busy: boolean;
  /** The user ticked "I checked the image" (needed when the review asks for a person). */
  reviewAcknowledged?: boolean;
  /** The user chose how to extract layers (needed after a structural change). */
  planChosen?: boolean;
  execution?: Phase & { edit?: { image?: unknown; review?: { requiresAcknowledgement: boolean; acknowledgedAt?: string } }; compatibility?: { status: string }; planDecision?: unknown };
}
/** The generated image may go to decomposition only with what it still needs from the user: a look, and a plan choice. */
export const needsReviewAcknowledgement = (e: WizardView['execution']) => !!e?.edit?.review?.requiresAcknowledgement && !e.edit.review.acknowledgedAt;
export const needsPlanDecision = (e: WizardView['execution']) => e?.compatibility?.status === 'structural-change' && !e.planDecision;
export type WizardAction = 'next' | 'create-template' | 'approve-generated' | 'decompose-original' | 'show-result' | 'open-editor' | 'none';
/** The footer's primary button. It never decomposes the original image while a content field is filled in. */
export function wizardPrimary(v: WizardView): { label: string; action: WizardAction; disabled: boolean } {
  const e = v.execution, running = !!e && !isResting(e), blocked = v.busy || running;
  if (v.step === 0) return { label: 'Next', action: 'next', disabled: blocked || !v.creating && !v.templateReady };
  if (v.step === 1) return { label: 'Next', action: 'next', disabled: blocked || !v.hasReference || !v.creating && (!v.templateReady || v.promptError) };
  if (v.step === 2) {
    // A started decomposition is shown, not restarted; a stopped one may be started again from here.
    if (e && !inGenerationPhase(e) && e.state !== 'failed') return { label: 'Continue', action: 'show-result', disabled: v.busy };
    if (v.creating) return { label: 'Create Template & Decompose', action: 'create-template', disabled: blocked || !v.hasReference };
    if (e?.state === 'generated' && e.edit?.image) return { label: 'Use this image', action: 'approve-generated',
      disabled: blocked || needsReviewAcknowledgement(e) && !v.reviewAcknowledged || needsPlanDecision(e) && !v.planChosen };
    if (running) return { label: 'Use this image', action: 'none', disabled: true };
    return { label: 'Use original image', action: 'decompose-original', disabled: blocked || !v.hasReference || !v.templateReady || v.hasChanges };
  }
  if (e?.state === 'done') return { label: 'Open in Editor', action: 'open-editor', disabled: v.busy };
  return { label: 'Open in Editor', action: 'none', disabled: true };
}

/** What survives a refresh in this tab. File bytes cannot: only the chosen file's name, to ask for it again. */
export type MainProductOptions = NonNullable<TemplateEditOptions['mainProduct']>;
/** smart: a smart edit's draft, kept only for the analysis it was made against (a new image starts empty). */
export interface WizardDraft { step?: WizardStep; selected?: string; creating?: boolean; values?: Record<string, string>; options?: MainProductOptions; executionId?: string; uploadName?: string; smart?: { analysisId: string; draft: SceneDraft; rulesOnly?: boolean };
  /** An open creative variant set (it keeps running on the server; a refresh shows it again). */
  variantSetId?: string; studio?: boolean }
export const WIZARD_DRAFT_KEY = 'frameflow-template-wizard-v1';
export function readWizardDraft(storage: Pick<Storage, 'getItem'> | undefined): WizardDraft {
  try {
    const raw: unknown = JSON.parse(storage?.getItem(WIZARD_DRAFT_KEY) ?? '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const d = raw as Record<string, unknown>, text = (value: unknown) => typeof value === 'string' && value ? value : undefined;
    const values = d.values && typeof d.values === 'object' && !Array.isArray(d.values)
      ? Object.fromEntries(Object.entries(d.values).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : undefined;
    const o = d.options && typeof d.options === 'object' && !Array.isArray(d.options) ? d.options as Record<string, unknown> : undefined;
    const options: MainProductOptions | undefined = o ? { ...(o.mode === 'replace' || o.mode === 'details' ? { mode: o.mode } : {}), ...(typeof o.brand === 'string' ? { brand: o.brand } : {}),
      ...(typeof o.keepSupporting === 'boolean' ? { keepSupporting: o.keepSupporting } : {}) } : undefined;
    // The server validates a restored smart draft again against its analysis before anything uses it.
    const smart = d.smart && typeof d.smart === 'object' && !Array.isArray(d.smart) ? d.smart as Record<string, unknown> : undefined, smartDraft = smart?.draft as Record<string, unknown> | undefined;
    const restored = smart && text(smart.analysisId) && smartDraft && typeof smartDraft === 'object' && smartDraft.edits && typeof smartDraft.edits === 'object' && !Array.isArray(smartDraft.edits) && smartDraft.corrections && typeof smartDraft.corrections === 'object' && !Array.isArray(smartDraft.corrections)
      ? { analysisId: text(smart.analysisId)!, draft: { edits: smartDraft.edits, corrections: smartDraft.corrections, ...(text(smartDraft.referenceFor) ? { referenceFor: text(smartDraft.referenceFor) } : {}) } as SceneDraft, ...(smart.rulesOnly === true ? { rulesOnly: true } : {}) } : undefined;
    return { ...(typeof d.step === 'number' && [0, 1, 2, 3].includes(d.step) ? { step: d.step as WizardStep } : {}), ...(text(d.selected) ? { selected: text(d.selected) } : {}), ...(restored ? { smart: restored } : {}),
      ...(text(d.variantSetId) && /^[0-9TZ-]+-[a-f0-9]{6}$/.test(text(d.variantSetId)!) ? { variantSetId: text(d.variantSetId) } : {}), ...(d.studio === true ? { studio: true } : {}),
      ...(typeof d.creating === 'boolean' ? { creating: d.creating } : {}), ...(values ? { values } : {}), ...(options && Object.keys(options).length ? { options } : {}),
      ...(text(d.executionId) ? { executionId: text(d.executionId) } : {}), ...(text(d.uploadName) ? { uploadName: text(d.uploadName) } : {}) };
  } catch { return {}; }
}
export function writeWizardDraft(storage: Pick<Storage, 'setItem'> | undefined, draft: WizardDraft): void {
  try { storage?.setItem(WIZARD_DRAFT_KEY, JSON.stringify(draft)); } catch { /* Private browsing may disallow storage. */ }
}
/** A draft without an execution returns to where it was, but never past a file the browser could not keep. */
export const draftStep = (draft: WizardDraft): WizardStep => Math.min(draft.step ?? 0, draft.uploadName ? 1 : 2) as WizardStep;

/** The structural content a card lists: each role once, back to front, without effects. */
export const templateSlotBadges = (template: Pick<CreativeTemplate, 'layerRoles'>, limit = 5) => {
  const roles = [...new Set(template.layerRoles)].filter((role): role is Exclude<TemplateRole, 'effect'> => role !== 'effect');
  return { shown: roles.slice(0, limit).map(role => TEMPLATE_ROLE_LABELS[role]), more: Math.max(0, roles.length - limit) };
};

/** User-facing progress, in order; each is complete once the run shows it. */
export function decompositionProgress(execution: ShownExecution | undefined, run: { stage: string; planner?: unknown; error?: { stage?: string }; refinement?: { stopReason?: unknown; background?: unknown } } | undefined, creating: boolean) {
  const ready = execution?.state === 'done';
  // Creating a run only records an attempt. A validated plan or a later stage proves planning succeeded.
  const planned = ready || !!run && (!!run.planner || ['planned', 'uploading', 'submitting', 'queued', 'in_progress', 'downloading', 'refining', 'done'].includes(run.stage)
    || run.stage === 'failed' && !!run.error?.stage && !['uploaded', 'planning'].includes(run.error.stage));
  return [
    { label: creating ? 'Learning template and plan' : 'Preparing saved plan', complete: planned },
    { label: 'Extracting layers', complete: ready || !!run && ['refining', 'done'].includes(run.stage) },
    { label: 'Checking missing objects', complete: ready || !!run?.refinement?.stopReason },
    { label: 'Cleaning background', complete: ready || !!run?.refinement?.background },
    { label: 'Preparing editor', complete: ready },
  ];
}

/** A recorded amount in rupees; estimates say so. */
export const money = (cost?: CostAmount) => !cost || cost.inr === null ? 'awaiting provider usage' : `${cost.confidence === 'Calculated' ? '' : `${cost.confidence.toLowerCase()} `}₹${cost.inr.toFixed(2)}`;
/**
 * Attempts and completed planning are separate: a sent request need not return a valid plan or recorded usage.
 */
export function costRows(execution: ShownExecution | undefined, diagnostics: RunDiagnostics | undefined, creating: boolean): { label: string; value: string }[] {
  const stage = (id: string) => diagnostics?.stages.find(s => s.id === id);
  const images = execution?.usage.imageGenerationCalls ?? 0, planner = stage('planner')?.calls.length ?? execution?.usage.plannerCalls ?? 0;
  const plannerPending = creating && execution?.state === 'planning' && !planner;
  const plannerComplete = stage('planner')?.status === 'Complete' || execution?.state === 'done';
  const extraction = [stage('seedream'), stage('residual')].flatMap(s => s?.calls ?? []).filter(call => call.kind === 'seedream').length, cleanup = stage('background')?.calls.length ?? 0;
  // A smart edit's analysis and resolution, or a creative variant's set, replace the saved template's free prompt planning.
  const smart = execution?.resolution ? [{ label: 'Image analysis', value: `${plural(execution.usage.analysisCalls ?? 0, 'call')} · shared by edits of this image` }, { label: 'Change resolution', value: plural(execution.usage.resolutionCalls ?? 0, 'call') }]
    : execution?.variant ? [{ label: 'Creative variant', value: 'subject cutout and scene ideas made in its set' }] : [{ label: 'Prompt planning', value: '0 calls · ₹0' }];
  const rows = [
    { label: 'Structure analysis', value: plural(execution?.inspection?.calls ?? 0, 'call') },
    ...smart,
    { label: 'Image generation', value: `${plural(images, 'call')}${images ? ` · ${money(execution?.generationCost)}` : ''}` },
    ...(execution?.usage.verificationCalls ? [{ label: 'AI check of the result', value: plural(execution.usage.verificationCalls, 'call') }] : []),
    { label: 'Decomposition planner', value: plannerPending ? 'planning in progress' : `${plural(planner, plannerComplete || !planner ? 'call' : 'attempt')}${planner ? '' : ' · ₹0'}` },
  ];
  if (diagnostics) {
    rows.push({ label: 'Layer extraction (Seedream)', value: plural(extraction, 'call') });
    if (cleanup) rows.push({ label: 'Background cleanup', value: plural(cleanup, 'call') });
    rows.push({ label: 'Total recorded cost', value: money(diagnostics.total) });
  } else if (images) rows.push({ label: 'Cost so far', value: money(execution?.generationCost) });
  return rows;
}

/** A template's fields by where they are offered: the few common controls first, the rest under Advanced elements. */
export function fieldGroups(version: Pick<TemplateVersion, 'structure'>): Record<SlotGroup, TemplateSlot[]> {
  const groups: Record<SlotGroup, TemplateSlot[]> = { product: [], subject: [], style: [], text: [], advanced: [] };
  for (const slot of describeTemplateSlots(version)) groups[slot.group].push(slot);
  return groups;
}
/** The options the compiler and the request use: only what applies to the filled main product field. */
export function mainProductOptions(options: MainProductOptions, mainFilled: boolean): MainProductOptions {
  if (!mainFilled) return {};
  const mode = options.mode ?? 'replace', brand = options.brand?.trim();
  return { ...(options.mode ? { mode } : {}), ...(mode === 'replace' && brand ? { brand } : {}), ...(mode === 'replace' && options.keepSupporting ? { keepSupporting: true } : {}) };
}

/** Rough provider costs a choice would add, for the buttons that make it. Estimates, never charges. */
export function extractionEstimate(layers: number, width = 0, height = 0, fx: number = AI_PRICING.budgetUsdInr) {
  const perLayer = width * height > AI_PRICING.seedream.thresholdPixels ? AI_PRICING.seedream.high : AI_PRICING.seedream.low;
  return { seedreamInr: Math.max(1, layers) * perLayer * fx, plannerInr: avoidedPlannerCost(1, fx).inr ?? 0 };
}
export const PLAN_CHOICES: { plan: ExtractionPlan; title: string; detail: (estimate: ReturnType<typeof extractionEstimate>) => string }[] = [
  { plan: 'saved', title: 'Use saved plan', detail: () => 'Planner 0 · ₹0. Learned from the original products: the new product may be missed or merged with another layer.' },
  { plan: 'simple', title: 'Simpler grouping', detail: () => 'Planner 0 · ₹0. Fewer, larger layers: products together, decorations with the background.' },
  { plan: 'refresh', title: 'Refresh decomposition plan', detail: e => `1 planner call · about ₹${e.plannerInr.toFixed(2)} (estimate). Plans the layers this new image actually has.` },
];
/** A creative variant's choices: its own exact layers, or only its new scenery split (the subject is never re-rendered). */
export const VARIANT_PLAN_CHOICES: typeof PLAN_CHOICES = [
  { plan: 'composed', title: 'Use its own layers', detail: () => 'No extraction · ₹0. New scenery, a soft contact shadow and your exact subject as separate layers.' },
  { plan: 'simple', title: 'Also split the new scenery', detail: e => `1 Seedream request on the scenery only (about ₹${e.seedreamInr.toFixed(2)}). Your exact subject is added back on top.` },
  { plan: 'refresh', title: 'Plan and split the new scenery', detail: e => `1 planner call (about ₹${e.plannerInr.toFixed(2)}) + 1 Seedream request on the scenery only. Your exact subject is added back on top.` },
];
/** A failed layer extraction of a saved image: the image is kept, and the user may retry explicitly. Never a creation. */
export const extractionRecovery = (e: Pick<TemplateExecution, 'mode' | 'state' | 'runId' | 'error'> | undefined) =>
  !!e && e.mode !== 'CREATE_TEMPLATE' && e.state === 'failed' && !!e.runId && !!e.error && e.error.state !== 'generating';
