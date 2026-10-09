import { describe, expect, it } from 'vitest';
import { textProblems } from './TemplateDetails';
import { compileTemplateEdit, type CostAmount, type RunDiagnostics, type TemplateExecution, type TemplateLayer, type TemplateVersion } from '@frameflow/shared';
import { costRows, decompositionProgress, draftStep, extractionEstimate, extractionRecovery, fieldGroups, hasContentChanges, mainProductOptions, PLAN_CHOICES, readWizardDraft, reopenStep, templateSlotBadges, wizardPrimary, WIZARD_DRAFT_KEY, writeWizardDraft, type ShownExecution, type WizardView } from './templateWizard';

const usage = (images = 0, planner = 0): TemplateExecution['usage'] => ({ plannerCalled: planner > 0, promptGenerationCalled: false, imageGenerationCalled: images > 0, plannerCalls: planner, imageGenerationCalls: images,
  generationPromptSource: 'saved-template', decompositionPlanSource: planner ? 'planner' : 'saved-template', timings: {} });
const execution = (patch: Partial<ShownExecution>): ShownExecution => ({ id: 'e1', mode: 'REUSE_TEMPLATE_WITH_EDIT', idempotencyKey: 'key-12345', state: 'queued', createdAt: '', updatedAt: '',
  upload: { file: 'upload.png', mimeType: 'image/png', width: 10, height: 10, bytes: 1, sha256: 'x' }, usage: usage(), warnings: [], reviewBeforeDecompose: true, ...patch });
const image = { file: 'edited.png', mimeType: 'image/png', width: 10, height: 10, bytes: 1, sha256: 'y' };
const view = (patch: Partial<WizardView>): WizardView => ({ step: 2, creating: false, templateReady: true, hasReference: true, hasChanges: false, promptError: false, busy: false, ...patch });
const cost = (inr: number): CostAmount => ({ usd: inr / 90, inr, knownUsd: inr / 90, knownInr: inr, confidence: 'Calculated', notes: [] });
const memory = () => { const data = new Map<string, string>(); return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data }; };

describe('template wizard: reopening a saved execution', () => {
  it('reopens image review until the user accepts the generated image, and the result afterwards', () => {
    expect(reopenStep(execution({ state: 'generating' }))).toBe(2);
    expect(reopenStep(execution({ state: 'generated', edit: { instruction: 'x', prompt: 'p', model: 'm', size: 's', image } }))).toBe(2);
    expect(reopenStep(execution({ state: 'failed', error: { code: 'GENERATION_FAILED', message: 'no', state: 'generating' } }))).toBe(2);
    expect(reopenStep(execution({ state: 'queued', imageAcceptedAt: 'now' }))).toBe(3);
    expect(reopenStep(execution({ state: 'decomposing', runId: 'r1', imageAcceptedAt: 'now' }))).toBe(3);
    expect(reopenStep(execution({ state: 'done', runId: 'r1', imageAcceptedAt: 'now' }))).toBe(3);
    expect(reopenStep(execution({ mode: 'CREATE_TEMPLATE', state: 'planning' }))).toBe(3);
    expect(reopenStep(execution({ mode: 'REUSE_TEMPLATE_ORIGINAL', state: 'done', runId: 'r1' }))).toBe(3);
  });
});

