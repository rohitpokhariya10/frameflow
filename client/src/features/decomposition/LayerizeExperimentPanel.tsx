import { useEffect, useRef, useState } from 'react';
import { useStore } from 'react-redux';
import { X, FlaskConical } from 'lucide-react';
import type { RunDiagnostics } from '@frameflow/shared';
import { useAppDispatch, type RootState } from '../../store';
import { assets } from '../../lib/assets/runtimeAssets';
import { variantSelected } from '../../store/uiSlice';
import { useDesigns } from '../editor/designs';
import { openResultInEditor } from '../imageTemplates/imageTemplates';
import { CreativeTemplateWorkspace, SavedTemplateExecutions, templateRequest, type ShownExecution } from '../imageTemplates/CreativeTemplateWorkspace';
import { experimentApi, experimentFileUrl, experimentZipUrl, runPrompt, runRecovery, type ExperimentRun } from './layerizeExperiment';
import { RunDashboard, DiagnosticDisclosure } from './RunDashboard';
import { ExperimentTabs, SavedRunBrowser, type ExperimentTab } from './ExperimentNavigation';
import './workspace/workspace.css';
import './experimentLab.css';

/** The four-tab workspace, using generic template executions and the existing run dashboard/importer. */
export function LayerizeExperimentPanel({ onClose }: { onClose: () => void }) {
  const dispatch = useAppDispatch(), store = useStore<RootState>(), designs = useDesigns();
  const [tab, setTab] = useState<ExperimentTab>('overview');
  const [requestedExecution, setRequestedExecution] = useState<{ id: string }>();
  const [file, setFile] = useState<File>();
  const [recursive, setRecursive] = useState(true);
  const [runs, setRuns] = useState<ExperimentRun[]>([]), [loaded, setLoaded] = useState(false);
  const [run, setRun] = useState<ExperimentRun>();
  const [diagnostics, setDiagnostics] = useState<RunDiagnostics>(), [diagnosticError, setDiagnosticError] = useState('');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const acting = useRef(false), mounted = useRef(true);
  const active = !!run && (run.active || !['done', 'failed'].includes(run.stage));
  useEffect(() => {
    mounted.current = true;
    // The newest run is only a default: a run the user already opened (View run) is never replaced by a late list.
    void experimentApi.list().then(v => { if (mounted.current) { setRuns(v.runs); setRun(current => current ?? v.runs[0]); setLoaded(true); } }).catch((e: Error) => { if (mounted.current) { setMessage(e.message); setLoaded(true); } });
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!run) return;
    let live = true;
    void experimentApi.diagnostics(run.id).then(d => { if (live) { setDiagnostics(d); setDiagnosticError(''); } }).catch((e: Error) => { if (live) setDiagnosticError(e.message); });
    return () => { live = false; };
  }, [run]);
  const runId = run?.id;
  useEffect(() => {
    if (!runId || !active) return;
    // A poll answer that arrives after another run was opened belongs to the old run: it never replaces the selection.
    let live = true;
    const timer = setInterval(() => { void experimentApi.get(runId).then(v => { if (live && mounted.current) setRun(v); }).catch((e: Error) => { if (live) setMessage(e.message); }); }, 1000);
    return () => { live = false; clearInterval(timer); };
  }, [runId, active]);
  const act = async (work: () => Promise<void>) => {
    if (acting.current) return;
    acting.current = true; setBusy(true); setMessage('');
    try { await work(); } catch (e) { if (mounted.current) setMessage(e instanceof Error ? e.message : 'Request failed.'); }
    finally { acting.current = false; if (mounted.current) setBusy(false); }
  };
  const show = async (id: string) => { const next = await experimentApi.get(id); setRun(next); setRuns(r => [next, ...r.filter(x => x.id !== id)]); setTab('overview'); };
  const selectRun = (id: string) => { void act(() => show(id)); };
  const open = async (current: ExperimentRun, execution?: ShownExecution) => {
    if (!execution && current.templateExecution) execution = await templateRequest<ShownExecution>(`/template-executions/${current.templateExecution.executionId}`);
    if (!designs) throw new Error('The editor is unavailable.');
    await openResultInEditor({ id: execution?.id ?? current.id, name: execution?.template?.name ?? 'Decomposed creative' }, { id: 'original', aspectRatio: 'original', decomposition: { runId: current.id, state: 'done', stage: 'done', createdAt: current.createdAt } }, {
      current: () => store.getState().editor.document, stored: () => designs.designs(), openStored: id => designs.openDesign(id), openNew: document => designs.openNewDesign(document), select: id => dispatch(variantSelected(id)),
      run: id => experimentApi.get(id), file: async (id, file) => { const response = await fetch(experimentFileUrl(id, file)); if (!response.ok) throw new Error('Could not load a saved layer.'); return response.blob(); },
      recordOpened: async runId => execution ? templateRequest(`/template-executions/${execution.id}/opened`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId }) }) : undefined,
      assets, wanted: () => mounted.current,
    });
    onClose();
  };
  const visibleRuns = run ? [run, ...runs.filter(r => r.id !== run.id)] : runs;
  return <div className="ws-backdrop"><div className="ws ff-lab" role="dialog" aria-modal="true" aria-labelledby="lx-title">
    <header className="ws-header ff-lab-header"><div className="ws-brand"><FlaskConical size={21} /><div><h2 id="lx-title">OpenAI + Seedream test</h2><p>Create a structure once. Reuse its plan. Review the layers and cost.</p></div></div><button className="ws-icon-button" aria-label="Close" onClick={onClose}><X size={18} /></button></header>
    <ExperimentTabs current={tab} onChange={setTab} runCount={visibleRuns.length} />
    <div className="ws-body ff-lab-body">{message && <p role="alert" className="ff-lab-alert">{message}</p>}
      <div role="tabpanel" id="lab-panel-create" aria-labelledby="lab-tab-create" hidden={tab !== 'create'}><CreativeTemplateWorkspace requestedExecution={requestedExecution} onRun={selectRun} onOpen={async e => open(await experimentApi.get(e.runId!), e)} /></div>
      <div role="tabpanel" id="lab-panel-decompose" aria-labelledby="lab-tab-decompose" hidden={tab !== 'decompose'} className="ff-lab-page"><section className="lx-card"><h2>Decompose an image</h2><p>Test any creative with a fresh planner. Use Create Template to save and reuse its structure.</p>
        <label className="ff-lab-upload"><strong>{file?.name ?? 'Choose an image to test'}</strong><input type="file" accept="image/png,image/jpeg,image/webp" aria-label="Image to decompose" onChange={e => setFile(e.target.files?.[0])} /></label>
        <p><label><input type="checkbox" checked={recursive} onChange={e => setRecursive(e.target.checked)} /> Recursive cleanup</label></p>
        <p className="ws-hint">One planner and one Seedream request. Cleanup can add up to two residual passes and one background edit when needed.</p>
        <button className="ws-btn ws-btn-primary" disabled={!file || busy || active} onClick={() => file && window.confirm('Start a fresh decomposition? This makes paid planner and Seedream calls, plus cleanup when needed.') && void act(async () => { const next = await experimentApi.start(file, 'generated', undefined, true, undefined, undefined, false, recursive); await show(next.id); })}>Run decomposition</button>
      </section></div>
      <div role="tabpanel" id="lab-panel-saved" aria-labelledby="lab-tab-saved" hidden={tab !== 'saved'} className="ff-lab-page">{tab === 'saved' && <SavedTemplateExecutions onSelect={id => { setRequestedExecution({ id }); setTab('create'); }} />}<SavedRunBrowser runs={visibleRuns} loading={!loaded} selected={run?.id} busy={busy} onSelect={selectRun} /></div>
      <div role="tabpanel" id="lab-panel-overview" aria-labelledby="lab-tab-overview" hidden={tab !== 'overview'} className="ff-lab-overview">{run ? <RunDashboard run={run} diagnostics={diagnostics?.runId === run.id ? diagnostics : undefined} loadingError={diagnosticError} actions={<>
        {run.stage === 'done' && <button className="ws-btn ws-btn-primary" disabled={busy} onClick={() => void act(() => open(run))}>Open in editor</button>}
        {runRecovery(run).resume && <button className="ws-btn" disabled={busy} onClick={() => void act(async () => { await experimentApi.resume(run.id); await show(run.id); })}>Resume saved result</button>}
        {runRecovery(run).retry && <button className="ws-btn" disabled={busy} onClick={() => window.confirm('Retry extraction with the saved plan? Incomplete generated instructions are repaired locally. One new paid Seedream request; no planner request. Success is not guaranteed.') && void act(async () => { const next = await experimentApi.retry(run.id); await show(next.id); })}>Retry extraction</button>}
        {run.stage === 'failed' && <button className="ws-btn" disabled={busy} onClick={() => setTab('create')}>Choose image or template</button>}
        <a className="ws-btn" href={experimentZipUrl(run.id)}>Download artifacts</a>
      </>} developer={<DiagnosticDisclosure title="Run artifacts and plan"><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{runPrompt(run)?.prompt}</pre><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(run, null, 2)}</pre></DiagnosticDisclosure>} /> : <section className="lx-card"><h2>Start with a creative</h2><p>Create a reusable template or test a decomposition. Saved runs keep their layers, plans and cost details.</p><button className="ws-btn ws-btn-primary" onClick={() => setTab('create')}>Create a reusable template</button></section>}</div>
    </div>
  </div></div>;
}
