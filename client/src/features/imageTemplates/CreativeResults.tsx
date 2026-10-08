import { useState } from 'react';
import { CircleAlert, ExternalLink, Layers, LoaderCircle, Plus, RotateCcw } from 'lucide-react';
import { IMAGE_TEMPLATE_LIMITS, IMAGE_TEMPLATE_RATIO_NAMES, type ImageTemplateRatio } from '@frameflow/shared';
import { LayerPreview } from '../decomposition/LayerPreview';
import '../decomposition/workspace/workspace.css';
import './imageTemplates.css';
import { referenceUrl, RESULT_STATUS_LABELS, resultImageUrl, resultStatus, type ImageTemplate, type ImageTemplateVariant } from './imageTemplates';

const spinner = <LoaderCircle size={16} className="ws-spin" aria-hidden="true" />;

/** A generated reference creative: what it was made from, and one card per size with its status and its next step. */
export function CreativeResults({ template, busy, openError, onRename, onGenerateRatio, onDecompose, onResume, onOpen }: {
  template: ImageTemplate; busy: string; openError?: { variantId: string; message: string }; onRename: (name: string) => void;
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
            <input className="cti-input" aria-label="Creative name" value={renaming} maxLength={IMAGE_TEMPLATE_LIMITS.name} autoFocus onChange={event => setRenaming(event.target.value)} />
            <button className="ws-btn ws-btn-primary" type="submit" disabled={!renaming.trim()}>Save</button><button className="ws-btn ws-btn-quiet" type="button" onClick={() => setRenaming(null)}>Cancel</button></form>}
        <div className="cti-meta">Created {new Date(template.createdAt).toLocaleString()} · {template.aspectRatios.join(' · ')}{template.promptEdited ? ' · prompt edited' : ''}</div>
        <details className="cti-advanced"><summary>Prompt used{template.promptEdited ? ' (edited)' : ''}</summary><p className="cti-prompt-text" data-testid="prompt-used">{template.prompt}</p></details>
      </div>
    </header>

    <section aria-label="Results">
      <div className="cti-section-head"><h3>Results</h3>
        {ready.length > 1 && <button className="ws-btn" disabled={!!busy} onClick={() => onDecompose(ready)}><Layers size={16} aria-hidden="true" /> Decompose all ({ready.length})</button>}</div>
      <div className="cti-results">{shown.map(variant => <ResultCard key={variant.id} template={template} variant={variant} busy={busy}
        openError={openError?.variantId === variant.id ? openError.message : undefined}
        onGenerate={() => onGenerateRatio(variant)} onDecompose={() => onDecompose([variant])} onResume={() => onResume(variant)} onOpen={() => onOpen(variant)} />)}</div>
      {missing.length > 0 && <div className="cti-add">Add another size:
        {missing.map(variant => <button key={variant.id} className="ws-btn" disabled={!!busy} onClick={() => onGenerateRatio(variant)}><Plus size={14} aria-hidden="true" /> {variant.aspectRatio} {IMAGE_TEMPLATE_RATIO_NAMES[variant.aspectRatio as ImageTemplateRatio]}</button>)}
        <span className="ws-hint">1 paid image request each.</span></div>}
    </section>
  </div>;
}

function ResultCard({ template, variant, busy, openError, onGenerate, onDecompose, onResume, onOpen }: {
  template: ImageTemplate; variant: ImageTemplateVariant; busy: string; openError?: string; onGenerate: () => void; onDecompose: () => void; onResume: () => void; onOpen: () => void;
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
      {openError && <p className="cti-result-error" role="alert" data-testid={`open-error-${variant.id}`}>{openError}</p>}
      {(status === 'generated' || failure === 'decomposition') && <span className="ws-hint">Decomposing uses 1 OpenAI planner request and 1 paid Seedream call; if the base is still contaminated, up to 2 more Seedream calls and 1 OpenAI image edit clean it (at most 5 calls).</span>}
    </div>
  </article>;
}
