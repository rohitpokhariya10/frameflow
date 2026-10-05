import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ImagePlus, LoaderCircle, Sparkles } from 'lucide-react';
import { createReferenceCreative, editReferenceChoices, IMAGE_TEMPLATE_LIMITS, IMAGE_TEMPLATE_RATIOS, REFERENCE_CHANGE_FIELDS, REFERENCE_CHANGE_LIMIT, REFERENCE_PRESERVE_FIELDS,
  rebuildReferencePrompt, referenceBlueprint, resolveImageTemplateName, validateReferenceGeneration,
  type ReferenceChanges, type ReferenceCreativeDraft, type ReferencePreserve } from '@frameflow/shared';
import { assets } from '../../lib/assets/runtimeAssets';
import { useAppDispatch, useAppSelector } from '../../store';
import { decomposedDesignImported } from '../../store/editorSlice';
import { variantSelected } from '../../store/uiSlice';
import { experimentApi, experimentFileUrl } from '../decomposition/layerizeExperiment';
import { TemplateResults } from '../imageTemplates/CreateTemplateFromImage';
import { imageTemplateApi, importAsVersion, productReferenceUrl, referenceUrl, resultStatus, templateInProgress, withTemplate,
  type ImageTemplate, type ImageTemplateInfo, type ImageTemplateVariant } from '../imageTemplates/imageTemplates';
import { readReferenceEdits, REFERENCE_LAST_KEY, referenceRequestGuard, writeReferenceEdits } from './referenceDraft';
import './referenceCreative.css';

