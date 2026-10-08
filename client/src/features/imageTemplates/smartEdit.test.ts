import { describe, expect, it } from 'vitest';
import { applySceneCorrections, basePlan, cleanDraft, compileResolvedEdit, emptyDraft, parseSceneDescription, type CostAmount, type SceneDraft, type TemplateExecution } from '@frameflow/shared';
import { appliancesAnalysis, holdingBallAnalysis, phoneOfferAnalysis, sofaAnalysis, twoPhonesAnalysis } from '../../../../server/src/decomposition/creativeTemplates/scene.fixture';
import { answerConflict, correctedScene, defaultProtected, draftChangeList, groupedControls, hasDraftChanges, resolutionKey, resolutionStatus, resolvedPreview, sceneControls, setCorrection, setEdit, smartCostRows, type Resolution, type SceneAnalysis } from './smartEdit';
import { costRows, readWizardDraft, VARIANT_PLAN_CHOICES, WIZARD_DRAFT_KEY, type ShownExecution } from './templateWizard';

const analysisOf = (raw: unknown): SceneAnalysis => ({ id: '2026-10-08T00-00-00-000Z-abcdef', state: 'ready', createdAt: '', binding: { imageSha256: 'x', templateId: 'tpl-1', templateVersion: 1, config: 'scene-v1|m' }, model: 'm', calls: 1, scene: parseSceneDescription(raw) });

describe('smart edit controls come from the image, not a category list', () => {
  it('groups a phone offer, a person holding a ball, appliances, furniture and similar phones by what was detected', () => {
    const phone = groupedControls(sceneControls(parseSceneDescription(phoneOfferAnalysis())));
    expect(phone.map(g => [g.label, g.controls.map(c => c.label)])).toEqual([['Main products & subjects', ['Smartphone']], ['Supporting objects', ['Earbuds']], ['Background & scene', ['Background', 'Pedestal']],
      ['Logos & text in the image', ['Merchant logo', 'Product brand mark', 'Bank logo', 'Overlaid text · top', 'Overlaid text · bottom']]]);
    const smartphone = phone[0].controls[0];
    expect(smartphone).toMatchObject({ current: 'Gold smartphone with a triple camera', identity: 'Apple iPhone 15 Pro', actions: ['keep', 'modify', 'replace', 'remove'], brandable: true, details: ['Color: gold', 'Finish: glossy'] });
    expect(phone[3].controls.find(c => c.label === 'Bank logo')).toMatchObject({ actions: ['keep', 'remove'], relation: 'placed on the artwork', brandable: false });
    expect(phone[2].controls[0].actions).toEqual(['keep', 'modify']);
    const ball = sceneControls(parseSceneDescription(holdingBallAnalysis()));
    expect(ball.map(c => [c.label, c.group, c.relation ?? ''])).toEqual([['Man', 'main', 'holds or wears Football'], ['Football', 'attached', 'held by Man'], ['Park', 'scene', '']]);
    expect(sceneControls(parseSceneDescription(appliancesAnalysis())).filter(c => c.group === 'main').map(c => c.label)).toEqual(['Refrigerator', 'Washing machine']);
    expect(sceneControls(parseSceneDescription(sofaAnalysis())).map(c => c.label)).toEqual(['Sofa', 'कुशन', 'Living room wall', 'Floor lamp']);
    expect(sceneControls(parseSceneDescription(twoPhonesAnalysis())).filter(c => c.group === 'main').map(c => c.label)).toEqual(['Smartphone · left', 'Smartphone · right']);
  });

  it('keeps explicit actions apart from inheritance, and corrections apart from detections', () => {
    const scene = parseSceneDescription(phoneOfferAnalysis());
    let draft: SceneDraft = emptyDraft();
    expect(hasDraftChanges(draft)).toBe(false);
    draft = setEdit(draft, 'earbuds_1', { action: 'keep' });
    expect(hasDraftChanges(draft)).toBe(false);
    draft = setEdit({ ...setEdit(draft, 'smartphone_1', { action: 'replace' }), referenceFor: 'smartphone_1' }, 'mark_1', { action: 'remove' });
    expect(draft.referenceFor).toBe('smartphone_1');
    // A product photo goes with a replaced object only: changing the action drops it.
    expect(setEdit(draft, 'smartphone_1', { action: 'modify', value: 'matte' }).referenceFor).toBeUndefined();
    expect(draftChangeList(scene, setEdit(draft, 'smartphone_1', { action: 'replace', value: 'phone', brand: 'Xiaomi' }))).toEqual([
      { id: 'earbuds_1', label: 'Earbuds', action: 'keep', text: 'keep as it is' }, { id: 'smartphone_1', label: 'Smartphone', action: 'replace', text: 'Xiaomi phone' }, { id: 'mark_1', label: 'Merchant logo', action: 'remove', text: 'remove' }]);
    const corrected = setCorrection(draft, 'smartphone_1', { brand: 'Google' });
    expect(correctedScene(analysisOf(phoneOfferAnalysis()), corrected)!.objects.find(o => o.id === 'smartphone_1')!.identity!.brand).toBe('Google');
    expect(setCorrection(corrected, 'smartphone_1', { brand: '' }).corrections).toEqual({});
  });

  it('marks a resolution stale after any edit, so a late response for an older draft is never used', () => {
    const scene = parseSceneDescription(phoneOfferAnalysis()), draft = cleanDraft(scene, { edits: { background_1: { action: 'modify', value: 'teal' } } });
    const key = resolutionKey('a1', draft), plan = basePlan(scene, draft);
    const resolution: Resolution & { key: string } = { id: 'r1', analysisId: 'a1', state: 'ready', binding: { draft: '' }, plan, resolver: { called: false }, key };
    expect(resolutionStatus(resolution, key)).toBe('ready');
    expect(resolutionStatus(resolution, resolutionKey('a1', setEdit(draft, 'background_1', { action: 'modify', value: 'pink' })))).toBe('stale');
    expect(resolutionStatus(resolution, resolutionKey('a1', draft, { name: 'p.png', size: 1, lastModified: 1 }))).toBe('stale');
    expect(resolutionStatus(resolution, resolutionKey('a2', draft))).toBe('stale');
    expect(resolutionStatus(undefined, key)).toBe('none');
    expect(resolutionStatus({ ...resolution, state: 'failed', plan: undefined }, key)).toBe('failed');
    // The preview is the same compiler the server persists.
    expect(resolvedPreview(scene, resolution, false)!.text).toBe(compileResolvedEdit(scene, plan).text);
    const asking = basePlan(scene, cleanDraft(scene, { edits: { smartphone_1: { action: 'replace', value: 'phone' } } }));
    expect(resolutionStatus({ ...resolution, plan: asking }, key)).toBe('needs-input');
    const answered = answerConflict(cleanDraft(scene, { edits: { smartphone_1: { action: 'replace', value: 'phone' } } }), asking.conflicts[0].options[1]);
    expect(answered.draft.edits.earbuds_1).toEqual({ action: 'remove' });
  });

  it('protects the one main subject by default, and nothing when the main subject is ambiguous', () => {
    expect(defaultProtected(parseSceneDescription(phoneOfferAnalysis()))).toEqual(['smartphone_1']);
    expect(defaultProtected(parseSceneDescription(appliancesAnalysis()))).toEqual([]);
    expect(defaultProtected(applySceneCorrections(parseSceneDescription(holdingBallAnalysis()), {}))).toEqual([]);
  });
});

