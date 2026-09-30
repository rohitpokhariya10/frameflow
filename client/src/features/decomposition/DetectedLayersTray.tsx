import { useEffect, useState } from 'react';
import { Eye, Loader2, PenLine, Plus, RotateCcw, Trash2, Wand2, X } from 'lucide-react';
import { LAYER_LIMITS, type DecompositionJobSummary, type DecompositionStroke, type DesignLayer, type DesignVariant, type ProposalReviewTarget } from '@frameflow/shared';
import { useAppDispatch } from '../../store';
import { layerAdded, layerImageReplaced, layerUpdated } from '../../store/editorSlice';
import { elementSelected } from '../../store/uiSlice';
import { assets } from '../../lib/assets/runtimeAssets';
import { artifactUrl, decompositionApi as api } from './api';
import { backgroundLayer, REBUILT_BACKGROUND_LAYER_ID, sceneLayerToDesignLayer } from './importScene';
import { cutoutLayerId, cutoutToLayer, detectedBackground, detectedItems, loadTrayPrefs, saveTrayPrefs, type DetectedItem, type TrayPrefs } from './detectedLayers';
import { Thumb } from './workspace/parts';
import { PaintCanvas } from './workspace/PaintCanvas';
import './workspace/workspace.css';
import './detectedLayers.css';

const now = () => new Date().toISOString();

/**
 * "Detected layers": everything AI found in the image this version was opened from, including layers left for later.
 * Add any of them to the canvas, refine a detected area with the brush, rename, preview or hide it from this list.
 * Nothing here calls AI; layers left for later are cut from the original image with their detected area.
 */
export function DetectedLayersTray({ variant }: { variant: DesignVariant }) {
  const jobId = variant.decomposition?.jobId;
  return jobId ? <Tray key={jobId} jobId={jobId} variant={variant} /> : null;
}

