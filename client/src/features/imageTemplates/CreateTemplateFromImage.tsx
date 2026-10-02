import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleAlert, ExternalLink, ImagePlus, Layers, LoaderCircle, Plus, RotateCcw, Sparkles, X } from 'lucide-react';
import { IMAGE_TEMPLATE_LIMITS, IMAGE_TEMPLATE_RATIO_NAMES, IMAGE_TEMPLATE_RATIOS, IMAGE_TEMPLATE_SIZES, type GenerationTemplateKey, type ImageTemplateRatio } from '@frameflow/shared';
import { useAppDispatch, useAppSelector } from '../../store';
import { assets } from '../../lib/assets/runtimeAssets';
import { decomposedDesignImported } from '../../store/editorSlice';
import { variantSelected } from '../../store/uiSlice';
import { experimentApi, experimentFileUrl, type ExperimentRun } from '../decomposition/layerizeExperiment';
import '../decomposition/workspace/workspace.css';
import './imageTemplates.css';
import { generationBlockers, imageTemplateApi, importAsVersion, referenceUrl, RESULT_STATUS_LABELS, resultImageUrl, resultStatus, templateInProgress, templateSummary, withRatio, withTemplate,
  type ImageTemplate, type ImageTemplateInfo, type ImageTemplateVariant, type TemplateChange } from './imageTemplates';

const NEW = 'new';
const MAX_UPLOAD_MB = 25;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const fileSize = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const spinner = <LoaderCircle size={16} className="ws-spin" aria-hidden="true" />;

/**
 * "Create Template from Image": the creative team's flow for turning a reference image into a named template in every
 * size they need. A dialog of its own, beside the OpenAI + Seedream test panel and independent of it: name → reference
 * image → prompt written from the image (editable) → sizes → generated results, each of which can be decomposed into
 * layers and opened in the editor. Templates are kept on the server and listed on the left.
 */