describe('the wizard counts smart and variant calls apart, and keeps legacy rows unchanged', () => {
  const usage = (extra: Partial<TemplateExecution['usage']> = {}): TemplateExecution['usage'] => ({ plannerCalled: false, promptGenerationCalled: false, imageGenerationCalled: true, plannerCalls: 0, imageGenerationCalls: 1, generationPromptSource: 'resolved-plan', decompositionPlanSource: 'saved-template', timings: {}, ...extra });
  const cost: CostAmount = { usd: 0.07, inr: 5.9, knownUsd: 0.07, knownInr: 5.9, confidence: 'Calculated', notes: [] };
  const execution = (extra: Partial<ShownExecution>): ShownExecution => ({ id: 'e', mode: 'REUSE_TEMPLATE_WITH_EDIT', idempotencyKey: 'k', state: 'generated', createdAt: '', updatedAt: '', upload: { file: 'upload.png', mimeType: 'image/png', width: 1, height: 1, bytes: 1, sha256: 'x' }, usage: usage(), warnings: [], generationCost: cost, ...extra });
  it('shows analysis, resolution and the AI check for a smart edit', () => {
    const rows = Object.fromEntries(costRows(execution({ resolution: { id: 'r', analysisId: 'a', summary: '', changes: 1, inferred: 0 }, usage: usage({ analysisCalls: 1, resolutionCalls: 1, verificationCalls: 1 }) }), undefined, false).map(r => [r.label, r.value]));
    expect(rows).toEqual({ 'Structure analysis': '0 calls', 'Image analysis': '1 call · shared by edits of this image', 'Change resolution': '1 call', 'Image generation': '1 call · ₹5.90', 'AI check of the result': '1 call', 'Decomposition planner': '0 calls · ₹0', 'Cost so far': '₹5.90' });
    expect(smartCostRows(execution({ variant: { setId: 's', variantId: 'v1', protectedLabels: ['Phone'], layers: {} as never } }))![0].label).toBe('Creative variant');
    expect(smartCostRows(execution({}))).toBeUndefined();
  });
  it('offers a variant its own layers or a scenery-only split, never the saved plan', () => {
    expect(VARIANT_PLAN_CHOICES.map(c => c.plan)).toEqual(['composed', 'simple', 'refresh']);
    expect(VARIANT_PLAN_CHOICES[0].detail({ seedreamInr: 9, plannerInr: 4 })).toMatch(/₹0/);
  });
  it('restores a smart draft only in its own shape', () => {
    const storage = (value: unknown) => ({ getItem: (key: string) => key === WIZARD_DRAFT_KEY ? JSON.stringify(value) : null });
    expect(readWizardDraft(storage({ step: 1, smart: { analysisId: 'a1', draft: { edits: { x: { action: 'remove' } }, corrections: {}, referenceFor: 'x' } } })).smart).toEqual({ analysisId: 'a1', draft: { edits: { x: { action: 'remove' } }, corrections: {}, referenceFor: 'x' } });
    expect(readWizardDraft(storage({ step: 1, smart: { analysisId: 'a1', draft: { edits: [] } } })).smart).toBeUndefined();
    expect(readWizardDraft(storage({ smart: 'nope' })).smart).toBeUndefined();
    // An open variant set comes back after a refresh; a malformed id does not.
    expect(readWizardDraft(storage({ variantSetId: '2026-10-08T10-00-00-000Z-abc123', studio: true }))).toMatchObject({ variantSetId: '2026-10-08T10-00-00-000Z-abc123', studio: true });
    expect(readWizardDraft(storage({ variantSetId: '../../etc', studio: 'yes' }))).toEqual({});
  });
});
