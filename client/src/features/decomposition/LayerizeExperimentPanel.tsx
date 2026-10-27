import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'react-redux';
import { X, FlaskConical, Sparkles } from 'lucide-react';
import type { ProjectDocument, RunDiagnostics, StudioPoster } from '@frameflow/shared';
import { useAppDispatch, type RootState } from '../../store';
import { assets } from '../../lib/assets/runtimeAssets';
import { variantSelected } from '../../store/uiSlice';
import { useDesigns } from '../editor/designs';
import { openResultInEditor } from '../imageTemplates/imageTemplates';
import { CreativeTemplateWorkspace, SavedTemplateExecutions, templateRequest, type ShownExecution } from '../imageTemplates/CreativeTemplateWorkspace';
import { qwenConfirmation } from '../imageTemplates/templateWizard';
import { experimentApi, experimentFileUrl, experimentZipUrl, isProtectedRun, runPrompt, runRecovery, type ExperimentRun } from './layerizeExperiment';
import { RunDashboard, DiagnosticDisclosure } from './RunDashboard';
import { ExperimentTabs, SavedRunBrowser, type ExperimentTab } from './ExperimentNavigation';
import { studioApi } from '../templateStudio/api';
import { TemplateStudio, type StudioRequest } from '../templateStudio/TemplateStudio';
import { WorkflowCost } from '../templateStudio/WorkflowCost';
import { prepareStudioImport, studioLinkOf, type StudioRunLink } from '../templateStudio/editorImport';
import { legacyCreativeTemplates } from '../../lib/featureFlags';
import { ProtectedTemplates, type OpenProtected, type ProtectedRequest } from '../protectedTemplates/ProtectedTemplates';
import { protectedTemplateDocument } from '../protectedTemplates/editorDocument';
import { variationDocument, variationResultId } from '../protectedTemplates/variationDocument';
import type { OpenVariation } from '../protectedTemplates/StyleVariations';
import { protectedFileUrl } from '../protectedTemplates/api';
import { protectPoster } from '../protectedTemplates/fromStudioPoster';
import { OfferTemplates, type OfferRequest } from '../masterTemplates/OfferTemplates';
import { masterApi, masterFileUrl } from '../masterTemplates/api';
import { creativeDocument, creativeResultId } from '../masterTemplates/creativeDocument';
import { loadCreativeFonts } from '../masterTemplates/creativeText';
import { creativeRunDocument, creativeRunSource, isCreativeRun, type CreativeRun } from '../masterTemplates/creativeRun';
import './workspace/workspace.css';
import './experimentLab.css';

/**
 * The workspace: Template Studio (template creation and image generation), then the existing decomposition tabs using
 * generic template executions and the existing run dashboard/importer. A generated image enters the decomposition only
 * through its Decompose action, which uses the same entry point as Decompose/Test.
 */
