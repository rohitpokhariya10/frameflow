import { useEffect, useRef, useState } from 'react';
import { X, FlaskConical, ImagePlus, Upload, ArrowRight, Layers3, FolderOpen } from 'lucide-react';
import { GENERATION_PROFILES, GENERATION_TEMPLATE_KEYS, type GenerationTemplateKey, type RunDiagnostics } from '@frameflow/shared';
import { useAppDispatch, useAppSelector } from '../../store';
import { assets } from '../../lib/assets/runtimeAssets';
import { isDesignVariant } from '../../lib/persistence/schema';
import { decomposedDesignImported } from '../../store/editorSlice';
import { variantSelected } from '../../store/uiSlice';
import { BACKGROUND_STATUS_LABELS, experimentApi, experimentFileUrl, experimentToVariant, experimentZipUrl, groupingOf, ownsOptions, parseTargetLayers, refinementSummary, runPrompt, suggestedLayers, targetLayerRange, templateOptionValues, type ExperimentLayer, type ExperimentRun, type PlannedLayer, type PromptMode, type TemplateEntry } from './layerizeExperiment';
import './workspace/workspace.css';
import { RunDashboard } from './RunDashboard';
import { TemplateGenerator } from './TemplateGenerator';
import { ExperimentTabs, SavedRunBrowser, type ExperimentTab } from './ExperimentNavigation';
import './experimentLab.css';

const ACTIVE = ['uploaded', 'planning', 'planned', 'uploading', 'submitting', 'queued', 'in_progress', 'downloading', 'refining'];
const box: React.CSSProperties = { padding: 16, borderTop: '1px solid var(--color-line)' };
const thumb: React.CSSProperties = { width: '100%', height: 150, objectFit: 'contain', background: 'repeating-conic-gradient(#e6e4de 0 25%, #fff 0 50%) 0 0/16px 16px' };
const pre: React.CSSProperties = { whiteSpace: 'pre-wrap', background: '#fff', padding: 10, borderRadius: 8, margin: '6px 0' };
const badge = (color: string): React.CSSProperties => ({ display: 'inline-block', padding: '3px 8px', borderRadius: 6, background: color, color: '#fff', fontWeight: 600 });
const GENERATED = '#2f6fb3', TEMPLATE = '#7a3fb0';
const when = (iso: string) => new Date(iso).toLocaleString();
/** The run sent Seedream no prompt: Template B's automatic mode, or an older explicit empty-prompt retry. */
const isAutomatic = (run: ExperimentRun) => run.promptSource?.mode === 'automatic' || (run.promptSource?.mode === 'retry' && run.promptSource.providerPrompt === 'auto');
const runTemplateKey = (run: ExperimentRun) => run.templateKey ?? run.layerTarget?.templateKey ?? (run.promptSource?.mode === 'template' ? run.promptSource.templateKey : undefined) ?? 'template-a';
const heldObjectLabel = (run: ExperimentRun) => run.separateHeldObject === false ? (runTemplateKey(run) === 'template-a' ? 'Combined with subject' : 'Combined with main product') : 'Separate';
/** The template whose test generator made a run's image ("template-b-generation" → "Template B"). */
const originTemplateName = (kind: string) => GENERATION_PROFILES[kind.replace(/-generation$/, '') as GenerationTemplateKey]?.name ?? kind;
/** A run's own template options (Template B), or undefined for runs that use the held-object checkbox (Template A, older Template B runs). */
const optionsLabel = (run: ExperimentRun, template?: TemplateEntry) => run.templateOptions && template?.options
  ? template.options.map(o => `${o.label}: ${run.templateOptions![o.key] ? 'on' : 'off'}`).join(' · ') : undefined;

function LayerTile({ l, f }: { l: ExperimentLayer; f: (file: string) => string }) {
  return <figure style={{ margin: 0 }}>
    <a href={f(l.file)} target="_blank" rel="noreferrer"><img src={f(l.file)} alt={l.name ?? l.file} style={thumb} /></a>
    <figcaption><strong>z{l.zIndex} {l.name ?? (l.placement.kind === 'base' ? 'base' : l.file)}</strong><br />{l.placement.kind} · {l.pixelWidth}×{l.pixelHeight} · {l.opaquePercent}% opaque
      {l.sources && l.sources.length > 1 && <div>Merged from {l.sources.join(' + ')}</div>}
      {l.provenance && <div>Pass {l.provenance.sourcePass}{l.provenance.sourcePass ? ` (from ${l.provenance.sourceImage})` : ''} · {l.provenance.role}{l.provenance.groupedFrom ? ` · grouped from ${l.provenance.groupedFrom.length} fragments` : ''}</div>}
      {l.grouping && <div>Kept together{l.grouping.protectedInteraction ? ' (hand holding object)' : ''}: {l.grouping.members.map(m => `${m.name ?? m.file} — ${m.role.replace(/_/g, ' ')}`).join('; ')}</div>}
      {l.cleanBackground && <div>Background: <strong>{BACKGROUND_STATUS_LABELS[l.cleanBackground.status]}</strong>{l.rawFile && <> · <a href={f(l.rawFile)} target="_blank" rel="noreferrer">raw Seedream base</a></>}</div>}
      {l.placement.reason && <div style={{ color: '#8a5a00' }}>{l.placement.reason}</div>}
      {l.rebuilt && !l.cleanBackground && <div>Rebuilt locally as a full-canvas background from {l.rebuilt.from.join(' + ')} ({l.rebuilt.holePercent}% filled{l.rebuilt.contaminationPercent ? `, incl. ${l.rebuilt.contaminationPercent}% leftover foreground` : ''}){l.rebuilt.residualPercent !== undefined && <> · residual {l.rebuilt.residualPercent}%</>}{l.rawFile && <> · <a href={f(l.rawFile)} target="_blank" rel="noreferrer">raw Seedream layer</a></>}</div>}</figcaption>
  </figure>;
}