const busyIcon = <LoaderCircle size={16} className="ws-spin" aria-hidden="true" />;
const errorText = (error: unknown) => error instanceof Error ? error.message : 'That did not work. Please try again.';
export function ReferenceCreative({ templateId, templateName, linkedSetId, onAssociate, onClose, onEditor }: {
  templateId: string; templateName: string; linkedSetId?: string; onAssociate: (id: string) => void; onClose: () => void; onEditor: () => void;
}) {
  const dispatch = useAppDispatch(), versions = useAppSelector(state => state.editor.document.variants.length);
  const [info, setInfo] = useState<ImageTemplateInfo>(), [list, setList] = useState<ImageTemplate[]>([]);
  const [current, setCurrent] = useState<ImageTemplate>(), [draft, setDraft] = useState<ReferenceCreativeDraft>();
  const [name, setName] = useState(''), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const guard = useRef(referenceRequestGuard()), mounted = useRef(true);
  const revision = useRef(0);
  const backButton = useRef<HTMLButtonElement>(null);
  const pendingDraft = useRef<ReferenceCreativeDraft | undefined>(undefined);
  const keep = useCallback((value: ImageTemplate) => { setCurrent(value); setList(items => withTemplate(items, value)); }, []);
  const remember = (value: ImageTemplate, nextName: string, nextDraft?: ReferenceCreativeDraft) => {
    try { writeReferenceEdits(window.localStorage, value, nextName, nextDraft); }
    catch { setError('Browser storage could not keep these edits. Use Save draft before leaving.'); }
  };
  const restore = useCallback((value: ImageTemplate) => {
    keep(value);
    let saved: ReturnType<typeof readReferenceEdits> = { name: value.name, draft: value.referenceCreative };
    try { saved = readReferenceEdits(window.localStorage, value); window.localStorage.setItem(REFERENCE_LAST_KEY, value.id); }
    catch { setError('Local edits could not be read. The saved server draft is shown.'); }
    pendingDraft.current = saved.draft;
    setDraft(saved.draft); setName(saved.name);
  }, [keep]);
  useEffect(() => {
    mounted.current = true;
    backButton.current?.focus();
    const requests = guard.current;
    const ticket = requests.ticket(), valid = () => mounted.current && guard.current.accepts(ticket);
    void imageTemplateApi.info().then(value => { if (mounted.current) setInfo(value); }).catch(reason => { if (mounted.current) setError(errorText(reason)); });
    void imageTemplateApi.list().then(async value => {
      if (!valid()) return;
      setList(value.templates.filter(t => t.workflow === 'offer-reference'));
      let id = linkedSetId;
      try { id ??= window.localStorage.getItem(REFERENCE_LAST_KEY) ?? undefined; } catch { /* server list remains available */ }
      if (id && valid()) { const found = value.templates.find(t => t.id === id) ?? await imageTemplateApi.get(id); if (valid()) restore(found); }
    }).catch(reason => { if (valid()) setError(errorText(reason)); }).finally(() => { if (mounted.current) setLoading(false); });
    return () => { mounted.current = false; requests.replace(); };
    // The opening association is a starting point; changing it never reloads a live draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const polling = !!current && templateInProgress(current);
  useEffect(() => {
    if (!current?.id || !polling) return;
    let stopped = false, reading = false;
    const ticket = guard.current.ticket(), id = current.id;
    const timer = window.setInterval(() => {
      if (reading) return;
      reading = true; const readRevision = revision.current;
      void imageTemplateApi.get(id).then(value => {
        if (stopped || !mounted.current || !guard.current.accepts(ticket) || readRevision !== revision.current) return;
        keep(value);
        if (value.promptGeneration?.status === 'done' && value.analysis && !pendingDraft.current) {
          const settings = value.referenceCreative ?? createReferenceCreative(value.analysis);
          pendingDraft.current = settings; setDraft(settings); setName(previous => previous || value.name);
        }
      }).catch(reason => { if (!stopped && guard.current.accepts(ticket)) setError(`Could not refresh results: ${errorText(reason)}. Retrying this status check does not generate images.`); }).finally(() => { reading = false; });
    }, 1000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [current?.id, polling, keep]);

  const act = async (label: string, action: (valid: () => boolean) => Promise<void>, ticket = guard.current.ticket()) => {
    if (!guard.current.begin(ticket)) return;
    const valid = () => mounted.current && guard.current.accepts(ticket);
    revision.current++; setBusy(label); setError(''); setNotice('');
    try { await action(valid); }
    catch (reason) { if (valid()) setError(errorText(reason)); }
    finally { revision.current++; guard.current.finish(ticket); if (valid()) setBusy(''); }
  };
  const edit = (next: ReferenceCreativeDraft) => {
    pendingDraft.current = next; setDraft(next);
    if (current) remember(current, name, next);
  };
  const fields = (update: { changes?: Partial<ReferenceChanges>; preserve?: Partial<ReferencePreserve> }) => {
    if (!draft || !current?.analysis) return;
    try { edit(editReferenceChoices(draft, current.analysis, update)); setError(''); }
    catch (reason) { setError(errorText(reason)); }
  };
  const saveDraft = async () => {
    const value = { current, draft, name }, ticket = guard.current.ticket();
    if (!value.current || value.current.generatedAt) return;
    const result = await imageTemplateApi.change(value.current.id, { name: value.name, ...(value.draft ? { referenceCreative: value.draft } : {}) });
    if (mounted.current && guard.current.accepts(ticket)) { keep(result); remember(result, value.name, value.draft); }
  };
  const leave = () => void act('save', async valid => { await saveDraft(); if (valid()) onClose(); });
  const select = (id: string) => {
    if (current) remember(current, name, draft);
    const ticket = guard.current.replace(); setBusy(''); setError(''); setNotice(''); setCurrent(undefined); setDraft(undefined); setName(''); pendingDraft.current = undefined;
    if (id) void act('load', async valid => { const value = await imageTemplateApi.get(id); if (valid()) restore(value); }, ticket);
    else { try { window.localStorage.removeItem(REFERENCE_LAST_KEY); } catch { /* explicit new draft is still available */ } }
  };
  const upload = (file: File, product = false) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || !/\.(png|jpe?g|webp)$/i.test(file.name)) { setError('Choose a PNG, JPEG or WebP file with its matching extension.'); return; }
    if (!file.size || file.size > 25 * 1024 * 1024) { setError('Choose a non-empty image up to 25 MB.'); return; }
    if (product) {
      if (!current) return;
      void act('product', async valid => { const value = await imageTemplateApi.product(current.id, file); if (valid()) keep(value); }); return;
    }
    if (current && (current.analysis || current.generatedAt || draft) && !window.confirm('Replace the current reference? Its analysis and edits will not apply to the new image. The previous draft/results remain in Saved reference sets.')) return;
    select('');
    void act('upload', async valid => {
      const value = await imageTemplateApi.create(file, '', [...IMAGE_TEMPLATE_RATIOS], true);
      if (!valid()) return;
      const associated = await imageTemplateApi.change(value.id, { originTemplate: { id: templateId, name: templateName } });
      if (valid()) restore(associated);
    });
  };
  const analyze = () => {
    if (!current) return;
    if (current.analysis && !window.confirm('Re-analyze this reference? This makes one analysis request and replaces the detected style and prompt edits.')) return;
    void act('analyze', async valid => {
      const value = await imageTemplateApi.regeneratePrompt(current.id);
      if (valid()) { pendingDraft.current = undefined; setDraft(undefined); keep(value); remember(value, name); }
    });
  };
  const generate = () => {
    if (!current?.analysis || !draft) return;
    let snapshot: ReferenceCreativeDraft;
    try { snapshot = validateReferenceGeneration(draft, current.analysis); const problem = resolveImageTemplateName(name).error; if (problem) throw new Error(problem); }
    catch (reason) { setError(errorText(reason)); return; }
    void act('generate', async valid => {
      const result = await imageTemplateApi.generate(current.id, { name, prompt: snapshot.prompt, aspectRatios: [...IMAGE_TEMPLATE_RATIOS], referenceCreative: snapshot });
      if (valid()) { keep(result); remember(result, name, snapshot); }
    });
  };
  const decompose = (variants: ImageTemplateVariant[]) => {
    if (!current || !window.confirm(`Decompose ${variants.length} image(s)? Each makes 1 OpenAI planner request and 1 paid Seedream call; if the base is still contaminated, up to 2 more Seedream calls and 1 OpenAI image edit clean it.`)) return;
    void act('decompose', async valid => { for (const variant of variants) { if (!valid()) return; const result = await imageTemplateApi.decompose(current.id, variant.id); if (valid()) keep(result); } });
  };
  const open = (variant: ImageTemplateVariant) => void act('open', async valid => {
    if (!current || !variant.decomposition?.runId) return;
    const run = await experimentApi.get(variant.decomposition.runId);
    const version = await importAsVersion(run, `${current.name} · ${variant.aspectRatio}`, { versions, assets, fetchFile: async file => {
      const response = await fetch(experimentFileUrl(run.id, file)); if (!response.ok) throw new Error('Could not download a layer.'); return response.blob();
    } });
    if (!valid()) { await Promise.all((version.layers ?? []).map(layer => layer.type === 'image' && layer.assetId ? assets.deleteAsset(layer.assetId) : undefined)); return; }
    dispatch(decomposedDesignImported({ variant: version, timestamp: new Date().toISOString() })); dispatch(variantSelected(version.id));
    await imageTemplateApi.opened(current.id, variant.id, run.id).catch(() => undefined);
    if (valid()) onEditor();
  });
  const ready = !!current?.analysis && current.promptGeneration?.status === 'done', frozen = !!current?.generatedAt;
  const analysis = current?.analysis;
  const blueprint = useMemo(() => analysis ? referenceBlueprint(analysis) : undefined, [analysis]);
  let promptError = '';
  if (draft && current?.analysis) { try { validateReferenceGeneration(draft, current.analysis); } catch (reason) { promptError = errorText(reason); } }
  const writing = current?.promptGeneration?.status === 'generating';
  const changes = draft ? Object.entries(REFERENCE_CHANGE_FIELDS).filter(([key]) => draft.changes[key as keyof ReferenceChanges].trim()) : [];
  const presets = (festival: boolean) => fields({ changes: festival ? { festival: 'Diwali', decorations: 'Diyas, gold bokeh and restrained marigold accents' } : { festival: '', decorations: '' } });
  const finished = current?.variants.some(v => v.status === 'done');

  return <div className="ws-backdrop"><div className="ws reference-creative" role="dialog" aria-modal="true" aria-labelledby="reference-title">
    <header className="ws-header reference-header"><div><h2 id="reference-title">Create from Reference Image</h2><p>Keep a design family. Make it your campaign.</p></div>
      <button ref={backButton} type="button" className="ws-btn" onClick={leave} disabled={!!busy}><ArrowLeft size={16} /> Back to template</button></header>
    <div className="reference-scroll">
      <div className="reference-topline"><p>Draft for <strong>{templateName}</strong> · Your canvas stays available.</p>
        <label>Saved reference sets<select aria-label="Saved reference sets" value={current?.id ?? ''} onChange={event => select(event.target.value)}><option value="">New reference draft</option>{list.map(t => <option key={t.id} value={t.id}>{t.name || t.reference.originalName || 'Untitled reference'}{t.generatedAt ? ' · generated' : ' · draft'}</option>)}</select></label>
      </div>
      {loading && <p role="status">Loading saved reference drafts…</p>}
      {error && <p id="reference-error" role="alert" className="reference-error">{error}</p>}
      {notice && <p role="status" className="reference-notice">{notice}</p>}
      <div className="reference-grid">
        <aside className="reference-source">
          <h3>1. Your reference</h3>
          {current ? <><div className="reference-preview"><img src={referenceUrl(current)} alt="Uploaded creative reference" /></div><p>{current.reference.originalName} · {current.reference.width} × {current.reference.height}</p>{current.reference.warnings?.map(message => <p className="reference-notice" key={message}>{message}</p>)}</> : <div className="reference-empty"><ImagePlus size={36} /><p>Upload a creative whose layout and style you want to keep.</p></div>}
          <label className="reference-upload">{busy === 'upload' ? 'Uploading…' : current ? 'Replace image' : 'Upload reference'}<input type="file" aria-label="Reference creative image" aria-describedby={error ? 'reference-error' : undefined} accept="image/png,image/jpeg,image/webp" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) upload(file); }} /></label>
          <p className="ws-hint">PNG, JPEG or WebP · up to 25 MB. Uploading does not start analysis.</p>
          {!frozen && <button type="button" className="ws-btn ws-btn-primary" disabled={!current || !!busy || writing} onClick={analyze}>{writing ? busyIcon : <Sparkles size={16} />}{writing ? 'Analyzing reference…' : current?.promptGeneration?.status === 'failed' ? 'Retry analysis' : current?.analysis ? 'Re-analyze reference' : 'Analyze reference'}</button>}
          {!frozen && <p className="ws-hint">One analysis request per click. Changing fields does not re-analyze.</p>}
          {current?.promptGeneration?.status === 'failed' && <p role="alert" className="reference-error">We couldn’t analyze this reference. {current.promptGeneration.error?.message} Your image is kept; retry when ready.</p>}
          {blueprint && <section className="reference-detected" aria-label="Detected reference style"><h3>Detected style</h3><strong>{blueprint.summary}</strong><p>{blueprint.subject}</p><span>{blueprint.subjectMode === 'collection' ? 'Collection / multiple products' : blueprint.subjectMode === 'single' ? 'Single product / subject' : 'General visual style'}</span>
            {['none', 'unclear'].includes(blueprint.subjectMode) && <p className="reference-notice">We found a general visual style but no clear product/offer structure. Add a product description or use a custom prompt.</p>}
            <details><summary>Composition and business zones</summary><dl>{Object.entries({
              Composition: blueprint.analysis.composition.visualHierarchy, Background: blueprint.analysis.backgroundTreatment,
              Palette: blueprint.analysis.palette.join(' · '), 'Product position / scale': `${blueprint.analysis.hero.position} · ${blueprint.analysis.hero.relativeScale}`,
              Lighting: blueprint.analysis.lighting, Framing: blueprint.analysis.composition.framing, 'Card / panel geometry': blueprint.analysis.design?.panelGeometry,
              'Typography mood': blueprint.analysis.design?.typographyMood, Decorations: blueprint.analysis.design?.decorations,
              'Theme / mood': blueprint.analysis.design?.theme, 'Depth / shadows': [blueprint.analysis.design?.depth, blueprint.analysis.design?.shadows].filter(Boolean).join(' · '),
              ...(blueprint.zones ? Object.fromEntries(Object.entries(blueprint.zones).map(([zone, value]) => [`${zone} zone`, value])) : {}),
            }).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || 'Not detected'}</dd></div>)}</dl></details>
          </section>}
        </aside>
        <main className="reference-controls">
          <h3>2. Make it your campaign</h3>
          {!ready || !draft ? <div className="reference-empty"><p>Analyze your reference to see what was detected and choose what to change.</p></div> : <>
            <label className="reference-field">Campaign name<input value={name} maxLength={IMAGE_TEMPLATE_LIMITS.name} disabled={frozen || !!busy} onChange={event => { setName(event.target.value); remember(current!, event.target.value, draft); }} /></label>
            {frozen && <p className="reference-notice">These settings are the snapshot used for this set. Choose a new reference draft to create another campaign.</p>}
            <fieldset disabled={frozen || !!busy} className="reference-preserve"><legend>What will stay</legend>{Object.entries(REFERENCE_PRESERVE_FIELDS).map(([key, label]) => <label key={key}><input type="checkbox" checked={draft.preserve[key as keyof ReferencePreserve]} onChange={event => fields({ preserve: { [key]: event.target.checked } })} />{label}</label>)}</fieldset>
            <fieldset disabled={frozen || !!busy} className="reference-changes"><legend>What will change</legend><p>Leave a field empty to retain the reference. Explicit changes take priority over checked preserve options.</p>
              <div className="reference-presets"><button type="button" className="ws-btn" onClick={() => presets(false)}>Keep style, replace product</button><button type="button" className="ws-btn" onClick={() => presets(true)}>Add Diwali theme</button></div>
              <div className="reference-fields">{Object.entries(REFERENCE_CHANGE_FIELDS).map(([key, label]) => <label className="reference-field" key={key}>{label}<input value={draft.changes[key as keyof ReferenceChanges]} maxLength={REFERENCE_CHANGE_LIMIT} placeholder={key === 'product' ? current!.analysis!.hero.identity || 'e.g. Samsung Galaxy phone' : key === 'background' ? current!.analysis!.backgroundTreatment : 'Keep reference / no change'} onChange={event => fields({ changes: { [key]: event.target.value } })} /></label>)}</div>
              {info?.productReferenceSupported ? <div className="reference-product"><label className="reference-field">Replacement product image (optional)<input type="file" aria-label="Replacement product image" accept="image/png,image/jpeg,image/webp" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) upload(file, true); }} /></label>{current?.productReference && <><img src={productReferenceUrl(current)} alt="Replacement product" /><button type="button" className="ws-btn" onClick={() => void act('product', async valid => { const value = await imageTemplateApi.removeProduct(current.id); if (valid()) keep(value); })}>Remove product image</button></>}<p className="ws-hint">Every ratio uses the original creative plus this same product image. Exact labels and product details may still vary.</p></div> : <p className="ws-hint">Product description is supported. This configured model does not expose a second image input.</p>}
            </fieldset>
            {draft.mode === 'guided' && <p className="reference-summary">{changes.length ? `Changes: ${changes.map(([key, label]) => `${label}: ${draft.changes[key as keyof ReferenceChanges]}`).join(' · ')}` : 'The reference creative will be adapted with minimal changes.'}</p>}
            <details className="reference-advanced"><summary>Advanced · Full editable prompt · {draft.mode === 'custom' ? 'Custom prompt edited' : 'Guided mode'}</summary>
              <p>{draft.mode === 'custom' ? 'Custom Prompt Mode: the exact prompt below will be used. Field and preserve changes stay pending until you choose Rebuild from fields.' : 'Guided Mode: fields build this prompt locally. Typing here switches to Custom Prompt Mode.'}</p>
              <label className="reference-field">Full prompt<textarea aria-label="Full prompt" aria-invalid={!!promptError} aria-describedby={promptError ? 'reference-prompt-error' : undefined} value={draft.prompt} disabled={frozen || !!busy} rows={8} onChange={event => edit({ ...draft, mode: 'custom', prompt: event.target.value })} /></label>
              <div className="reference-prompt-tools"><span>{draft.prompt.length} / {IMAGE_TEMPLATE_LIMITS.prompt}</span><button type="button" className="ws-btn" onClick={() => void navigator.clipboard.writeText(draft.prompt).then(() => setNotice('Prompt copied.')).catch(() => setError('Could not copy. Select the prompt text and copy it manually.'))}>Copy prompt</button>
                <button type="button" className="ws-btn" disabled={frozen || !!busy} onClick={() => { if (draft.mode !== 'custom' || window.confirm('Replace your custom prompt with the current field choices?')) { try { edit(rebuildReferencePrompt(draft, current!.analysis!)); setError(''); } catch (reason) { setError(errorText(reason)); } } }}>Rebuild from fields</button></div>
            </details>
            {draft.mode === 'custom' && <p role="status" className="reference-notice">Custom prompt edited. Generate uses the full prompt; field changes are pending until rebuilt.</p>}
            {promptError && <p id="reference-prompt-error" role="alert" className="reference-error">{promptError}</p>}
            {!frozen && <div className="reference-generate"><div><strong>3. Generate your campaign</strong><p>1:1 Square · 4:5 Portrait · 16:9 Landscape</p><small>This makes 3 paid image requests. Decomposition is a separate action.</small></div>
              <button type="button" className="ws-btn ws-btn-primary" disabled={!!busy || !!promptError || !name.trim()} onClick={generate}>{busy === 'generate' ? busyIcon : <Sparkles size={16} />} Generate 3 variants</button>
              <button type="button" className="ws-btn" disabled={!!busy || draft.prompt.length > IMAGE_TEMPLATE_LIMITS.prompt} onClick={() => void act('save', async valid => { await saveDraft(); if (valid()) setNotice('Draft saved. No analysis or generation request was made.'); })}>Save draft</button></div>}
            <p className="ws-hint">Generated text and logos are pixels. Verify product details and add exact offers, contact details and branding as editable content in the editor.</p>
          </>}
        </main>
      </div>
      {frozen && current && <section className="reference-output" aria-label="Campaign results">
        <div className="reference-use"><div><h3>Campaign results</h3><p>{linkedSetId === current.id ? 'This generated set is linked to your template.' : 'Keep this ratio set with your template, then decompose any result when ready.'}</p></div>
          <button type="button" className="ws-btn ws-btn-primary" disabled={!finished || !!busy || linkedSetId === current.id} onClick={() => { onAssociate(current.id); setNotice('Generated set linked. Return to the canvas and Save Template to keep the association. Undo can restore the previous link.'); }}>Use Generated Set</button></div>
        <TemplateResults template={current} info={info} busy={busy} onRename={next => void act('save', async valid => { const value = await imageTemplateApi.change(current.id, { name: next }); if (valid()) { keep(value); setName(value.name); } })}
          onLayerStyle={decomposeWith => void act('save', async valid => { const value = await imageTemplateApi.change(current.id, { decomposeWith }); if (valid()) keep(value); })}
          onGenerateRatio={variant => { if (!window.confirm(`Retry ${variant.aspectRatio}? This makes 1 paid image request using the saved settings and original reference.`)) return; void act(`generate-${variant.id}`, async valid => { const value = await imageTemplateApi.generateRatio(current.id, variant.id); if (valid()) keep(value); }); }}
          onDecompose={decompose} onResume={variant => void act('resume', async valid => { const value = await imageTemplateApi.resume(current.id, variant.id); if (valid()) keep(value); })} onOpen={variant => void open(variant)} />
        {current.variants.some(v => resultStatus(v).failure === 'generation') && <p className="reference-notice">Successful images are kept. Retry only the failed size; it uses this set’s saved prompt and original reference.</p>}
      </section>}
    </div>
  </div></div>;
}