export function CreateTemplateFromImage({ onClose }: { onClose: () => void }) {
  const dispatch = useAppDispatch();
  const versions = useAppSelector((state) => state.editor.document.variants.length);
  const [info, setInfo] = useState<ImageTemplateInfo>();
  const [templates, setTemplates] = useState<ImageTemplate[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState(NEW);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [retrySaveId, setRetrySaveId] = useState('');
  const saves = useRef<Promise<void>>(Promise.resolve());
  const failedSaves = useRef(new Map<string, { change: TemplateChange; message: string }>());
  const revisions = useRef(new Map<string, number>());
  const acceptedReads = useRef(new Map<string, number>());
  const readSequence = useRef(0);
  const acting = useRef(false);
  const mounted = useRef(true);
  // A late refresh must not replace a mutation result or a newer refresh with an older snapshot.
  const refresh = useCallback(async (id: string) => {
    const revision = revisions.current.get(id) ?? 0, sequence = ++readSequence.current;
    const template = await imageTemplateApi.get(id);
    if (!mounted.current || revision !== (revisions.current.get(id) ?? 0) || sequence < (acceptedReads.current.get(id) ?? 0)) return;
    acceptedReads.current.set(id, sequence);
    setTemplates(list => withTemplate(list, template));
  }, []);
  useEffect(() => {
    mounted.current = true;
    void imageTemplateApi.info().then(value => mounted.current && setInfo(value)).catch((error: Error) => mounted.current && setMessage(error.message));
    void imageTemplateApi.list().then((value) => {
      if (!mounted.current) return;
      setTemplates(value.templates);
      // Pick up where the user left off: the newest template, if there is one.
      setSelected(current => current === NEW && value.templates[0] ? value.templates[0].id : current);
    }).catch((error: Error) => mounted.current && setMessage(error.message)).finally(() => { if (mounted.current) setLoaded(true); });
    return () => { mounted.current = false; };
  }, []);
  const current = templates.find(template => template.id === selected), currentId = current?.id;
  // While anything of the open template is on its way it is read again every two seconds. Reading costs nothing.
  const inProgress = !!current && templateInProgress(current);
  useEffect(() => {
    if (!currentId || !inProgress) return;
    const timer = window.setInterval(() => { void refresh(currentId).catch(() => undefined); }, 2000);
    return () => window.clearInterval(timer);
  }, [currentId, inProgress, refresh]);

  const keep = (template: ImageTemplate) => {
    revisions.current.set(template.id, (revisions.current.get(template.id) ?? 0) + 1);
    if (mounted.current) setTemplates(list => withTemplate(list, template));
  };
  const act = async (name: string, work: () => Promise<void>) => {
    if (acting.current) return;
    acting.current = true;
    setBusy(name); setMessage('');
    try {
      await saves.current;
      const failed = currentId && failedSaves.current.get(currentId);
      if (failed) { if (mounted.current) setRetrySaveId(currentId); throw new Error(failed.message); }
      await work();
    } catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : 'That did not work.'); }
    finally { acting.current = false; if (mounted.current) setBusy(''); }
  };
  const select = (id: string) => {
    setSelected(id); setMessage('');
    if (id !== NEW) void refresh(id).catch(() => undefined);
  };
  const create = (file: File, name: string, ratios: ImageTemplateRatio[]) => act('create', async () => {
    const template = await imageTemplateApi.create(file, name, ratios);
    if (!mounted.current) return;
    keep(template); setSelected(template.id);
  });
  // Serialize autosaves without disabling the button a blur is trying to click. Explicit actions wait for them.
  const change = (template: ImageTemplate, value: TemplateChange) => {
    saves.current = saves.current.then(async () => {
      // Keep failed fields until a successful retry, even when the next edit changes a different field.
      const pending = { ...failedSaves.current.get(template.id)?.change, ...value };
      try {
        const updated = await imageTemplateApi.change(template.id, pending);
        failedSaves.current.delete(template.id);
        keep(updated);
        if (mounted.current) { setMessage(''); setRetrySaveId(id => id === template.id ? '' : id); }
      } catch (error) {
        const failure = `Could not save changes: ${error instanceof Error ? error.message : 'Try again.'}`;
        failedSaves.current.set(template.id, { change: pending, message: failure });
        if (mounted.current) { setMessage(failure); setRetrySaveId(template.id); }
      }
    });
  };
  const regenerate = async (template: ImageTemplate) => {
    if (!window.confirm('Write the prompt again from the image? This makes 1 OpenAI request and replaces your edits.')) return false;
    let started = false;
    await act('prompt', async () => { keep(await imageTemplateApi.regeneratePrompt(template.id)); started = true; });
    return started;
  };
  const generate = (template: ImageTemplate, request: { name: string; prompt: string; aspectRatios: ImageTemplateRatio[] }) => {
    const count = request.aspectRatios.length;
    return window.confirm(`Generate "${request.name.trim()}" in ${request.aspectRatios.join(', ')}? This makes ${plural(count, 'paid OpenAI image request')}${info ? ` (${info.imageModel})` : ''}.`)
      && act('generate', async () => keep(await imageTemplateApi.generate(template.id, request)));
  };
  const generateRatio = (template: ImageTemplate, variant: ImageTemplateVariant) => window.confirm(`Generate the ${variant.aspectRatio} image${variant.attempts ? ' again' : ''} from the original reference? This makes 1 paid OpenAI image request.`)
    && act(`generate-${variant.id}`, async () => keep(await imageTemplateApi.generateRatio(template.id, variant.id)));
  const decompose = (template: ImageTemplate, list: ImageTemplateVariant[]) => window.confirm(list.length === 1
    ? `Decompose the ${list[0].aspectRatio} image into layers? This makes 1 OpenAI planner request and 1 paid Seedream call.`
    : `Decompose ${plural(list.length, 'image')} into layers (${list.map(variant => variant.aspectRatio).join(', ')})? Each makes 1 OpenAI planner request and 1 paid Seedream call; they run one at a time.`)
    && act(list.length === 1 ? `decompose-${list[0].id}` : 'decompose-all', async () => { for (const variant of list) keep(await imageTemplateApi.decompose(template.id, variant.id)); });
  const resume = (template: ImageTemplate, variant: ImageTemplateVariant) => act(`resume-${variant.id}`, async () => keep(await imageTemplateApi.resume(template.id, variant.id)));
  // The finished decomposition becomes a new version of the open design, selected, and the dialog closes onto it.
  const open = (template: ImageTemplate, variant: ImageTemplateVariant) => act(`open-${variant.id}`, async () => {
    const runId = variant.decomposition?.runId;
    if (!runId) throw new Error('This image has no finished decomposition yet.');
    const run = await experimentApi.get(runId);
    const fetchFile = async (name: string) => { const response = await fetch(experimentFileUrl(run.id, name)); if (!response.ok) throw new Error(`Could not download ${name}.`); return response.blob(); };
    const version = await importAsVersion(run, `${template.name} · ${variant.aspectRatio}`, { versions, fetchFile, assets });
    dispatch(decomposedDesignImported({ variant: version, timestamp: new Date().toISOString() }));
    dispatch(variantSelected(version.id));
    // Recorded so the result shows "Ready in editor" next time; the design version exists whether or not this is saved.
    await imageTemplateApi.opened(template.id, variant.id, runId).catch(() => undefined);
    onClose();
  });

  return <div className="ws-backdrop"><div className="ws cti" role="dialog" aria-modal="true" aria-labelledby="cti-title">
    <header className="ws-header cti-header">
      <div className="ws-brand"><span className="ws-brand-mark"><ImagePlus size={16} aria-hidden="true" /></span><h2 id="cti-title">Create Template from Image</h2></div>
      <button className="ws-icon-button" aria-label="Close" onClick={onClose}><X size={18} /></button>
    </header>
    <div className="cti-body">
      <aside className="cti-sidebar" aria-label="Your templates">
        <button className="ws-btn ws-btn-primary" aria-pressed={selected === NEW} onClick={() => select(NEW)}><Plus size={16} aria-hidden="true" /> New template</button>
        <div className="cti-side-head">Your templates <span className="ws-count">{templates.length}</span></div>
        {!loaded ? <p className="ws-muted">Loading…</p> : templates.length === 0 ? <p className="cti-side-empty">No templates yet. Upload a reference image to create your first one.</p>
          : <ul className="cti-list">{templates.map(template => <li key={template.id}>
            <button aria-current={template.id === selected ? 'true' : undefined} onClick={() => select(template.id)}>
              <img className="cti-thumb" src={referenceUrl(template)} alt="" />
              <span className="cti-list-text"><span className="cti-list-name">{template.name || 'Untitled template'}</span><span className="cti-list-meta" data-testid="template-summary">{templateSummary(template)}</span></span>
            </button></li>)}</ul>}
      </aside>
      <main className="cti-main">
        {message && <p className="cti-banner" role="alert"><CircleAlert size={16} aria-hidden="true" /> {message}
          {current && retrySaveId === current.id && <button className="ws-btn" disabled={!!busy} onClick={() => change(current, {})}>Retry save</button>}
        </p>}
        {!loaded ? <p role="status">Loading templates…</p> : current?.generatedAt
          ? <TemplateResults key={current.id} template={current} info={info} busy={busy} onRename={name => change(current, { name })} onLayerStyle={key => change(current, { decomposeWith: key })}
            onGenerateRatio={variant => void generateRatio(current, variant)} onDecompose={list => void decompose(current, list)} onResume={variant => void resume(current, variant)} onOpen={variant => void open(current, variant)} />
          : <TemplateDraft key={current?.id ?? NEW} template={current} info={info} busy={busy} onCreate={(file, name, ratios) => void create(file, name, ratios)} onChange={value => current && void change(current, value)}
            onRegenerate={() => current ? regenerate(current) : Promise.resolve(false)} onGenerate={request => current && void generate(current, request)} onInvalid={setMessage} />}
      </main>
    </div>
  </div></div>;
}

