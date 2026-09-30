import { afterEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DecompositionJobSummary, ProposalReviewTarget } from '@frameflow/shared';
import { canCombineLayers, initialDraft, layerChoice, ReviewStep } from './workspace/ReviewStep';
import { EdgesStep, RefineStep, restoredSelections } from './workspace/RefineStep';
import { draftKey } from './workspace/refineDrafts';

afterEach(() => vi.unstubAllGlobals());
const target = (id: string, patch: Partial<ProposalReviewTarget> = {}): ProposalReviewTarget => ({ id, label: id, proposalIds: [], approved: true, rejected: false, groupMode: 'single', role: 'object', ...patch });
const job = (patch: Partial<DecompositionJobSummary>): DecompositionJobSummary => ({ id: 'job', revision: 4, sourceWidth: 256, sourceHeight: 256, sourcePreviewArtifactId: 'source', warnings: [], artifacts: [], ...patch }) as DecompositionJobSummary;
const props = { onSubmit: async () => {}, busy: false };
/** In-memory sessionStorage with the per-object draft format. */
function memoryStorage(entries: [string, string][] = []) {
  const map = new Map(entries);
  return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k), key: (i: number) => [...map.keys()][i] ?? null, get length() { return map.size; } };
}
const storedDraft = (objectId: string, label: string, base: string, draft: object, extra: object = {}): [string, string] =>
  [draftKey('job', objectId), JSON.stringify({ v: 1, jobId: 'job', objectId, label, base, width: 256, height: 256, draft, ...extra })];

it('replaces proposal review with named layers, editable type, manual additions and no internal terminology', () => {
  const value = job({
    proposals: [{ id: 'proposal-1', label: 'Woman holding phone', description: 'Young woman in a jacket', artifactId: 'rgba', alphaArtifactId: 'alpha', width: 256, height: 256, registered: true, warnings: [], provider: 'seedream', zIndex: 1, requestFingerprint: 'fingerprint-abc' }] as DecompositionJobSummary['proposals'],
    proposalTargets: [target('target-1', { label: 'Woman holding phone', description: 'Young woman in a jacket', proposalIds: ['proposal-1'] }), target('target-background', { label: 'Background', role: 'background', baseLayer: true })],
  });
  const html = renderToStaticMarkup(createElement(ReviewStep, { job: value, ...props }));
  for (const text of ['Detected layers', 'Woman holding phone', 'Young woman in a jacket', 'Background', 'Shape', 'Adjust area', 'Add a layer', 'Save for later', 'Continue']) expect(html).toContain(text);
  const visibleText = html.replace(/<[^>]+>/g, ' ');
  for (const internal of ['proposal-1', 'fingerprint-abc', 'seedream', 'target-1']) expect(visibleText).not.toContain(internal);
});

it('saved choices over the per-job limit block saving and continuing with a clear limit message, while every choice stays available', () => {
  const choices = [target('First'), target('Second'), target('Background', { role: 'background', baseLayer: true })];
  const value = job({ options: { maxObjects: 1 } as DecompositionJobSummary['options'], proposalTargets: choices, reviewSubmission: { action: 'save-proposals', expectedRevision: 3, targets: choices } });
  const html = renderToStaticMarkup(createElement(ReviewStep, { job: value, ...props }));
  expect(html).toContain('You can open up to 1 editable layer at once. Choose “Leave for later” for 1 more — they stay in your design.');
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save for later<\/button>/);
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Continue<\/button>/);
  for (const choice of ['Leave for later', 'Remove']) expect(html).toMatch(new RegExp(`<button role="radio"[^>]*(?<!disabled="")>[\\s\\S]*?${choice}</button>`));
});