describe('template wizard: the footer action', () => {
  it('needs a template before Customize, and a usable reference and prompt before Generate', () => {
    expect(wizardPrimary(view({ step: 0, templateReady: false }))).toMatchObject({ label: 'Next', disabled: true });
    expect(wizardPrimary(view({ step: 0 }))).toMatchObject({ action: 'next', disabled: false });
    expect(wizardPrimary(view({ step: 0, creating: true, templateReady: false })).disabled).toBe(false);
    expect(wizardPrimary(view({ step: 1, hasReference: false })).disabled).toBe(true);
    expect(wizardPrimary(view({ step: 1, promptError: true })).disabled).toBe(true);
    expect(wizardPrimary(view({ step: 1, creating: true, templateReady: false })).disabled).toBe(false);
    expect(wizardPrimary(view({ step: 1, busy: true })).disabled).toBe(true);
  });
  it('changed content cannot skip generation: the original image is offered only while every field is empty', () => {
    expect(wizardPrimary(view({ hasChanges: true }))).toMatchObject({ label: 'Use original image', action: 'decompose-original', disabled: true });
    expect(wizardPrimary(view({ hasChanges: false }))).toMatchObject({ label: 'Use original image', action: 'decompose-original', disabled: false });
    // A failed generation leaves changed content still needing an image.
    const failed = execution({ state: 'failed', error: { code: 'GENERATION_FAILED', message: 'no', state: 'generating' } });
    expect(wizardPrimary(view({ hasChanges: true, execution: failed })).disabled).toBe(true);
    expect(wizardPrimary(view({ hasChanges: false, templateReady: false })).disabled).toBe(true);
  });
  it('waits while generating, then approves exactly the generated image', () => {
    expect(wizardPrimary(view({ hasChanges: true, execution: execution({ state: 'generating' }) }))).toMatchObject({ label: 'Use this image', disabled: true, action: 'none' });
    const generated = execution({ state: 'generated', edit: { instruction: 'x', prompt: 'p', model: 'm', size: 's', image } });
    expect(wizardPrimary(view({ hasChanges: true, execution: generated }))).toMatchObject({ label: 'Use this image', action: 'approve-generated', disabled: false });
    expect(wizardPrimary(view({ hasChanges: true, execution: generated, busy: true })).disabled).toBe(true);
  });
  it('never restarts a decomposition already under way, but lets a stopped one start again', () => {
    expect(wizardPrimary(view({ execution: execution({ state: 'decomposing', runId: 'r1', imageAcceptedAt: 'now' }) }))).toMatchObject({ label: 'Continue', action: 'show-result' });
    expect(wizardPrimary(view({ execution: execution({ mode: 'REUSE_TEMPLATE_ORIGINAL', state: 'done', runId: 'r1' }) })).action).toBe('show-result');
    const stopped = execution({ mode: 'REUSE_TEMPLATE_ORIGINAL', state: 'failed', runId: 'r1', error: { code: 'X', message: 'no', state: 'decomposing' } });
    expect(wizardPrimary(view({ execution: stopped })).action).toBe('decompose-original');
    expect(wizardPrimary(view({ creating: true, execution: { ...stopped, mode: 'CREATE_TEMPLATE' } })).action).toBe('create-template');
  });
  it('creating a template confirms the upload at Generate with no image request', () => {
    expect(wizardPrimary(view({ creating: true, templateReady: false }))).toMatchObject({ label: 'Create Template & Decompose', action: 'create-template', disabled: false });
    expect(wizardPrimary(view({ creating: true, hasReference: false })).disabled).toBe(true);
  });
  it('opens the editor only once the decomposition is done', () => {
    expect(wizardPrimary(view({ step: 3, execution: execution({ state: 'decomposing', runId: 'r1' }) }))).toMatchObject({ label: 'Open in Editor', disabled: true });
    expect(wizardPrimary(view({ step: 3, execution: execution({ state: 'failed', runId: 'r1' }) })).disabled).toBe(true);
    expect(wizardPrimary(view({ step: 3, execution: execution({ state: 'done', runId: 'r1' }) }))).toMatchObject({ action: 'open-editor', disabled: false });
  });
});

describe('template wizard: drafts across Back, Next and refresh', () => {
  it('round-trips the step, template, fields, execution and the name of a file that must be chosen again', () => {
    const storage = memory(), draft = { step: 2 as const, selected: 't1', creating: false, values: { held_object: 'smartphone' }, executionId: 'e1', uploadName: 'mine.png' };
    writeWizardDraft(storage, draft);
    expect(readWizardDraft(storage)).toEqual(draft);
  });
  it('ignores damaged or foreign drafts, and storage that refuses access', () => {
    const storage = memory();
    storage.setItem(WIZARD_DRAFT_KEY, '{not json'); expect(readWizardDraft(storage)).toEqual({});
    storage.setItem(WIZARD_DRAFT_KEY, JSON.stringify({ step: 9, values: { a: 'kept', b: 4 }, selected: 7, creating: 'yes' }));
    expect(readWizardDraft(storage)).toEqual({ values: { a: 'kept' } });
    expect(readWizardDraft(undefined)).toEqual({});
    expect(() => writeWizardDraft({ setItem: () => { throw new Error('quota'); } }, { step: 1 })).not.toThrow();
  });
  it('restores up to Generate, and stops at Customize when an uploaded file must be chosen again', () => {
    expect(draftStep({})).toBe(0);
    expect(draftStep({ step: 2 })).toBe(2);
    expect(draftStep({ step: 3 })).toBe(2);
    expect(draftStep({ step: 2, uploadName: 'mine.png' })).toBe(1);
  });
  it('treats whitespace-only fields as unchanged content', () => {
    expect(hasContentChanges({ a: ' ', b: '' })).toBe(false);
    expect(hasContentChanges({ a: ' ', held_object: 'smartphone' })).toBe(true);
  });
});

