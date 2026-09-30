import { useEffect, useRef, useState } from 'react';
import { useStore } from 'react-redux';
import { Sparkles, ArrowUpRight } from 'lucide-react';
import { AI_LIMITS, CANVAS_PRESETS, TEXT_LIMITS, type StyleBrief } from '@frameflow/shared';
import { selectActiveVariant, useAppDispatch, useAppSelector, type RootState } from '../../store';
import { generationStarted, generationReady, generationFailed, generationCleared } from '../../store/aiSlice';
import { generatedDesignApplied } from '../../store/editorSlice';
import { elementSelected, aiModeChanged } from '../../store/uiSlice';
import { aiConfigured, generateDesign } from './api';
import { composeText, emptyContent, quietRegion } from './composition';
import { measureText } from '../../lib/layout/measureText';
import { loadEditorFonts } from '../text/fonts';
import { abortable, assets, storeGeneratedImage } from '../../lib/assets/runtimeAssets';

import { DecompositionPanel } from '../decomposition/DecompositionPanel';
import { AdaptPanel } from './AdaptPanel';

const themes: StyleBrief[] = [
  { theme: 'Elegant wedding', palette: ['ivory', 'warm gold', 'soft sage'], motifs: ['delicate florals', 'ornamental details'], mood: 'romantic, refined, editorial' },
  { theme: 'Minimal event', palette: ['warm white', 'charcoal'], motifs: ['clean geometry'], mood: 'quiet, contemporary' },
  { theme: 'Floral', palette: ['cream', 'blush', 'leaf green'], motifs: ['botanical borders'], mood: 'fresh, natural' },
  { theme: 'Editorial', palette: ['paper white', 'muted olive'], motifs: ['subtle paper texture'], mood: 'considered, sophisticated' },
  { theme: 'Luxury', palette: ['ivory', 'antique gold'], motifs: ['fine ornamental edges'], mood: 'understated elegance' },
];
export function AIPanel() {
  const dispatch = useAppDispatch();
  const mode = useAppSelector((state) => state.ui.aiMode), busy = useAppSelector((state) => state.ai.status === 'generating');
  const previewAssetId = useAppSelector((state) => state.ai.preview?.variant.background?.assetId);
  return <div className="ai-tools"><div className="ai-mode-controls" role="group" aria-label="AI operation">{(['generate', 'adapt', 'decompose'] as const).map((value) => <button key={value} aria-pressed={mode === value} disabled={busy} onClick={() => {
    if (value === mode) return;
    dispatch(generationCleared()); dispatch(aiModeChanged(value));
    if (previewAssetId) void assets.deleteAsset(previewAssetId).catch(() => undefined);
  }}>{value === 'generate' ? 'Generate' : value === 'adapt' ? 'Adapt format' : 'Decompose'}</button>)}</div>{mode === 'decompose' ? <DecompositionPanel embedded /> : mode === 'adapt' ? <AdaptPanel /> : <GeneratePanel />}</div>;
}
function GeneratePanel() {
  const dispatch = useAppDispatch(); const store = useStore<RootState>();
  const variant = useAppSelector(selectActiveVariant);
  const ai = useAppSelector((state) => state.ai);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [healthError, setHealthError] = useState(''); const [retry, setRetry] = useState(0);
  const [prompt, setPrompt] = useState(ai.preview?.originalPrompt ?? '');
  const [theme, setTheme] = useState(() => Math.max(0, themes.findIndex((item) => item.theme === ai.preview?.styleBrief.theme)));
  const [format, setFormat] = useState(() => CANVAS_PRESETS.find((preset) => preset.width === ai.preview?.variant.canvas.width && preset.height === ai.preview?.variant.canvas.height)?.id ?? 'current');
  const [content, setContent] = useState(() => {
    const restored = { ...emptyContent };
    for (const element of ai.preview?.variant.elements ?? []) {
      if (Object.hasOwn(restored, element.role)) restored[element.role as keyof typeof restored] = element.text;
    }
    return restored;
  });
  const [formError, setFormError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const feedback = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ai.status !== 'idle' || formError) feedback.current?.scrollIntoView({ block: 'nearest' });
  }, [ai.status, formError]);
  useEffect(() => {
    const controller = new AbortController();
    void aiConfigured(controller.signal).then(setConfigured).catch((error: Error) => { if (!controller.signal.aborted) setHealthError(error.message); });
    return () => controller.abort();
  }, [retry]);
  useEffect(() => () => {
    if (pending.current) { pending.current.abort(); dispatch(generationCleared()); }
  }, [dispatch]);
  const busy = ai.status === 'generating';
  async function discard() {
    const assetId = store.getState().ai.preview?.variant.background?.assetId;
    dispatch(generationCleared());
    // This ID belongs only to an unapplied preview; applied/history assets are retained.
    if (assetId) await assets.deleteAsset(assetId).catch(() => undefined);
  }
  async function generate() {
    if (pending.current || configured !== true) return;
    if (!prompt.trim() || prompt.length > AI_LIMITS.prompt) { setFormError('Describe the artwork in 1–2,000 characters.'); return; }
    setFormError('');
    const source = store.getState();
    const sourceVariant = selectActiveVariant(source);
    const targetPreset = CANVAS_PRESETS.find((preset) => preset.id === format);
    const target = targetPreset ? { width: targetPreset.width, height: targetPreset.height } : { width: sourceVariant.canvas.width, height: sourceVariant.canvas.height };
    const requestId = crypto.randomUUID(); const controller = new AbortController(); pending.current = controller;
    const timeout = setTimeout(() => controller.abort('timeout'), 185000);
    let assetId: string | undefined;
    try {
      const cleanup = discard();
      dispatch(generationStarted(requestId));
      await abortable(cleanup, controller.signal);
      controller.signal.throwIfAborted();
      if (pending.current !== controller) return;
      const result = await generateDesign({ prompt, target, styleBrief: themes[theme], quietRegion: quietRegion(target) }, controller.signal);
      controller.signal.throwIfAborted();
      assetId = crypto.randomUUID();
      await abortable(storeGeneratedImage(result, assetId, controller.signal), controller.signal);
      await abortable(loadEditorFonts(), controller.signal);
      controller.signal.throwIfAborted();
      if (store.getState().ai.requestId !== requestId) { await assets.deleteAsset(assetId).catch(() => undefined); return; }
      const composed = composeText(content, target, measureText, () => crypto.randomUUID());
      dispatch(elementSelected(null));
      dispatch(generationReady({ requestId, preview: { sourceProjectId: source.editor.document.id, sourceVersion: source.editor.version,
        originalPrompt: prompt, styleBrief: themes[theme], unresolved: composed.unresolved,
        variant: { id: sourceVariant.id, name: sourceVariant.name, revision: sourceVariant.revision,
          canvas: { ...target, backgroundColor: '#FFFEFA' }, elements: composed.elements,
          background: { assetId, fit: 'cover', focalPoint: { x: .5, y: .5 } },
          generation: { ...result.generation, returnedWidth: result.image.width, returnedHeight: result.image.height } } } }));
    } catch (error) {
      if (assetId) void assets.deleteAsset(assetId).catch(() => undefined);
      if (controller.signal.aborted && controller.signal.reason !== 'timeout') return;
      dispatch(generationFailed({ requestId, message: controller.signal.reason === 'timeout' ? 'Generation timed out. Your design is unchanged. Please check before retrying.' : error instanceof Error ? error.message : 'Generation failed. Your design is unchanged.' }));
    } finally { clearTimeout(timeout); if (pending.current === controller) pending.current = null; }
  }
  function apply() {
    const preview = store.getState().ai.preview; if (!preview) return;
    const state = store.getState();
    if (preview.sourceVersion !== state.editor.version || preview.sourceProjectId !== state.editor.document.id) {
      setFormError('Your design changed while this preview was prepared. Discard it or regenerate from your current design.'); return;
    }
    dispatch(generatedDesignApplied({ preview, timestamp: new Date().toISOString() }));
    dispatch(generationCleared()); dispatch(elementSelected(null));
  }
  return <div className="ai-panel">
    <div className="ai-panel-scroll">
      <div className="section-intro"><h2>Set the atmosphere.</h2><p>Original artwork. Your words, editable.</p></div>
      {configured === null && !healthError && <p className="inspector-hint" role="status">Checking AI availability…</p>}
      {configured === false && <p className="ai-notice">AI artwork is unavailable right now. You can still add text, edit and export.</p>}
      {healthError && <div className="ai-notice" role="alert">{healthError}<button className="text-link" onClick={() => { setHealthError(''); setRetry(retry + 1); }}>Check connection</button></div>}
      <label className="control-label" htmlFor="ai-prompt">Artwork direction</label>
      <textarea id="ai-prompt" placeholder="Ivory florals, warm gold details, soft romantic light…" maxLength={AI_LIMITS.prompt} value={prompt} disabled={busy} onChange={(event) => { setPrompt(event.target.value); setFormError(''); }} />
      <p className="inspector-hint">Describe the visual style, mood and decoration.</p>
      <span className="control-label theme-label">Style</span><div className="theme-options" role="group" aria-label="Theme suggestions">{themes.map((item, index) => <button key={item.theme} aria-pressed={index === theme} disabled={busy} onClick={() => setTheme(index)}>{item.theme}</button>)}</div>
      <label className="control-label" htmlFor="ai-format">Preview format</label>
      <select id="ai-format" disabled={busy} value={format} onChange={(event) => setFormat(event.target.value)}><option value="current">Current · {variant.canvas.width} × {variant.canvas.height}</option>{CANVAS_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.name} · {preset.width} × {preset.height}</option>)}</select>
      <details className="event-fields" open><summary>Exact event wording <span>Editable text</span></summary><p className="inspector-hint">Names, dates and venue stay editable and separate from the AI artwork. All fields are optional.</p>
        {(Object.keys(content) as (keyof typeof content)[]).map((role) => <label key={role}><span className="control-label">{role[0].toUpperCase() + role.slice(1)}</span>{role === 'date'
          ? <input type="date" aria-label="Date" value={content.date} disabled={busy} onChange={(event) => setContent({ ...content, date: event.target.value })} />
          : <textarea aria-label={`Event ${role}`} aria-describedby={role === 'eyebrow' ? 'eyebrow-help' : undefined} placeholder={role === 'title' ? 'Main event title' : role === 'venue' ? 'Location or venue name' : undefined} value={content[role]} maxLength={TEXT_LIMITS.maxCharacters} disabled={busy} onChange={(event) => setContent({ ...content, [role]: event.target.value })} rows={role === 'venue' ? 2 : 1} />}{role === 'eyebrow' && <span id="eyebrow-help" className="inspector-hint">Small text above the main title.</span>}</label>)}
      </details>
      <div ref={feedback}>
      {ai.preview && <div className="ai-preview-note" role="status"><h3>Generated preview</h3><p>This is a preview. Your current design is unchanged. Apply it to replace your artwork and text.</p><p>{ai.preview.variant.canvas.width} × {ai.preview.variant.canvas.height} canvas · ready to edit after applying</p><p>Check for unwanted lettering or cropping. Only your text layers stay editable.</p>{ai.preview.unresolved.length > 0 && <p className="ai-notice">Some text needs manual adjustment. All wording is preserved.</p>}</div>}
      {(formError || ai.error) && <p className="ai-notice" role="alert">{formError || ai.error}</p>}
      {busy && <div className="ai-loading" role="status"><Sparkles size={18} /><strong>Creating your design…</strong><p>This may take a minute. Your current design is safe.</p></div>}
      </div>
    </div>
    <div className="ai-panel-actions">
      {ai.preview ? <><button className="button primary-button" onClick={apply}>Use this design<ArrowUpRight size={14} /></button><div className="ai-secondary-actions"><button className="button" disabled={configured !== true} onClick={() => void generate()}>Regenerate</button><button className="button tertiary-button" onClick={() => void discard()}>Discard</button></div></>
        : busy ? <button className="button" onClick={() => { pending.current?.abort(); pending.current = null; dispatch(generationCleared()); }}>Cancel generation</button>
          : <button className="button primary-button" disabled={configured !== true || busy} onClick={() => void generate()}><Sparkles size={14} />Generate design</button>}
      <p className="inspector-hint">Artwork is generated by AI. Text stays yours.</p>
    </div>
  </div>;
}