it('first review adds layers up to the editor limit and leaves the rest for later; the background starts excluded', () => {
  for (const count of [1, 2, 3]) {
    const fresh = (label: string, patch: Partial<ProposalReviewTarget> = {}) => target(label, { approved: false, rejected: false, ...patch });
    const value = job({ options: { maxObjects: 2 } as DecompositionJobSummary['options'], proposalTargets: [...Array.from({ length: count }, (_, i) => fresh(`Layer ${i}`)), fresh('Background', { baseLayer: true, role: 'background' })] });
    const html = renderToStaticMarkup(createElement(ReviewStep, { job: value, ...props }));
    expect(html).toContain(`<strong>${Math.min(count, 2)} of 2</strong> selected for the editor${count > 2 ? ' · 1 left for later' : ''}`);
    expect(html.includes('You can open up to 2 editable layers at once.')).toBe(count >= 2);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Save for later<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Continue<\/button>/);
    // "Add a layer" stays available at the limit: a new layer is left for later instead of being refused.
    expect(/<button[^>]*disabled=""[^>]*>[\s\S]*?Add a layer<\/button>/.test(html)).toBe(false);
    expect(html.match(/data-choice="later"/g)?.length ?? 0).toBe(Math.max(0, count - 2));
    expect(html).toContain('data-choice="exclude"');
  }
  const draft = initialDraft(job({ options: { maxObjects: 1 } as DecompositionJobSummary['options'], proposalTargets: [target('A', { approved: false }), target('B', { approved: false }), target('Background', { approved: false, baseLayer: true, role: 'background' })] }), 'k');
  expect(draft.targets.map(t => [t.label, layerChoice(t)])).toEqual([['A', 'add'], ['B', 'later'], ['Background', 'remove']]);
});

it('keeps saved "left for later" choices exactly as they were', () => {
  const choices = [target('A'), target('B', { approved: false, rejected: false }), target('C', { approved: false, rejected: true })];
  const draft = initialDraft(job({ proposalTargets: choices, reviewSubmission: { action: 'save-proposals', expectedRevision: 3, targets: choices } }), 'k');
  expect(draft.targets.map(t => layerChoice(t))).toEqual(['add', 'later', 'remove']);
});

it('allows reducing an oversized group but prevents combining removed layers above the limit', () => {
  const targets = [target('one'), target('two'), target('three'), target('off-one', { approved: false, rejected: true }), target('off-two', { approved: false, rejected: true }), target('background', { baseLayer: true })];
  expect(canCombineLayers(targets, ['one', 'two'], 1)).toBe(true);
  expect(canCombineLayers(targets, ['off-one', 'off-two'], 3)).toBe(false);
  expect(canCombineLayers(targets, ['one', 'off-one'], 2)).toBe(false);
  expect(canCombineLayers(targets, ['one', 'off-one'], 3)).toBe(true);
  expect(canCombineLayers(targets, ['off-one', 'off-two'], 4)).toBe(true);
  expect(canCombineLayers(targets, ['one', 'background'], 3)).toBe(false);
});

it('recovers rejected submission choices, classifications, server background and composite hints even from storage', () => {
  const saved = [target('heading', { role: 'unknown', proposalIds: ['p1'], classification: { kind: 'TEXT', confidence: 'medium', source: 'provider-label', reasons: [] }, maskArtifactId: 'heading-mask' }), target('person', { proposalIds: ['p2'], maskArtifactId: 'person-mask' }), target('background', { baseLayer: true, role: 'background' })];
  const choices = [target('heading', { label: 'Renamed heading', role: 'unknown', proposalIds: ['p1'], baseLayer: true, strokes: [{ mode: 'add', radius: 4, points: [{ x: 10, y: 12 }] }] }), target('group', { proposalIds: ['p2'], groupMode: 'group', memberTargetIds: ['person'], label: 'Custom group' }), target('background', { role: 'background', baseLayer: false })];
  const value = job({ state: 'failed', error: { code: 'TARGET_LIMIT', message: '', retryable: true }, proposalTargets: saved, reviewSubmission: { action: 'save-proposals', expectedRevision: 3, targets: choices } });
  for (const fromStorage of [false, true]) {
    vi.stubGlobal('localStorage', { getItem: () => fromStorage ? JSON.stringify({ targets: choices, memberMasks: {} }) : null });
    const restored = initialDraft(value, 'same-revision');
    expect(restored.targets[0]).toMatchObject({ label: 'Renamed heading', role: 'unknown', baseLayer: false, classification: { kind: 'TEXT' }, strokes: choices[0].strokes });
    expect(restored.targets.at(-1)).toMatchObject({ id: 'background', baseLayer: true });
    expect(restored.targets[1]).toMatchObject({ label: 'Custom group', memberTargetIds: ['person'] });
    expect(restored.memberMasks).toEqual({ group: ['person-mask'] });
  }
});