describe('template wizard: cards, progress and cost', () => {
  it('lists each editable role once, without effects, and counts the rest', () => {
    expect(templateSlotBadges({ layerRoles: ['background', 'primary_subject', 'held_object', 'effect', 'primary_subject'] })).toEqual({ shown: ['Background', 'Primary subject', 'Held object'], more: 0 });
    expect(templateSlotBadges({ layerRoles: ['background', 'backdrop', 'primary_subject', 'held_object', 'headline', 'cta', 'logo'] }, 5).more).toBe(2);
  });
  it('shows user-facing progress, complete once the run reports each part', () => {
    const labels = decompositionProgress(undefined, undefined, false).map(p => p.label);
    expect(labels).toEqual(['Preparing saved plan', 'Extracting layers', 'Checking missing objects', 'Cleaning background', 'Preparing editor']);
    expect(decompositionProgress(undefined, undefined, true)[0].label).toBe('Learning template and plan');
    const running = decompositionProgress(execution({ state: 'decomposing', runId: 'r1' }), { stage: 'refining', refinement: { stopReason: 'complete' } }, false).map(p => p.complete);
    expect(running).toEqual([true, true, true, false, false]);
    expect(decompositionProgress(execution({ state: 'done', runId: 'r1' }), undefined, false).every(p => p.complete)).toBe(true);
  });
  it('reports a reuse with one generated image: prompt planning 0, planner 0, one image call with its cost', () => {
    const rows = Object.fromEntries(costRows(execution({ state: 'generated', usage: usage(1, 0), generationCost: cost(5.9) }), undefined, false).map(r => [r.label, r.value]));
    expect(rows).toEqual({ 'Structure analysis': '0 calls', 'Prompt planning': '0 calls · ₹0', 'Image generation': '1 call · ₹5.90', 'Decomposition planner': '0 calls · ₹0', 'Cost so far': '₹5.90' });
  });
  it('counts Seedream extraction including residual passes, background cleanup and the recorded total', () => {
    const stage = (id: string, calls: { kind: 'text' | 'image' | 'seedream' }[]) => ({ id, label: id, status: 'Complete', result: '', calls, callsMeasured: true, cost: cost(0) });
    const diagnostics = { runId: 'r1', stages: [stage('planner', []), stage('seedream', [{ kind: 'seedream' }]), stage('residual', [{ kind: 'seedream' }]), stage('background', [{ kind: 'image' }])], total: { ...cost(20), confidence: 'Estimated' } } as unknown as RunDiagnostics;
    const rows = Object.fromEntries(costRows(execution({ state: 'done', runId: 'r1', usage: usage(0, 0) }), diagnostics, false).map(r => [r.label, r.value]));
    expect(rows).toMatchObject({ 'Image generation': '0 calls', 'Decomposition planner': '0 calls · ₹0', 'Layer extraction (Seedream)': '2 calls', 'Background cleanup': '1 call', 'Total recorded cost': 'estimated ₹20.00' });
  });
  it('does not mark an allocated run or failed planning attempt as a completed plan', () => {
    const e = execution({ mode: 'CREATE_TEMPLATE', state: 'failed', runId: 'r1', usage: usage(0, 1) });
    for (const run of [undefined, { stage: 'uploaded' }, { stage: 'planning' }, { stage: 'failed', error: { stage: 'planning' } }])
      expect(decompositionProgress(e, run, true).every(p => !p.complete)).toBe(true);
    expect(decompositionProgress(e, { stage: 'failed', error: { stage: 'uploading' } }, true)[0].complete).toBe(true);
    expect(decompositionProgress(e, { stage: 'failed', planner: { prompt: 'valid plan' } }, true)[0].complete).toBe(true);
    expect(costRows(e, undefined, true).find(r => r.label === 'Decomposition planner')?.value).toBe('1 attempt');
  });
  it('shows planning in progress, recorded attempts and successful calls separately', () => {
    const planner = (e: ShownExecution) => costRows(e, undefined, true).find(r => r.label === 'Decomposition planner')!.value;
    expect(planner(execution({ mode: 'CREATE_TEMPLATE', state: 'planning', usage: usage(0, 0) }))).toBe('planning in progress');
    expect(planner(execution({ mode: 'CREATE_TEMPLATE', state: 'failed', usage: usage(0, 0) }))).toBe('0 calls · ₹0');
    expect(planner(execution({ mode: 'CREATE_TEMPLATE', state: 'done', usage: usage(0, 1) }))).toBe('1 call');
  });
});

