import { useState, type ReactNode } from 'react';
import { AI_PRICING, type CostAmount, type DiagnosticPrompt, type DiagnosticStage, type RunDiagnostics } from '@frameflow/shared';
import { editorLayersOf, experimentFileUrl, type BackgroundStep, type ExperimentLayer, type ExperimentRun } from './layerizeExperiment';
import './runDashboard.css';

export const rupees = (value: number) => `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export function costText(cost: CostAmount) {
  return cost.inr === null ? `${rupees(cost.knownInr)} known + unknown` : `${cost.confidence} ${rupees(cost.inr)}`;
}
/** Don't mount hidden thumbnails, prompts or large debug trees until explicitly opened. */
export function DiagnosticDisclosure({ title, children, className = '' }: { title: string; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  return <details className={`lx-disclosure ${className}`} onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>{title}</summary>{open && <div className="lx-disclosure-body">{children}</div>}
  </details>;
}
function Prompt({ prompt }: { prompt: DiagnosticPrompt }) {
  const [copy, setCopy] = useState('Copy');
  return <DiagnosticDisclosure title={prompt.label}>
    <div className="lx-row"><span>{prompt.model ?? 'Model not recorded'} · {prompt.text.length.toLocaleString()} characters{prompt.inputTokens !== undefined && ` · ${prompt.inputTokens.toLocaleString()} total request input tokens`}</span>
      <button className="ws-btn" onClick={async () => {
        try { await navigator.clipboard.writeText(prompt.text); setCopy('Copied'); }
        catch { setCopy('Copy unavailable'); }
      }}>{copy}</button></div>
    {copy === 'Copy unavailable' && <p role="status">Select the prompt below and copy it manually; clipboard access is unavailable.</p>}
    <pre>{prompt.text}</pre>
  </DiagnosticDisclosure>;
}
const STEP_LABELS: Record<BackgroundStep['step'], string> = {
  'provider-base': 'Seedream base', 'scene-composite': 'Seedream scene layers', 'local-continuation': 'Local continuation', 'ai-reconstruction': 'AI reconstruction', fallback: 'Fallback',
};
export function displayLayer(layer: ExperimentLayer, run: ExperimentRun): { name: string; role: string } {
  const category = run.refinement?.curation?.entries.find(e => e.file === layer.file)?.category ?? layer.provenance?.role ?? '';
  const words = `${category} ${layer.name ?? ''}`;
  const role = layer.placement.kind === 'base' || layer.cleanBackground ? 'Background'
    : /person|woman|man\b|model|subject|portrait/i.test(words) ? 'Person'
    : /cta|button|call.to.action/i.test(words) ? 'CTA'
    : /text|headline|title|badge|copy|caption/i.test(words) ? 'Text'
    : /product|phone|bottle|speaker|watch|headphone|earbud/i.test(words) ? 'Product' : 'Decoration';
  const name = layer.name?.replace(/[_]+/g, ' ').replace(/\s*\((?:z\d+|pass \d+)\)\s*$/i, '').trim();
  return { role, name: !name || /^(?:layer[ -]?\d+|provider base|generated base|fallback helper)$/i.test(name) ? role === 'Background' ? 'Background' : `${role} element` : name };
}
function Usage({ stage }: { stage: DiagnosticStage }) {
  if (!stage.calls.length) return <span>{stage.id === 'curation' || stage.id === 'editor' ? 'Local processing' : 'No paid call'}</span>;
  return <>{stage.calls.map((call, i) => <div key={i}>
    <div>{call.model ?? 'Model not recorded'}{call.quality ? ` · ${call.quality}` : ''}</div>
    <small>{call.usage?.inputTokens !== undefined && <>{call.usage.inputTokens.toLocaleString()} in / {call.usage.outputTokens?.toLocaleString() ?? '?'} out tokens</>}
      {call.rawLayers !== undefined && `${call.rawLayers} billable raw layers`}{call.imageCount !== undefined && ` · ${call.imageCount} image(s)`}</small>
  </div>)}</>;
}
export function dashboardStatus(run: ExperimentRun, editorCount: number) {
  if (run.stage === 'failed') return 'FAILED';
  if (run.stage !== 'done' || run.active) return 'RUNNING';
  const bg = run.refinement?.background;
  return run.warnings.some(w => w.startsWith('TEMPLATE_')) || !editorCount || run.refinement?.state === 'failed' || bg?.contaminated || bg?.status === 'fallback' || (bg?.quality && bg.quality !== 'usable') ? 'PARTIAL' : 'READY FOR EDITOR';
}
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const duration = (ms: number | null | undefined) => ms === null || ms === undefined ? 'Not recorded' : `${Math.floor(ms / 60000)}m ${Math.floor(ms / 1000) % 60}s`;
const marks = { Complete: '✓', Running: '◉', Skipped: '—', Failed: '×', Warning: '!', Pending: '○' };
const methods: Record<string, string> = { 'provider-base': 'Provider base', 'scene-composite': 'Scene composite', 'plain-field': 'Local continuation', 'ai-reconstruction': 'AI reconstruction', 'graphic-fill': 'Local graphic fill', 'local-fill': 'Local fallback' };
export function RunDashboard({ run, diagnostics: d, loadingError, actions, developer }: {
  run: ExperimentRun; diagnostics?: RunDiagnostics; loadingError?: string; actions?: ReactNode; developer?: ReactNode;
}) {
  let layers: ExperimentLayer[] = [];
  try { if (run.stage === 'done') layers = editorLayersOf(run) ?? []; } catch { /* Invalid saved selection is partial, never raw fallback. */ }
  const status = dashboardStatus(run, layers.length), f = (name: string) => experimentFileUrl(run.id, name);
  const residual = d?.stages.find(s => s.id === 'residual'), background = d?.stages.find(s => s.id === 'background');
  const bg = run.refinement?.background, counts = run.refinement?.curation?.counts;
  const seedream = d?.stages.find(s => s.id === 'seedream');
  const largest = d?.stages.reduce<DiagnosticStage | undefined>((best, s) => !best || s.cost.knownInr > best.cost.knownInr ? s : best, undefined);
  const failedStage = d?.stages.find(s => s.status === 'Failed');
  const failurePoint: Record<string, string> = { uploading: 'Image upload', downloading: 'Layer download or local rendering', refining: 'Layer refinement', planning: 'Layer planning', submitting: 'Provider submission', queued: 'Seedream layerization', in_progress: 'Seedream layerization' };
  const target = AI_PRICING.targetInr;
  return <main className="lx-dashboard" aria-label="Decomposition diagnostics">
    <section className="lx-card lx-summary" aria-label="Run summary">
      <div className="lx-row"><div><p className="lx-eyebrow">Decomposition result · {run.templateKey ?? 'Template A'}</p><h2>Image to editor layers</h2></div>
        <span className={`lx-badge lx-${status === 'FAILED' ? 'failed' : status === 'PARTIAL' ? 'warning' : status === 'RUNNING' ? 'running' : 'complete'}`} role="status">{status}</span></div>
      <p className="lx-muted lx-run-id">{new Date(run.createdAt).toLocaleString()} · Run {run.id}</p>
      <div className="lx-stats">
        <div className="lx-total"><span>{run.stage === 'failed' ? 'AI cost so far' : status === 'RUNNING' ? 'AI cost so far' : 'Total AI cost'}</span><strong data-testid="run-cost">{d ? costText(d.total) : loadingError ? 'Unavailable' : 'Loading usage…'}</strong><small>Target ₹{target.min}–₹{target.max}{d?.total.inr !== null && d?.total.inr !== undefined && d.total.inr > target.max ? ` · ${rupees(d.total.inr - target.max)} above` : ''}</small></div>
        <div><span>Paid API calls</span><strong>{d ? `${d.calls}${d.callsMeasured ? '' : ' inferred'}` : '—'}</strong></div>
        <div><span>Raw → Editor layers</span><strong data-testid="layer-story">{d?.rawLayers ?? '—'} → {layers.length}</strong></div>
        <div><span>Residual passes</span><strong>{residual?.calls.length ?? '—'}</strong></div>
        <div><span>Background AI edit</span><strong>{background ? background.calls.length ? `Yes · ${background.calls.length}` : 'No' : '—'}</strong></div>
        <div><span>Total recorded runtime</span><strong>{duration(d?.elapsedMs)}</strong></div>
      </div>
      {run.stage === 'failed' && <div className="lx-message lx-failure" role="alert"><p>{`${failedStage?.label ?? failurePoint[run.error?.stage ?? ''] ?? 'Processing'} failed. `}{run.error?.code === 'PROVIDER_DECOMPOSITION_REJECTED'
        ? 'Seedream could not produce a valid decomposition. No raw layers were returned.' : run.error?.code === 'PROVIDER_SAFETY_REJECTED' ? 'The provider withheld the result after its safety check. Choose a different image.' : 'The run stopped before editor layers were ready.'}</p>
        {run.error?.provider && <p>Provider response (HTTP {run.error.provider.status}): {run.error.provider.messages.map(m => m.msg).join(' ')}</p>}
        {run.error?.code === 'PROVIDER_DECOMPOSITION_REJECTED' && <p>This request is final; Resume cannot recover it. Retry extraction reuses the saved plan without another planner call, but makes a new paid Seedream request and may fail again. You can also choose a different image or template.</p>}
        <p>Technical details are available below.</p></div>}
      {status === 'PARTIAL' && <p className="lx-message">The result needs manual review. Check background quality and the final layers before using it.</p>}
      {loadingError && <p className="lx-message" role="alert">Recorded usage could not be loaded. Reopen this run to retry. Costs are unavailable.</p>}
      <div className="lx-actions">{actions}</div>
    </section>
    {d?.execution && <section className="lx-card" aria-label="Reusable template"><h3>Reusable template</h3>
      <p><strong>{d.execution.template?.name ?? 'New template'} {d.execution.template && `v${d.execution.template.version}`}</strong></p>
      <div className="lx-stats">
        <div><span>Generation prompt</span><strong>{d.execution.generationPromptSource === 'saved-template' ? 'Reused locally · ₹0' : d.execution.generationPromptSource === 'planner' ? 'Captured with first plan' : 'No image edit requested'}</strong></div>
        <div><span>Decomposition plan</span><strong>{d.execution.decompositionPlanSource === 'saved-template' ? 'Reused · ₹0' : d.execution.plannerReason === 'plan-fresh' ? 'Planner: user chose Plan fresh' : 'Planner: new structure'}</strong></div>
        <div><span>GPT planner</span><strong>{d.execution.plannerCallsAvoided ? 'Skipped · 0 calls' : `${d.stages.find(s => s.id === 'planner')?.calls.length ?? 0} calls`}</strong></div>
      </div>
      {d.execution.inspection && <p>{d.execution.inspection.reason}</p>}
      <p>{plural(d.execution.plannerCallsAvoided, 'planner call')} avoided. {d.reuseSaving ? `Estimated saving: ${rupees(d.reuseSaving.knownInr)} using typical planner usage.` : 'No verified monetary saving available.'}</p>
      <DiagnosticDisclosure title="Reuse details"><p>{d.execution.mode} · {d.execution.executionId}</p><p>{d.reuseSaving?.notes.join(' ')}</p><p>Comparison estimates are never subtracted from actual run costs.</p></DiagnosticDisclosure>
    </section>}
    <section className="lx-card"><h3>Original / final comparison</h3><div className="lx-comparison">
      <figure><figcaption>Original <small>{run.original.width}×{run.original.height}</small></figcaption><img src={f(run.original.file)} alt="Original upload" /></figure>
      <figure><figcaption>Final reconstructed <small>{run.canvas && `${run.canvas.width}×${run.canvas.height}`}</small></figcaption>{run.stage === 'done' && layers.length ? <img src={`${f('reconstructed.png')}?${run.timings.renderMs ?? ''}`} alt="Reconstruction" /> : <div className="lx-placeholder">{status === 'FAILED' ? 'No completed reconstruction' : 'Waiting for completed layers'}</div>}</figure>
    </div></section>
    <section className="lx-card" aria-label="Final editor layers"><div className="lx-row"><h3>Final editor layers <span className="lx-count">{layers.length}</span></h3><span className="lx-muted">What “Open in editor” imports</span></div>
      {counts && <DiagnosticDisclosure title="Layer curation details"><p className="lx-note">{counts.rawLayers} raw AI layers → {counts.editorLayers} editor layers · {Math.max(0, counts.rawLayers - counts.editorLayers)} fewer layers after curation. Raw dispositions: {counts.merged} merged · {counts.background} background · {counts.internal} internal · {counts.dropped} dropped. Final layers can combine several raw candidates.</p></DiagnosticDisclosure>}
      <div className="lx-layer-grid" data-testid="editor-layer-grid">{layers.map(layer => { const display = displayLayer(layer, run); return <figure className="lx-layer" key={layer.file}>
        <a href={f(layer.file)} target="_blank" rel="noreferrer"><img src={f(layer.file)} alt={display.name} loading="lazy" /></a><figcaption><strong>{display.name}</strong><span className="lx-role">{display.role}</span>{layer.provenance && <small>Seedream pass {layer.provenance.sourcePass}</small>}</figcaption>
      </figure>; })}</div>{!layers.length && <p className="lx-muted">Editor layers will appear after a successful run.</p>}
    </section>
    {d && <>
      <section className="lx-card" aria-label="Pipeline"><h3>Pipeline</h3><ol className="lx-pipeline">{d.stages.filter(s => s.id !== 'fit' || s.calls.length).map(stage => <li key={stage.id} className={`lx-${stage.status.toLowerCase()}`}>
        <span className="lx-step-mark" aria-hidden="true">{marks[stage.status]}</span><strong>{stage.label}</strong><span>{stage.status}</span><small>{stage.result}</small>
      </li>)}</ol></section>
      <section className="lx-card" aria-label="Cost breakdown"><div className="lx-row"><h3>AI cost for this image</h3><span className="lx-muted">API calls · {d.callsMeasured ? 'Recorded' : 'Inferred where counters are missing'}</span></div>
        <div className="lx-cost-table"><table><thead><tr><th>Stage / model / usage</th><th>Calls</th><th>Cost</th></tr></thead><tbody>{d.stages.filter(s => s.id !== 'editor').map(stage => <tr key={stage.id} data-testid={`cost-${stage.id}`}>
          <td><strong>{stage.label}</strong><span className="lx-inline-status">{stage.status}</span><div className="lx-muted"><Usage stage={stage} /></div></td>
          <td>{stage.calls.length}</td><td><strong>{stage.cost.inr === null ? 'Unknown' : rupees(stage.cost.inr)}</strong><small>{stage.cost.confidence}{stage.cost.inr === null && stage.cost.knownInr > 0 ? ` · ${rupees(stage.cost.knownInr)} known` : ''}</small></td>
        </tr>)}</tbody><tfoot><tr><th>Total</th><td>{d.calls}</td><td data-testid="breakdown-total">{costText(d.total)}</td></tr></tfoot></table></div>
        <div className="lx-target" data-testid="cost-target"><strong>Cost target · ₹{target.min}–₹{target.max} / image</strong><span>{d.total.inr === null ? d.total.knownInr > target.max ? `Known subtotal already above ₹${target.max} by ${rupees(d.total.knownInr - target.max)}; additional charges unknown` : 'Comparison pending: some charges are unknown'
          : d.total.inr > target.max ? `Above ₹${target.max} target by ${rupees(d.total.inr - target.max)}` : d.total.inr < target.min ? `Below ₹${target.min} target by ${rupees(target.min - d.total.inr)}` : 'Within target'}</span></div>
        {largest?.id === 'seedream' && seedream?.calls[0]?.rawLayers && <p className="lx-note">{seedream.calls[0].rawLayers} initial raw layers are the largest known cost contributor. Curation does not reduce billed layers.</p>}
        {residual && residual.calls.length > 0 && <p className="lx-note">Recursive cleanup added {costText(residual.cost)}.</p>}
        {background && background.calls.length > 0 && <p className="lx-note">Background recovery added {costText(background.cost)}.</p>}
        <p className="lx-muted">Using project budget rate: ₹{d.fx} / $ · Rate card {d.pricingVersion}</p>
        <DiagnosticDisclosure title="Cost accounting details"><p className="lx-muted">Costs are calculated from recorded usage and configured provider rates. Provider invoice may differ due to taxes, billing adjustments, FX/payment fees, or rate changes. Call counts include attempted requests; an unknown charge requires checking provider billing.</p>
        {d.notes.map(note => <p className="lx-note" key={note}>{note}</p>)}</DiagnosticDisclosure>
      </section>
    </>}
    <div className="lx-two-cards">
      <section className="lx-card" aria-label="Background"><h3>Background</h3><strong>{bg ? bg.quality !== 'usable' || bg.contaminated ? 'Needs review' : bg.status === 'ai-reconstructed' ? 'AI reconstructed' : 'Clean' : run.stage === 'done' ? 'Legacy result · quality not recorded' : 'Not ready'}</strong>
        <p>{bg ? methods[bg.method] ?? bg.method : 'See final reconstruction'}</p><p>AI calls: {background?.calls.length ?? '—'} · {background ? costText(background.cost) : 'Cost unavailable'}</p>
        {background?.calls.map((c, i) => <p className="lx-muted" key={i}>{c.model ?? 'Model not recorded'}</p>)}
        {bg?.quality && bg.quality !== 'usable' && <p className="lx-message">Background quality is {bg.quality}. Review the recovered area.</p>}
        {bg?.steps && <DiagnosticDisclosure title="Why each recovery step ran or was skipped"><ol className="lx-steps" aria-label="Background recovery steps">{bg.steps.map(step => <li key={step.step} data-outcome={step.outcome}>
          <strong>{STEP_LABELS[step.step]}: {step.outcome}{step.call ? ' · 1 paid call' : ''}</strong><span>{step.reason}</span></li>)}</ol>
          {bg.trust && <p className="lx-muted">Local continuation {bg.trust.trusted ? 'trusted' : 'not trusted'}: {bg.trust.reason}</p>}</DiagnosticDisclosure>}
      </section>
      <section className="lx-card" aria-label="Recursive cleanup"><h3>Recursive cleanup</h3><strong>{residual?.calls.length ?? '—'} / {run.refinement?.options.maxDepth ?? 0} passes used</strong>
        <p>{residual?.result ?? 'Usage not loaded'}</p><p>Additional raw layers: {residual?.calls.length ? residual.calls.every(c => c.rawLayers !== undefined) ? residual.calls.reduce((n, c) => n + c.rawLayers!, 0) : 'Unknown' : 0}</p>
        <p>Extra Seedream cost: {residual ? costText(residual.cost) : 'Unavailable'}</p>
        {run.refinement?.stopDetail && <p className="lx-muted" data-testid="recursion-decision">Why: {run.refinement.stopDetail}</p>}
      </section>
    </div>
    <section className="lx-card lx-debug" aria-label="Debug tools"><h3>Inspect details</h3>
      <DiagnosticDisclosure title={`Raw / internal layers (${d?.rawLayers ?? 'unknown'})`}><div className="lx-layer-grid" data-testid="raw-layer-grid">{d?.raw.map(layer => <figure className="lx-layer" key={layer.file}>
        <a href={f(layer.file)} target="_blank" rel="noreferrer"><img src={f(layer.file)} alt={layer.name} loading="lazy" /></a><figcaption><strong>{layer.name}</strong><span className="lx-role">{({ merge: 'Merged', drop: 'Dropped' } as Record<string, string>)[layer.disposition] ?? layer.disposition}</span><small>Seedream pass {layer.pass}</small><p>{layer.reasons.join(' ')}</p></figcaption>
      </figure>)}</div>{!d?.raw.length && <p>Raw layer artifacts are unavailable for this run.</p>}</DiagnosticDisclosure>
      {d?.prompts.map(prompt => <Prompt key={prompt.label} prompt={prompt} />)}
      <DiagnosticDisclosure title="Developer details">
        {d && <><h4>Request IDs and cost evidence</h4>{d.stages.map(s => <div key={s.id}><strong>{s.label}</strong>{s.calls.map((c, i) => <div key={i}>{c.model ?? 'Unknown model'} · Request {c.requestId ?? 'not recorded'}<pre>{JSON.stringify(c.usage ?? { rawLayers: c.rawLayers, baseWidth: c.baseWidth, baseHeight: c.baseHeight }, null, 2)}</pre></div>)}{s.cost.notes.map((note, i) => <p key={i}>{note}</p>)}</div>)}
          <p>Pricing sources: {d.sources.map((url, i) => <a key={url} href={url} target="_blank" rel="noreferrer">{i ? ' · ' : ''}{new URL(url).pathname.split('/').at(-1)}</a>)}</p></>}
        <DiagnosticDisclosure title="Advanced details · metrics, artifacts and run controls">{developer}</DiagnosticDisclosure>
      </DiagnosticDisclosure>
    </section>
  </main>;
}