function StepHead({ number, title, done, hint }: { number: number; title: string; done: boolean; hint?: string }) {
  return <div className="cti-step-head">
    <span className="cti-step-num" aria-hidden="true">{number}</span><h3>{title}</h3>{done && <span className="cti-done">Done</span>}
    {hint && <span className="cti-step-hint">{hint}</span>}
  </div>;
}

/**
 * A new template, or a draft: name, reference, prompt and sizes. What the user types is kept here until it is saved
 * (on leaving a field, on choosing a size, on generating); until then the server's value shows through.
 */
function TemplateDraft({ template, info, busy, onCreate, onChange, onRegenerate, onGenerate, onInvalid }: {
  template?: ImageTemplate; info?: ImageTemplateInfo; busy: string; onCreate: (file: File, name: string, ratios: ImageTemplateRatio[]) => void; onChange: (change: TemplateChange) => void;
  onRegenerate: () => Promise<boolean>; onGenerate: (request: { name: string; prompt: string; aspectRatios: ImageTemplateRatio[] }) => void; onInvalid: (message: string) => void;
}) {
  const [name, setName] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [ratios, setRatios] = useState<ImageTemplateRatio[] | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const nameText = name ?? template?.name ?? '', promptText = prompt ?? template?.prompt ?? '', chosen = ratios ?? template?.aspectRatios ?? [...IMAGE_TEMPLATE_RATIOS];
  const writing = template?.promptGeneration?.status === 'generating', failed = template?.promptGeneration?.status === 'failed';
  const edited = !!template?.generatedPrompt && promptText !== template.generatedPrompt;
  const blockers = generationBlockers({ name: nameText, prompt: promptText, ratios: chosen, promptGeneration: template?.promptGeneration?.status });
  const choose = (next: File) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(next.type)) return onInvalid('Choose a PNG, JPEG or WebP image.');
    if (next.size > MAX_UPLOAD_MB * 1024 * 1024) return onInvalid(`Images must be at most ${MAX_UPLOAD_MB} MB.`);
    onInvalid('');
    setFile(next); setPreview(URL.createObjectURL(next));
  };
  const saveName = () => { if (template && name !== null && name !== template.name) onChange({ name }); };
  const savePrompt = () => { if (template && prompt !== null && prompt !== template.prompt) onChange({ prompt }); };
  const toggle = (ratio: ImageTemplateRatio, on: boolean) => { const next = withRatio(chosen, ratio, on); setRatios(next); if (template) onChange({ aspectRatios: next }); };

  return <div className="cti-inner">
    <div className="cti-page-head">
      <h2>{template ? nameText.trim() || 'Untitled template' : 'New template'}</h2>
      <p>Upload a reference image. Review and edit its visual details, then pick your sizes. Every size uses the original image to preserve the same creative.</p>
    </div>

    <section className={`cti-step${template ? ' is-done' : ''}`} aria-label="Name and reference image">
      <StepHead number={1} title="Name and reference image" done={!!template && !!nameText.trim()} />
      <label className="cti-field">
        <span>Template name</span>
        <input className="cti-input" value={nameText} maxLength={IMAGE_TEMPLATE_LIMITS.name} placeholder="e.g. Diwali offer — product hero" onChange={event => setName(event.target.value)} onBlur={saveName} />
      </label>
      {template
        ? <div className="cti-reference">
          <img src={referenceUrl(template)} alt="Reference image" />
          <div className="cti-reference-meta"><strong>{template.reference.originalName ?? 'Reference image'}</strong>
            <span>{template.reference.width} × {template.reference.height} · {fileSize(template.reference.bytes)}</span>
            <span className="ws-hint">The reference stays with this template. To use another image, start a new template.</span></div>
        </div>
        : <label className={`cti-drop${preview ? ' has-image' : ''}`} onDragOver={event => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const dropped = event.dataTransfer.files[0]; if (dropped) choose(dropped); }}>
          <input type="file" accept="image/png,image/jpeg,image/webp" aria-label="Reference image" onChange={(event) => { const picked = event.target.files?.[0]; if (picked) choose(picked); event.target.value = ''; }} />
          {preview && file
            ? <><img src={preview} alt="Reference preview" /><span className="cti-drop-meta"><strong>{file.name}</strong><span>{fileSize(file.size)} · <span className="ws-link">Choose another image</span></span></span></>
            : <><ImagePlus size={28} aria-hidden="true" /><strong>Drop a reference image here, or click to choose</strong><span>PNG, JPEG or WebP, up to {MAX_UPLOAD_MB} MB</span></>}
        </label>}
    </section>

    <section className="cti-step" aria-label="Prompt">
      <StepHead number={2} title="Prompt" done={!!template?.prompt && !writing} hint="Built from your image’s visual details" />
      {!template
        ? <div className="cti-generate-prompt">
          <button className="ws-btn ws-btn-primary" disabled={!file || !!busy} onClick={() => file && onCreate(file, nameText, chosen)}>{busy === 'create' ? spinner : <Sparkles size={16} aria-hidden="true" />} Generate prompt from image</button>
          <span className="ws-hint">{file ? 'One OpenAI request. Your image is saved with the template.' : 'Choose a reference image first.'}</span>
        </div>
        : writing
          ? <div className="cti-writing" role="status">{spinner} Reading your image and writing the prompt…</div>
          : <>
            {failed && <div className="cti-alert" role="alert"><CircleAlert size={16} aria-hidden="true" /><span>The prompt could not be written: {template.promptGeneration?.error?.message} You can try again, or write the prompt yourself.</span>
              <button className="ws-btn" disabled={!!busy} onClick={() => void onRegenerate().then(started => { if (started) setPrompt(null); })}><RotateCcw size={14} aria-hidden="true" /> Try again</button></div>}
            <div className="cti-prompt-head">
              <label htmlFor="cti-prompt">{template.generatedPrompt ? 'Generated prompt' : 'Prompt'}</label>
              {template.generatedPrompt && <span className={`cti-pill${edited ? ' is-edited' : ''}`} data-testid="prompt-state">{edited ? 'Edited' : 'Written from your image'}</span>}
              <span className={`cti-count${promptText.length > IMAGE_TEMPLATE_LIMITS.prompt ? ' is-over' : ''}`}>{promptText.length} / {IMAGE_TEMPLATE_LIMITS.prompt}</span>
            </div>
            <textarea id="cti-prompt" className="cti-textarea" value={promptText} rows={7} placeholder="Describe the image to generate." onChange={event => setPrompt(event.target.value)} onBlur={savePrompt} />
            <div className="ws-row">
              {edited && <button className="ws-btn ws-btn-quiet" disabled={!!busy} onClick={() => { setPrompt(template.generatedPrompt!); onChange({ prompt: template.generatedPrompt! }); }}><RotateCcw size={14} aria-hidden="true" /> Reset to generated prompt</button>}
              {!failed && <button className="ws-btn ws-btn-quiet" disabled={!!busy} onClick={() => void onRegenerate().then(started => { if (started) setPrompt(null); })}><Sparkles size={14} aria-hidden="true" /> Write again from image</button>}
            </div>
            <LayerStyle template={template} info={info} disabled={!!busy} onChange={key => onChange({ decomposeWith: key })} />
          </>}
    </section>

    <section className="cti-step" aria-label="Sizes">
      <StepHead number={3} title="Sizes" done={false} hint="Every size uses the same prompt" />
      <div className="cti-ratios">
        {IMAGE_TEMPLATE_RATIOS.map(ratio => { const size = info?.ratios.find(item => item.ratio === ratio) ?? { ...IMAGE_TEMPLATE_SIZES[ratio], name: IMAGE_TEMPLATE_RATIO_NAMES[ratio] }, on = chosen.includes(ratio);
          return <label key={ratio} className={`cti-ratio${on ? ' is-on' : ''}`}>
            <input type="checkbox" checked={on} aria-label={`${ratio} ${size.name}`} onChange={event => toggle(ratio, event.target.checked)} />
            <span className="cti-glyph" style={{ aspectRatio: `${size.width} / ${size.height}` }} aria-hidden="true" />
            <span className="cti-ratio-text"><strong>{ratio}</strong><span>{size.name} · {size.width} × {size.height}</span></span>
          </label>; })}
      </div>
    </section>

    <div className="cti-generate">
      <button className="ws-btn ws-btn-primary ws-btn-large" disabled={!template || blockers.length > 0 || !!busy} onClick={() => onGenerate({ name: nameText, prompt: promptText, aspectRatios: chosen })}>
        {busy === 'generate' ? spinner : <Sparkles size={16} aria-hidden="true" />} Generate selected templates{chosen.length ? ` (${chosen.length})` : ''}</button>
      <span className="ws-hint" data-testid="generate-hint">{blockers.length ? blockers.join(' ') : `${plural(chosen.length, 'paid image request')}${info ? ` · OpenAI ${info.imageModel}` : ''}. Each size can then be decomposed and opened in the editor.`}</span>
    </div>
  </div>;
}