it('restores saved selection hints and exclusions without applying processed strokes again', () => {
  const candidates = [{ id: 'candidate-8', label: 'Person', source: 'sam3', maskArtifactId: 'native-mask', overlayArtifactId: 'overlay', warnings: [] }, { id: 'candidate-9', label: 'Phone', source: 'sam3', maskArtifactId: 'phone-mask', warnings: [] }] as NonNullable<DecompositionJobSummary['candidates']>;
  const value = job({ candidates, reviewSubmission: { expectedRevision: 3, action: 'accept-masks', objects: [{ id: 'candidate-8', selected: true, points: [{ x: 100, y: 100, label: 1 }], strokes: [{ mode: 'add', radius: 5, points: [{ x: 80, y: 90 }] }] }, { id: 'candidate-9', selected: false }] } });
  expect(restoredSelections(value, candidates)).toEqual({ 'candidate-8': { selected: true, points: [{ x: 100, y: 100, label: 1 }], strokes: [] }, 'candidate-9': { selected: false, points: [], strokes: [] } });
  const html = renderToStaticMarkup(createElement(RefineStep, { job: value, ...props }));
  expect(html).toContain('Selection for Person');
  expect(html).toContain('Not included');
  expect(html).toContain('cx="100" cy="100"');
  expect(html).not.toContain('<polyline');
});

it('retains unsaved same-revision brush edits on reload', () => {
  const value = job({ candidates: [{ id: 'candidate', label: 'Person', source: 'sam3', maskArtifactId: 'mask', warnings: [] }] as NonNullable<DecompositionJobSummary['candidates']> });
  vi.stubGlobal('sessionStorage', memoryStorage([storedDraft('candidate', 'Person', 'mask', { selected: true, strokes: [{ mode: 'subtract', radius: 5, points: [{ x: 80, y: 90 }] }] })]));
  const html = renderToStaticMarkup(createElement(RefineStep, { job: value, ...props }));
  expect(html).toContain('Unsaved edits');
  expect(html).toContain('<polyline points="80,90"');
  expect(html).toMatch(/<button class="ws-btn" title="Apply your painted changes exactly, without AI."/);
});

