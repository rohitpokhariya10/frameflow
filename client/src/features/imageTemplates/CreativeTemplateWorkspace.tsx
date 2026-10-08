import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ImagePlus, Layers, LoaderCircle, Lock, Plus, Sparkles } from 'lucide-react';
import { baseTemplatePrompt, BRAND_LIMIT, compileTemplateEdit, FIELD_LIMIT, ZONE_PHRASES, type CompiledTemplateEdit, type CreativeTemplate, type EditOperation, type ExecutionMode, type ExtractionPlan, type PromptSegment, type RunDiagnostics, type TemplateSlot, type TemplateVersion } from '@frameflow/shared';
import { LayerPreview } from '../decomposition/LayerPreview';
import { TemplateDetails } from './TemplateDetails';
import { experimentApi, type ExperimentRun } from '../decomposition/layerizeExperiment';
import { costRows, decompositionProgress, draftStep, extractionEstimate, extractionRecovery, fieldGroups, hasContentChanges, inGenerationPhase, isResting, mainProductOptions, money, needsPlanDecision, needsReviewAcknowledgement, PLAN_CHOICES, plural, readWizardDraft, reopenStep, templateSlotBadges, wizardPrimary, WIZARD_STEPS, writeWizardDraft, type MainProductOptions, type ShownExecution, type WizardStep } from './templateWizard';
import './templateWizard.css';

export type { ShownExecution };
const BASE = '/api/layerize-experiment';
const imageUrl = (id: string, which = 'upload') => `${BASE}/template-executions/${id}/images/${which}`;
const session = () => { try { return window.sessionStorage; } catch { return undefined; } };
class TemplateRequestError extends Error {
  constructor(message: string, readonly code?: string, readonly warnings: string[] = []) { super(message); }
}
export async function templateRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, init), value = await response.json();
  if (!response.ok) throw new TemplateRequestError(value.error?.message ?? 'Request failed.', value.error?.code, value.error?.warnings);
  return value as T;
}
/** Server warnings carry a code for diagnostics; the user reads the sentence. */
const readable = (warning: string) => warning.replace(/^[A-Z_]+: /, '');
const fieldId = (slotId: string) => `tw-field-${slotId}`;
const OPERATION: Record<EditOperation, string> = { replace: 'Replace', details: 'Change details', restyle: 'Restyle', text: 'Exact text', remove: 'Remove' };
const reducedMotion = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
/**
 * A prompt with its dynamic parts marked: each part that comes from a field is a button that leads to that field; the
 * rest are locked rules, plain text the form cannot change.
 */
function SlotPrompt({ segments, linked, onLink, onPick, label, sentences = false }: { segments: PromptSegment[]; linked: string; onLink: (slotId: string) => void; onPick: (slotId: string) => void; label: string; sentences?: boolean }) {
  return <p className="tw-slot-prompt" aria-label={label}>{segments.map((segment, index) => segment.kind === 'slot' && segment.slotId
    // Field names are buttons; whole compiled sentences are marked text (the "What will change" list is their keyboard path).
    ? sentences ? <mark key={index} className={`tw-slot-text${linked === segment.slotId ? ' is-linked' : ''}`} title={segment.label} onClick={() => onPick(segment.slotId!)} onMouseEnter={() => onLink(segment.slotId!)} onMouseLeave={() => onLink('')}>{segment.text}</mark>
      : <button type="button" key={index} className={`tw-slot-chip${linked === segment.slotId ? ' is-linked' : ''}`} aria-controls={fieldId(segment.slotId)} title={`Edit ${segment.label}`}
        onClick={() => onPick(segment.slotId!)} onMouseEnter={() => onLink(segment.slotId!)} onMouseLeave={() => onLink('')} onFocus={() => onLink(segment.slotId!)} onBlur={() => onLink('')}>{segment.text}</button>
    : <span key={index} className="tw-locked">{segment.text} </span>)}</p>;
}

