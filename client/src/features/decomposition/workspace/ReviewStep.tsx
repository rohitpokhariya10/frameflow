import { useEffect, useMemo, useRef, useState } from 'react';
import { Combine, Split, Eye, EyeOff, PenLine } from 'lucide-react';
import type { DecompositionJobSummary, DecompositionReview, ProposalReviewTarget } from '@frameflow/shared';
import { artifactUrl } from '../api';
import { submitReviewOnce } from '../reviewSubmission';
import { friendlyType, TYPE_ROLE, type FriendlyType } from '../flow';
import { Thumb, Toast, TypeChip } from './parts';
import { PaintCanvas } from './PaintCanvas';

type Draft = { targets: ProposalReviewTarget[]; memberMasks: Record<string, string[]> };
const TYPES: Exclude<FriendlyType, 'Choose type'>[] = ['Image', 'Text', 'Shape', 'Background'];
const firstSentence = (text?: string) => text?.split(/(?<=\.)\s/)[0];

/** Kept by default: a customer removes what they don't want rather than approving everything one by one. */
function initialDraft(job: DecompositionJobSummary, key: string): Draft {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null') as Draft | null;
    if (saved?.targets?.length) return saved;
  } catch { /* browser storage is optional */ }
  const targets = (job.proposalTargets ?? []).map(t => (!t.approved && !t.rejected ? { ...t, approved: true } : t));
  return { targets: [...targets.filter(t => !t.baseLayer), ...targets.filter(t => t.baseLayer)], memberMasks: {} };
}

