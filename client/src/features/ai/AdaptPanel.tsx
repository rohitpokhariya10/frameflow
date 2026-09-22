import { useEffect, useRef, useState } from 'react';
import { useStore } from 'react-redux';
import { CANVAS_PRESETS, validateCanvasSize, type AdaptFormat, type StyleBrief } from '@frameflow/shared';
import { selectActiveVariant, useAppDispatch, useAppSelector, type RootState } from '../../store';
import { adaptationIsCurrent, generationStarted, generationReady, generationFailed, generationCleared } from '../../store/aiSlice';
import { adaptedDesignApplied } from '../../store/editorSlice';
import { elementSelected } from '../../store/uiSlice';
import { aiConfigured, adaptDesign } from './api';
import { adaptText, adaptationRegion } from './adaptation';
import { abortable, assets, storeGeneratedImage } from '../../lib/assets/runtimeAssets';
import { prepareReference } from '../../lib/assets/referenceImage';
import { loadEditorFonts } from '../text/fonts';
import { measureText } from '../../lib/layout/measureText';

export function AdaptPanel() {
  const store = useStore<RootState>(), dispatch = useAppDispatch();
  const source = useAppSelector(selectActiveVariant), ai = useAppSelector((state) => state.ai);
  const project = useAppSelector((value) => value.editor.document);
  const version = useAppSelector((value) => value.editor.version);
  const ui = useAppSelector((value) => value.ui);
  const [configured, setConfigured] = useState<boolean | null>(null), [healthError, setHealthError] = useState('');
  const [retry, setRetry] = useState(0), [error, setError] = useState('');
  const [format, setFormat] = useState<AdaptFormat>(ai.preview?.adaptation?.format ?? 'landscape');
  const [custom, setCustom] = useState({ width: String(ai.preview?.variant.canvas.width ?? 1600), height: String(ai.preview?.variant.canvas.height ?? 900) });
  const [brief, setBrief] = useState(ai.preview?.originalPrompt ?? project.originalPrompt ?? 'Preserve the source artwork and its visual identity.');
  const pending = useRef<AbortController | null>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const busy = ai.status === 'generating';
  const preview = ai.preview?.adaptation ? ai.preview : null;
  const stale = Boolean(preview && !adaptationIsCurrent(preview, project, version, ui.activeVariantId, ui.selectionVersion));
  useEffect(() => {
    const controller = new AbortController();
    void aiConfigured(controller.signal).then(setConfigured).catch((failure: Error) => { if (!controller.signal.aborted) setHealthError(failure.message); });
    return () => controller.abort();
  }, [retry]);
  useEffect(() => () => { if (pending.current) { pending.current.abort(); dispatch(generationCleared()); } }, [dispatch]);
  useEffect(() => { if (ai.status !== 'idle' || error) feedback.current?.scrollIntoView({ block: 'nearest' }); }, [ai.status, error]);
  async function discard() {
    const assetId = store.getState().ai.preview?.variant.background?.assetId;
    dispatch(generationCleared()); setError('');
    if (assetId) await assets.deleteAsset(assetId).catch(() => undefined);
  }
  async function adapt() {
    if (pending.current || configured !== true) return;
    const snapshot = store.getState(), original = selectActiveVariant(snapshot);
    if (!original.background) { setError('This version needs artwork before it can be adapted.'); return; }
    if (snapshot.editor.document.variants.length >= 30) { setError('This project has reached the 30-version limit.'); return; }
    const preset = CANVAS_PRESETS.find((item) => item.id === format);
    const size = preset ? validateCanvasSize(preset.width, preset.height) : validateCanvasSize(custom.width, custom.height);
    if (!size.valid) { setError(Object.values(size.errors).join(' ')); return; }
    if (!brief.trim()) { setError('Describe the visual identity to preserve.'); return; }
    const target = size.size;
    const styleBrief: StyleBrief = snapshot.editor.document.styleBrief ?? { theme: 'Source design', palette: [], motifs: [], mood: 'Preserve the source mood and artistic treatment' };
    const requestId = crypto.randomUUID(), controller = new AbortController(); pending.current = controller;
    const timeout = setTimeout(() => controller.abort('timeout'), 185000);
    let assetId: string | undefined;
    try {
      const cleanup = discard(); dispatch(generationStarted(requestId));
      await abortable(cleanup, controller.signal);
      const referenceImage = await prepareReference(original.background.assetId, controller.signal);
      controller.signal.throwIfAborted();
      const result = await adaptDesign({ prompt: brief, target, format, styleBrief, quietRegion: adaptationRegion(target, format), referenceImage,
        source: { projectId: snapshot.editor.document.id, variantId: original.id, revision: original.revision, assetId: original.background.assetId, width: original.canvas.width, height: original.canvas.height } }, controller.signal);
      controller.signal.throwIfAborted();
      assetId = crypto.randomUUID();
      await abortable(storeGeneratedImage(result, assetId, controller.signal), controller.signal);
      await abortable(loadEditorFonts(), controller.signal);
      controller.signal.throwIfAborted();
      if (store.getState().ai.requestId !== requestId) { await assets.deleteAsset(assetId).catch(() => undefined); return; }
      const layout = adaptText(original, target, format, measureText);
      dispatch(elementSelected(null));
      dispatch(generationReady({ requestId, preview: { sourceProjectId: snapshot.editor.document.id, sourceVersion: snapshot.editor.version,
        adaptation: { source: original, selectionVersion: snapshot.ui.selectionVersion, format }, originalPrompt: brief, styleBrief, unresolved: layout.unresolved,
        variant: { id: crypto.randomUUID(), name: `${preset?.name ?? 'Custom'} · ${target.width}×${target.height}`, revision: 0,
          sourceVariantId: original.id, canvas: { ...target, backgroundColor: original.canvas.backgroundColor }, elements: layout.elements,
          background: { assetId, fit: 'cover', focalPoint: { x: .5, y: .5 } },
          generation: { ...result.generation, sourceAssetId: original.background.assetId, returnedWidth: result.image.width, returnedHeight: result.image.height } } } }));
    } catch (failure) {
      if (assetId) void assets.deleteAsset(assetId).catch(() => undefined);
      if (controller.signal.aborted && controller.signal.reason !== 'timeout') return;
      dispatch(generationFailed({ requestId, message: controller.signal.reason === 'timeout' ? 'Adaptation timed out. Your source is unchanged. Check before retrying.' : failure instanceof Error ? failure.message : 'Adaptation failed. Your source is unchanged.' }));
    } finally { clearTimeout(timeout); if (pending.current === controller) pending.current = null; }
  }
  function apply() {
    const current = store.getState(), ready = current.ai.preview;
    if (!ready || !adaptationIsCurrent(ready, current.editor.document, current.editor.version, current.ui.activeVariantId, current.ui.selectionVersion)) { setError('The source context changed. Regenerate from the current version.'); return; }
    dispatch(adaptedDesignApplied({ preview: ready, timestamp: new Date().toISOString() }));
    if (store.getState().editor.document === current.editor.document) { setError('Could not apply this version. Your source is unchanged.'); return; }
    dispatch(generationCleared()); dispatch(elementSelected(null));
  }
  return <div className="ai-panel">
    <div className="ai-panel-scroll">
      <div className="section-intro"><span className="eyebrow">ADAPT FORMAT</span><h2>A new shape. The same story.</h2><p>Recompose your artwork. Keep every word.</p></div>
      <p className="inspector-hint">Source: {source.name} · {source.canvas.width} × {source.canvas.height}</p>
      {!source.background && <p className="ai-notice">Generate artwork for this version before adapting it.</p>}
      {configured === false && <p className="ai-notice">AI is not configured for this environment.</p>}
      {healthError && <div className="ai-notice" role="alert">{healthError}<button className="text-link" onClick={() => { setHealthError(''); setRetry(retry + 1); }}>Check connection</button></div>}
      <label className="control-label" htmlFor="adapt-format">Target format</label>
      <select id="adapt-format" value={format} disabled={busy} onChange={(event) => { setFormat(event.target.value as AdaptFormat); setError(''); }}>{CANVAS_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.name} · {preset.width} × {preset.height}</option>)}<option value="custom">Custom</option></select>
      {format === 'custom' && <div className="dimension-fields">{(['width', 'height'] as const).map((field) => <label key={field}><span className="control-label">Target {field}</span><input aria-label={`Target ${field}`} inputMode="numeric" value={custom[field]} disabled={busy} onChange={(event) => setCustom({ ...custom, [field]: event.target.value })} /></label>)}</div>}
      <label className="control-label" htmlFor="adapt-brief">Visual continuity brief</label>
      <textarea id="adapt-brief" maxLength={2000} value={brief} disabled={busy} onChange={(event) => setBrief(event.target.value)} />
      <p className="inspector-hint">Describe artwork only. Names, dates and all existing text stay exact and editable.</p>
      <div ref={feedback}>
        {preview && <div className="ai-preview-note" role="status"><h3>Adapted preview</h3><p>The source is unchanged. Use this version to add a new editable design.</p><p>{preview.variant.generation?.returnedWidth} × {preview.variant.generation?.returnedHeight} artwork · fitted without stretching</p>{preview.unresolved.length > 0 && <p className="ai-notice">{preview.unresolved.length} text {preview.unresolved.length === 1 ? 'element needs' : 'elements need'} manual adjustment. All wording is preserved.</p>}</div>}
        {stale && <p className="ai-notice" role="alert">The source context changed. Regenerate from the current version or discard this preview.</p>}
        {(error || ai.error) && <p className="ai-notice" role="alert">{error || ai.error}</p>}
        {busy && <div className="ai-loading" role="status"><strong>Adapting your artwork…</strong><p>This may take a minute. Your source is safe.</p></div>}
      </div>
    </div>
    <div className="ai-panel-actions">
      {preview ? <><button className="button primary-button" disabled={stale} onClick={apply}>Use this version</button><div className="ai-secondary-actions"><button className="button" disabled={configured !== true} onClick={() => void adapt()}>Regenerate</button><button className="button" onClick={() => void discard()}>Discard</button></div></>
        : busy ? <button className="button" onClick={() => { pending.current?.abort(); pending.current = null; dispatch(generationCleared()); }}>Cancel adaptation</button>
          : <button className="button primary-button" disabled={configured !== true || !source.background} onClick={() => void adapt()}>Adapt artwork</button>}
      <p className="inspector-hint">Reference-based artwork. Exact editable text.</p>
    </div>
  </div>;
}
