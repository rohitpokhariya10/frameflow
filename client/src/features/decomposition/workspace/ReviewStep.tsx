import { useEffect, useMemo, useRef, useState } from 'react';
import { Combine, Split, Plus, PenLine, SquarePlus, Clock, Trash2 } from 'lucide-react';
import type { DecompositionJobSummary, DecompositionReview, ProposalReviewTarget } from '@frameflow/shared';
import { artifactUrl } from '../api';
import { submitReviewOnce } from '../reviewSubmission';
import { friendlyType, TYPE_ROLE, type FriendlyType } from '../flow';
import { Thumb, Toast, TypeChip } from './parts';
import { PaintCanvas } from './PaintCanvas';

type Draft = { targets: ProposalReviewTarget[]; memberMasks: Record<string, string[]> };
const TYPES: Exclude<FriendlyType, 'Choose type'>[] = ['Image', 'Text', 'Shape', 'Background'];
const firstSentence = (text?: string) => text?.split(/(?<=\.)\s/)[0];

/**
 * Each detected layer is either added to the editor, left for later (kept in the design, not opened now) or removed.
 * On first review, layers up to the editor limit are added and the rest are left for later, so Continue is never
 * blocked by a count the customer did not choose. The background is excluded unless the customer includes it.
 */
export type LayerChoice = 'add' | 'later' | 'remove';
export const layerChoice = (t: Pick<ProposalReviewTarget, 'approved' | 'rejected'>): LayerChoice => t.rejected ? 'remove' : t.approved ? 'add' : 'later';
const CHOICE: Record<LayerChoice, Pick<ProposalReviewTarget, 'approved' | 'rejected'>> = { add: { approved: true, rejected: false }, later: { approved: false, rejected: false }, remove: { approved: false, rejected: true } };
export function firstReviewDefaults(targets: ProposalReviewTarget[], limit: number): ProposalReviewTarget[] {
  let added = 0;
  return targets.map(t => t.baseLayer ? { ...t, ...CHOICE.remove } : { ...t, ...(added++ < limit ? CHOICE.add : CHOICE.later) });
}
export function initialDraft(job: DecompositionJobSummary, key: string): Draft {
  let stored: Draft | null = null;
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null') as Draft | null;
    if (saved?.targets?.length) stored = saved;
  } catch { /* browser storage is optional */ }
  // A rejected submission has not reached proposalTargets yet. Preserve its names, groups, types and keep choices.
  const recoveringLimit = job.state === 'failed' && job.error?.code === 'TARGET_LIMIT';
  const choices = stored?.targets ?? (recoveringLimit ? job.reviewSubmission?.targets : undefined);
  const targets = choices ? choices.map(choice => {
    const saved = job.proposalTargets?.find(target => target.id === choice.id);
    const sameMembers = saved && JSON.stringify(saved.proposalIds) === JSON.stringify(choice.proposalIds);
    return { ...(sameMembers ? saved : {}), ...choice, baseLayer: saved?.baseLayer === true, ...(sameMembers ? { classification: saved.classification } : {}) };
  })
    // Saved choices (including "left for later") are kept as they are; only a never-reviewed design gets defaults.
    : job.reviewSubmission?.targets ? job.proposalTargets ?? []
      : firstReviewDefaults([...(job.proposalTargets ?? []).filter(t => !t.baseLayer), ...(job.proposalTargets ?? []).filter(t => t.baseLayer)], job.options?.maxObjects ?? 6);
  const memberMasks = Object.fromEntries(targets.filter(t => t.memberTargetIds?.length).map(t => [t.id, t.memberTargetIds!.flatMap(id => { const original = job.proposalTargets?.find(target => target.id === id); return original?.maskArtifactId ? [original.maskArtifactId] : []; })]));
  return { targets: [...targets.filter(t => !t.baseLayer), ...targets.filter(t => t.baseLayer)], memberMasks: { ...memberMasks, ...stored?.memberMasks } };
}

