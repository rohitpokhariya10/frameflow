import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Layers, Trash2 } from 'lucide-react';
import { avoidedPlannerCost, SEPARABLE_ROLES, TEMPLATE_ROLE_LABELS, ZONE_PHRASES, type CreativeTemplate, type TemplateExecution, type TemplateHealth, type TemplateVersion } from '@frameflow/shared';
import { extractionEstimate, type ShownExecution } from './templateWizard';

const BASE = '/api/layerize-experiment';
export const NAME_LIMIT = 60, DESCRIPTION_LIMIT = 240;
type Details = { template: CreativeTemplate; version: TemplateVersion; versions: { version: number; createdAt: string; derivedFrom?: TemplateVersion['derivedFrom']; runs: number }[]; executions: TemplateExecution[]; health: TemplateHealth };
type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
const json = (body: unknown): RequestInit => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const MODE: Record<TemplateExecution['mode'], string> = { CREATE_TEMPLATE: 'Created', REUSE_TEMPLATE_ORIGINAL: 'Original image', REUSE_TEMPLATE_WITH_EDIT: 'Generated creative' };

/** Name and description as the server stores them, with the reason it would refuse them. */
export function textProblems(name: string, description: string): string[] {
  const clean = (value: string) => value.replace(/\s+/g, ' ').trim(), problems: string[] = [];
  if (!clean(name) || clean(name).length > NAME_LIMIT) problems.push(`A name is 1–${NAME_LIMIT} characters.`);
  if (clean(description).length > DESCRIPTION_LIMIT) problems.push(`A description is at most ${DESCRIPTION_LIMIT} characters.`);
  if (/[{}<>]/.test(name + description)) problems.push('Use plain text, without { } < >.');
  return problems;
}

/** A confirmation that stays inside the panel: focus starts on Cancel, Escape cancels. */
function Confirm({ title, children, confirm, danger, onConfirm, onCancel, busy }: { title: string; children: React.ReactNode; confirm: string; danger?: boolean; onConfirm: () => void; onCancel: () => void; busy: boolean }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancel.current?.focus(); }, []);
  return <div className="tw-confirm-backdrop"><div role="alertdialog" aria-modal="true" aria-labelledby="tw-confirm-title" className="tw-confirm" onKeyDown={e => { if (e.key === 'Escape') onCancel(); }}>
    <h3 id="tw-confirm-title">{title}</h3>{children}
    <div className="tw-actions"><button ref={cancel} className="ws-btn" onClick={onCancel} disabled={busy}>Cancel</button><button className={`ws-btn ${danger ? 'ws-btn-danger' : 'ws-btn-primary'}`} onClick={onConfirm} disabled={busy}>{confirm}</button></div>
  </div></div>;
}

/**
 * One saved template: what it is, its versions and recent runs, and the edits it supports. Names change in place;
 * plan settings always save a new version (runs keep the one they used); an update of the plan is an explicit, priced
 * new plan of the source creative; deleting needs a confirmation and keeps every saved run.
 */