function Tray({ jobId, variant }: { jobId: string; variant: DesignVariant }) {
  const dispatch = useAppDispatch();
  const [job, setJob] = useState<DecompositionJobSummary>();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<TrayPrefs>(() => loadTrayPrefs(jobId));
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [refining, setRefining] = useState<ProposalReviewTarget | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  useEffect(() => {
    let active = true;
    void api.job(jobId).then(value => { if (active) setJob(value); })
      .catch((e: { status?: number }) => { if (active) setError(e.status === 401 ? 'Sign in to “Image to layers” to see the layers detected in this image.' : 'Detected layers could not be loaded. Check your connection and reopen this design.'); });
    return () => { active = false; };
  }, [jobId]);
  useEffect(() => { saveTrayPrefs(jobId, prefs); }, [jobId, prefs]);

  const layers = variant.layers ?? [];
  const full = layers.length >= LAYER_LIMITS.maxLayers;
  const nameOf = (t: ProposalReviewTarget) => prefs.names[t.id] ?? t.label;
  const storeAsset = async (artifactId: string) => {
    const response = await fetch(artifactUrl(artifactId), { credentials: 'same-origin' });
    if (!response.ok) throw new Error('This layer could not be downloaded. Try again.');
    const id = `decomp-${crypto.randomUUID()}`;
    await assets.putAsset(id, await response.blob());
    return id;
  };
  const run = async (key: string, work: () => Promise<void>) => {
    setBusy(key); setMessage(''); setError('');
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : 'That didn’t work. Try again.'); } finally { setBusy(null); }
  };
  const place = (layer: DesignLayer, position: 'top' | 'bottom' = 'top') => {
    dispatch(layerAdded({ variantId: variant.id, layer, position, timestamp: now() }));
    dispatch(elementSelected(layer.id));
  };
  /** A pipeline layer keeps its AI-refined result; otherwise the detected area is cut from the original image. */
  const add = (item: DetectedItem, strokes?: DecompositionStroke[]) => run(item.target.id, async () => {
    if (full) throw new Error(`This design already has ${LAYER_LIMITS.maxLayers} layers. Delete one to add another.`);
    const id = `layer-${crypto.randomUUID()}`, name = nameOf(item.target);
    const existing = strokes && layers.find(l => l.source?.jobId === jobId && l.source.layerId === cutoutLayerId(item.target.id));
    if (item.sceneLayer && !strokes) place({ ...(await sceneLayerToDesignLayer(item.sceneLayer, jobId, storeAsset, id)), name });
    else {
      const cutout = await api.cutout(jobId, item.target.id, strokes);
      const assetId = await storeAsset(cutout.artifactId);
      if (existing?.type === 'image') {
        // A refined cut-out replaces the one already on the canvas, keeping any move/resize the user made.
        dispatch(layerImageReplaced({ variantId: variant.id, id: existing.id, assetId, timestamp: now() }));
        dispatch(elementSelected(existing.id));
      } else place(cutoutToLayer(cutout, jobId, assetId, id, name));
    }
    setMessage(`${existing ? 'Updated' : 'Added'} “${name}” on the canvas.`);
    setRefining(null);
  });
  const addBackground = (artifactId: string) => run('background', async () => {
    if (full) throw new Error(`This design already has ${LAYER_LIMITS.maxLayers} layers. Delete one to add another.`);
    place(backgroundLayer(`layer-${crypto.randomUUID()}`, await storeAsset(artifactId), variant.canvas.width, variant.canvas.height, 'Background', jobId), 'bottom');
    setMessage('Added the rebuilt background behind your layers.');
  });
  const rename = (target: ProposalReviewTarget, value: string) => {
    const name = value.trim().slice(0, 200);
    setRenaming(null);
    if (!name || name === nameOf(target)) return;
    setPrefs(p => ({ ...p, names: { ...p.names, [target.id]: name } }));
    const item = job && detectedItems(job, variant).find(i => i.target.id === target.id);
    for (const layer of layers.filter(l => l.source?.jobId === jobId && (l.source.layerId === cutoutLayerId(target.id) || l.source.layerId === item?.sceneLayer?.id)))
      dispatch(layerUpdated({ variantId: variant.id, id: layer.id, changes: { name }, timestamp: now() }));
  };

  if (error && !job) return <section className="detected-layers" aria-label="Detected layers"><div className="section-label"><h3>Detected layers</h3></div><p className="detected-note" role="status">{error}</p></section>;
  if (!job) return <section className="detected-layers" aria-label="Detected layers"><div className="section-label"><h3>Detected layers</h3></div><p className="detected-note"><Loader2 size={13} className="ws-spin" /> Loading…</p></section>;
  const items = detectedItems(job, variant);
  const shown = items.filter(i => !prefs.hidden.includes(i.target.id)), hidden = items.filter(i => prefs.hidden.includes(i.target.id));
  const background = detectedBackground(job), backgroundOnCanvas = layers.some(l => l.source?.jobId === jobId && l.source.layerId === REBUILT_BACKGROUND_LAYER_ID);
  const offCanvas = shown.filter(i => !i.onCanvas).length;
  const row = (item: DetectedItem) => {
    const { target, sceneLayer, onCanvas } = item, name = nameOf(target), proposal = job.proposals?.find(p => p.id === target.proposalIds[0]);
    const art = sceneLayer ? (sceneLayer.type === 'image' ? sceneLayer.transparentRgbaArtifactId : sceneLayer.rasterArtifactId) : undefined;
    const working = busy === target.id;
    return <li key={target.id} data-detected={target.id} className={onCanvas ? 'is-on-canvas' : ''}>
      <div className="detected-row">
        <button className="detected-thumb" aria-label={`Preview ${name}`} aria-pressed={preview === target.id} onClick={() => setPreview(preview === target.id ? null : target.id)}>
          {art ? <Thumb artifactId={art} size={40} /> : <Thumb artifactId={proposal?.artifactId} region={proposal?.bounds} width={proposal?.width} height={proposal?.height} size={40} />}
        </button>
        <span className="detected-text">
          {renaming?.id === target.id
            ? <input aria-label={`Rename ${name}`} autoFocus maxLength={200} value={renaming.value} onChange={e => setRenaming({ id: target.id, value: e.target.value })}
                onBlur={() => rename(target, renaming.value)} onKeyDown={e => { if (e.key === 'Enter') rename(target, renaming.value); if (e.key === 'Escape') setRenaming(null); }} />
            : <span className="detected-name" title={name}>{name}</span>}
          <span className="detected-status">{onCanvas ? 'On canvas' : sceneLayer ? 'Ready to add' : target.rejected ? 'Removed earlier · can still be added' : 'Left for later'}</span>
        </span>
        <span className="detected-actions">
          <button className="icon-button" aria-label={`Add ${name} to canvas`} title={onCanvas ? 'Add another copy to the canvas' : 'Add to canvas'} disabled={!!busy || full} onClick={() => void add(item)}>{working ? <Loader2 size={14} className="ws-spin" /> : <Plus size={14} />}</button>
          {!sceneLayer && <button className="icon-button" aria-label={`Refine ${name}`} title="Refine the detected area with the brush" disabled={!!busy} onClick={() => setRefining(target)}><Wand2 size={14} /></button>}
          <button className="icon-button" aria-label={`Rename ${name}`} title="Rename" onClick={() => setRenaming({ id: target.id, value: name })}><PenLine size={14} /></button>
          <button className="icon-button" aria-label={`Remove ${name} from this list`} title="Remove from this list (it stays saved)" onClick={() => setPrefs(p => ({ ...p, hidden: [...p.hidden, target.id] }))}><Trash2 size={14} /></button>
        </span>
      </div>
      {preview === target.id && <div className="detected-preview">{art ? <img src={artifactUrl(art)} alt={`${name} preview`} /> : <Thumb artifactId={proposal?.artifactId} region={proposal?.bounds} width={proposal?.width} height={proposal?.height} size={160} alt={`${name} preview`} />}
        {!sceneLayer && <p className="detected-note">Cut from your original image using the area AI detected. Use <Wand2 size={11} /> to fix rough edges.</p>}</div>}
    </li>;
  };
  return <section className="detected-layers" aria-label="Detected layers">
    <div className="section-label"><h3>Detected layers</h3><span>{items.length}</span></div>
    <p className="detected-note">{offCanvas ? `${offCanvas} not on the canvas yet. Add any of them at their original position.` : 'Everything AI found is on your canvas.'}</p>
    <p className="detected-message" role="status" aria-live="polite">{message}</p>
    {error && <p className="detected-error" role="alert">{error}</p>}
    <ul aria-label="Layers detected in your image">{shown.map(row)}</ul>
    {background && <div className="detected-row detected-background">
      <Thumb artifactId={background} size={40} />
      <span className="detected-text"><span className="detected-name">Background</span><span className="detected-status">{backgroundOnCanvas ? 'On canvas' : 'Rebuilt by AI without your layers'}</span></span>
      <span className="detected-actions"><button className="icon-button" aria-label="Add background to canvas" title="Add behind your layers" disabled={!!busy || backgroundOnCanvas || full} onClick={() => void addBackground(background)}>{busy === 'background' ? <Loader2 size={14} className="ws-spin" /> : <Plus size={14} />}</button></span>
    </div>}
    {hidden.length > 0 && <button className="detected-link" aria-expanded={showHidden} onClick={() => setShowHidden(!showHidden)}><Eye size={13} />{showHidden ? 'Hide removed layers' : `Show ${hidden.length} removed layer${hidden.length === 1 ? '' : 's'}`}</button>}
    {showHidden && <ul aria-label="Removed from this list">{hidden.map(item => <li key={item.target.id} className="detected-row is-hidden"><span className="detected-text"><span className="detected-name">{nameOf(item.target)}</span></span>
      <button className="icon-button" aria-label={`Restore ${nameOf(item.target)}`} title="Put back in the list" onClick={() => setPrefs(p => ({ ...p, hidden: p.hidden.filter(id => id !== item.target.id) }))}><RotateCcw size={14} /></button></li>)}</ul>}
    {refining && job.sourcePreviewArtifactId && <RefineDialog job={job} target={refining} name={nameOf(refining)} busy={busy === refining.id} error={error}
      onClose={() => setRefining(null)} onApply={strokes => { const item = items.find(i => i.target.id === refining.id); if (item) void add(item, strokes); }}
      replaces={layers.some(l => l.source?.jobId === jobId && l.source.layerId === cutoutLayerId(refining.id))} />}
  </section>;
}