export function ReviewStep({ job, onSubmit, busy }: { job: DecompositionJobSummary; onSubmit: (body: DecompositionReview) => Promise<void>; busy: boolean }) {
  const key = `frameflow:layer-review:${job.id}:${job.revision}`;
  const [draft, setDraft] = useState<Draft>(() => initialDraft(job, key));
  const { targets, memberMasks } = draft;
  const [activeId, setActiveId] = useState(targets[0]?.id ?? '');
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [combining, setCombining] = useState(false);
  const [combinedName, setCombinedName] = useState('');
  const [editingArea, setEditingArea] = useState(false);
  const [toast, setToast] = useState('');
  const [status, setStatus] = useState({ pending: false, error: '' }); const lock = useRef(false);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(draft)); } catch { /* optional */ } }, [key, draft]);
  useEffect(() => { if (!toast) return; const t = window.setTimeout(() => setToast(''), 3500); return () => window.clearTimeout(t); }, [toast]);
  const active = targets.find(t => t.id === activeId) ?? targets[0];
  const shown = targets.find(t => t.id === hoverId) ?? active;
  const proposalOf = (t: ProposalReviewTarget) => job.proposals?.find(p => p.id === t.proposalIds[0]);
  const masksOf = (t?: ProposalReviewTarget) => !t || t.baseLayer ? [] : t.maskArtifactId ? [t.maskArtifactId] : memberMasks[t.id] ?? [];
  const update = (id: string, change: Partial<ProposalReviewTarget>) => setDraft(d => ({ ...d, targets: d.targets.map(t => t.id === id ? { ...t, ...change } : t) }));
  const kept = targets.filter(t => t.approved && !t.rejected);
  const needsType = kept.filter(t => friendlyType(t).type === 'Choose type');
  const keptObjects = kept.filter(t => !t.baseLayer);
  const disabled = busy || status.pending;
  const blocker = !keptObjects.length ? 'Keep at least one layer to continue.' : needsType.length ? `Choose a type for ${needsType.map(t => `“${t.label}”`).join(', ')}.` : kept.some(t => !t.label.trim()) ? 'Every kept layer needs a name.' : '';
  const canCombine = checked.length >= 2 && checked.length <= 6;
  const combine = () => {
    const members = targets.filter(t => checked.includes(t.id) && !t.baseLayer);
    if (members.length < 2) return;
    const id = `target-${crypto.randomUUID()}`;
    const label = (combinedName.trim() || members.map(m => m.label).join(' + ')).slice(0, 100);
    const group: ProposalReviewTarget = { id, label, proposalIds: [...new Set(members.flatMap(m => m.proposalIds))].slice(0, 6), approved: true, rejected: false,
      memberTargetIds: members.filter(m => m.maskArtifactId).map(m => m.id), groupMode: 'group', role: 'object',
      points: members.flatMap(m => m.points ?? []).slice(-64), strokes: members.flatMap(m => m.strokes ?? []).slice(-100) };
    const masks = members.flatMap(m => masksOf(m));
    const at = targets.findIndex(t => t.id === members[0].id);
    const rest = targets.filter(t => !checked.includes(t.id));
    rest.splice(Math.min(at, rest.length), 0, group);
    setDraft({ targets: rest, memberMasks: { ...memberMasks, [id]: masks } });
    setChecked([]); setCombining(false); setCombinedName(''); setActiveId(id);
    setToast(`Combined ${members.length} layers into “${label}”`);
  };
  const split = (group: ProposalReviewTarget) => {
    const parts = group.proposalIds.map(pid => ({ ...group, id: `target-${crypto.randomUUID()}`, label: (job.proposals?.find(p => p.id === pid)?.label ?? group.label).slice(0, 100), proposalIds: [pid],
      groupMode: 'single' as const, memberTargetIds: undefined, maskArtifactId: undefined, provisionalMaskRevision: undefined, provenance: undefined, classification: undefined, role: 'unknown' as const, points: [], strokes: [], splitFromTargetId: group.id }));
    const at = targets.findIndex(t => t.id === group.id);
    const next = targets.filter(t => t.id !== group.id); next.splice(at, 0, ...parts);
    const masks = Object.fromEntries(parts.map(p => { const original = job.proposalTargets?.find(t => t.proposalIds.length === 1 && t.proposalIds[0] === p.proposalIds[0] && t.maskArtifactId); return [p.id, original?.maskArtifactId ? [original.maskArtifactId] : []]; }));
    setDraft({ targets: next, memberMasks: { ...memberMasks, ...masks } });
    setActiveId(parts[0].id); setToast(`Split into ${parts.length} layers`);
  };
  const send = (action: 'save-proposals' | 'approve-proposals') => void submitReviewOnce(lock, { expectedRevision: job.revision, action, targets: targets.map(({ classification: _c, ...t }) => { void _c; return t; }) }, async body => {
    await onSubmit(body); try { localStorage.removeItem(key); } catch { /* optional */ }
  }, setStatus);
  const moveActive = (delta: number) => {
    const index = targets.findIndex(t => t.id === active?.id), next = targets[Math.max(0, Math.min(targets.length - 1, index + delta))];
    if (next) { setActiveId(next.id); listRef.current?.querySelector<HTMLButtonElement>(`[data-layer="${next.id}"]`)?.focus(); }
  };
  const summary = useMemo(() => {
    const byType = (type: FriendlyType) => kept.filter(t => friendlyType(t).type === type).length;
    return `${kept.length} kept · ${byType('Image')} image${byType('Image') === 1 ? '' : 's'}, ${byType('Text')} text, ${byType('Shape')} shape${byType('Shape') === 1 ? '' : 's'}`;
  }, [kept]);

  return <div className="ws-grid">
    <aside className="ws-pane ws-list-pane" aria-label="Detected layers">
      <div className="ws-pane-head"><h3>Detected layers <span className="ws-count">{targets.length}</span></h3><p>Select two or more to combine them.</p></div>
      {!job.proposals?.length && <p className="ws-notice ws-list-notice" role="status">AI couldn’t find separate layers in this image. You can mark an area yourself with “Adjust area”, or try a different image.</p>}
      {checked.length > 0 && <div className="ws-selection-bar" role="region" aria-label="Selected layers">
        <strong>{checked.length} layer{checked.length === 1 ? '' : 's'} selected</strong>
        {combining
          ? <form className="ws-combine" onSubmit={e => { e.preventDefault(); combine(); }}>
              <label>Name (optional)<input autoFocus value={combinedName} maxLength={100} placeholder={targets.filter(t => checked.includes(t.id)).map(t => t.label).join(' + ')} onChange={e => setCombinedName(e.target.value)} /></label>
              <div className="ws-row"><button type="submit" className="ws-btn ws-btn-primary" disabled={!canCombine || disabled}>Combine</button><button type="button" className="ws-btn" onClick={() => setCombining(false)}>Cancel</button></div>
            </form>
          : <div className="ws-row"><button className="ws-btn ws-btn-primary" disabled={!canCombine || disabled} title={canCombine ? 'Merge the selected layers into one image' : 'Select at least two layers'} onClick={() => setCombining(true)}><Combine size={14} />Combine layers</button><button className="ws-btn" onClick={() => setChecked([])}>Clear</button></div>}
      </div>}
      <ul className="ws-layer-list" ref={listRef} onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); } if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); } }}>
        {targets.map(t => {
          const { type, suggested } = friendlyType(t), proposal = proposalOf(t), removed = t.rejected || !t.approved;
          return <li key={t.id} className={`ws-layer ${t.id === active?.id ? 'is-active' : ''} ${removed ? 'is-removed' : ''}`} onMouseEnter={() => setHoverId(t.id)} onMouseLeave={() => setHoverId(null)}>
            <input type="checkbox" aria-label={`Select ${t.label}`} disabled={t.baseLayer || disabled} checked={checked.includes(t.id)} onChange={e => setChecked(ids => e.target.checked ? [...ids, t.id] : ids.filter(id => id !== t.id))} />
            <button className="ws-layer-main" data-layer={t.id} aria-current={t.id === active?.id} onClick={() => { setActiveId(t.id); setEditingArea(false); }}>
              {t.baseLayer ? <Thumb artifactId={job.discovery?.baseLayer?.artifactId} /> : <Thumb artifactId={proposal?.artifactId} region={proposal?.bounds} width={proposal?.width} height={proposal?.height} />}
              <span className="ws-layer-text"><span className="ws-layer-name">{t.label || 'Untitled layer'}</span><span className="ws-layer-meta"><TypeChip type={type} suggested={suggested} />{t.groupMode === 'group' && <span className="ws-muted">Combined</span>}{removed && <span className="ws-muted">Removed</span>}</span></span>
            </button>
          </li>;
        })}
      </ul>
    </aside>

    <section className="ws-pane ws-preview-pane" aria-label="Design preview">
      {editingArea && active && !active.baseLayer
        ? <PaintCanvas label={`Adjust the area of ${active.label}`} sourceId={job.sourcePreviewArtifactId!} width={job.sourceWidth!} height={job.sourceHeight!} maskId={masksOf(active)[0]}
            edits={{ points: active.points, strokes: active.strokes, box: active.userBox }} onChange={edits => update(active.id, { points: edits.points, strokes: edits.strokes, userBox: edits.box })} disabled={disabled} />
        : <div className="ws-preview" style={{ aspectRatio: `${job.sourceWidth} / ${job.sourceHeight}`, width: `min(100%, calc((100vh - var(--ws-chrome, 250px)) * ${(job.sourceWidth ?? 1) / (job.sourceHeight ?? 1)}))` }}>
            <img src={artifactUrl(job.sourcePreviewArtifactId!)} alt="Your design" className={masksOf(shown).length ? 'is-dimmed' : ''} />
            {masksOf(shown).map(id => <div key={id} className="ws-highlight" style={{ maskImage: `url("${artifactUrl(id)}")`, WebkitMaskImage: `url("${artifactUrl(id)}")` }}><img src={artifactUrl(job.sourcePreviewArtifactId!)} alt="" /></div>)}
            {shown && <span className="ws-preview-label">{shown.label}{shown.baseLayer ? ' · whole background' : ''}</span>}
          </div>}
    </section>

    <aside className="ws-pane ws-inspector-pane" aria-label="Layer settings">
      {active ? <div className="ws-inspector">
        <h3 className="ws-inspector-title">{active.baseLayer ? 'Background' : 'Layer'}</h3>
        {active.baseLayer
          ? <p className="ws-muted">The background stays as the bottom layer of your editable design.</p>
          : <>
            <label className="ws-field">Name<input aria-label="Layer name" value={active.label} maxLength={100} disabled={disabled} onChange={e => update(active.id, { label: e.target.value })} /></label>
            <fieldset className="ws-field"><legend>Type</legend><div className="ws-segmented" role="radiogroup" aria-label="Layer type">
              {TYPES.map(type => <button key={type} role="radio" aria-checked={friendlyType(active).type === type} className={friendlyType(active).type === type ? 'is-on' : ''} disabled={disabled} onClick={() => { update(active.id, { role: TYPE_ROLE[type] }); setToast(`“${active.label}” is now ${type === 'Image' ? 'an image' : `a ${type.toLowerCase()}`}`); }}>{type}</button>)}
            </div>
            {friendlyType(active).type === 'Choose type' && <p className="ws-warn">AI wasn't sure what this is. Choose a type to continue.</p>}
            {friendlyType(active).suggested && friendlyType(active).type !== 'Choose type' && <p className="ws-muted">Suggested by AI.</p>}</fieldset>
            <fieldset className="ws-field"><legend>In your design</legend><div className="ws-segmented" role="radiogroup" aria-label="Keep or remove">
              <button role="radio" aria-checked={active.approved && !active.rejected} className={active.approved && !active.rejected ? 'is-on' : ''} disabled={disabled} onClick={() => { update(active.id, { approved: true, rejected: false }); setToast(`Keeping “${active.label}”`); }}><Eye size={14} />Keep</button>
              <button role="radio" aria-checked={!active.approved || active.rejected} className={!active.approved || active.rejected ? 'is-on' : ''} disabled={disabled} onClick={() => { update(active.id, { approved: false, rejected: true }); setToast(`Removed “${active.label}”`); }}><EyeOff size={14} />Remove</button>
            </div></fieldset>
            {active.groupMode === 'group' && <div className="ws-field"><p className="ws-muted">Combined from {active.proposalIds.map(id => job.proposals?.find(p => p.id === id)?.label).filter(Boolean).join(', ') || 'several layers'}.</p>
              <button className="ws-btn" disabled={disabled || active.proposalIds.length < 2} title={active.proposalIds.length < 2 ? 'This layer cannot be split further' : 'Separate into the original layers'} onClick={() => split(active)}><Split size={14} />Split layer</button></div>}
            {firstSentence(active.description) && <p className="ws-note">{firstSentence(active.description)}</p>}
            {friendlyType(active).type === 'Image' && <button className="ws-btn" aria-pressed={editingArea} disabled={disabled} onClick={() => setEditingArea(!editingArea)}><PenLine size={14} />{editingArea ? 'Done adjusting' : 'Adjust area'}</button>}
          </>}
      </div> : <p className="ws-muted">No layers were detected. Start over with a different image.</p>}
    </aside>

    <footer className="ws-footer">
      <span className="ws-footer-status" aria-live="polite">{status.error ? <span className="ws-error-text" role="alert">{status.error}</span> : blocker || summary}</span>
      <button className="ws-btn" disabled={disabled} onClick={() => send('save-proposals')}>Save for later</button>
      <button className="ws-btn ws-btn-primary" disabled={disabled || !!blocker} onClick={() => send('approve-proposals')}>{status.pending ? 'Saving…' : 'Continue'}</button>
    </footer>
    <Toast message={toast} />
  </div>;
}