/** Combining is allowed at the limit only when the result fits, or reduces an already oversized review. */
export function canCombineLayers(targets: ProposalReviewTarget[], selected: string[], limit: number): boolean {
  const members = targets.filter(target => selected.includes(target.id) && !target.baseLayer);
  const kept = targets.filter(target => !target.baseLayer && target.approved && !target.rejected).length;
  const next = kept - members.filter(target => target.approved && !target.rejected).length + 1;
  return members.length >= 2 && members.length <= 6 && new Set(members.flatMap(target => target.proposalIds)).size <= 6 && (next <= limit || next < kept);
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
  const maxObjects = job.options?.maxObjects ?? 6;
  const overLimit = keptObjects.length > maxObjects;
  const atLimit = keptObjects.length >= maxObjects;
  const later = targets.filter(t => !t.baseLayer && layerChoice(t) === 'later');
  const limitCopy = `You can open up to ${maxObjects} editable layer${maxObjects === 1 ? '' : 's'} at once.`;
  const blocker = overLimit ? `${limitCopy} Choose “Leave for later” for ${keptObjects.length - maxObjects} more — they stay in your design.` : !keptObjects.length ? 'Add at least one layer to the editor to continue.' : needsType.length ? `Choose a type for ${needsType.map(t => `“${t.label}”`).join(', ')}.` : kept.some(t => !t.label.trim()) ? 'Every layer you add needs a name.' : '';
  const canCombine = canCombineLayers(targets, checked, maxObjects);
  const addLayer = () => {
    if (disabled || targets.length >= 12) return;
    const id = `target-${crypto.randomUUID()}`;
    // At the limit a new layer is left for later rather than refused.
    setDraft(d => ({ ...d, targets: [...d.targets.filter(t => !t.baseLayer), { id, label: 'New layer', proposalIds: [], ...(atLimit ? CHOICE.later : CHOICE.add), groupMode: 'single', role: 'object' }, ...d.targets.filter(t => t.baseLayer)] }));
    setActiveId(id); setEditingArea(true);
  };
  const combine = () => {
    const members = targets.filter(t => checked.includes(t.id) && !t.baseLayer);
    if (disabled || !canCombineLayers(targets, checked, maxObjects)) return;
    const id = `target-${crypto.randomUUID()}`;
    const label = (combinedName.trim() || members.map(m => m.label).join(' + ')).slice(0, 100);
    const group: ProposalReviewTarget = { id, label, proposalIds: [...new Set(members.flatMap(m => m.proposalIds))], approved: true, rejected: false,
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
    if (keptObjects.length + (group.approved && !group.rejected ? group.proposalIds.length - 1 : 0) > maxObjects || targets.length + group.proposalIds.length - 1 > 12) return;
    const parts = group.proposalIds.map(pid => ({ ...group, id: `target-${crypto.randomUUID()}`, label: (job.proposals?.find(p => p.id === pid)?.label ?? group.label).slice(0, 100), proposalIds: [pid],
      groupMode: 'single' as const, memberTargetIds: undefined, maskArtifactId: undefined, provisionalMaskRevision: undefined, provenance: undefined, classification: undefined, role: 'unknown' as const, points: [], strokes: [], splitFromTargetId: group.id }));
    const at = targets.findIndex(t => t.id === group.id);
    const next = targets.filter(t => t.id !== group.id); next.splice(at, 0, ...parts);
    const masks = Object.fromEntries(parts.map(p => { const original = job.proposalTargets?.find(t => t.proposalIds.length === 1 && t.proposalIds[0] === p.proposalIds[0] && t.maskArtifactId); return [p.id, original?.maskArtifactId ? [original.maskArtifactId] : []]; }));
    setDraft({ targets: next, memberMasks: { ...memberMasks, ...masks } });
    setActiveId(parts[0].id); setToast(`Split into ${parts.length} layers`);
  };
  const send = (action: 'save-proposals' | 'approve-proposals') => {
    if (overLimit || disabled || (action === 'approve-proposals' && blocker)) return;
    void submitReviewOnce(lock, { expectedRevision: job.revision, action, targets: targets.map(({ classification: _c, ...t }) => { void _c; return t; }) }, async body => {
      try { await onSubmit(body); }
      catch (error) {
        if ((error as { code?: string }).code === 'TARGET_LIMIT') throw new Error(`${limitCopy} Your choices are kept — leave some layers for later, then save again.`, { cause: error });
        throw error;
      }
      try { localStorage.removeItem(key); } catch { /* optional */ }
    }, setStatus);
  };
  const moveActive = (delta: number) => {
    const index = targets.findIndex(t => t.id === active?.id), next = targets[Math.max(0, Math.min(targets.length - 1, index + delta))];
    if (next) { setActiveId(next.id); listRef.current?.querySelector<HTMLButtonElement>(`[data-layer="${next.id}"]`)?.focus(); }
  };
  const summary = useMemo(() => {
    const byType = (type: FriendlyType) => keptObjects.filter(t => friendlyType(t).type === type).length;
    return `${keptObjects.length} for the editor · ${byType('Image')} image${byType('Image') === 1 ? '' : 's'}, ${byType('Text')} text, ${byType('Shape')} shape${byType('Shape') === 1 ? '' : 's'}${later.length ? ` · ${later.length} left for later` : ''}`;
  }, [keptObjects, later.length]);
  const choose = (t: ProposalReviewTarget, choice: LayerChoice) => {
    update(t.id, CHOICE[choice]);
    setToast(choice === 'add' ? `“${t.label}” will open in the editor` : choice === 'later' ? `“${t.label}” is saved for later` : `Removed “${t.label}”`);
  };

  return <div className="ws-grid">
    <aside className="ws-pane ws-list-pane" aria-label="Detected layers">
      <div className="ws-pane-head"><h3>Detected layers <span className="ws-count">{targets.filter(t => !t.baseLayer).length}</span></h3>
        <p className="ws-limit" data-testid="editor-selection-count"><strong>{keptObjects.length} of {maxObjects}</strong> selected for the editor{later.length ? ` · ${later.length} left for later` : ''}</p>
        {atLimit && <p className="ws-hint" role="status">{limitCopy} Others stay here — add them later.</p>}
        <p>Select two or more to combine them.</p><button className="ws-btn" disabled={disabled || targets.length >= 12} title={targets.length >= 12 ? 'This design has the most layers it can hold' : undefined} onClick={addLayer}><Plus size={14} />Add a layer</button></div>
      {job.state === 'failed' && job.error?.code === 'TARGET_LIMIT' && <p className="ws-notice ws-list-notice" role="status">Your layer choices are kept. Combine or remove layers to fit the limit, then save for later or continue.</p>}
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
          const { type, suggested } = friendlyType(t), proposal = proposalOf(t), choice = layerChoice(t);
          return <li key={t.id} data-choice={t.baseLayer ? (choice === 'add' ? 'include' : 'exclude') : choice} className={`ws-layer ${t.id === active?.id ? 'is-active' : ''} ${choice === 'remove' ? 'is-removed' : choice === 'later' ? 'is-later' : ''}`} onMouseEnter={() => setHoverId(t.id)} onMouseLeave={() => setHoverId(null)}>
            <input type="checkbox" aria-label={`Select ${t.label}`} disabled={t.baseLayer || disabled} checked={checked.includes(t.id)} onChange={e => setChecked(ids => e.target.checked ? [...ids, t.id] : ids.filter(id => id !== t.id))} />
            <button className="ws-layer-main" data-layer={t.id} aria-current={t.id === active?.id} onClick={() => { setActiveId(t.id); setEditingArea(false); }}>
              {t.baseLayer ? <Thumb artifactId={job.discovery?.baseLayer?.artifactId} /> : <Thumb artifactId={proposal?.artifactId} region={proposal?.bounds} width={proposal?.width} height={proposal?.height} />}
              <span className="ws-layer-text"><span className="ws-layer-name">{t.label || 'Untitled layer'}</span><span className="ws-layer-meta"><TypeChip type={type} suggested={suggested} />{t.groupMode === 'group' && <span className="ws-muted">Combined</span>}{t.baseLayer ? <span className="ws-muted">{choice === 'add' ? 'Included' : 'Not included'}</span> : choice === 'remove' ? <span className="ws-muted">Removed</span> : choice === 'later' ? <span className="ws-muted">Left for later</span> : <span className="ws-chip-add">In editor</span>}</span></span>
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
          ? <fieldset className="ws-field"><legend>Background</legend><div className="ws-segmented" role="radiogroup" aria-label="Background">
              <button role="radio" aria-checked={active.approved && !active.rejected} className={active.approved && !active.rejected ? 'is-on' : ''} disabled={disabled} onClick={() => { update(active.id, CHOICE.add); setToast('The background will be included'); }}>Include background</button>
              <button role="radio" aria-checked={!active.approved || active.rejected} className={!active.approved || active.rejected ? 'is-on' : ''} disabled={disabled} onClick={() => { update(active.id, CHOICE.remove); setToast('The background will not be included'); }}>Exclude background</button>
            </div><p className="ws-muted">Your layers can open on a blank canvas without it. You can add a background later in the editor.</p></fieldset>
          : <>
            <label className="ws-field">Name<input aria-label="Layer name" value={active.label} maxLength={100} disabled={disabled} onChange={e => update(active.id, { label: e.target.value })} /></label>
            <fieldset className="ws-field"><legend>Type</legend><div className="ws-segmented" role="radiogroup" aria-label="Layer type">
              {TYPES.map(type => <button key={type} role="radio" aria-checked={friendlyType(active).type === type} className={friendlyType(active).type === type ? 'is-on' : ''} disabled={disabled} onClick={() => { update(active.id, { role: TYPE_ROLE[type] }); setToast(`“${active.label}” is now ${type === 'Image' ? 'an image' : `a ${type.toLowerCase()}`}`); }}>{type}</button>)}
            </div>
            {friendlyType(active).type === 'Choose type' && <p className="ws-warn">AI wasn't sure what this is. Choose a type to continue.</p>}
            {friendlyType(active).suggested && friendlyType(active).type !== 'Choose type' && <p className="ws-muted">Suggested by AI.</p>}</fieldset>
            <fieldset className="ws-field"><legend>In your design</legend><div className="ws-segmented ws-choice" role="radiogroup" aria-label="Layer choice">
              {([['add', 'Add to editor', SquarePlus], ['later', 'Leave for later', Clock], ['remove', 'Remove', Trash2]] as const).map(([choice, label, Icon]) => {
                const on = layerChoice(active) === choice, blockedByLimit = choice === 'add' && !on && atLimit;
                return <button key={choice} role="radio" aria-checked={on} className={on ? 'is-on' : ''} disabled={disabled || blockedByLimit} title={blockedByLimit ? `${limitCopy} Leave another layer for later first.` : undefined} onClick={() => choose(active, choice)}><Icon size={14} />{label}</button>;
              })}
            </div>
            {layerChoice(active) === 'later' && <p className="ws-muted">Saved in your design. Add it to the editor any time from “Detected layers”.</p>}
            {atLimit && layerChoice(active) !== 'add' && <p className="ws-hint">{limitCopy}</p>}</fieldset>
            {active.groupMode === 'group' && <div className="ws-field"><p className="ws-muted">Combined from {active.proposalIds.map(id => job.proposals?.find(p => p.id === id)?.label).filter(Boolean).join(', ') || 'several layers'}.</p>
              <button className="ws-btn" disabled={disabled || active.proposalIds.length < 2 || keptObjects.length + (active.approved && !active.rejected ? active.proposalIds.length - 1 : 0) > maxObjects || targets.length + active.proposalIds.length - 1 > 12} title={active.proposalIds.length < 2 ? 'This layer cannot be split further' : 'Separate into the original layers within your layer limit'} onClick={() => split(active)}><Split size={14} />Split layer</button></div>}
            {firstSentence(active.description) && <p className="ws-note">{firstSentence(active.description)}</p>}
            {friendlyType(active).type === 'Image' && <button className="ws-btn" aria-pressed={editingArea} disabled={disabled} onClick={() => setEditingArea(!editingArea)}><PenLine size={14} />{editingArea ? 'Done adjusting' : 'Adjust area'}</button>}
          </>}
      </div> : <p className="ws-muted">No layers were detected. Start over with a different image.</p>}
    </aside>

    <footer className="ws-footer">
      <span className="ws-footer-status" aria-live="polite">{status.error ? <span className="ws-error-text" role="alert">{status.error}</span> : blocker || summary}</span>
      <button className="ws-btn" disabled={disabled || overLimit} onClick={() => send('save-proposals')}>Save for later</button>
      <button className="ws-btn ws-btn-primary" disabled={disabled || !!blocker} onClick={() => send('approve-proposals')}>{status.pending ? 'Saving…' : 'Continue'}</button>
    </footer>
    <Toast message={toast} />
  </div>;
}