/** Brush corrections on a detected area. Uses the original image only; no AI. */
function RefineDialog({ job, target, name, busy, error, replaces, onApply, onClose }: { job: DecompositionJobSummary; target: ProposalReviewTarget; name: string; busy: boolean; error: string; replaces: boolean; onApply: (strokes: DecompositionStroke[]) => void; onClose: () => void }) {
  const [strokes, setStrokes] = useState<DecompositionStroke[]>([]);
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [onClose]);
  return <div className="ws-backdrop detected-dialog-backdrop"><div className="ws detected-dialog" role="dialog" aria-modal="true" aria-label={`Refine ${name}`}>
    <header className="ws-header"><h2>Refine “{name}”</h2><button className="ws-icon-button" aria-label="Close" onClick={onClose}><X size={18} /></button></header>
    <div className="detected-dialog-body">
      <p className="ws-muted">Paint to add or remove parts of the detected area. This uses your original image — no AI.</p>
      <PaintCanvas label={`Refine the area of ${name}`} sourceId={job.sourcePreviewArtifactId!} width={job.sourceWidth!} height={job.sourceHeight!} maskId={target.maskArtifactId} edits={{ strokes }} onChange={edits => setStrokes(edits.strokes ?? [])} disabled={busy} />
      {error && <p className="ws-error-text" role="alert">{error}</p>}
    </div>
    <footer className="ws-footer"><span className="ws-footer-status">{strokes.length ? `${strokes.length} change${strokes.length === 1 ? '' : 's'} painted` : 'Paint over missing or extra parts.'}</span>
      <button className="ws-btn" onClick={onClose}>Cancel</button>
      <button className="ws-btn ws-btn-primary" disabled={busy} onClick={() => onApply(strokes)}>{busy ? 'Working…' : replaces ? 'Update on canvas' : 'Add to canvas'}</button></footer>
  </div></div>;
}