/** Which decomposition template a result is split with: detected from the reference, or chosen. Folded away; most never change it. */
function LayerStyle({ template, info, disabled, onChange }: { template: ImageTemplate; info?: ImageTemplateInfo; disabled: boolean; onChange: (key: GenerationTemplateKey) => void }) {
  const key = template.decomposeWith ?? template.detected?.templateKey ?? 'template-b', style = info?.layerStyles.find(item => item.key === key);
  const how = template.decomposeWithChosen ? 'chosen by you' : template.detected ? 'detected from your image' : 'default';
  return <details className="cti-advanced" data-testid="layer-style">
    <summary>Layer style: <strong>{style ? `${style.summary.split(':')[0]} (${style.name})` : key}</strong> · {how}</summary>
    <label className="cti-field"><span>How the results are split into layers when decomposed</span>
      <select value={key} disabled={disabled || !info} onChange={event => onChange(event.target.value as GenerationTemplateKey)}>
        {(info?.layerStyles ?? []).map(item => <option key={item.key} value={item.key}>{item.name} — {item.summary}</option>)}
      </select></label>
    {template.detected && <span className="ws-hint">Detected: {info?.layerStyles.find(item => item.key === template.detected!.templateKey)?.name ?? template.detected.templateKey}. {template.detected.reason}</span>}
  </details>;
}