/** `client`: Create Offer Creative — straight to the template gallery, without the developer tabs (the same flows behind it). */
export function LayerizeExperimentPanel({ onClose, client = false }: { onClose: () => void; client?: boolean }) {
  const dispatch = useAppDispatch(), store = useStore<RootState>(), designs = useDesigns();
  const [tab, setTab] = useState<ExperimentTab>(client ? 'offer' : 'overview');
  const [requestedExecution, setRequestedExecution] = useState<{ id: string }>();
  const [file, setFile] = useState<File>();
  const [recursive, setRecursive] = useState(true);
  const [runs, setRuns] = useState<ExperimentRun[]>([]), [loaded, setLoaded] = useState(false);
  const [run, setRun] = useState<ExperimentRun>();
  const [diagnostics, setDiagnostics] = useState<RunDiagnostics>(), [diagnosticError, setDiagnosticError] = useState('');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  // Template Studio: a poster to show (from Overview's workflow card), and whether the open run came from one.
  const [studioRequest, setStudioRequest] = useState<StudioRequest>();
  // Offer Templates' "Product + Text" choice: Template Studio opened on its own Create Template.
  const [studioCreate, setStudioCreate] = useState(0);
  const [runLink, setRunLink] = useState<{ runId: string; link: StudioRunLink | null }>();
  // Protected templates: a template to show (a protected run's "Open protected template").
  const [protectedRequest, setProtectedRequest] = useState<ProtectedRequest>();
  // Offer templates: a view to show (Template Studio's "Text & Graphics" choice starts a new one there).
  const [offerRequest, setOfferRequest] = useState<OfferRequest & { at: number }>();
  // The earlier wizard keeps its panel; its tab shows only with the legacy flag (otherwise it opens from Saved Runs).
  const [legacy] = useState(legacyCreativeTemplates);
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
    if (!runId) return;
    let live = true;
    void studioLinkOf(runId).then(link => { if (live) setRunLink({ runId, link }); });
    return () => { live = false; };
  }, [runId]);
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
  const show = useCallback(async (id: string) => { const next = await experimentApi.get(id); setRun(next); setRuns(r => [next, ...r.filter(x => x.id !== id)]); setTab('overview'); }, []);
  const selectRun = (id: string) => { void act(() => show(id)); };
  /**
   * A creative's decomposition run in the editor: its pictures as layers, its texts and plates as native text and shapes.
   * A design of its own (never written back to the creative); the same run opens its design again. Stored files only.
   */
  const openCreativeRun = async (current: CreativeRun) => {
    if (!designs) throw new Error('The editor is unavailable.');
    const source = creativeRunSource(current), same = (v?: { templateId: string; resultId: string; runId: string }) => !!v && v.templateId === source.templateId && v.resultId === source.resultId && v.runId === source.runId;
    const version = store.getState().editor.document.variants.find(v => same(v.importedFrom));
    if (version) { dispatch(variantSelected(version.id)); onClose(); return; }
    const stored = designs.designs().find(d => same(d.importedFrom));
    if (stored) { designs.openDesign(stored.id); onClose(); return; }
    await loadCreativeFonts(current.creative);
    const document = await creativeRunDocument(current, { file: async file => { const response = await fetch(experimentFileUrl(current.id, file), { cache: 'no-store' }); if (!response.ok) throw new Error('Could not load a saved layer.'); return response.blob(); }, assets });
    try { designs.openNewDesign(document); }
    catch (error) { await Promise.all((document.variants[0].layers ?? []).map(l => l.type === 'image' && l.assetId ? assets.deleteAsset(l.assetId).catch(() => undefined) : undefined)); throw error; }
    onClose();
  };
  const open = async (current: ExperimentRun, execution?: ShownExecution) => {
    if (isCreativeRun(current)) return openCreativeRun(current);
    if (!execution && current.templateExecution) execution = await templateRequest<ShownExecution>(`/template-executions/${current.templateExecution.executionId}`);
    if (!designs) throw new Error('The editor is unavailable.');
    // A run made from a Template Studio image also gets that image's copy and logo as native editor elements.
    const studioImport = execution ? null : await prepareStudioImport(current.id, assets);
    const studioName = studioImport && ([studioImport.link.template?.name, studioImport.link.poster?.headline].filter(Boolean).join(' · ') || 'Generated image');
    const openNew = (document: ProjectDocument) => designs.openNewDesign(document);
    try {
    await openResultInEditor({ id: execution?.id ?? current.id, name: execution?.template?.name ?? studioName ?? 'Decomposed creative' }, { id: 'original', aspectRatio: 'original', decomposition: { runId: current.id, state: 'done', stage: 'done', createdAt: current.createdAt } }, {
      current: () => store.getState().editor.document, stored: () => designs.designs(), openStored: id => designs.openDesign(id), openNew: studioImport ? studioImport.wrap(openNew) : openNew, select: id => dispatch(variantSelected(id)),
      run: id => experimentApi.get(id), file: async (id, file) => { const response = await fetch(experimentFileUrl(id, file)); if (!response.ok) throw new Error('Could not load a saved layer.'); return response.blob(); },
      recordOpened: async runId => execution ? templateRequest(`/template-executions/${execution.id}/opened`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId }) }) : undefined,
      assets, wanted: () => mounted.current,
    });
    } finally { await studioImport?.finish(); }
    onClose();
  };
  /**
   * A protected template in the editor: Seedream's layers and the protected slots. The approved template itself opens
   * once and is returned to after (like a template result); a reuse is always a new design. Reads stored files only.
   */
  const openProtected: OpenProtected = async (template, current, reuse) => {
    if (!designs) throw new Error('The editor is unavailable.');
    const fetchBlob = async (url: string) => { const response = await fetch(url, { cache: 'no-store' }); if (!response.ok) throw new Error('Could not load a saved file of the template.'); return response.blob(); };
    if (!reuse) {
      const source = { templateId: template.id, resultId: `approved-r${template.elementsRevision}`, runId: current.id };
      const same = (v?: { templateId: string; resultId: string; runId: string }) => !!v && v.templateId === source.templateId && v.resultId === source.resultId && v.runId === source.runId;
      const version = store.getState().editor.document.variants.find(v => same(v.importedFrom));
      if (version) { dispatch(variantSelected(version.id)); onClose(); return; }
      const stored = designs.designs().find(d => same(d.importedFrom));
      if (stored) { designs.openDesign(stored.id); onClose(); return; }
    }
    const document = await protectedTemplateDocument(template, current, { runFile: file => fetchBlob(experimentFileUrl(current.id, file)), templateFile: file => fetchBlob(protectedFileUrl(template.id, file)), assets },
      reuse ? { replacements: reuse.replacements, name: reuse.name } : { importedFrom: true });
    try { designs.openNewDesign(document); }
    catch (error) { await Promise.all((document.variants[0].layers ?? []).map(l => l.type === 'image' && l.assetId ? assets.deleteAsset(l.assetId).catch(() => undefined) : undefined)); throw error; }
    onClose();
  };
  /**
   * A style variation in the editor: its artwork, logo slots and words as native text. The same variation opens its
   * earlier design again; reads stored files only, never a provider.
   */
  const openVariation: OpenVariation = async (template, variation) => {
    if (!designs) throw new Error('The editor is unavailable.');
    const same = (v?: { templateId: string; resultId: string; runId: string }) => !!v && v.templateId === template.id && v.resultId === variationResultId(variation) && v.runId === variation.id;
    const version = store.getState().editor.document.variants.find(v => same(v.importedFrom));
    if (version) { dispatch(variantSelected(version.id)); onClose(); return; }
    const stored = designs.designs().find(d => same(d.importedFrom));
    if (stored) { designs.openDesign(stored.id); onClose(); return; }
    const fetchBlob = async (url: string) => { const response = await fetch(url, { cache: 'no-store' }); if (!response.ok) throw new Error('Could not load a saved file of the variation.'); return response.blob(); };
    const document = await variationDocument(template, variation, { file: fetchBlob, templateFileUrl: file => protectedFileUrl(template.id, file), assets });
    try { designs.openNewDesign(document); }
    catch (error) { await Promise.all((document.variants[0].layers ?? []).map(l => l.type === 'image' && l.assetId ? assets.deleteAsset(l.assetId).catch(() => undefined) : undefined)); throw error; }
    onClose();
  };
  /**
   * A creative of a master template in the editor, as a design of its own. Built from the saved creative (the server's
   * copy is the one that counts); the design this creative had on this device is replaced in place, so there is one
   * design per creative. Reads stored files only: no OCR, decomposition or AI request.
   */
  const openCreative = useCallback(async (masterId: string, creativeId: string) => {
    if (!designs) throw new Error('The editor is unavailable.');
    const creative = await masterApi.getCreative(masterId, creativeId), snapshot = await masterApi.snapshot(masterId, creative.masterRevision);
    const same = (v?: { templateId: string; resultId: string; runId: string }) => !!v && v.templateId === masterId && v.resultId === creativeResultId(creativeId) && v.runId === creativeId;
    const version = store.getState().editor.document.variants.find(v => same(v.importedFrom));
    if (version?.creative?.syncedRevision === creative.revision) { dispatch(variantSelected(version.id)); onClose(); return; }
    const stored = designs.designs().find(d => same(d.importedFrom));
    if (stored && Date.parse(stored.updatedAt) > Date.parse(creative.updatedAt) + 2000
      && window.confirm('This creative has editor changes on this device that were not saved to the creative. Open them? (Cancel opens the saved creative instead and replaces them.)')) { designs.openDesign(stored.id); onClose(); return; }
    // Words are placed with their own fonts' metrics: the fonts load first.
    await loadCreativeFonts(creative);
    const fetchBlob = async (file: string) => { const response = await fetch(masterFileUrl(masterId, file), { cache: 'no-store' }); if (!response.ok) throw new Error('Could not load a saved file of the template.'); return response.blob(); };
    const document = await creativeDocument(snapshot, creative, { file: fetchBlob, assets });
    designs.openNewDesign(stored ? { ...document, id: stored.id } : document);
    onClose();
  }, [designs, dispatch, onClose, store]);
  /** A creative sent to decomposition (Offer Templates): its run, made or found by the server, shown in the run dashboard. */
  const openCreativeDecomposition = useCallback(async (runId: string) => { await show(runId); }, [show]);
  /** A Product with Text creative in the editor: its run (made by the server, locally) opened like a creative's run. */
  const openProductCreativeRun = async (runId: string) => { const next = await experimentApi.get(runId); if (!isCreativeRun(next)) throw new Error('That creative could not be opened.'); await openCreativeRun(next); };
  /** A Template Studio poster's own image as a Text & Graphics master: no download and upload; its scan starts at once. */
  const masterFromPoster = useCallback(async (poster: StudioPoster) => {
    const reuse = poster.provenance === 'reference_reuse';
    const response = await fetch(reuse ? poster.urls.decompositionScene : `/api/template-studio/posters/${poster.id}/image?format=png`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not read the poster\'s image.');
    const master = await masterApi.create(await response.blob(), `${poster.template.name} · ${poster.copy.headline ?? 'poster'}`.slice(0, 120),
      { kind: 'template-studio-poster', posterId: poster.id, provenance: reuse ? 'reference_reuse' : 'ai_generated', templateName: poster.template.name.slice(0, 120) });
    setOfferRequest({ view: 'setup', id: master.template.id, at: Date.now() }); setTab('offer');
  }, []);
  /** A poster's protected template, made from the studio's own data (no model call), opened for review. */
  const protectStudioPoster = useCallback(async (poster: StudioPoster) => {
    const template = await protectPoster(poster);
    setProtectedRequest({ templateId: template.id, at: Date.now() }); setTab('protected');
  }, []);
  /** The adapter's browser half: a generated poster's text-free scene goes to the same entry point as Decompose/Test. */
  const decomposePoster = useCallback(async (poster: StudioPoster, cleanup: boolean) => {
    const response = await fetch(poster.urls.decompositionScene, { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not prepare the generated scene for decomposition.');
    const scene = new File([await response.blob()], `template-studio-${poster.id}.png`, { type: 'image/png' });
    const next = await experimentApi.start(scene, 'generated', undefined, true, undefined, undefined, false, cleanup);
    await studioApi.post(`/posters/${poster.id}/decompositions`, { runId: next.id });
    await show(next.id);
  }, [show]);
  const link = runLink && runLink.runId === run?.id ? runLink.link : null;
  const visibleRuns = run ? [run, ...runs.filter(r => r.id !== run.id)] : runs;
  return <div className="ws-backdrop"><div className={`ws ff-lab${client ? ' is-client' : ''}`} role="dialog" aria-modal="true" aria-labelledby="lx-title">
    {client ? <header className="ws-header ff-lab-header ff-client-header"><div className="ws-brand"><span className="ff-client-mark" aria-hidden="true"><Sparkles size={18} /></span><div><h2 id="lx-title">Create Offer Creative</h2><p>Choose a template, add your products — FrameFlow designs the poster.</p></div></div><button className="ws-icon-button" aria-label="Close" onClick={onClose}><X size={18} /></button></header>
      : <header className="ws-header ff-lab-header"><div className="ws-brand"><FlaskConical size={21} /><div><h2 id="lx-title">OpenAI + Seedream test</h2><p>Create a structure once. Reuse its plan. Review the layers and cost.</p></div></div><button className="ws-icon-button" aria-label="Close" onClick={onClose}><X size={18} /></button></header>}
    {!client && <ExperimentTabs current={tab === 'create' && !legacy ? 'saved' : tab} onChange={setTab} runCount={visibleRuns.length} legacy={legacy} />}
    <div className="ws-body ff-lab-body">{message && <p role="alert" className="ff-lab-alert">{message}</p>}
      <div role="tabpanel" id="lab-panel-offer" aria-labelledby="lab-tab-offer" hidden={tab !== 'offer'}>{tab === 'offer' && <OfferTemplates key={offerRequest?.at ?? 0} client={client} request={offerRequest} onOpenCreative={openCreative} onOpenRun={openCreativeDecomposition} onOpenRunInEditor={openProductCreativeRun}
        onProductTemplate={() => { setStudioRequest(undefined); setStudioCreate(Date.now()); setTab('studio'); }} />}</div>
      <div role="tabpanel" id="lab-panel-studio" aria-labelledby="lab-tab-studio" hidden={tab !== 'studio'}>{tab === 'studio' && <TemplateStudio key={studioRequest?.at ?? studioCreate} onDecompose={decomposePoster} onOpenRun={selectRun} onOpenDecomposition={() => setTab('overview')} onProtect={protectStudioPoster} request={studioRequest}
        startOnCreate={!!studioCreate && !studioRequest} onTextGraphics={() => { setOfferRequest({ view: 'new', at: Date.now() }); setTab('offer'); }} onMakeMaster={masterFromPoster} />}</div>
      <div role="tabpanel" id="lab-panel-create" aria-labelledby={legacy ? 'lab-tab-create' : 'lab-tab-saved'} hidden={tab !== 'create'}>{!legacy && tab === 'create' && <button className="ws-btn ws-btn-quiet ts-back-to-saved" onClick={() => setTab('saved')}>← Back to Saved Runs</button>}<CreativeTemplateWorkspace requestedExecution={requestedExecution} onRun={selectRun} onOpen={async e => open(await experimentApi.get(e.runId!), e)} /></div>
      <div role="tabpanel" id="lab-panel-decompose" aria-labelledby="lab-tab-decompose" hidden={tab !== 'decompose'} className="ff-lab-page"><section className="lx-card"><h2>Decompose an image</h2><p>Test any creative with a fresh planner. Use Create Template to save and reuse its structure.</p>
        <label className="ff-lab-upload"><strong>{file?.name ?? 'Choose an image to test'}</strong><input type="file" accept="image/png,image/jpeg,image/webp" aria-label="Image to decompose" onChange={e => setFile(e.target.files?.[0])} /></label>
        <p><label><input type="checkbox" checked={recursive} onChange={e => setRecursive(e.target.checked)} /> Recursive cleanup</label></p>
        <p className="ws-hint">One planner and one Seedream request. Cleanup can add up to two residual passes and one background edit when needed.</p>
        <button className="ws-btn ws-btn-primary" disabled={!file || busy || active} onClick={() => file && window.confirm('Start a fresh decomposition? This makes paid planner and Seedream calls, plus cleanup when needed.') && void act(async () => { const next = await experimentApi.start(file, 'generated', undefined, true, undefined, undefined, false, recursive); await show(next.id); })}>Run decomposition</button>
      </section></div>
      <div role="tabpanel" id="lab-panel-protected" aria-labelledby="lab-tab-protected" hidden={tab !== 'protected'}>{tab === 'protected' && <ProtectedTemplates key={protectedRequest?.at ?? 0} runs={visibleRuns} onOpenRun={selectRun} onOpenEditor={openProtected} onOpenVariation={openVariation} request={protectedRequest} />}</div>
      <div role="tabpanel" id="lab-panel-saved" aria-labelledby="lab-tab-saved" hidden={tab !== 'saved'} className="ff-lab-page">{tab === 'saved' && <SavedTemplateExecutions onSelect={id => { setRequestedExecution({ id }); setTab('create'); }} />}<SavedRunBrowser runs={visibleRuns} loading={!loaded} selected={run?.id} busy={busy} onSelect={selectRun} /></div>
      <div role="tabpanel" id="lab-panel-overview" aria-labelledby="lab-tab-overview" hidden={tab !== 'overview'} className="ff-lab-overview">{run && link && <WorkflowCost link={link} diagnostics={diagnostics?.runId === run.id ? diagnostics : undefined} onOpenPoster={posterId => { setStudioRequest({ posterId, at: Date.now() }); setTab('studio'); }} />}{run ? <RunDashboard run={run} diagnostics={diagnostics?.runId === run.id ? diagnostics : undefined} loadingError={diagnosticError} actions={<>
        {/* A protected run opens with its protected slots, from its template (Seedream's layers alone would drop them). */}
        {isProtectedRun(run) && run.origin && <button className="ws-btn ws-btn-primary" disabled={busy} onClick={() => { setProtectedRequest({ templateId: run.origin!.generationId, at: Date.now() }); setTab('protected'); }}>Open protected template</button>}
        {run.stage === 'done' && !isProtectedRun(run) && <button className="ws-btn ws-btn-primary" disabled={busy} onClick={() => void act(() => open(run))}>Open in editor</button>}
        {runRecovery(run).resume && <button className="ws-btn" disabled={busy} onClick={() => void act(async () => { await experimentApi.resume(run.id); await show(run.id); })}>Resume saved result</button>}
        {runRecovery(run).retry && <button className="ws-btn" disabled={busy} onClick={() => window.confirm('Retry extraction with the saved plan? Incomplete generated instructions are repaired locally. One new paid Seedream request; no planner request. Success is not guaranteed.') && void act(async () => { const next = await experimentApi.retry(run.id); await show(next.id); })}>Retry extraction</button>}
        {/* The alternative provider, only after Seedream refused this image; a Template Studio poster's link follows the new run. */}
        {runRecovery(run).qwen && <button className="ws-btn" disabled={busy} onClick={() => window.confirm(qwenConfirmation()) && void act(async () => {
          const next = await experimentApi.qwen(run.id), posterId = link?.link?.posterId;
          try { if (posterId) await studioApi.post(`/posters/${posterId}/decompositions`, { runId: next.id }); } finally { await show(next.id); }
        })}>Try Qwen layers</button>}
        {run.stage === 'failed' && !isProtectedRun(run) && <button className="ws-btn" disabled={busy} onClick={() => setTab(legacy || run.templateExecution ? 'create' : 'studio')}>Choose image or template</button>}
        <a className="ws-btn" href={experimentZipUrl(run.id)}>Download artifacts</a>
      </>} developer={<DiagnosticDisclosure title="Run artifacts and plan"><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{runPrompt(run)?.prompt}</pre><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(run, null, 2)}</pre></DiagnosticDisclosure>} /> : <section className="lx-card"><h2>Start with a creative</h2><p>Create a reusable template or test a decomposition. Saved runs keep their layers, plans and cost details.</p><button className="ws-btn ws-btn-primary" onClick={() => setTab('studio')}>Create a reusable template</button></section>}</div>
    </div>
  </div></div>;
}