/** One saved execution, with an explicit review pause between image generation and the existing decomposition. */
export function CreativeTemplateWorkspace({ onRun, onOpen, requestedExecution }: { onRun: (id: string) => void; onOpen: (e: ShownExecution) => Promise<void>; requestedExecution?: { id: string } }) {
  const [draft] = useState(() => readWizardDraft(session()));
  const [templates, setTemplates] = useState<CreativeTemplate[]>([]), [libraryLoaded, setLibraryLoaded] = useState(false);
  const [selected, setSelected] = useState(draft.selected ?? ''), [creating, setCreating] = useState(draft.creating ?? false);
  const [values, setValues] = useState<Record<string, string>>(draft.values ?? {}), [loadedVersion, setVersion] = useState<TemplateVersion>();
  const [mainOptions, setMainOptions] = useState<MainProductOptions>(draft.options ?? {}), [productReference, setProductReference] = useState<File>(), [productReferenceUrl, setProductReferenceUrl] = useState('');
  // The field and prompt part the user points at, and the user's decisions on a generated image.
  const [detailsOf, setDetailsOf] = useState<string>(), [libraryNote, setLibraryNote] = useState('');
  const [linked, setLinked] = useState(''), [advancedOpen, setAdvancedOpen] = useState(false), [decision, setDecision] = useState<{ image: string; acknowledged?: boolean; plan?: ExtractionPlan }>({ image: '' });
  const [step, setStep] = useState<WizardStep>(() => draftStep(draft)), [execution, setExecution] = useState<ShownExecution>();
  // While a regeneration runs, the image it would replace stays visible and usable; it is replaced only by a success.
  const [previous, setPreviousState] = useState<ShownExecution>(), previousRef = useRef<ShownExecution | undefined>(undefined);
  const [file, setFile] = useState<File>(), [fileUrl, setFileUrl] = useState(''), [referenceExecution, setReferenceExecution] = useState('');
  const [missingUpload, setMissingUpload] = useState(draft.uploadName ?? '');
  const [fitWarning, setFitWarning] = useState<string[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [run, setRun] = useState<ExperimentRun>(), [diagnostics, setDiagnostics] = useState<RunDiagnostics>();
  const pending = useRef(false), submission = useRef<string | undefined>(undefined), warningIntent = useRef<'generate' | 'decompose' | 'fresh'>('decompose'), mismatchAccepted = useRef(false);
  // A session picked in Saved Runs replaces the one shown only once it has loaded: until then nothing acts on the old one.
  const [loadedRequest, setLoadedRequest] = useState<{ id: string }>(), switching = !!requestedExecution && loadedRequest !== requestedExecution;
  const active = !!execution && !isResting(execution), locked = busy || active || switching;
  // Each generated image is judged on its own: a new one is never approved by a tick given to the previous one.
  const imageKey = `${execution?.id ?? ''}:${execution?.edit?.image?.sha256 ?? ''}`, ownDecision = decision.image === imageKey ? decision : { image: imageKey };
  const acknowledged = !!ownDecision.acknowledged, planChoice = ownDecision.plan;
  const setAcknowledged = (value: boolean) => setDecision({ ...ownDecision, acknowledged: value }), setPlanChoice = (plan: ExtractionPlan) => setDecision({ ...ownDecision, plan });
  const chosen = templates.find(t => t.id === selected);
  const versionNumber = execution?.template?.id === selected ? execution.template.version : chosen?.currentVersion;
  const version = loadedVersion?.templateId === selected && loadedVersion.version === versionNumber ? loadedVersion : undefined;
  const setPrevious = useCallback((next?: ShownExecution) => { previousRef.current = next; setPreviousState(next); }, []);
  const setReferenceFile = useCallback((next?: File) => { setFile(next); setFileUrl(next ? URL.createObjectURL(next) : ''); }, []);
  const refreshLibrary = async () => { const data = await templateRequest<{ templates: CreativeTemplate[] }>('/templates'); setTemplates(data.templates); setLibraryLoaded(true); };
  const loadExecution = useCallback((e: ShownExecution, preferred?: WizardStep) => {
    setExecution(e); setPrevious(undefined); setSelected(e.template?.id ?? ''); setCreating(e.mode === 'CREATE_TEMPLATE'); setValues(e.slotValues ?? {}); setMainOptions(e.editOptions?.mainProduct ?? {});
    setReferenceExecution(e.id); setMissingUpload(''); setReferenceFile(undefined); setFitWarning([]); setError('');
    setStep(Math.min(preferred ?? 3, reopenStep(e)) as WizardStep);
  }, [setReferenceFile, setPrevious]);
  useEffect(() => {
    let live = true;
    const id = requestedExecution?.id ?? draft.executionId;
    void templateRequest<{ templates: CreativeTemplate[] }>('/templates').then(data => {
      if (!live) return;
      setTemplates(data.templates); setLibraryLoaded(true);
      // A restored draft whose template was removed starts again from the library.
      if (!id && draft.selected && !data.templates.some(t => t.id === draft.selected)) { setSelected(''); setValues({}); setStep(0); }
    }).catch((e: Error) => { if (live) setError(e.message); });
    if (id) void templateRequest<ShownExecution>(`/template-executions/${id}`).then(e => { if (live) { loadExecution(e, requestedExecution ? undefined : draft.step); setLoadedRequest(requestedExecution); } })
      .catch((e: Error) => { if (live) { setError(e.message); setLoadedRequest(requestedExecution); } });
    return () => { live = false; };
  }, [requestedExecution, draft.executionId, draft.selected, draft.step, loadExecution]);
  useEffect(() => {
    writeWizardDraft(session(), { step, selected, creating, values, options: mainOptions, executionId: execution?.id, uploadName: file?.name ?? missingUpload });
  }, [step, selected, creating, values, mainOptions, execution?.id, file, missingUpload]);
  useEffect(() => () => { if (fileUrl) URL.revokeObjectURL(fileUrl); }, [fileUrl]);
  useEffect(() => () => { if (productReferenceUrl) URL.revokeObjectURL(productReferenceUrl); }, [productReferenceUrl]);
  useEffect(() => {
    let live = true;
    if (selected && versionNumber) void templateRequest<TemplateVersion>(`/templates/${selected}/versions/${versionNumber}`).then(v => { if (live) setVersion(v); }).catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [selected, versionNumber]);
  useEffect(() => {
    if (!execution?.id || !active) return;
    let live = true;
    const timer = window.setInterval(() => {
      void templateRequest<ShownExecution>(`/template-executions/${execution.id}`).then(e => {
        if (!live) return;
        const prior = previousRef.current;
        if (prior && e.state === 'failed' && inGenerationPhase(e)) {
          setPrevious(undefined); setExecution(prior); setReferenceExecution(prior.id);
          setError(`The new image could not be generated. ${e.error?.message ?? ''} Your previous image is kept.`);
          return;
        }
        if (e.state === 'generated') setPrevious(undefined);
        setExecution(e);
        if (isResting(e)) void refreshLibrary().catch((reason: Error) => setError(reason.message));
      }).catch((e: Error) => { if (live) setError(e.message); });
    }, 700);
    return () => { live = false; clearInterval(timer); };
  }, [execution?.id, active, setPrevious]);
  useEffect(() => {
    if (!execution?.runId) return;
    let live = true;
    const update = () => void Promise.all([experimentApi.get(execution.runId!), experimentApi.diagnostics(execution.runId!)]).then(([r, d]) => { if (live) { setRun(r); setDiagnostics(d); } }).catch(() => { /* The run dashboard remains available for diagnostics. */ });
    update(); const timer = active ? window.setInterval(update, 1500) : undefined;
    return () => { live = false; if (timer) clearInterval(timer); };
  }, [execution?.runId, execution?.state, active]);
  const act = async (work: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try { await work(); } catch (e) {
      if (e instanceof TemplateRequestError && e.code === 'TEMPLATE_MAY_NOT_FIT') setFitWarning(e.warnings.length ? e.warnings : [e.message]);
      else setError(e instanceof Error ? e.message : 'Request failed.');
    } finally { pending.current = false; setBusy(false); }
  };
  const clearResult = () => { setExecution(undefined); setPrevious(undefined); setFitWarning([]); setError(''); submission.current = undefined; };
  const chooseProductReference = (next?: File) => { setProductReference(next); setProductReferenceUrl(next ? URL.createObjectURL(next) : ''); };
  const choose = (id: string) => { clearResult(); setSelected(id); setCreating(!id); setValues({}); setMainOptions({}); chooseProductReference(undefined); setReferenceFile(undefined); setMissingUpload(''); setReferenceExecution(''); mismatchAccepted.current = false; };
  const reference = file ? fileUrl : referenceExecution ? imageUrl(referenceExecution) : version ? imageUrl(version.source.executionId) : '';
  const hasReference = !!file || !missingUpload && !!reference;
  const groups = version ? fieldGroups(version) : undefined, slots = groups ? Object.values(groups).flat() : [];
  // Only the loaded version's own fields are sent: a draft from an older version never blocks the form.
  const fields = Object.fromEntries(slots.filter(slot => values[slot.id]?.trim()).map(slot => [slot.id, values[slot.id]]));
  const hasChanges = hasContentChanges(fields);
  const mainSlot = groups?.product[0], supporting = slots.filter(s => s.role === 'supporting_product');
  const mainFilled = !!mainSlot && !!fields[mainSlot.id], options = mainProductOptions(mainOptions, mainFilled);
  const replacingMain = mainFilled && (options.mode ?? 'replace') === 'replace', sendReference = replacingMain && !!productReference;
  // The one compiler the server uses: the preview is the prompt that is sent.
  let compiled: CompiledTemplateEdit | undefined, previewError = '';
  if (version) try { compiled = compileTemplateEdit(version, fields, { ...(Object.keys(options).length ? { mainProduct: options } : {}), productReference: sendReference }); } catch (e) { previewError = (e as Error).message; }
  const preview = compiled?.text ?? '';
  /** Leads from a prompt part or a listed change to its field (opening Advanced elements when it is there). */
  const pickField = (slotId: string) => {
    if (groups?.advanced.some(s => s.id === slotId)) setAdvancedOpen(true);
    window.requestAnimationFrame(() => { const input = document.getElementById(fieldId(slotId)); input?.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' }); input?.focus({ preventScroll: true }); });
  };
  const setField = (slotId: string, value: string) => { setValues(v => ({ ...v, [slotId]: value })); clearResult(); };
  const field = (slot: TemplateSlot) => <label key={slot.id} className={`tw-field${linked === slot.id ? ' is-linked' : ''}`}>
    <span>{slot.label}{!slot.label.includes('·') && slot.zone && slot.zone !== 'full-canvas' && <small> · {ZONE_PHRASES[slot.zone].replace(/^(at|on|in) the /, '')}</small>}</span>
    <input id={fieldId(slot.id)} aria-label={`${slot.label} content`} aria-describedby={`${fieldId(slot.id)}-hint`} title={slot.hint} maxLength={FIELD_LIMIT} value={values[slot.id] ?? ''} placeholder={slot.placeholder} disabled={locked}
      onFocus={() => setLinked(slot.id)} onBlur={() => setLinked('')} onChange={e => setField(slot.id, e.target.value)} />
    <small id={`${fieldId(slot.id)}-hint`}>{slot.groupedWith ? `Stays grouped with the ${slot.groupedWith}. ` : ''}{slot.hint}</small>
  </label>;
  const upload = async () => {
    if (file) return file;
    if (!hasReference) throw new Error('Choose a reference image first.');
    const response = await fetch(reference);
    if (!response.ok) throw new Error('The saved reference is unavailable. Upload a reference image to continue.');
    const blob = await response.blob(), ext = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png';
    return new File([blob], `reference.${ext}`, { type: blob.type });
  };
  const start = (intent: 'generate' | 'decompose' | 'fresh', allowMismatch = mismatchAccepted.current) => {
    warningIntent.current = intent;
    const mode: ExecutionMode = creating || intent === 'fresh' ? 'CREATE_TEMPLATE' : intent === 'generate' ? 'REUSE_TEMPLATE_WITH_EDIT' : 'REUSE_TEMPLATE_ORIGINAL';
    const replacing = intent === 'generate' && execution?.state === 'generated' ? execution : undefined;
    if (replacing) submission.current = undefined;
    void act(async () => {
      const body = new FormData(); submission.current ??= crypto.randomUUID();
      body.append('mode', mode); body.append('idempotencyKey', submission.current); body.append('image', await upload());
      if (mode !== 'CREATE_TEMPLATE') { body.append('templateId', selected); body.append('templateVersion', String(versionNumber)); }
      if (mode === 'REUSE_TEMPLATE_WITH_EDIT') {
        body.append('values', JSON.stringify(fields)); body.append('reviewBeforeDecompose', 'true');
        if (Object.keys(options).length) body.append('options', JSON.stringify({ mainProduct: options }));
        if (sendReference) body.append('productReference', productReference!);
      }
      if (intent === 'fresh') body.append('planFresh', 'true');
      if (allowMismatch) body.append('allowMismatch', 'true');
      const next = await templateRequest<ShownExecution>('/template-executions', { method: 'POST', body });
      if (allowMismatch) mismatchAccepted.current = true;
      setPrevious(replacing && next.id !== replacing.id ? replacing : undefined);
      setExecution(next); setCreating(next.mode === 'CREATE_TEMPLATE'); setReferenceExecution(next.id); setFitWarning([]); submission.current = undefined;
      setStep(intent === 'generate' ? 2 : 3);
    });
  };
  // Decomposition of a generated image carries the user's explicit decisions: that they looked, and which plan.
  const approve = (accepted: ShownExecution) => void act(async () => {
    const decision = { ...(acknowledged ? { acknowledgeReview: true } : {}), ...(planChoice ? { plan: planChoice } : {}) };
    setExecution(await templateRequest<ShownExecution>(`/template-executions/${accepted.id}/decompose`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(decision) })); setStep(3);
  });
  /** One explicit new extraction of the saved image after a failed one; nothing is regenerated. */
  const retryExtraction = (id: string, plan: ExtractionPlan) => void act(async () => {
    setExecution(await templateRequest<ShownExecution>(`/template-executions/${id}/retry-extraction`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }) }));
  });
  const detect = () => {
    if (!window.confirm('Run the optional automatic-layout experiment? This may make a paid structure-analysis request.')) return;
    void act(async () => { const body = new FormData(); body.append('image', await upload()); body.append('idempotencyKey', crypto.randomUUID());
      const next = await templateRequest<ShownExecution>('/template-executions/inspect', { method: 'POST', body }); setExecution(next); setReferenceExecution(next.id); setStep(3); });
  };
  const backToLibrary = (templateId: string) => void act(async () => { await refreshLibrary(); choose(templateId); setStep(0); });
  const currentRun = run?.id === execution?.runId ? run : undefined, currentDiagnostics = diagnostics?.runId === execution?.runId ? diagnostics : undefined;
  const ready = execution?.state === 'done';
  // The image the user reviews: this execution's, or the one a running regeneration may replace.
  const candidate = execution?.edit?.image ? execution : previous, regenerating = !!previous && active;
  const primary = wizardPrimary({ step, creating, templateReady: !!version, hasReference, hasChanges, promptError: !!previewError, busy: busy || switching, execution, reviewAcknowledged: acknowledged, planChosen: !!planChoice });
  // The image waiting for approval (a running regeneration is not reviewable yet), with what its local review found.
  const reviewing = execution?.state === 'generated' && execution.edit?.image ? execution : undefined, review = reviewing?.edit?.review;
  const warnings = review?.checks.filter(c => c.severity === 'warning') ?? [], hints = review?.checks.filter(c => c.severity === 'info') ?? [];
  const recovering = extractionRecovery(execution) ? execution : undefined, rejectedRun = recovering && currentRun?.error?.code === 'PROVIDER_DECOMPOSITION_REJECTED' ? currentRun : undefined;
  // A layer the plan asked for that the editor did not get: a quality issue, shown as one, never as a plain note.
  const layerIssues = execution?.warnings.filter(w => /^(PLANNED_LAYER_|TEMPLATE_PLAN_INCOMPLETE|TEMPLATE_LAYERS_MISSING)/.test(w)) ?? [];
  const extracted = execution?.edit?.image ?? execution?.upload, estimate = extractionEstimate(version?.structure.layers.filter(l => l.independent).length ?? slots.length, extracted?.width, extracted?.height);
  const stepTitle = ['Choose a template', creating ? 'Add your reference creative' : 'Make it your own', creating ? 'Confirm your reference' : 'Review your creative', ready ? execution.mode === 'CREATE_TEMPLATE' ? 'Your template is ready' : 'Your creative is ready' : 'Turn your creative into layers'][step];
  const templateName = execution?.template?.name ?? chosen?.name ?? 'Saved template', templateVersion = execution?.template?.version ?? versionNumber ?? 1;
  const progress = decompositionProgress(execution, currentRun, execution?.mode === 'CREATE_TEMPLATE');
  const footerNext = () => {
    if (primary.action === 'next') setStep(s => Math.min(3, s + 1) as WizardStep);
    else if (primary.action === 'show-result') setStep(3);
    else if (primary.action === 'approve-generated' && execution) approve(execution);
    else if (primary.action === 'decompose-original' || primary.action === 'create-template') start('decompose');
    else if (primary.action === 'open-editor' && execution) void act(() => onOpen(execution));
  };
  return <section className="tw-workspace" aria-label="Creative template wizard">
    <nav className="tw-steps" aria-label="Creation steps"><ol>{WIZARD_STEPS.map((label, index) => <li key={label} aria-current={step === index ? 'step' : undefined} className={step === index ? 'is-current' : index < step ? 'is-complete' : ''}><span>{index < step ? <Check size={13} /> : index + 1}</span>{label}</li>)}</ol></nav>
    <div className="tw-content" key={step}>
      <header className="tw-heading"><div><p className="ff-lab-kicker">STEP {step + 1} OF 4</p><h2>{stepTitle}</h2><p>{step === 0 ? 'Pick a saved composition. Change the content, keep the layout.' : creating ? 'One planner call learns a reusable template from your image.' : `${templateName} · v${templateVersion}`}</p></div>
        {step === 0 && <button className="ws-btn ws-btn-primary" disabled={locked} onClick={() => { choose(''); setStep(1); }}><Plus size={16} /> Create New Template</button>}
      </header>
      {error && <p role="alert" className="tw-alert">{error}</p>}
      {fitWarning.length > 0 && <div role="alert" className="tw-alert"><strong>Selected template may not fit this image.</strong>{fitWarning.map(w => <p key={w}>{readable(w)}</p>)}<p>Your template has not changed. No planner or structure analysis was started.</p><div className="tw-actions"><button className="ws-btn" onClick={() => start(warningIntent.current, true)} disabled={locked}>Continue with selected template</button><button className="ws-btn" onClick={() => { setFitWarning([]); setStep(0); }}>Choose another template</button><button className="ws-btn" onClick={() => { clearResult(); setCreating(true); setStep(1); }}>Create New Template</button></div></div>}

      {step === 0 && libraryNote && <p role="status" className="tw-saved">{libraryNote}</p>}
      {step === 0 && detailsOf && <TemplateDetails id={detailsOf} request={templateRequest} onBack={() => setDetailsOf(undefined)} onChanged={() => void refreshLibrary().catch((e: Error) => setError(e.message))}
        onDeleted={id => { setDetailsOf(undefined); if (selected === id) { clearResult(); setSelected(''); setValues({}); } setLibraryNote('Template deleted. Its saved runs stay in Saved Runs.'); void refreshLibrary().catch((e: Error) => setError(e.message)); }}
        onReplanned={e => { setDetailsOf(undefined); setLibraryNote(''); loadExecution(e); }} />}
      {step === 0 && !detailsOf && <div className="tw-library" role="region" aria-label="Template library">{!libraryLoaded ? <p role="status">Loading templates…</p> : !templates.length ? <div className="tw-empty"><Layers size={36} /><h3>Your library starts here</h3><p>Create a template from a reference image. It appears here, ready to reuse with planning ₹0.</p><button className="ws-btn ws-btn-primary" disabled={locked} onClick={() => { choose(''); setStep(1); }}><Plus size={16} /> Create New Template</button></div> : templates.map(t => {
        const isSelected = selected === t.id && !creating, badges = templateSlotBadges(t);
        return <article key={t.id} className={`tw-template${isSelected ? ' is-selected' : ''}`} aria-label={`${t.name} v${t.currentVersion}`}>
          <div className="tw-template-image">{t.thumbnail ? <img src={`${BASE}/templates/${t.id}/thumbnail`} alt={`${t.name} template preview`} /> : <Layers size={40} />}<span className="tw-badge">Reusable · Planner ₹0</span>{isSelected && <span className="tw-selected-mark" aria-hidden="true"><Check size={14} /></span>}</div>
          <div className="tw-template-info"><h3>{t.name} <small>v{t.currentVersion}</small></h3><p>{t.description}</p>
            <div className="tw-slots" aria-label="Editable content">{badges.shown.map(label => <span key={label}>{label}</span>)}{badges.more > 0 && <span>+{badges.more} more</span>}</div>
            <p className="tw-template-meta">{t.stats.reuses ? `Reused ${plural(t.stats.reuses, 'time')}` : 'Not reused yet'}</p>
            <div className="tw-card-actions"><button className={`ws-btn${isSelected ? ' ws-btn-primary' : ''}`} aria-label={`Select ${t.name} v${t.currentVersion}`} aria-pressed={isSelected} disabled={locked} onClick={() => choose(t.id)}>{isSelected ? <><Check size={15} /> Selected</> : 'Select template'}</button>
              <button className="ws-btn ws-btn-quiet" aria-label={`Details of ${t.name} v${t.currentVersion}`} disabled={locked} onClick={() => { setLibraryNote(''); setDetailsOf(t.id); }}>Details</button></div></div>
        </article>;
      })}</div>}

      {step === 1 && <div className="tw-customize"><section className="tw-pane" aria-label={creating ? 'Reference creative' : 'Template content'}>
        <div className="tw-reference"><div className="tw-reference-image">{hasReference && reference ? <img src={reference} alt="Reference creative" /> : <ImagePlus size={28} />}</div>
          <div className="tw-reference-info"><strong>{file?.name ?? (creating ? 'Upload a creative' : 'Template reference')}</strong><span>{creating ? 'PNG, JPG or WebP. Its composition becomes your reusable template.' : 'New creatives start from this image. Upload another with the same layout if you prefer.'}</span>
            <label className="ws-btn tw-upload"><ImagePlus size={15} /> {hasReference ? 'Replace image' : 'Upload image'}<input className="tw-file" aria-label="Creative image" type="file" accept="image/png,image/jpeg,image/webp" disabled={locked} onChange={e => { setReferenceFile(e.target.files?.[0]); setMissingUpload(''); setReferenceExecution(''); clearResult(); mismatchAccepted.current = false; }} /></label></div></div>
        {missingUpload && <p role="alert" className="tw-alert">Reselect {missingUpload} to continue. The browser cannot keep image files across a refresh; your other choices are saved.</p>}
        {!creating && version && groups ? <><h3>Customize content</h3><p className="tw-muted">Empty fields keep the reference content. Layout, positions and layer grouping stay the same.</p>
          {mainSlot && <fieldset className={`tw-group tw-main${linked === mainSlot.id ? ' is-linked' : ''}`}><legend>Main product</legend>
            <div className="tw-modes" role="radiogroup" aria-label="How the main product changes">{(['replace', 'details'] as const).map(mode => <label key={mode} className={(mainOptions.mode ?? 'replace') === mode ? 'is-on' : ''}>
              <input type="radio" name="tw-main-mode" value={mode} checked={(mainOptions.mode ?? 'replace') === mode} disabled={locked} onChange={() => { setMainOptions(o => ({ ...o, mode })); clearResult(); }} />{mode === 'replace' ? 'Replace product' : 'Change details'}</label>)}</div>
            <label className={`tw-field${linked === mainSlot.id ? ' is-linked' : ''}`}><span>{(mainOptions.mode ?? 'replace') === 'replace' ? 'New product' : 'Product details'}</span>
              <input id={fieldId(mainSlot.id)} aria-label="Main product content" aria-describedby={`${fieldId(mainSlot.id)}-hint`} maxLength={FIELD_LIMIT} value={values[mainSlot.id] ?? ''} disabled={locked}
                placeholder={(mainOptions.mode ?? 'replace') === 'replace' ? 'e.g. Bluetooth speaker' : 'e.g. matte black finish'} onFocus={() => setLinked(mainSlot.id)} onBlur={() => setLinked('')} onChange={e => setField(mainSlot.id, e.target.value)} />
              <small id={`${fieldId(mainSlot.id)}-hint`}>{(mainOptions.mode ?? 'replace') === 'replace' ? 'A different product, in the same place: its shape may change. Leave empty to keep the original.' : 'The same product, changed: color, finish or material. Its shape stays.'}</small></label>
            {(mainOptions.mode ?? 'replace') === 'replace' && <div className="tw-main-extra">
              <label className="tw-field"><span>Brand <small>optional</small></span><input aria-label="Brand (optional)" maxLength={BRAND_LIMIT} value={mainOptions.brand ?? ''} placeholder="e.g. boAt" disabled={locked || !mainFilled} title="Shown only as the product would plainly carry it. No logo is invented." onChange={e => { setMainOptions(o => ({ ...o, brand: e.target.value })); clearResult(); }} /></label>
              <div className="tw-field"><span>Product photo <small>optional</small></span>
                <label className="ws-btn tw-upload"><ImagePlus size={15} /> {productReference ? 'Replace photo' : 'Add product photo'}<input className="tw-file" aria-label="Product reference image" type="file" accept="image/png,image/jpeg,image/webp" disabled={locked || !mainFilled} onChange={e => { chooseProductReference(e.target.files?.[0]); clearResult(); }} /></label>
                {productReference && <span className="tw-reference-chip">{productReferenceUrl && <img src={productReferenceUrl} alt="" />}{productReference.name}<button type="button" className="ws-btn ws-btn-quiet" disabled={locked} onClick={() => { chooseProductReference(undefined); clearResult(); }}>Remove</button></span>}
                <small>Sent as a second image so the new product matches it. Without one, nothing about the product is invented beyond your words.</small></div>
              {supporting.length > 0 && <label className="tw-check"><input type="checkbox" checked={!!mainOptions.keepSupporting} disabled={locked || !mainFilled} onChange={e => { setMainOptions(o => ({ ...o, keepSupporting: e.target.checked })); clearResult(); }} />
                Keep the original supporting products ({supporting.map(s => s.label.replace('Supporting product · ', '')).join(', ')})<small>Otherwise they are removed with the original product, unless you describe their replacement under Advanced elements.</small></label>}
            </div>}
          </fieldset>}
          {groups.style.length > 0 && <fieldset className="tw-group"><legend>Background &amp; style</legend><div className="tw-fields">{groups.style.map(field)}</div></fieldset>}
          {groups.subject.length > 0 && <fieldset className="tw-group"><legend>People &amp; held objects</legend><div className="tw-fields">{groups.subject.map(field)}</div></fieldset>}
          {groups.text.length > 0 && <fieldset className="tw-group"><legend>Offer text</legend><p className="tw-muted">Used exactly as typed. No price, discount or claim is added that you did not write.</p><div className="tw-fields">{groups.text.map(field)}</div></fieldset>}
          {groups.advanced.length > 0 && <details className="tw-group tw-more" open={advancedOpen || groups.advanced.some(s => !!values[s.id]?.trim())} onToggle={e => setAdvancedOpen((e.target as HTMLDetailsElement).open)}>
            <summary>Advanced elements ({groups.advanced.length})</summary><div className="tw-fields">{groups.advanced.map(field)}</div></details>}
          {!slots.length && <p className="tw-muted">This template has no editable content fields. Use the original image or generate a fresh version.</p>}</>
          : !creating ? <p role="status">Loading template…</p>
          : <div className="tw-note"><h3>One image, a reusable starting point</h3><p>We learn its composition, save its content fields and base prompt, and prepare editable layers. The new template appears in your library.</p><span className="tw-badge">1 planner call · no image generation</span></div>}
      </section><aside className="tw-pane tw-prompt-pane" aria-label="Generation prompts">{!creating && version ? <>
        <section className="tw-changes" aria-label="What will change"><h3>What will change</h3>
          {compiled?.changes.length ? <ul>{compiled.changes.map(c => <li key={c.slotId}><button type="button" className={`tw-change${linked === c.slotId ? ' is-linked' : ''}`} onClick={() => pickField(c.slotId)} onMouseEnter={() => setLinked(c.slotId)} onMouseLeave={() => setLinked('')}>
            <b className={`tw-op tw-op-${c.operation}`}>{OPERATION[c.operation]}</b> {c.label}{c.value ? <>: <q>{c.value}</q></> : c.operation === 'remove' ? ' (part of the original product set)' : ''}</button></li>)}</ul>
            : <p className="tw-muted">Nothing yet. Generating with no changes recreates the reference as it is.</p>}
          {compiled?.compatibility.status === 'structural-change' && <p className="tw-note-warn" role="note">This changes the objects your saved decomposition plan was learned from. After you review the image, you choose: the saved plan (₹0), a simpler grouping (₹0), or a refreshed plan (one planner call, about ₹{estimate.plannerInr.toFixed(2)}).</p>}
          {previewError && <p className="tw-alert" role="alert">{previewError}</p>}
        </section>
        <details className="tw-prompt" open><summary>Base template prompt</summary>
          <p className="tw-legend"><span className="tw-slot-chip is-sample">{'{Field}'}</span> comes from your fields · <Lock size={11} aria-hidden="true" /> the rest are locked layout rules</p>
          <SlotPrompt label="Base template prompt" segments={baseTemplatePrompt(version)} linked={linked} onLink={setLinked} onPick={pickField} /></details>
        <details className="tw-prompt"><summary>Final prompt · exactly what is sent</summary>
          {compiled && <SlotPrompt label="Final prompt with your changes" segments={compiled.segments} linked={linked} onLink={setLinked} onPick={pickField} sentences />}
          <textarea aria-label="Final prompt preview" readOnly value={preview || previewError} rows={6} spellCheck={false} /></details>
        <span className="tw-badge">Compiled locally · 0 LLM calls · ₹0</span></> : <div className="tw-empty"><Sparkles size={30} /><h3>Your prompt will be saved here</h3><p>The first planner call also learns your reusable prompt and fields. Future generations reuse them locally.</p></div>}
        <details className="tw-advanced"><summary>Advanced · planning experiments</summary><p>Optional and never automatic. Normal template reuse needs neither.</p><button className="ws-btn" disabled={locked || !hasReference} onClick={detect}>Detect reusable layout</button><button className="ws-btn" disabled={locked || !hasReference} onClick={() => { if (window.confirm('Plan fresh? This makes one paid planner call, plus extraction and cleanup.')) start('fresh'); }}>Plan fresh &amp; decompose</button></details>
      </aside></div>}

      {step === 2 && <div className="tw-generation"><div className={`tw-previews${creating ? ' is-single' : ''}`}><figure><figcaption>{creating ? 'Your reference creative' : 'Original / reference'}</figcaption>{reference && hasReference ? <img src={reference} alt="Original reference creative" /> : <div className="tw-empty"><ImagePlus size={30} /><p>Go back and choose an image.</p></div>}</figure>
        {!creating && <figure className={!candidate ? 'tw-generated-placeholder' : ''}><figcaption>Generated creative</figcaption>{candidate ? <div className="tw-candidate"><img src={imageUrl(candidate.id, 'edited')} alt="Generated creative" />{regenerating && <div className="tw-candidate-overlay" role="status"><LoaderCircle size={18} className="ws-spin" aria-hidden="true" />Generating a new version…</div>}</div> : <div className="tw-empty"><Sparkles size={34} /><h3>{active ? 'Creating your image…' : 'Ready to generate'}</h3><p>{active ? 'One image request is in progress. Decomposition waits for your approval.' : 'Your saved prompt and content changes become a new image.'}</p></div>}</figure>}</div>
        <div className="tw-generation-bar"><div><strong>{creating ? 'New template' : `Template · ${templateName} v${templateVersion}`}</strong>{creating ? <><p>Decomposition planner: <b>1 call</b> · learns the reusable template</p><p>Image generation: <b>0 calls</b> · uses your upload</p></> : <><p>Prompt planning: <b>0 calls · ₹0</b></p><p>Image generation: <b>{plural(candidate?.usage.imageGenerationCalls ?? 0, 'call')}</b>{candidate?.usage.imageGenerationCalls ? ` · ${money(candidate.generationCost)}` : ' · no charge yet'}</p><small>Saved template + local edits</small></>}</div>
          {!creating && <div className="tw-actions"><button className="ws-btn ws-btn-primary" disabled={locked || !!previewError || !hasReference || !version} onClick={() => start('generate')}>{active ? <LoaderCircle size={16} className="ws-spin" aria-hidden="true" /> : <Sparkles size={16} />}{candidate ? 'Regenerate' : 'Generate Creative'}</button><button className="ws-btn" disabled={locked} onClick={() => setStep(1)}>Edit changes</button></div>}</div>
        {!creating && <p className="tw-muted" role="note">{candidate ? 'Regenerate makes one more paid image request. Decomposition starts only when you choose Use this image.' : hasChanges ? 'Your changes need a generated image before decomposition. Choose Generate Creative.' : 'No changes: use the original image for no generation charge, or Generate Creative for one paid image request.'}</p>}
        {reviewing && (review || needsPlanDecision(reviewing)) && <div className="tw-decisions">
          {review && <section className={`tw-review${warnings.length ? ' has-warnings' : ''}`} aria-label="Image review"><h3>{warnings.length ? 'Check the generated image' : 'Review the generated image'}</h3>
            {warnings.length > 0 && <ul role="alert">{warnings.map(c => <li key={`${c.id}-${c.slotId ?? ''}`}>{c.message}</li>)}</ul>}
            {hints.map(c => <p className="tw-muted" key={`${c.id}-${c.slotId ?? ''}`}>{c.message}</p>)}
            <p className="tw-muted">{review.note}</p>
            {needsReviewAcknowledgement(reviewing) && <label className="tw-check"><input type="checkbox" checked={acknowledged} disabled={locked} onChange={e => setAcknowledged(e.target.checked)} />
              {warnings.length ? 'Use anyway: I checked the image and the requested changes are there' : 'I checked the image: the requested changes are there'}</label>}
            {warnings.length > 0 && <div className="tw-actions"><button className="ws-btn" disabled={locked} onClick={() => setStep(1)}>Edit the request or add a product photo</button></div>}
          </section>}
          {needsPlanDecision(reviewing) && <fieldset className="tw-plan" aria-label="How to extract layers"><legend>How should layers be extracted?</legend>
            <p className="tw-muted">{reviewing.compatibility!.reasons.join(' ')} Each choice is one Seedream extraction (about ₹{estimate.seedreamInr.toFixed(2)}, billed by the layers returned).</p>
            {PLAN_CHOICES.map(choice => <label key={choice.plan} className={planChoice === choice.plan ? 'is-on' : ''}><input type="radio" name="tw-plan" value={choice.plan} checked={planChoice === choice.plan} disabled={locked} onChange={() => setPlanChoice(choice.plan)} />
              <span><strong>{choice.title}</strong><small>{choice.detail(estimate)}</small></span></label>)}
          </fieldset>}
        </div>}
        {execution?.error && inGenerationPhase(execution) && <p role="alert" className="tw-alert">{execution.error.message}</p>}
      </div>}

      {step === 3 && <div className="tw-decompose"><figure className="tw-result-image"><figcaption>{execution?.edit?.image ? 'Generated creative' : 'Your creative'}</figcaption>{(execution?.edit?.image || reference) && <img src={execution?.edit?.image ? imageUrl(execution.id, 'edited') : reference} alt="Creative to decompose" />}</figure>
        <section className="tw-pane" aria-label="Decomposition progress"><h3>{ready ? execution.mode === 'CREATE_TEMPLATE' ? 'Template saved to your library' : 'Editor-ready layers' : execution?.state === 'failed' ? 'Decomposition stopped' : 'A few steps to editable layers'}</h3>
          {recovering && <section className="tw-recovery" aria-label="Extraction recovery">
            <p className="tw-alert" role="alert"><strong>Layer extraction failed. Your generated creative is kept.</strong> {rejectedRun ? `fal rejected the extraction request (HTTP ${rejectedRun.error?.provider?.status ?? 422}).` : 'The extraction did not finish.'} Image generation succeeded and is not repeated. Nothing was retried automatically.</p>
            {rejectedRun && <p className="tw-muted">Resume would return the same stored answer. fal request <code>{rejectedRun.error?.provider?.requestId ?? rejectedRun.seedream.requestId}</code>{rejectedRun.error?.provider?.billableUnits === '0' ? ' · billed 0 units' : ''}</p>}
            <div className="tw-actions">
              <button className="ws-btn ws-btn-primary" disabled={locked} onClick={() => retryExtraction(recovering.id, 'simple')}>Retry with simpler grouping · 1 Seedream request</button>
              <button className="ws-btn" disabled={locked} onClick={() => retryExtraction(recovering.id, recovering.planDecision?.choice ?? 'saved')}>Retry with the same plan · 1 Seedream request</button>
              <button className="ws-btn" disabled={locked} onClick={() => retryExtraction(recovering.id, 'refresh')}>Refresh plan and retry · 1 planner + 1 Seedream request</button>
            </div>
            <p className="tw-muted">Estimates: Seedream about ₹{estimate.seedreamInr.toFixed(2)} per extraction (billed by the layers returned); a planner call about ₹{estimate.plannerInr.toFixed(2)}. A simpler grouping sends a different, shorter layer request.</p>
            <details><summary>Provider details</summary><p className="tw-muted">{execution!.error!.message}</p></details>
          </section>}
          <ol className="tw-progress">{progress.map(({ label, complete }, index) => <li key={label} className={complete ? 'is-complete' : ''}><span>{complete ? <Check size={15} /> : index + 1}</span>{label}{active && !complete && (index === 0 || progress[index - 1].complete) && <small>In progress…</small>}</li>)}</ol>
          <dl className="tw-cost-summary" aria-label="Cost summary">{costRows(execution, currentDiagnostics, execution ? execution.mode === 'CREATE_TEMPLATE' : creating).map(row => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>
          {!execution?.runId && !execution?.inspection && <p className="tw-muted">{creating ? 'One planner call learns this template. ' : 'Your saved decomposition plan is reused. '}Extraction and any needed cleanup have their own provider charges.</p>}
          {!recovering && execution?.error && <p className="tw-alert" role="alert">{execution.error.message}</p>}
          {!!execution?.extractionAttempts?.length && <details className="tw-attempts"><summary>Earlier extraction attempts ({execution.extractionAttempts.length})</summary><ul>{execution.extractionAttempts.map(a => <li key={a.runId}>{new Date(a.at).toLocaleString()} · plan: {a.plan} · {a.error?.code ?? 'failed'} · <button type="button" className="ws-btn ws-btn-quiet" onClick={() => onRun(a.runId)}>Run details</button></li>)}</ul></details>}
          {!!layerIssues.length && <div className="tw-note-warn" role="note" aria-label="Layer quality"><strong>Not every planned layer came back as its own layer.</strong>{layerIssues.map(w => <p key={w}>{readable(w)}</p>)}
            {execution?.template && execution.mode !== 'CREATE_TEMPLATE' && <button className="ws-btn" disabled={locked} onClick={() => { setStep(0); setDetailsOf(execution.template!.id); }}>Review the template's plan</button>}</div>}
          {execution?.warnings.filter(w => !layerIssues.includes(w)).map(w => <p className="tw-muted" key={w}>{readable(w)}</p>)}
          <div className="tw-actions">
            {ready && execution.mode === 'CREATE_TEMPLATE' && execution.template && <button className="ws-btn" disabled={locked} onClick={() => backToLibrary(execution.template!.id)}>Back to template library</button>}
            {execution?.decomposition?.resumable && <button className="ws-btn" disabled={locked} onClick={() => void act(async () => setExecution(await templateRequest(`/template-executions/${execution.id}/resume`, { method: 'POST' })))}>Resume saved result</button>}
            {execution?.runId && <button className="ws-btn ws-btn-quiet" onClick={() => onRun(execution.runId!)}>Run details</button>}
          </div>
          {ready && execution.runId && <LayerPreview key={execution.runId} runId={execution.runId} />}
          {execution?.inspection && <details className="tw-advanced"><summary>Advanced detection result</summary><p>{execution.inspection.reason}</p>{execution.state === 'ready' && <button className="ws-btn" disabled={locked} onClick={() => { if (window.confirm('Start the detected plan? It may require a planner call, plus extraction.')) void act(async () => setExecution(await templateRequest(`/template-executions/${execution.id}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }))); }}>Start detected plan</button>}</details>}
        </section></div>}
    </div>
    <footer className="tw-footer"><button className="ws-btn" disabled={locked || step === 0} onClick={() => setStep(s => Math.max(0, s - 1) as WizardStep)}><ArrowLeft size={15} /> Back</button><span>{step === 0 ? 'Your saved compositions' : creating ? 'Create once. Reuse whenever you need.' : 'Saved prompt + saved layout · planning ₹0'}</span><button className="ws-btn ws-btn-primary" disabled={primary.disabled} onClick={footerNext}>{locked ? active ? 'Working…' : 'Please wait…' : primary.label}<ArrowRight size={15} /></button></footer>
  </section>;
}

const SESSION_STATUS: Partial<Record<ShownExecution['state'], string>> = { generated: 'Waiting for your review', done: 'Layers ready', failed: 'Stopped', ready: 'Detection ready' };
/** Execution history lives in Saved Runs, including generated images awaiting approval. */
export function SavedTemplateExecutions({ onSelect }: { onSelect: (id: string) => void }) {
  const [history, setHistory] = useState<ShownExecution[]>([]), [loaded, setLoaded] = useState(false), [error, setError] = useState('');
  useEffect(() => { let live = true; void templateRequest<{ executions: ShownExecution[] }>('/template-executions').then(data => { if (live) { setHistory(data.executions); setLoaded(true); } }).catch((e: Error) => { if (live) { setError(e.message); setLoaded(true); } }); return () => { live = false; }; }, []);
  return <section aria-label="Saved template executions"><h3>Creative sessions</h3><p className="tw-muted">Continue a generated creative or reopen its layers.</p>{error && <p role="alert">{error}</p>}<div className="tw-history">{history.map(e => <button className="tw-history-card" key={e.id} onClick={() => onSelect(e.id)}><img src={imageUrl(e.id, e.edit?.image ? 'edited' : 'upload')} alt="" loading="lazy" /><span><strong>{e.template ? `${e.template.name} v${e.template.version}` : 'New template'}</strong><small>{SESSION_STATUS[e.state] ?? 'In progress'} · {new Date(e.createdAt).toLocaleString()}</small></span><ArrowRight size={16} /></button>)}</div>{loaded && !history.length && !error && <p className="tw-muted">No creative sessions yet.</p>}</section>;
}