const layer = (id: string, role: TemplateLayer['role'], order: number, zone?: TemplateLayer['zone']): TemplateLayer => ({ id, role, order, independent: true, required: false, ...(zone ? { zone } : {}) });
/** The saved Product Trio structure: two earbuds and their case, a backdrop, decorations, a pedestal. */
const trio: Pick<TemplateVersion, 'structure'> = { structure: { relationships: [], layers: [layer('background', 'background', 0, 'full-canvas'), layer('backdrop', 'backdrop', 1, 'middle-left'),
  layer('decoration', 'decoration', 2), layer('prop', 'prop', 3, 'bottom-center'), { ...layer('effect', 'effect', 4, 'top-center'), independent: false },
  layer('supporting_product', 'supporting_product', 6, 'top-left'), layer('supporting_product_2', 'supporting_product', 7, 'top-center'), layer('main_product_2', 'main_product', 8, 'bottom-center')] } };

describe('template wizard: customizing a template', () => {
  it('offers the main product and background first; supporting products, decorations and props sit under Advanced elements with distinct labels', () => {
    const groups = fieldGroups(trio);
    expect(groups.product.map(s => s.label)).toEqual(['Main product']);
    expect(groups.style.map(s => s.label)).toEqual(['Background', expect.stringMatching(/backdrop/i)]);
    expect(groups.text).toEqual([]);
    expect(groups.advanced.map(s => s.label)).toEqual([expect.stringMatching(/decorat/i), expect.stringMatching(/prop|support/i), 'Supporting product · top left', 'Supporting product · top']);
    expect(Object.values(groups).flat().some(s => s.role === 'effect')).toBe(false);
  });
  it('sends only the options that apply to a filled main product field', () => {
    expect(mainProductOptions({ brand: 'boAt', keepSupporting: true }, false)).toEqual({});
    expect(mainProductOptions({ brand: '  boAt ' }, true)).toEqual({ brand: 'boAt' });
    expect(mainProductOptions({ mode: 'details', brand: 'boAt', keepSupporting: true }, true)).toEqual({ mode: 'details' });
    expect(mainProductOptions({ mode: 'replace', keepSupporting: true }, true)).toEqual({ mode: 'replace', keepSupporting: true });
    // The preview compiled with these options is the server's: the same function, the same arguments.
    expect(compileTemplateEdit(trio, { main_product_2: 'speaker' }, { mainProduct: mainProductOptions({ brand: 'boAt' }, true) }).text).toContain('"boAt speaker"');
  });
  it('restores main product options from a draft and ignores malformed ones', () => {
    const storage = memory();
    writeWizardDraft(storage, { step: 1, selected: 'tpl-1', values: { main_product_2: 'speaker' }, options: { mode: 'replace', brand: 'boAt', keepSupporting: true } });
    expect(readWizardDraft(storage).options).toEqual({ mode: 'replace', brand: 'boAt', keepSupporting: true });
    storage.setItem(WIZARD_DRAFT_KEY, JSON.stringify({ step: 1, options: { mode: 'swap', brand: 7, keepSupporting: 'yes' } }));
    expect(readWizardDraft(storage).options).toBeUndefined();
  });
});