function PlanDetails({ layers, warnings }: { layers: PlannedLayer[]; warnings: string[] }) {
  return <>
    <div>Planned layers: {layers.map(l => l.name).join(', ') || '—'}</div>
    {warnings.map(w => <div key={w} style={{ color: '#8a5a00' }}>Planner warning: {w}</div>)}
  </>;
}

/**
 * Local diagnostic dashboard for the existing OpenAI → Seedream experiment; controls keep their original behavior.
 * onCreateFromImage: when given, the panel offers "Create Template from Image" (its own dialog, features/imageTemplates).
 */
export function LayerizeExperimentPanel({ onClose, onCreateFromImage }: { onClose: () => void; onCreateFromImage?: () => void }) {
  const dispatch = useAppDispatch();
  const variantCount = useAppSelector((s) => s.editor.document.variants.length);
  const [tab, setTab] = useState<ExperimentTab>('overview');
  const [runsLoaded, setRunsLoaded] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const navigate = (next: ExperimentTab) => { setTab(next); bodyRef.current?.scrollTo({ top: 0 }); };
  const [file, setFile] = useState<File | null>(null);
  const [runs, setRuns] = useState<ExperimentRun[]>([]);
  const [run, setRun] = useState<ExperimentRun>();
  const [diagnosticState, setDiagnosticState] = useState<{ runId: string; updatedAt?: string; value?: RunDiagnostics; error?: string }>();
  useEffect(() => {
    if (!run) return;
    let cancelled = false;
    void experimentApi.diagnostics(run.id).then(value => {
      if (!cancelled) setDiagnosticState({ runId: run.id, updatedAt: run.updatedAt, value });
    }).catch((e: Error) => { if (!cancelled) setDiagnosticState({ runId: run.id, updatedAt: run.updatedAt, error: e.message }); });
    return () => { cancelled = true; };
  }, [run]);
  const [templates, setTemplates] = useState<TemplateEntry[]>([]);
  const [templateKey, setTemplateKey] = useState('template-a');
  const [mode, setMode] = useState<PromptMode>('generated');
  const [separateHeldObject, setSeparateHeldObject] = useState(true);
  // The recursive refinement: residual passes for objects left in the base, then one clean background (experiment).
  const [recursive, setRecursive] = useState(true);
  // Per template, the options the user changed (Template B); unchanged options take the template's default.
  const [optionChoices, setOptionChoices] = useState<Record<string, Record<string, boolean>>>({});
  const [targetText, setTargetText] = useState('');
  const [retargetText, setRetargetText] = useState('');
  const [notes, setNotes] = useState('');
  const [message, setMessage] = useState('');
  // The test generator of one template (admin harness), shown on demand.
  const [generatorKey, setGeneratorKey] = useState<GenerationTemplateKey>();
  // Whether the server checks the template before planning (off in the test harness: the selected template is trusted).
  const [fitCheck, setFitCheck] = useState(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void experimentApi.list().then(v => { if (!mounted.current) return; setRuns(v.runs); setRunsLoaded(true); if (v.runs[0]) setRun(v.runs[0]); }).catch((e: Error) => { if (mounted.current) { setMessage(e.message); setRunsLoaded(true); } });
    void experimentApi.templates().then(v => { if (!mounted.current) return; setTemplates(v.templates); setFitCheck(v.fitCheck === true); }).catch(() => undefined);
    return () => { mounted.current = false; };
  }, []);
  const polling = !!run && (run.active || ACTIVE.includes(run.stage));
  useEffect(() => {
    if (!run || !polling) return;
    const timer = window.setInterval(() => { void experimentApi.get(run.id).then(v => mounted.current && setRun(v)).catch(() => undefined); }, 2000);
    return () => window.clearInterval(timer);
  }, [run, polling]);
  const act = async (work: () => Promise<void>) => {
    setBusy(true); setMessage('');
    try { await work(); } catch (e) { if (mounted.current) setMessage(e instanceof Error ? e.message : 'That did not work.'); }
    finally { if (mounted.current) setBusy(false); }
  };
  const template = templates.find(t => t.key === templateKey);
  const saved = template?.saved;
  // Automatic templates send Seedream no prompt: no OpenAI call, nothing to save or reuse.
  const automaticTemplate = template?.providerPrompt === 'automatic';
  // Image-specific prompts (Template B) name one image's layers: always generated, never saved or reused.
  const imageSpecific = !!template?.imageSpecificPrompt;
  const reuse = mode === 'template' && !automaticTemplate && !imageSpecific;
  const templateOptions = templateOptionValues(template, optionChoices[templateKey]);
  const suggested = suggestedLayers(template, separateHeldObject), targetRange = targetLayerRange(template, separateHeldObject);
  // Empty means the suggested count; out-of-range values are blocked (never changed for the user).
  const target = parseTargetLayers(targetText, template, separateHeldObject);
  const start = () => file && act(async () => {
    if (target.error) throw new Error(target.error);
    const next = await experimentApi.start(file, reuse ? 'template' : 'generated', templateKey, separateHeldObject, target.targetLayers, templateOptions, false, recursive);
    setRun(next); setRuns(r => [next, ...r]); navigate('overview');
  });
  const resume = () => run && act(async () => { await experimentApi.resume(run.id); setRun(await experimentApi.get(run.id)); });
  // After the template fit check stopped a run: a NEW run of the same uploaded image, with the template that fits, or
  // with the same template anyway (no check). Explicit and confirmed: it makes OpenAI calls and one paid Seedream call.
  const rerun = (key: string, skipFitCheck: boolean) => run && window.confirm(`Start a NEW run of this image with ${templates.find(t => t.key === key)?.name ?? key}${skipFitCheck ? ', without the template fit check' : ''}? This makes OpenAI calls and one paid Seedream call.`) && act(async () => {
    const response = await fetch(experimentFileUrl(run.id, run.original.file));
    if (!response.ok) throw new Error('The original image could not be loaded.');
    const blob = await response.blob();
    const image = new File([blob], run.original.file, { type: blob.type || 'image/png' });
    const next = await experimentApi.start(image, 'generated', key, run.separateHeldObject !== false, undefined, templateOptionValues(templates.find(t => t.key === key), optionChoices[key]), skipFitCheck, !!run.refinement);
    setTemplateKey(key); setRun(next); setRuns(r => [next, ...r]); navigate('overview');
  });
  // Explicit, confirmed user action only: one new paid Seedream call. Nothing is ever retried automatically.
  const retry = (providerPrompt: 'current' | 'auto') => run && window.confirm(providerPrompt === 'auto'
    ? 'Retry as a NEW run with an EMPTY prompt (Seedream picks the major elements itself; roles are classified locally)? This is one new paid Seedream call (OpenAI is not called).'
    : 'Retry as a NEW run with the current provider prompt? This is one new paid Seedream call (OpenAI is not called again).') && act(async () => {
    const next = await experimentApi.retry(run.id, providerPrompt);
    setRun(next); setRuns(r => [next, ...r]); navigate('overview');
  });
  // Re-render a finished run at another exact count from its saved result: no OpenAI or Seedream call.
  const runTemplate = run && templates.find(t => t.key === runTemplateKey(run));
  const retarget = run && parseTargetLayers(retargetText, runTemplate, run.separateHeldObject !== false, runTemplate?.dynamicLayerCount ? run.layerCount?.suggestedLayers : undefined);
  const grouping = groupingOf(template), runGrouping = groupingOf(runTemplate);
  const rerenderAtTarget = () => run && retarget?.targetLayers !== undefined && act(async () => { await experimentApi.resume(run.id, undefined, retarget.targetLayers); setRun(await experimentApi.get(run.id)); });
  const saveAsTemplate = () => run && template && act(async () => {
    await experimentApi.saveTemplate(template.key, run.id, notes);
    setTemplates((await experimentApi.templates()).templates);
    setNotes('');
  });
  const open = () => run && act(async () => {
    const fetchFile = async (name: string) => { const r = await fetch(experimentFileUrl(run.id, name)); if (!r.ok) throw new Error(`Could not download ${name}.`); return r.blob(); };
    const next = await experimentToVariant(run, fetchFile, assets);
    if (!isDesignVariant(next) || variantCount >= 30) {
      await Promise.all((next.layers ?? []).map(l => l.type === 'image' && l.assetId ? assets.deleteAsset(l.assetId).catch(() => undefined) : undefined));
      throw new Error(variantCount >= 30 ? 'This design already has 30 versions. Delete one and try again.' : 'The layers could not be opened as a design version.');
    }
    dispatch(decomposedDesignImported({ variant: next, timestamp: new Date().toISOString() }));
    dispatch(variantSelected(next.id));
    onClose();
  });
  const f = (name: string) => run ? experimentFileUrl(run.id, name) : '';
  const prompt = run && runPrompt(run);
  const generated = run && run.promptSource?.mode !== 'template' && !!run.planner;

  const visibleRuns = run ? [run, ...runs.filter(item => item.id !== run.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : runs;
  const selectRun = (id: string) => void act(async () => { setRun(await experimentApi.get(id)); navigate('overview'); });

  return <div className="ws-backdrop"><div className="ws ff-lab" role="dialog" aria-modal="true" aria-labelledby="lx-title">
    <header className="ws-header ff-lab-header">
      <div className="ws-brand"><span className="ff-lab-brand"><FlaskConical size={21} aria-hidden="true" /></span><div><h2 id="lx-title">OpenAI + Seedream test</h2><p>Create images. Test editable layers. Review the result.</p></div></div>
      <button className="ws-icon-button" aria-label="Close" onClick={onClose}><X size={18} /></button>
    </header>
    <ExperimentTabs current={tab} onChange={navigate} runCount={visibleRuns.length} />
    <div className="ws-body ff-lab-body" ref={bodyRef}>
      {message && <p role="alert" className="ff-lab-alert">{message}</p>}
      <div role="tabpanel" id="lab-panel-create" aria-labelledby="lab-tab-create" hidden={tab !== 'create'} className="ff-lab-page">
        <div className="ff-lab-page-heading"><div><p className="ff-lab-kicker">START WITH A CREATIVE</p><h2>Create a template</h2><p>Use a reference image, or build a new creative from a template.</p></div></div>
        {onCreateFromImage && <section className="ff-lab-reference-card"><span className="ff-lab-feature-icon"><ImagePlus size={26} aria-hidden="true" /></span><div><h3>Start from a reference image</h3><p>Match a saved layout, edit its fields, and reuse its generation and decomposition plans.</p></div><button className="ws-btn ws-btn-primary" onClick={onCreateFromImage}>Create Template from Image <ArrowRight size={16} aria-hidden="true" /></button></section>}
        <div className="ff-lab-section-heading"><h3>Legacy starter layouts</h3><p>Existing A/B/C generators remain available for comparison; reusable families are the reference workflow.</p></div>
        <div className="ff-lab-template-grid">{GENERATION_TEMPLATE_KEYS.map(key => <button key={key} className={`ff-lab-template-card${generatorKey === key ? ' is-selected' : ''}`} aria-pressed={generatorKey === key} aria-label={`Create ${GENERATION_PROFILES[key].name}`} onClick={() => setGeneratorKey(key)}>
          <span className={`ff-lab-template-art ff-lab-art-${key}`} aria-hidden="true"><i /><i /><i /></span>
          <span><strong>{GENERATION_PROFILES[key].name}</strong><span>{key === 'template-a' ? 'Framed portraits' : key === 'template-b' ? 'Product creatives' : 'People & campaigns'}</span></span><ArrowRight size={17} aria-hidden="true" />
        </button>)}</div>
        {generatorKey && <TemplateGenerator key={generatorKey} templateKey={generatorKey} template={templates.find(t => t.key === generatorKey)} runActive={polling} fitCheck={fitCheck}
          onGenerated={() => setRun(undefined)}
          onRunStarted={next => { setTemplateKey(generatorKey); setRun(next); setRuns(r => [next, ...r]); navigate('overview'); }}
          onOpenRun={selectRun} />}
      </div>
      <div role="tabpanel" id="lab-panel-decompose" aria-labelledby="lab-tab-decompose" hidden={tab !== 'decompose'} className="ff-lab-page">
        <div className="ff-lab-page-heading"><div><p className="ff-lab-kicker">TEST AN EXISTING IMAGE</p><h2>Decompose into editable layers</h2><p>Choose an image and a layout. Review the result and costs in Overview.</p></div></div>
        <div className="ff-lab-setup-grid">
          <section className="ff-lab-card"><div className="ff-lab-card-title"><span>1</span><h3>Choose your image</h3></div>
            <label className={`ff-lab-upload${file ? ' has-file' : ''}`}><Upload size={28} aria-hidden="true" /><strong>{file ? file.name : 'Choose an image to test'}</strong><span>PNG, JPG or WebP</span><input type="file" accept="image/png,image/jpeg,image/webp" aria-label="Image to decompose" onChange={e => setFile(e.target.files?.[0] ?? null)} /></label>
            <p className="ff-lab-help">Use the complete creative. The original stays available for comparison.</p>
          </section>
          <section className="ff-lab-card"><div className="ff-lab-card-title"><span>2</span><h3>Choose a layout</h3></div>
            <label className="ff-lab-field">Template<select aria-label="Template" value={templateKey} onChange={e => setTemplateKey(e.target.value)}>
              {(templates.length ? templates : [{ key: 'template-a', name: 'Template A' }]).map(t => <option key={t.key} value={t.key}>{t.name}</option>)}
            </select></label>
            <p className="ff-lab-help">{template?.description ?? 'Choose the layout that best matches your image.'}</p>
            <div className="ff-lab-settings">{ownsOptions(template) ? template!.options!.map(o => <label key={o.key} className="ff-lab-check"><input type="checkbox" checked={templateOptions![o.key]} onChange={e => setOptionChoices(c => ({ ...c, [templateKey]: { ...c[templateKey], [o.key]: e.target.checked } }))} /><span><strong>{o.label}</strong><small>{o.help}</small></span></label>)
              : <label className="ff-lab-check"><input type="checkbox" checked={separateHeldObject} onChange={e => setSeparateHeldObject(e.target.checked)} /><span><strong>{grouping.label}</strong><small>{separateHeldObject ? grouping.checked : grouping.unchecked}</small></span></label>}</div>
          </section>
        </div>
        <section className="ff-lab-card">
          <div className="ff-lab-card-title"><span>3</span><h3>Review and run</h3></div>
          <div className="ff-lab-review-row"><div><strong>{automaticTemplate ? 'Automatic layer extraction' : reuse ? 'Use a saved layer plan' : 'Create a plan for this image'}</strong><p className="ff-lab-help">{automaticTemplate ? 'Seedream chooses the major elements. No planner call.' : reuse ? `Reuse the saved ${template?.name} prompt. No new planner call.` : 'OpenAI plans the layers, then Seedream extracts them.'}</p></div><span className="ff-lab-count">{suggested ? `${suggested} suggested layers` : 'Layer count follows the image'}</span></div>
          <details className="ff-lab-advanced"><summary>Advanced test settings</summary><div className="ff-lab-advanced-body">
            {!automaticTemplate && !imageSpecific && <fieldset className="ff-lab-fieldset"><legend>Layer planning</legend><label><input type="radio" name="lx-mode" checked={!reuse} onChange={() => setMode('generated')} /> Generate new prompt (OpenAI)</label><label><input type="radio" name="lx-mode" checked={reuse} disabled={!saved} onChange={() => setMode('template')} /> Reuse saved {template?.name ?? 'template'} prompt</label>{!saved && <small>Save a successful run’s prompt from its developer details to enable reuse.</small>}</fieldset>}
            <label className="ff-lab-field">Target layers<input type="number" min={targetRange?.min} max={targetRange?.max} step={1} value={targetText} placeholder={suggested !== undefined ? String(suggested) : 'Natural count'} onChange={e => setTargetText(e.target.value)} /><small>Leave empty for {template?.dynamicLayerCount ? 'the natural layer count' : 'the suggested count'}.{targetRange && ` Allowed: ${targetRange.min}–${targetRange.max}.`} Counts include the background; merging happens locally.</small></label>
            <label className="ff-lab-check"><input type="checkbox" checked={recursive} onChange={e => setRecursive(e.target.checked)} /><span><strong>Recursive cleanup + clean background (experiment)</strong><small>Look for missed objects and recover the background when needed. Up to 2 extra Seedream calls and 1 background image edit. Resume uses saved results.</small></span></label>
            {!automaticTemplate && !imageSpecific && saved && <details className="ff-lab-advanced"><summary>Saved {saved.templateName} prompt · {saved.prompt.length} characters</summary><div className="ff-lab-advanced-body"><p>{saved.plannerModel} · saved {when(saved.savedAt)} · source run {saved.sourceRunId}</p>{saved.notes && <p>{saved.notes}</p>}<pre style={pre}>{saved.prompt}</pre><PlanDetails layers={saved.planned_layers} warnings={saved.warnings} /></div></details>}
          </div></details>
          {target.error && <p role="alert" className="ff-lab-alert">{target.error}</p>}
          <div className="ff-lab-run-footer"><div><strong>{automaticTemplate || reuse ? fitCheck ? '1 OpenAI fit check + 1 Seedream call' : '1 paid Seedream call' : `${fitCheck ? 2 : 1} OpenAI + 1 paid Seedream call`}</strong><p className="ff-lab-help">{recursive ? 'Cleanup enabled: up to 2 extra Seedream calls and 1 image edit, only if needed.' : 'Recursive cleanup is off.'}</p>{polling && <p className="ff-lab-help">A run is active. You can follow its progress in Overview.</p>}</div>
            <button className="ws-btn ws-btn-primary ws-btn-large" disabled={!file || busy || polling || (reuse && !saved) || !!target.error} onClick={start}><Layers3 size={17} aria-hidden="true" />Run decomposition</button>
          </div>
        </section>
      </div>
      <div role="tabpanel" id="lab-panel-saved" aria-labelledby="lab-tab-saved" hidden={tab !== 'saved'} className="ff-lab-page">
        <SavedRunBrowser runs={visibleRuns} loading={!runsLoaded} selected={run?.id} busy={busy} onSelect={selectRun} />
      </div>
      <div role="tabpanel" id="lab-panel-overview" aria-labelledby="lab-tab-overview" hidden={tab !== 'overview'} className="ff-lab-overview">
        {!runsLoaded && !run ? <div className="ff-lab-page"><p role="status">Loading your workspace…</p></div> : !run ? <div className="ff-lab-page">
          <section className="ff-lab-welcome"><span className="ff-lab-kicker">YOUR CREATIVE TEST WORKSPACE</span><h2>From one image<br />to editable layers.</h2><p>Create a new creative or test an image you already have. Track quality, useful layers, and AI costs in one place.</p><div className="ff-lab-workflow"><span>Choose an image</span><ArrowRight size={15} /><span>Extract layers</span><ArrowRight size={15} /><span>Review in editor</span></div></section>
          <div className="ff-lab-start-grid"><button className="ff-lab-start-card" onClick={() => navigate('create')}><ImagePlus size={25} aria-hidden="true" /><strong>Create a template</strong><span>Start from a reference or choose a layout.</span><span className="ff-lab-start-link">Explore templates <ArrowRight size={16} /></span></button><button className="ff-lab-start-card" onClick={() => navigate('decompose')}><Upload size={25} aria-hidden="true" /><strong>Test your image</strong><span>Upload a creative and inspect its editable layers.</span><span className="ff-lab-start-link">Start a test <ArrowRight size={16} /></span></button></div>
        </div> : <div className="ff-lab-overview-toolbar"><span>Selected run · {(run.templateKey ?? 'template-a').replace('template-', 'Template ').toUpperCase().replace('TEMPLATE', 'Template')}</span><div><button className="ws-btn" onClick={() => navigate('saved')}><FolderOpen size={16} aria-hidden="true" />Browse saved runs</button><button className="ws-btn" onClick={() => navigate('decompose')}>New test</button></div></div>}
      {run && <RunDashboard key={run.id} run={run}
        diagnostics={diagnosticState?.runId === run.id && diagnosticState.updatedAt === run.updatedAt ? diagnosticState.value : undefined}
        loadingError={diagnosticState?.runId === run.id ? diagnosticState.error : undefined}
        actions={<>
            {run.stage === 'failed' && run.seedream.requestId && <button className="ws-btn" disabled={busy} onClick={resume}>Resume from saved request (no new charge)</button>}
            {run.stage === 'failed' && run.error?.code === 'PROVIDER_DECOMPOSITION_REJECTED' && runTemplate?.providerPrompt !== 'automatic' && <button className="ws-btn" disabled={busy || polling} onClick={() => retry('current')}>
              Retry with current provider prompt (1 new paid Seedream call)</button>}
            {run.stage === 'failed' && run.error?.code === 'PROVIDER_DECOMPOSITION_REJECTED' && runTemplateKey(run) === 'template-b' && <button className="ws-btn" disabled={busy || polling} onClick={() => retry('auto')}>
              Retry with Seedream automatic major elements, empty prompt (1 new paid Seedream call)</button>}
            {run.stage === 'done' && <button className="ws-btn ws-btn-primary" disabled={busy} onClick={open}>Open in editor</button>}
            {run.stage === 'done' && <button className="ws-btn" disabled={busy} onClick={resume}>Re-render from saved results</button>}
            <a className="ws-btn" href={experimentZipUrl(run.id)} download>Download outputs</a>
        </>}
        developer={<>
        <section style={box}>
          <strong>Stage: {run.stage}</strong>{polling && ' …'}
          {run.seedream.requestId && <> · fal request <code>{run.seedream.requestId}</code></>}
          {run.planner && <> · {run.planner.model} ({run.planner.usage?.input_tokens ?? '?'} in / {run.planner.usage?.output_tokens ?? '?'} out tokens)</>}
          <div>Timings: {Object.entries(run.timings).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`).join(' · ') || '—'}</div>
          {run.error && <p style={{ color: 'var(--color-error)' }}>{run.error.code} at {run.error.stage}: {run.error.message}</p>}
          {run.error?.provider && <div style={{ border: '1px solid var(--color-error)', borderRadius: 8, padding: 8 }}>
            <strong>fal response:</strong> HTTP {run.error.provider.status} · {run.error.provider.code}
            {run.error.provider.billableUnits !== undefined && <> · billable units {run.error.provider.billableUnits}</>}
            {run.error.provider.requestId && <> · request <code>{run.error.provider.requestId}</code></>}
            {run.error.provider.messages.map((m, i) => <div key={i}>“{m.msg}”{m.type && <> · type <code>{m.type}</code></>}{m.loc && <> · field <code>{m.loc}</code></>}{m.reason && <> · reason <code>{m.reason}</code></>}</div>)}
            {!run.error.provider.messages.length && <div>fal returned no message body.</div>}
            {run.error.provider.bodyFile && <div><a href={f(run.error.provider.bodyFile)} target="_blank" rel="noreferrer">Full fal error response</a> (status, headers and body, including the input fal echoed)</div>}
            {run.error.code === 'PROVIDER_SAFETY_REJECTED'
              ? <div style={{ color: 'var(--color-muted)' }}>fal's safety checker flagged this request, so the result was withheld. This is not a decomposition failure: the prompt and layer count are not the cause. The safety checker stays enabled and this is not retried; try a different image.</div>
              : run.error.code === 'PROVIDER_DECOMPOSITION_REJECTED'
              ? <div style={{ color: 'var(--color-muted)' }}>Seedream completed inference but did not produce a valid decomposition for this image/prompt combination. This can be transient. Its stored result is final (Resume only re-reads it) and nothing was retried. The layer count is applied locally and never sent to Seedream.</div>
              : (run.error.provider.status === 400 || run.error.provider.status === 422) && <div style={{ color: 'var(--color-muted)' }}>Provider rejected this image/prompt combination. This can be transient. Adjust the request or explicitly run again.</div>}
          </div>}
          {run.error?.code === 'TEMPLATE_NOT_SUITABLE' && <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            {run.templateFit?.bestTemplate && run.templateFit.bestTemplate !== runTemplateKey(run) && <button className="ws-btn ws-btn-primary" disabled={busy || polling} onClick={() => rerun(run.templateFit!.bestTemplate!, false)}>
              Run with {templates.find(t => t.key === run.templateFit!.bestTemplate)?.name ?? run.templateFit.bestTemplate}</button>}
            <button className="ws-btn" disabled={busy || polling} onClick={() => rerun(runTemplateKey(run), true)}>Run with {runTemplate?.name ?? runTemplateKey(run)} anyway</button>
          </div>}
          {run.warnings.map(w => <div key={w} style={{ color: '#8a5a00' }}>{w}</div>)}

        </section>
        {run.refinement && <section style={box} data-testid="refinement-debug" aria-label="Recursive decomposition debug">
          <strong>Recursive decomposition (debug)</strong>
          <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '2px 12px', marginTop: 6 }}>
            {refinementSummary(run).map(({ label, value }) => <div key={label} style={{ display: 'contents' }}><span style={{ color: 'var(--color-muted)' }}>{label}</span><span data-testid={`refinement-${label.toLowerCase().replace(/\s+/g, '-')}`}>{value}</span></div>)}
          </div>
          {run.refinement.stopDetail && <div style={{ marginTop: 6 }}>Stop: {run.refinement.stopDetail}</div>}
          {run.refinement.curation && <details data-testid="curation-debug">
            <summary>Developer curation: {run.refinement.curation.counts.rawLayers} raw → {run.refinement.curation.counts.editorLayers} editor layers</summary>
            <div>{run.refinement.curation.complexity} creative · soft target {run.refinement.curation.budget.min}–{run.refinement.curation.budget.max}{run.refinement.curation.overBudget ? ' · essential content kept above target' : ''}</div>
            {run.refinement.curation.entries.map(entry => <div key={entry.file} style={{ marginTop: 6 }}>
              <a href={f(entry.file)} target="_blank" rel="noreferrer">{entry.name ?? entry.file}</a>: {entry.disposition}{entry.mergedInto ? ` → ${entry.mergedInto}` : ''}
              {' · '}usefulness {entry.usefulnessScore} · quality {entry.qualityScore}. {entry.reasons.join(' ')}
            </div>)}
          </details>}
          {run.refinement.background?.candidates && <div data-testid="background-candidates">Background candidates: {run.refinement.background.candidates.map(c => `${c.method} ${c.quality}${c.reasons.length ? ` (${c.reasons.join(', ')})` : ''}${c.chosen ? ' ✓ used' : ''}`).join(' → ')}</div>}
          {run.refinement.background?.reasons.map(reason => <div key={reason} style={{ color: run.refinement!.background!.contaminated || run.refinement!.background!.status === 'fallback' ? '#8a5a00' : undefined }}>{reason}</div>)}
          {run.refinement.passes.map(p => <div key={p.pass} style={{ marginTop: 4 }}>Residual pass {p.pass}: {p.state}{p.requestId && <> · fal <code>{p.requestId}</code></>}{p.returnedLayers !== undefined && ` · returned ${p.returnedLayers}`} · kept {p.accepted.length}{p.grouped?.length ? ` (+${p.grouped.length} grouped)` : ''}
            {p.rejected.length > 0 && ` · rejected ${p.rejected.map(r => `${r.name ?? r.file} (${r.reason}${r.duplicateOf ? ` of ${r.duplicateOf}` : ''})`).join(', ')}`}{p.error && <span style={{ color: 'var(--color-error)' }}> · {p.error.code}: {p.error.message}</span>}</div>)}
          {run.interactions?.decisions.filter(d => d.decision === 'kept-separate').map(d => <div key={`${d.file}-${d.role}`} style={{ color: 'var(--color-muted)' }}>Kept separate: {d.name ?? d.file} ({d.role.replace(/_/g, ' ')}) — {d.reason}</div>)}
          {run.refinement.fidelity && <div style={{ marginTop: 4 }}>Reconstruction vs original: mean difference {run.refinement.fidelity.after.meanAbsDiff} (before refinement {run.refinement.fidelity.before.meanAbsDiff})</div>}
          {run.stage === 'done' && <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 6 }}>
            {['decomposition-debug.json', 'contact-sheet.png', run.refinement.mask?.file, run.refinement.mask?.shadowFile, run.refinement.background?.method !== 'provider-base' ? run.refinement.background?.file : undefined, ...run.refinement.assessments.map(a => a.residual)]
              .filter((file): file is string => !!file).map(file => <a key={file} href={f(file)} target="_blank" rel="noreferrer">{file}</a>)}
          </div>}
        </section>}
        <section style={box}>
          {run.promptSource?.mode === 'template'
            ? <div><span style={badge(TEMPLATE)}>Prompt source: {run.promptSource.templateName} saved prompt</span> Reused from run <code>{run.promptSource.sourceRunId}</code>, saved {when(run.promptSource.savedAt)}. OpenAI was not called.
              {saved && saved.templateKey === run.promptSource.templateKey && <> {saved.prompt === run.promptSource.prompt ? '(Same as the current saved prompt.)' : `(${saved.templateName}'s saved prompt has changed since this run.)`}</>}</div>
            : isAutomatic(run)
              ? <div><span style={badge(TEMPLATE)}>Prompt source: none (Seedream automatic major elements)</span> {run.promptSource?.mode === 'automatic' && run.promptSource.retryOf ? <>Explicit retry of run <code>{run.promptSource.retryOf}</code>. </> : run.promptSource?.mode === 'retry' ? <>Explicit retry of run <code>{run.promptSource.fromRunId}</code>. </> : null}Roles are classified locally. OpenAI was not called.</div>
            : run.promptSource?.mode === 'retry'
              ? <div><span style={badge(TEMPLATE)}>Prompt source: retry of run {run.promptSource.fromRunId}</span> {run.promptSource.providerPrompt === 'auto'
                ? 'Empty prompt: Seedream automatic major elements; roles are classified locally.' : 'Same base prompt, current provider rules.'} OpenAI was not called.</div>
              : <div><span style={badge(GENERATED)}>Prompt source: OpenAI generated</span> Generated from this run's image.</div>}
          <div style={{ marginTop: 6 }}><strong>Template: {runTemplate?.name ?? runTemplateKey(run)} · {optionsLabel(run, runTemplate) ?? <>{runGrouping.modeName}: {heldObjectLabel(run)}</>}</strong></div>
          {run.templateFit && <div>Template fit: <strong>{run.templateFit.fits ? 'fits' : 'does not fit'}</strong> ({run.templateFit.reason})</div>}
          {run.skipFitCheck && <div>Template fit: not checked (run anyway)</div>}
          {run.origin && <div>Image: {originTemplateName(run.origin.kind)} test generation <code>{run.origin.generationId}</code>{run.origin.aspectRatio && <>, its <strong>{run.origin.aspectRatio}</strong> variant</>}</div>}
          <div><strong>Layer count:</strong> {run.layerCount
            ? `Suggested ${run.layerCount.suggestedLayers ?? '—'} · Target ${run.layerCount.targetLayers ?? '— (none)'} · Provider returned ${run.layerCount.providerReturnedLayers} · Final output ${run.layerCount.finalOutputLayers}`
            : run.layerTarget ? `Suggested ${run.layerTarget.suggestedLayers} · Target ${run.layerTarget.targetLayers ?? (run.layerTarget.minLayers !== undefined || run.layerTarget.maxLayers !== undefined ? `older min/max run (${run.layerTarget.minLayers ?? '—'}–${run.layerTarget.maxLayers ?? '—'})` : '—')}` : 'not recorded (older run)'}</div>
          {run.stage === 'done' && runTemplate && <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
            <label>Re-render at target layers: <input type="number" step={1} value={retargetText} onChange={e => setRetargetText(e.target.value)} style={{ width: 64 }} /></label>
            <button className="ws-btn" disabled={busy || !retargetText.trim() || !!retarget?.error} onClick={rerenderAtTarget}>Re-render (no new charge)</button>
            {retargetText.trim() && retarget?.error && <span role="alert" style={{ color: 'var(--color-error)' }}>{retarget.error}</span>}
          </div>}
          {run.promptSource?.mode === 'automatic' ? <div style={{ marginTop: 8 }}><strong>Prompt sent to Seedream:</strong> none (empty prompt: Seedream automatic major elements).</div> : prompt ? <>
            <div style={{ marginTop: 8 }}><strong>Prompt sent to Seedream ({(run.finalPrompt ?? prompt.prompt).length} chars)</strong></div>
            <pre style={pre}>{run.finalPrompt === '' ? '(empty prompt: Seedream automatic major elements)' : run.finalPrompt ?? prompt.prompt}</pre>
            {run.finalPrompt !== undefined && run.finalPrompt !== prompt.prompt && <details><summary>Provider prompt adapted from the saved/base prompt (held-object grouping, current provider layer rules); base prompt ({prompt.prompt.length} chars)</summary><pre style={pre}>{prompt.prompt}</pre></details>}
            <PlanDetails layers={prompt.planned_layers} warnings={prompt.warnings} />
          </> : <p>No prompt yet.</p>}
          {generated && template && !runTemplate?.imageSpecificPrompt && <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
            {runTemplateKey(run) !== template.key ? <span>This prompt was generated for {runTemplate?.name ?? runTemplateKey(run)}; select that template to save it.</span>
              : saved?.sourceRunId === run.id ? <span>✓ This is the current saved {template.name} prompt.</span> : <>
              <input placeholder="Notes (optional)" value={notes} onChange={e => setNotes(e.target.value)} style={{ minWidth: 260 }} />
              <button className="ws-btn" disabled={busy} onClick={saveAsTemplate}>Save this prompt as {template.name}</button>
              {saved && <span style={{ color: '#8a5a00' }}>Replaces the saved prompt from run {saved.sourceRunId}.</span>}
            </>}
          </div>}
        </section>
        {run.layers && <section style={box}>
          <strong>Final output layers ({(run.outputLayers ?? run.layers).length}) — what Open in editor imports</strong>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12, marginTop: 8 }}>
            {(run.outputLayers ?? run.layers).map(l => <LayerTile key={l.file} l={l} f={f} />)}
          </div>
          {run.layerCount?.roles && <details style={{ marginTop: 12 }}><summary>{runTemplate?.name ?? runTemplateKey(run)} roles, classified locally ({run.layerCount.roles.length} semantic layers)</summary>
            <ul>{run.layerCount.roles.map(r => <li key={r.file}><code>{r.file}</code> {r.name ?? ''} → <strong>{r.role}</strong>{r.attached ? ' (attached)' : ''}{r.folded ? ' (folded)' : ''}: {r.reason}</li>)}</ul>
          </details>}
          {run.outputLayers && run.layerCount?.normalized && <details style={{ marginTop: 12 }}><summary>Semantic layers from Seedream ({run.layers.length}), before the layer count</summary>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12, marginTop: 8 }}>
              {run.layers.map(l => <LayerTile key={l.file} l={l} f={f} />)}
            </div>
          </details>}
        </section>}
      </>} />}
      </div>
    </div>
  </div></div>;
}
