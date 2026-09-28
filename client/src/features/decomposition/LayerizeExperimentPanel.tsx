import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '../../store';
import { assets } from '../../lib/assets/runtimeAssets';
import { isDesignVariant } from '../../lib/persistence/schema';
import { decomposedDesignImported } from '../../store/editorSlice';
import { variantSelected } from '../../store/uiSlice';
import { experimentApi, experimentFileUrl, experimentToVariant, experimentZipUrl, type ExperimentRun } from './layerizeExperiment';
import './workspace/workspace.css';

const ACTIVE = ['uploaded', 'planning', 'planned', 'uploading', 'submitting', 'queued', 'in_progress', 'downloading'];
const box: React.CSSProperties = { padding: 16, borderTop: '1px solid var(--color-line)' };
const thumb: React.CSSProperties = { width: '100%', height: 150, objectFit: 'contain', background: 'repeating-conic-gradient(#e6e4de 0 25%, #fff 0 50%) 0 0/16px 16px' };

/** Plain local test harness for the OpenAI → Seedream layerize experiment. Functionality first; no pipeline, no review. */
export function LayerizeExperimentPanel({ onClose }: { onClose: () => void }) {
  const dispatch = useAppDispatch();
  const variantCount = useAppSelector((s) => s.editor.document.variants.length);
  const [file, setFile] = useState<File | null>(null);
  const [runs, setRuns] = useState<ExperimentRun[]>([]);
  const [run, setRun] = useState<ExperimentRun>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void experimentApi.list().then(v => { if (!mounted.current) return; setRuns(v.runs); if (v.runs[0]) setRun(v.runs[0]); }).catch((e: Error) => mounted.current && setMessage(e.message));
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
  const start = () => file && act(async () => { const next = await experimentApi.start(file); setRun(next); setRuns(r => [next, ...r]); });
  const resume = () => run && act(async () => { await experimentApi.resume(run.id); setRun(await experimentApi.get(run.id)); });
  const open = () => run && act(async () => {
    const fetchFile = async (name: string) => { const r = await fetch(experimentFileUrl(run.id, name)); if (!r.ok) throw new Error(`Could not download ${name}.`); return r.blob(); };
    const next = await experimentToVariant(run, fetchFile, assets);
    if (!isDesignVariant(next) || variantCount >= 30) {
      await Promise.all((next.layers ?? []).map(l => l.type === 'image' ? assets.deleteAsset(l.assetId).catch(() => undefined) : undefined));
      throw new Error(variantCount >= 30 ? 'This design already has 30 versions. Delete one and try again.' : 'The layers could not be opened as a design version.');
    }
    dispatch(decomposedDesignImported({ variant: next, timestamp: new Date().toISOString() }));
    dispatch(variantSelected(next.id));
    onClose();
  });
  const f = (name: string) => run ? experimentFileUrl(run.id, name) : '';

  return <div className="ws-backdrop"><div className="ws" role="dialog" aria-modal="true" aria-labelledby="lx-title" style={{ gridTemplateRows: 'auto minmax(0, 1fr)' }}>
    <header className="ws-header" style={{ gridTemplateColumns: '1fr auto' }}>
      <h2 id="lx-title" style={{ fontSize: 15, fontWeight: 600 }}>OpenAI + Seedream test</h2>
      <button className="ws-icon-button" aria-label="Close" onClick={onClose}><X size={18} /></button>
    </header>
    <div className="ws-body" style={{ fontSize: 13 }}>
      <section style={{ ...box, borderTop: 0, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="file" accept="image/png,image/jpeg,image/webp" onChange={e => setFile(e.target.files?.[0] ?? null)} />
        <button className="ws-btn ws-btn-primary" disabled={!file || busy || polling} onClick={start}>Run (1 OpenAI + 1 paid Seedream call)</button>
        {runs.length > 0 && <select value={run?.id ?? ''} onChange={e => void act(async () => setRun(await experimentApi.get(e.target.value)))}>
          {runs.map(r => <option key={r.id} value={r.id}>{r.id} — {r.stage}</option>)}
        </select>}
      </section>
      {message && <p role="alert" style={{ ...box, color: 'var(--color-error)' }}>{message}</p>}
      {run && <>
        <section style={box}>
          <strong>Stage: {run.stage}</strong>{polling && ' …'}
          {run.seedream.requestId && <> · fal request <code>{run.seedream.requestId}</code></>}
          {run.planner && <> · {run.planner.model} ({run.planner.usage?.input_tokens ?? '?'} in / {run.planner.usage?.output_tokens ?? '?'} out tokens)</>}
          <div>Timings: {Object.entries(run.timings).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`).join(' · ') || '—'}</div>
          {run.error && <p style={{ color: 'var(--color-error)' }}>{run.error.code} at {run.error.stage}: {run.error.message}</p>}
          {run.warnings.map(w => <div key={w} style={{ color: '#8a5a00' }}>{w}</div>)}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            {run.stage === 'failed' && run.seedream.requestId && <button className="ws-btn" disabled={busy} onClick={resume}>Resume from saved request (no new charge)</button>}
            {run.stage === 'done' && <button className="ws-btn ws-btn-primary" disabled={busy} onClick={open}>Open in editor</button>}
            {run.stage === 'done' && <button className="ws-btn" disabled={busy} onClick={resume}>Re-render from saved results</button>}
            <a className="ws-btn" href={experimentZipUrl(run.id)} download>Download outputs</a>
          </div>
        </section>
        {run.planner && <section style={box}>
          <strong>Generated prompt ({run.planner.prompt.length} chars)</strong>
          <pre style={{ whiteSpace: 'pre-wrap', background: '#fff', padding: 10, borderRadius: 8 }}>{run.planner.prompt}</pre>
          <div>Planned layers: {run.planner.planned_layers.map(l => l.name).join(', ')}</div>
          {run.planner.warnings.map(w => <div key={w} style={{ color: '#8a5a00' }}>Planner warning: {w}</div>)}
        </section>}
        <section style={{ ...box, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <figure><figcaption>Original ({run.original.width}×{run.original.height})</figcaption><img src={f(run.original.file)} alt="Original upload" style={{ ...thumb, height: 360 }} /></figure>
          <figure><figcaption>Reconstructed from generated base + layers{run.canvas ? ` (${run.canvas.width}×${run.canvas.height})` : ''}</figcaption>
            {run.stage === 'done' ? <img src={`${f('reconstructed.png')}?${run.timings.renderMs ?? ''}`} alt="Reconstruction" style={{ ...thumb, height: 360 }} /> : <p>Not ready.</p>}</figure>
        </section>
        {run.layers && <section style={{ ...box, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
          {run.layers.map(l => <figure key={l.file} style={{ margin: 0 }}>
            <a href={f(l.file)} target="_blank" rel="noreferrer"><img src={f(l.file)} alt={l.name ?? l.file} style={thumb} /></a>
            <figcaption><strong>z{l.zIndex} {l.name ?? (l.placement.kind === 'base' ? 'base' : l.file)}</strong><br />{l.placement.kind} · {l.pixelWidth}×{l.pixelHeight} · {l.opaquePercent}% opaque
              {l.placement.reason && <div style={{ color: '#8a5a00' }}>{l.placement.reason}</div>}</figcaption>
          </figure>)}
        </section>}
      </>}
    </div>
  </div></div>;
}