it('holds AI refine until an empty selection has a painted hint, instead of replaying a failed label-only request', () => {
  const empty = { id: 'jhula', label: 'Jhula', source: 'sam3', maskArtifactId: 'mask', qualityTier: 'FAIL', qualityChecks: [{ code: 'EMPTY_MASK', tier: 'FAIL', message: 'The mask is empty.' }], statistics: { area: 0, bbox: null }, warnings: [] };
  const value = job({ review: { code: 'PROVIDER_EMPTY_OUTPUT', message: 'x', actions: ['guided-refine'], gate: 'semantic-mask-review' }, candidates: [empty] as unknown as NonNullable<DecompositionJobSummary['candidates']> } as Partial<DecompositionJobSummary>);
  const html = renderToStaticMarkup(createElement(RefineStep, { job: value, ...props }));
  expect(html).toContain('Nothing is selected yet.');
  expect(html).toMatch(/<button class="ws-btn" disabled=""[^>]*>.*?AI refine<\/button>/);
  expect(html).toContain('Paint over the object first so AI knows where to look');
  expect(html).toContain('AI couldn’t find this object from these hints.');
  expect(html).not.toContain('busy');
  // A painted "add" stroke is a real hint: AI refine becomes available again.
  vi.stubGlobal('sessionStorage', memoryStorage([storedDraft('jhula', 'Jhula', 'mask', { selected: true, strokes: [{ mode: 'add', radius: 8, points: [{ x: 80, y: 90 }] }] })]));
  expect(renderToStaticMarkup(createElement(RefineStep, { job: value, ...props }))).toMatch(/<button class="ws-btn" title="Let AI clean[^>]*>.*?AI refine<\/button>/);
});

it('shows AI\'s provisional selection as a starting point that must be kept or fixed before continuing', () => {
  const provisional = { id: 'jhula', label: 'Jhula', source: 'sam3', maskArtifactId: 'provisional-mask', overlayArtifactId: 'provisional-overlay', provisional: true, qualityTier: 'REVIEW', qualityStatus: 'needs-correction',
    qualityChecks: [{ code: 'PROVISIONAL_SELECTION', tier: 'REVIEW', message: 'x' }, { code: 'POSITIVE_GUIDANCE_UNSATISFIED', tier: 'FAIL', message: 'x' }], statistics: { area: 60096, areaFraction: 0.06, bbox: { x: 0, y: 299, width: 736, height: 736 } }, warnings: [] };
  const html = renderToStaticMarkup(createElement(RefineStep, { job: job({ candidates: [provisional] as unknown as NonNullable<DecompositionJobSummary['candidates']> }), ...props }));
  expect(html).toContain('Check this selection');
  expect(html).toContain('AI found a possible selection. Check it and fix any missing or extra areas.');
  expect(html).toContain('provisional-mask');
  expect(html).not.toContain('Nothing is selected yet.');
  expect(html).not.toContain('Looks right');
  expect(html).toContain('Keep this selection');
  expect(html).toMatch(/<button class="ws-btn" title="Let AI clean[^>]*>.*?AI refine<\/button>/);
  expect(html).toContain('Check “Jhula” first — keep AI’s selection or save your fixes.');
  expect(html).toMatch(/<button class="ws-btn ws-btn-primary" disabled="">Looks good<\/button>/);
});

it.each([['REVIEW'], ['FAIL']])('holds "Looks good" while a %s selection has unsaved strokes, and never implies they apply automatically', tier => {
  const candidate = { id: 'jhula', label: 'Jhula', source: 'sam3', maskArtifactId: 'mask', qualityTier: tier, qualityChecks: [], statistics: { area: 100, areaFraction: 0.1, bbox: { x: 10, y: 10, width: 50, height: 50 } }, warnings: [] };
  const value = job({ candidates: [candidate] as unknown as NonNullable<DecompositionJobSummary['candidates']> });
  vi.stubGlobal('sessionStorage', memoryStorage([storedDraft('jhula', 'Jhula', 'mask', { selected: true, strokes: [{ mode: 'add', radius: 8, points: [{ x: 80, y: 90 }] }] })]));
  const html = renderToStaticMarkup(createElement(RefineStep, { job: value, ...props }));
  expect(html).toContain('Save your changes first — “Jhula” has unsaved edits.');
  expect(html).toMatch(/<button class="ws-btn ws-btn-primary" disabled="">Looks good<\/button>/);
  expect(html).not.toContain('applied when you continue');
  // Drafts are kept: the stroke is still drawn and "Save my changes" is available.
  expect(html).toContain('<polyline points="80,90"');
  expect(html).toMatch(/<button class="ws-btn" title="Apply your painted changes exactly, without AI."/);
});

it.each([['REVIEW', false], ['FAIL', true]])('after a save, "Looks good" follows the saved revision\'s ownership checks (%s)', (tier, disabled) => {
  const candidate = { id: 'jhula', label: 'Jhula', source: 'sam3', maskArtifactId: 'saved-mask', qualityTier: tier, manualOwnership: true, qualityChecks: tier === 'FAIL' ? [{ code: 'EMPTY_MASK', tier: 'FAIL', message: 'x' }] : [], warnings: [] };
  const html = renderToStaticMarkup(createElement(RefineStep, { job: job({ revision: 5, candidates: [candidate] as unknown as NonNullable<DecompositionJobSummary['candidates']> }), ...props }));
  expect(html).not.toContain('Save your changes first');
  expect(/<button class="ws-btn ws-btn-primary" disabled="">Looks good<\/button>/.test(html)).toBe(disabled);
});

it('replaces alpha review with surfaces, editable edges, restore and back controls', () => {
  const value = job({ refined: [{ id: 'person', label: 'Person', maskArtifactId: 'mask', alphaArtifactId: 'alpha', overlayArtifactId: 'overlay' }] as DecompositionJobSummary['refined'] });
  const html = renderToStaticMarkup(createElement(EdgesStep, { job: value, ...props }));
  for (const text of ['Transparent', 'Dark', 'Light', 'Edges of Person', 'Add area', 'Remove area', 'Restore trimmed areas', 'Back to selection', 'Save my changes', 'Looks good']) expect(html).toContain(text);
});