export function TemplateDetails({ id, request, onBack, onChanged, onDeleted, onReplanned }: { id: string; request: Request; onBack: () => void; onChanged: () => void; onDeleted: (id: string) => void; onReplanned: (e: ShownExecution) => void }) {
  const [details, setDetails] = useState<Details>(), [error, setError] = useState(''), [status, setStatus] = useState(''), [busy, setBusy] = useState(false);
  const [name, setName] = useState(''), [description, setDescription] = useState('');
  const [separate, setSeparate] = useState<Record<string, boolean>>({}), [refinement, setRefinement] = useState(true), [range, setRange] = useState({ min: 1, max: 1 });
  const [confirming, setConfirming] = useState<'delete' | 'replan'>();
  const apply = useCallback((d: Details) => {
    setDetails(d); setName(d.template.name); setDescription(d.template.description);
    setSeparate(Object.fromEntries(d.version.structure.layers.filter(l => SEPARABLE_ROLES.includes(l.role)).map(l => [l.id, l.independent])));
    setRefinement(d.version.decomposition.refinement); setRange(d.version.decomposition.expectedEditorLayers);
  }, []);
  const load = useCallback(() => request<Details>(`/templates/${id}`).then(apply), [id, request, apply]);
  useEffect(() => {
    let live = true;
    void request<Details>(`/templates/${id}`).then(d => { if (live) apply(d); }).catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [id, request, apply]);
  const act = async (work: () => Promise<void>) => {
    setBusy(true); setError(''); setStatus('');
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : 'Request failed.'); } finally { setBusy(false); }
  };
  if (!details) return <section className="tw-details" aria-label="Template details">{error ? <p role="alert" className="tw-alert">{error}</p> : <p role="status">Loading template…</p>}</section>;
  const { template, version, versions, executions, health } = details;
  const problems = textProblems(name, description), textChanged = name.replace(/\s+/g, ' ').trim() !== template.name || description.replace(/\s+/g, ' ').trim() !== template.description;
  const layers = [...version.structure.layers].sort((a, b) => a.order - b.order), parentOf = (parent?: string) => layers.find(l => l.id === parent);
  const changedLayers = Object.fromEntries(Object.entries(separate).filter(([layer, own]) => layers.find(l => l.id === layer)?.independent !== own));
  const rangeValid = Number.isInteger(range.min) && Number.isInteger(range.max) && range.min >= 1 && range.max <= 40 && range.min <= range.max;
  const settingsChanged = Object.keys(changedLayers).length > 0 || refinement !== version.decomposition.refinement || range.min !== version.decomposition.expectedEditorLayers.min || range.max !== version.decomposition.expectedEditorLayers.max;
  const estimate = extractionEstimate(version.plan.recommendedLayers), plannerInr = avoidedPlannerCost(1).inr ?? 0;
  const saveText = () => void act(async () => { await request(`/templates/${id}`, { method: 'PATCH', ...json({ name, description }) }); await load(); onChanged(); setStatus('Name and description saved.'); });
  const saveSettings = () => void act(async () => {
    const saved = await request<{ version: TemplateVersion }>(`/templates/${id}/versions`, { method: 'POST', ...json({ fromVersion: version.version, ...(Object.keys(changedLayers).length ? { separateLayers: changedLayers } : {}),
      ...(refinement !== version.decomposition.refinement ? { refinement } : {}), expectedEditorLayers: range }) });
    await load(); onChanged(); setStatus(`Saved as v${saved.version.version}. Runs that used v${version.version} keep it.`);
  });
  const remove = () => void act(async () => { await request(`/templates/${id}`, { method: 'DELETE' }); setConfirming(undefined); onDeleted(id); });
  const replan = () => void act(async () => { const e = await request<ShownExecution>(`/templates/${id}/replan`, { method: 'POST', ...json({ idempotencyKey: crypto.randomUUID() }) }); setConfirming(undefined); onReplanned(e); });

  return <section className="tw-details" aria-label="Template details">
    <div className="tw-details-head"><button className="ws-btn" onClick={onBack} disabled={busy}><ArrowLeft size={15} /> Template library</button>
      <button className="ws-btn ws-btn-danger" onClick={() => setConfirming('delete')} disabled={busy}><Trash2 size={15} /> Delete template</button></div>
    {error && <p role="alert" className="tw-alert">{error}</p>}{status && <p role="status" className="tw-saved">{status}</p>}
    <div className="tw-details-grid">
      <section className="tw-pane" aria-label="About this template">
        <div className="tw-details-thumb">{template.thumbnail ? <img src={`${BASE}/templates/${id}/thumbnail`} alt={`${template.name} source creative`} /> : <Layers size={40} />}</div>
        <p className="tw-muted">v{template.currentVersion} · {versions.length} version{versions.length === 1 ? '' : 's'} · reused {template.stats.reuses}× · created {new Date(template.createdAt).toLocaleDateString()}</p>
        <label className="tw-field"><span>Name</span><input aria-label="Template name" value={name} maxLength={NAME_LIMIT + 20} onChange={e => setName(e.target.value)} disabled={busy} /></label>
        <label className="tw-field"><span>Description <small>{description.replace(/\s+/g, ' ').trim().length}/{DESCRIPTION_LIMIT}</small></span><textarea aria-label="Template description" value={description} rows={3} onChange={e => setDescription(e.target.value)} disabled={busy} /></label>
        {textChanged && problems.map(p => <p key={p} className="tw-field-error" role="alert">{p}</p>)}
        <div className="tw-actions"><button className="ws-btn ws-btn-primary" onClick={saveText} disabled={busy || !textChanged || problems.length > 0}>Save name and description</button></div>
        <h3>Versions</h3>
        <ol className="tw-versions">{[...versions].reverse().map(v => <li key={v.version}><strong>v{v.version}</strong> · {new Date(v.createdAt).toLocaleString()}{v.derivedFrom ? ` · from v${v.derivedFrom.version}: ${v.derivedFrom.change}` : ' · learned from its source creative'} · {v.runs} run{v.runs === 1 ? '' : 's'}</li>)}</ol>
        <h3>Recent runs</h3>
        {executions.length ? <ul className="tw-versions">{executions.map(e => <li key={e.id}>{new Date(e.createdAt).toLocaleString()} · {MODE[e.mode]} · v{e.template?.version ?? '?'} · {e.state}</li>)}</ul> : <p className="tw-muted">No runs yet.</p>}
      </section>
      <section className="tw-pane" aria-label="Plan settings">
        <h3>Layers and plan</h3>
        <div className={`tw-health is-${health.status}`} role="note"><strong>{health.status === 'ok' ? 'The plan names every layer its runs show' : health.status === 'plan-incomplete' ? 'The plan may be incomplete' : 'Not checked yet'}</strong>
          {health.issues.map(issue => <p key={issue}>{issue}</p>)}<small>Read from {health.checkedRuns} run{health.checkedRuns === 1 ? '' : 's'}; no call.</small>
          {health.status === 'plan-incomplete' && <button className="ws-btn" onClick={() => setConfirming('replan')} disabled={busy}>Update plan from the source creative</button>}</div>
        <ul className="tw-layer-list" aria-label="Template layers">{layers.map(l => {
          const zone = l.zone && l.zone !== 'full-canvas' ? ` · ${ZONE_PHRASES[l.zone].replace(/^(at|on|in) the /, '')}` : '', role = TEMPLATE_ROLE_LABELS[l.role];
          return <li key={l.id}><span><b>{role}</b><small>{l.id}{zone}</small></span>{SEPARABLE_ROLES.includes(l.role)
            ? <label className="tw-check"><input type="checkbox" aria-label={`${role} (${l.id}) is its own layer`} checked={separate[l.id] ?? l.independent} disabled={busy} onChange={e => setSeparate(s => ({ ...s, [l.id]: e.target.checked }))} />Own layer</label>
            : <small>{l.independent ? 'Always its own layer' : `Kept with ${TEMPLATE_ROLE_LABELS[parentOf(l.attachment?.parent)?.role ?? 'background'].toLowerCase()}`}</small>}</li>;
        })}</ul>
        <label className="tw-check"><input type="checkbox" checked={refinement} onChange={e => setRefinement(e.target.checked)} disabled={busy} />Clean up after extraction<small>Finds missed objects and rebuilds a clean background when needed; may add provider calls.</small></label>
        <div className="tw-range"><label className="tw-field"><span>Min layers</span><input type="number" aria-label="Expected editor layers, minimum" min={1} max={40} value={range.min} onChange={e => setRange(r => ({ ...r, min: Number(e.target.value) }))} disabled={busy} /></label>
          <label className="tw-field"><span>Max layers</span><input type="number" aria-label="Expected editor layers, maximum" min={1} max={40} value={range.max} onChange={e => setRange(r => ({ ...r, max: Number(e.target.value) }))} disabled={busy} /></label></div>
        {!rangeValid && <p className="tw-field-error" role="alert">Expected layers are whole numbers from 1 to 40, with min ≤ max.</p>}
        <p className="tw-muted">Saving creates v{template.currentVersion + 1}. The plan is rebuilt locally (0 planner calls); runs that used earlier versions keep them.</p>
        <div className="tw-actions"><button className="ws-btn ws-btn-primary" onClick={saveSettings} disabled={busy || !settingsChanged || !rangeValid}>Save settings as a new version</button></div>
        <details className="tw-prompt"><summary>Decomposition plan · v{version.version}</summary><p className="tw-muted">{version.plan.strategy}</p><textarea aria-label="Decomposition plan" readOnly value={version.plan.prompt} rows={5} /></details>
      </section>
    </div>
    {confirming === 'delete' && <Confirm title={`Delete “${template.name}”?`} confirm="Delete template" danger busy={busy} onConfirm={remove} onCancel={() => setConfirming(undefined)}>
      <p>It leaves the library and can no longer be used for new creatives.</p><p>Saved runs, their images and layers, and this template's versions stay available in Saved Runs.</p></Confirm>}
    {confirming === 'replan' && <Confirm title="Update the plan from the source creative?" confirm="Update plan" busy={busy} onConfirm={replan} onCancel={() => setConfirming(undefined)}>
      <p>One planner call (about ₹{plannerInr.toFixed(2)}) plans the source creative again, then one Seedream extraction (about ₹{estimate.seedreamInr.toFixed(2)}, billed by the layers returned) checks it. The result is saved as v{template.currentVersion + 1}; earlier versions and their runs stay as they are.</p></Confirm>}
  </section>;
}