describe('template wizard: approving a generated image', () => {
  const generated = (patch: Partial<ShownExecution> = {}) => execution({ state: 'generated', edit: { instruction: 'x', prompt: 'p', model: 'm', size: 's', image }, ...patch });
  const review = (requiresAcknowledgement: boolean) => ({ method: 'source-layer-masks' as const, checks: [], requiresAcknowledgement, note: 'Local pixel comparison only.' });
  it('waits for the user to look when the review asks for it, and for a plan choice after a structural change', () => {
    expect(wizardPrimary(view({ execution: generated() }))).toMatchObject({ label: 'Use this image', disabled: false });
    const replaced = generated({ edit: { instruction: 'x', prompt: 'p', model: 'm', size: 's', image, review: review(true) } });
    expect(wizardPrimary(view({ execution: replaced })).disabled).toBe(true);
    expect(wizardPrimary(view({ execution: replaced, reviewAcknowledged: true })).disabled).toBe(false);
    const structural = generated({ compatibility: { status: 'structural-change', reasons: ['Main product becomes "speaker".'], changedSlots: ['main_product_2'] } });
    expect(wizardPrimary(view({ execution: structural })).disabled).toBe(true);
    expect(wizardPrimary(view({ execution: structural, planChosen: true })).disabled).toBe(false);
    // Decisions already recorded on the server (a reopened session) are not asked again.
    expect(wizardPrimary(view({ execution: { ...structural, planDecision: { choice: 'saved', at: 'now' } } })).disabled).toBe(false);
    expect(wizardPrimary(view({ execution: generated({ edit: { instruction: 'x', prompt: 'p', model: 'm', size: 's', image, review: { ...review(true), acknowledgedAt: 'now' } } }) })).disabled).toBe(false);
  });
  it('offers an explicit extraction retry only after a failed extraction of a saved image, with costs on every choice', () => {
    expect(extractionRecovery(execution({ state: 'failed', runId: 'r1', imageAcceptedAt: 'now', error: { code: 'PROVIDER_DECOMPOSITION_REJECTED', message: 'x', state: 'decomposing' } }))).toBe(true);
    expect(extractionRecovery(execution({ state: 'failed', error: { code: 'GENERATION_FAILED', message: 'x', state: 'generating' } }))).toBe(false);
    expect(extractionRecovery(execution({ mode: 'CREATE_TEMPLATE', state: 'failed', runId: 'r1', error: { code: 'PROVIDER_DECOMPOSITION_REJECTED', message: 'x', state: 'decomposing' } }))).toBe(false);
    expect(extractionRecovery(execution({ state: 'done', runId: 'r1' }))).toBe(false);
    const estimate = extractionEstimate(7, 1216, 1520);
    expect(estimate.seedreamInr).toBeCloseTo(7 * 0.03375 * 90);
    expect(extractionEstimate(7, 2048, 2048).seedreamInr).toBeCloseTo(7 * 0.0675 * 90);
    expect(estimate.plannerInr).toBeGreaterThan(0);
    expect(PLAN_CHOICES.map(c => [c.plan, c.detail(estimate)])).toEqual([['saved', expect.stringContaining('₹0')], ['simple', expect.stringContaining('₹0')], ['refresh', expect.stringMatching(/1 planner call · about ₹\d+\.\d\d \(estimate\)/)]]);
  });
});

describe('template details: name and description validation', () => {
  it('refuses what the server would refuse, before anything is sent', () => {
    expect(textProblems('Presenter on a panel', 'A person in front of a panel.')).toEqual([]);
    expect(textProblems('   ', '')).toEqual(['A name is 1–60 characters.']);
    expect(textProblems('x'.repeat(61), '')).toEqual(['A name is 1–60 characters.']);
    expect(textProblems('Hero', 'd'.repeat(241))).toEqual(['A description is at most 240 characters.']);
    expect(textProblems('<b>Hero</b>', '')).toEqual(['Use plain text, without { } < >.']);
    // Spaces collapse as the server stores them: 60 visible characters with extra spaces are still fine.
    expect(textProblems(`  ${'a'.repeat(30)}    ${'b'.repeat(29)}  `, '')).toEqual([]);
  });
});