/** A generated template: what it was made from, and one card per size with its status and its next step. */
export function TemplateResults({ template, info, busy, onRename, onLayerStyle, onGenerateRatio, onDecompose, onResume, onOpen }: {
  template: ImageTemplate; info?: ImageTemplateInfo; busy: string; onRename: (name: string) => void; onLayerStyle: (key: GenerationTemplateKey) => void;
  onGenerateRatio: (variant: ImageTemplateVariant) => void; onDecompose: (list: ImageTemplateVariant[]) => void; onResume: (variant: ImageTemplateVariant) => void; onOpen: (variant: ImageTemplateVariant) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const shown = template.variants.filter(variant => template.aspectRatios.includes(variant.aspectRatio as ImageTemplateRatio));
  const missing = template.variants.filter(variant => !template.aspectRatios.includes(variant.aspectRatio as ImageTemplateRatio));
  const ready = shown.filter(variant => resultStatus(variant).status === 'generated');
  return <div className="cti-inner">
    <header className="cti-summary">
      <img src={referenceUrl(template)} alt="Reference image" />
      <div className="cti-summary-text">
        {renaming === null
          ? <div className="cti-title-row"><h2>{template.name}</h2><button className="ws-btn ws-btn-quiet" disabled={!!busy} onClick={() => setRenaming(template.name)}>Rename</button></div>
          : <form className="cti-title-row" onSubmit={(event) => { event.preventDefault(); if (renaming.trim() && renaming.trim() !== template.name) onRename(renaming); setRenaming(null); }}>
            <input className="cti-input" aria-label="Template name" value={renaming} maxLength={IMAGE_TEMPLATE_LIMITS.name} autoFocus onChange={event => setRenaming(event.target.value)} />
            <button className="ws-btn ws-btn-primary" type="submit" disabled={!renaming.trim()}>Save</button><button className="ws-btn ws-btn-quiet" type="button" onClick={() => setRenaming(null)}>Cancel</button></form>}
        <div className="cti-meta">Created {new Date(template.createdAt).toLocaleString()} · {template.aspectRatios.join(' · ')}{template.promptEdited ? ' · prompt edited' : ''}</div>
        <details className="cti-advanced"><summary>Prompt used{template.promptEdited ? ' (edited)' : ''}</summary><p className="cti-prompt-text" data-testid="prompt-used">{template.prompt}</p></details>
        <LayerStyle template={template} info={info} disabled={!!busy} onChange={onLayerStyle} />
      </div>
    </header>

    <section aria-label="Results">
      <div className="cti-section-head"><h3>Results</h3>
        {ready.length > 1 && <button className="ws-btn" disabled={!!busy} onClick={() => onDecompose(ready)}><Layers size={16} aria-hidden="true" /> Decompose all ({ready.length})</button>}</div>
      <div className="cti-results">{shown.map(variant => <ResultCard key={variant.id} template={template} variant={variant} busy={busy}
        onGenerate={() => onGenerateRatio(variant)} onDecompose={() => onDecompose([variant])} onResume={() => onResume(variant)} onOpen={() => onOpen(variant)} />)}</div>
      {missing.length > 0 && <div className="cti-add">Add another size:
        {missing.map(variant => <button key={variant.id} className="ws-btn" disabled={!!busy} onClick={() => onGenerateRatio(variant)}><Plus size={14} aria-hidden="true" /> {variant.aspectRatio} {IMAGE_TEMPLATE_RATIO_NAMES[variant.aspectRatio as ImageTemplateRatio]}</button>)}
        <span className="ws-hint">1 paid image request each.</span></div>}
    </section>
  </div>;
}

function ResultCard({ template, variant, busy, onGenerate, onDecompose, onResume, onOpen }: {
  template: ImageTemplate; variant: ImageTemplateVariant; busy: string; onGenerate: () => void; onDecompose: () => void; onResume: () => void; onOpen: () => void;
}) {
  const { status, detail, failure } = resultStatus(variant), ratio = variant.aspectRatio as ImageTemplateRatio, working = busy.endsWith(`-${variant.id}`);
  return <article className="cti-result" aria-label={`${ratio} result`} data-ratio={variant.id}>
    <div className="cti-result-media" style={{ aspectRatio: `${variant.size.width} / ${variant.size.height}` }}>
      {variant.image ? <a href={resultImageUrl(template, variant)} target="_blank" rel="noreferrer"><img src={resultImageUrl(template, variant)} alt={`${template.name}, ${ratio}`} /></a>
        : <div className="cti-placeholder">{status === 'generating' ? <>{spinner}<span>Generating…</span></> : status === 'failed' ? <><CircleAlert size={20} aria-hidden="true" /><span>No image</span></> : <span>Not generated</span>}</div>}
      {status === 'decomposing' && <div className="cti-media-overlay">{spinner}<span>Decomposing…</span></div>}
    </div>
    <div className="cti-result-body">
      <div className="cti-result-head"><strong>{ratio}</strong><span className="cti-result-size">{IMAGE_TEMPLATE_RATIO_NAMES[ratio]} · {variant.size.width} × {variant.size.height}</span>
        <span className={`cti-status is-${status}`} data-testid={`status-${variant.id}`}>{RESULT_STATUS_LABELS[status]}</span></div>
      <p className={failure ? 'cti-result-error' : 'cti-result-detail'} role={failure ? 'alert' : undefined}>{detail}</p>
      {variant.decomposition?.state === 'done' && <LayerPreview key={variant.decomposition.runId} runId={variant.decomposition.runId} />}
      <div className="cti-result-actions">
        {status === 'generated' && <button className="ws-btn ws-btn-primary" disabled={!!busy} onClick={onDecompose}>{working ? spinner : <Layers size={16} aria-hidden="true" />} Decompose into layers</button>}
        {status === 'decomposed' && <button className="ws-btn ws-btn-primary" disabled={!!busy} onClick={onOpen}>{working ? spinner : <ExternalLink size={16} aria-hidden="true" />} Open in editor</button>}
        {status === 'in-editor' && <button className="ws-btn" disabled={!!busy} onClick={onOpen}>{working ? spinner : <ExternalLink size={16} aria-hidden="true" />} Open in editor again</button>}
        {status === 'not-generated' && <button className="ws-btn" disabled={!!busy} onClick={onGenerate}>Generate</button>}
        {failure === 'generation' && <button className="ws-btn" disabled={!!busy} onClick={onGenerate}><RotateCcw size={14} aria-hidden="true" /> Try again</button>}
        {failure === 'decomposition' && variant.decomposition?.resumable && <button className="ws-btn ws-btn-primary" disabled={!!busy} onClick={onResume}>Resume (no new charge)</button>}
        {failure === 'decomposition' && <button className="ws-btn" disabled={!!busy} onClick={onDecompose}><RotateCcw size={14} aria-hidden="true" /> Decompose again</button>}
      </div>
      {(status === 'generated' || failure === 'decomposition') && <span className="ws-hint">Decomposing makes 1 OpenAI planner request and 1 paid Seedream call.</span>}
    </div>
  </article>;
}

/** Read-only preview of exactly the final layers the existing editor importer will use. */
function LayerPreview({ runId }: { runId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [run, setRun] = useState<ExperimentRun>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!expanded || run) return;
    let current = true;
    void experimentApi.get(runId).then(value => { if (current) { setRun(value); setError(''); } }).catch((reason: Error) => { if (current) setError(reason.message); });
    return () => { current = false; };
  }, [expanded, run, runId]);
  return <details className="cti-advanced" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>Preview layers</summary>
    {expanded && <>
      {error ? <p role="alert">{error} Close and reopen this preview to try again.</p> : !run ? <p role="status">Loading layers…</p> : <>
        <div className="cti-layer-previews">{(run.outputLayers ?? run.layers ?? []).map(layer => <figure key={layer.file}>
          <img src={experimentFileUrl(run.id, layer.file)} alt={layer.name ?? `Layer ${layer.zIndex}`} loading="lazy" />
          <figcaption>{layer.name ?? `Layer ${layer.zIndex}`}{layer.placement.kind === 'unresolved' ? ' · placement needs review' : ''}</figcaption>
        </figure>)}</div>
        {run.warnings.map(warning => <p key={warning} className="ws-hint">{warning}</p>)}
        <p className="ws-hint">Each output opens as an image layer you can move, resize or replace. Text within an image remains pixels.</p>
      </>}
    </>}
  </details>;
}
