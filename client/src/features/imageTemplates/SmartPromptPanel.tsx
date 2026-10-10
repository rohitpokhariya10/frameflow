import { LoaderCircle, Lock, Sparkles, Undo2 } from 'lucide-react';
import { baseResolvedPrompt, describeTemplateSlots, type CompiledResolvedEdit, type ConflictOption, type PlanConflict, type PlanEntry, type SceneDescription, type SceneDraft, type SceneSlotMapping, type TemplateVersion } from '@frameflow/shared';
import { SlotPrompt } from './SlotPrompt';
import { draftChangeList, strategyPreview, type Resolution, type ResolutionStatus } from './smartEdit';
import { smartFieldId } from './SmartEditPanel';

const OPERATION: Record<PlanEntry['operation'], string> = { keep: 'Keep', modify: 'Change', replace: 'Replace', remove: 'Remove', adjust: 'Adjust' };
const SOURCE: Record<PlanEntry['source'], string> = { explicit: 'you asked', inherited: 'inherited', inferred: 'inferred' };

/**
 * The right column of a smart edit, in three clearly separate parts: the template's base reusable prompt (locked rules
 * and the fields a change can touch), the draft (what the user asked, not resolved yet), and the resolved plan with the
 * final prompt exactly as it is sent. Inferred changes say why, and each can be undone; questions block generation.
 */
export function SmartPromptPanel({ version, scene, mapping, draft, resolution, status, preview, busy, locked, linked, onLink, onPick, onResolve, onAnswer, onUndoInferred, analysisCalls, verifyAvailable, cutout, showBase = true }: {
  version: TemplateVersion; scene: SceneDescription; mapping?: SceneSlotMapping; draft: SceneDraft; resolution?: Resolution; status: ResolutionStatus; preview?: CompiledResolvedEdit; busy: boolean; locked: boolean;
  linked: string; onLink: (id: string) => void; onPick: (id: string) => void; onResolve: (rulesOnly?: boolean) => void; onAnswer: (conflict: PlanConflict, option: ConflictOption) => void; onUndoInferred: (entry: PlanEntry) => void;
  analysisCalls: number; verifyAvailable: boolean; cutout?: string;
  /** The item cards' base prompt (the template fields show the template's own, linked to them, instead). */
  showBase?: boolean;
}) {
  const slots = describeTemplateSlots(version), changes = draftChangeList(scene, draft), plan = status !== 'stale' && status !== 'none' ? resolution?.plan : undefined;
  const shown = plan?.entries.filter(e => e.operation !== 'keep') ?? [], kept = plan?.entries.filter(e => e.operation === 'keep') ?? [];
  // How the image will be made, decided from the plan exactly as the server decides it.
  const how = plan && plan.status !== 'needs-input' ? strategyPreview(scene, plan, cutout) : undefined;
  // A template field chip leads to the detected item that fills it.
  const pickSlot = (slotId: string) => { const id = Object.entries(mapping?.slots ?? {}).find(([, s]) => s === slotId)?.[0]; if (id) onPick(id); };
  return <>
    {showBase && <details className="tw-prompt"><summary>Base reusable prompt</summary>
      <p className="tw-legend"><span className="tw-slot-chip is-sample">{'{Field}'}</span> a saved template field · <Lock size={11} aria-hidden="true" /> locked rules, for every image of this template</p>
      <SlotPrompt label="Base reusable prompt" segments={baseResolvedPrompt(slots)} linked="" onLink={() => undefined} onPick={pickSlot} controlsId={smartFieldId} /></details>}
    <section className="tw-changes" aria-label="Draft changes"><h3>Draft changes <small className="tw-muted">not resolved yet</small></h3>
      {changes.length ? <ul>{changes.map(c => <li key={c.id}><button type="button" className={`tw-change${linked === c.id ? ' is-linked' : ''}`} onClick={() => onPick(c.id)} onMouseEnter={() => onLink(c.id)} onMouseLeave={() => onLink('')}>
        <b className={`tw-op tw-op-${c.action === 'modify' ? 'details' : c.action}`}>{OPERATION[c.action]}</b> {c.label}: {c.text}</button></li>)}</ul>
        : <p className="tw-muted">Nothing yet. Everything is kept as detected: with no changes, use the original image (no image request).</p>}
    </section>
    <section className={`sm-resolution is-${status}`} aria-label="Resolved changes" aria-live="polite"><h3>AI plan</h3>
      {status === 'none' && <p className="tw-muted">Resolve your changes to see what else they affect. Rules run first; an AI call is made only when your words or a photo name a product or brand.</p>}
      {status === 'stale' && <p className="tw-note-warn" role="note">Your changes are different from the last resolved plan. Resolve again before generating.</p>}
      {status === 'failed' && <div className="tw-alert" role="alert"><p>{resolution?.error?.message ?? 'The changes could not be resolved.'}</p>
        <div className="tw-actions"><button type="button" className="ws-btn" disabled={locked || busy} onClick={() => onResolve()}>Try again</button><button type="button" className="ws-btn" disabled={locked || busy} onClick={() => onResolve(true)}>Continue with rules only</button></div></div>}
      {plan && plan.conflicts.length > 0 && <div className="sm-conflicts" role="alert"><p><strong>{plan.conflicts.length === 1 ? 'One question before generating' : `${plan.conflicts.length} questions before generating`}</strong></p>
        {plan.conflicts.map(c => <fieldset key={c.id} className="sm-conflict"><legend>{c.question}</legend><div className="tw-actions">{c.options.map(o => <button type="button" key={o.id} className="ws-btn" disabled={locked} onClick={() => onAnswer(c, o)}>{o.label}</button>)}</div></fieldset>)}</div>}
      {plan && shown.length > 0 && <ul className="sm-entries">{shown.map(e => <li key={e.id} className={`is-${e.source}${linked === e.targetId ? ' is-linked' : ''}`} onMouseEnter={() => onLink(e.targetId)} onMouseLeave={() => onLink('')}>
        <span className="sm-entry-head"><b className={`tw-op tw-op-${e.operation === 'modify' || e.operation === 'adjust' ? 'details' : e.operation}`}>{OPERATION[e.operation]}</b> <button type="button" className="ws-btn-link" onClick={() => onPick(e.targetId)}>{e.label}</button>
          {e.property ? ` · ${e.property}` : ''}{e.to ? <>: <q>{e.to}</q></> : null}<span className={`sm-source is-${e.source}`}>{SOURCE[e.source]}</span></span>
        {/* An inference about an item the user changed themselves (its brand, read from their words) is corrected in that item's own fields. */}
        {e.source === 'inferred' && <span className="sm-reason">{e.reason}{e.evidence ? ` (${e.evidence})` : ''} {draft.edits[e.targetId] ? <small>Edit {e.label} to change it.</small>
          : <button type="button" className="ws-btn ws-btn-quiet" disabled={locked} onClick={() => onUndoInferred(e)}><Undo2 size={13} /> Keep it instead</button>}</span>}</li>)}</ul>}
      {plan && <p className="tw-muted">{kept.length} detected item{kept.length === 1 ? '' : 's'} inherited unchanged{kept.some(e => e.source === 'explicit') ? ` (${kept.filter(e => e.source === 'explicit').length} kept by you)` : ''}.</p>}
      {plan && plan.notes.map(n => <p key={n} className="tw-muted">{n}</p>)}
      {how && <p className={`sm-strategy is-${how.kind}`} role="note"><b>How it is made:</b> {how.text}{how.extra ? <small> {how.extra}</small> : null}</p>}
      {plan && !!resolution?.rejected?.length && <details><summary>AI suggestions not used ({resolution.rejected.length})</summary><ul>{resolution.rejected.map(r => <li key={r}>{r}</li>)}</ul></details>}
      {(status === 'none' || status === 'stale') && <button type="button" className="ws-btn" disabled={locked || busy} onClick={() => onResolve()}>{busy ? <LoaderCircle size={15} className="ws-spin" aria-hidden="true" /> : <Sparkles size={15} />} Preview the AI plan</button>}
    </section>
    <details className="tw-prompt" open={!!preview}><summary>Final prompt · exactly what is sent</summary>
      {preview ? <><SlotPrompt label="Resolved final prompt" segments={preview.segments} linked={linked} onLink={onLink} onPick={onPick} sentences controlsId={smartFieldId} />
        <textarea aria-label="Resolved final prompt text" readOnly value={preview.text} rows={6} spellCheck={false} /></>
        : <p className="tw-muted">{status === 'needs-input' ? 'Answer the questions above first.' : 'Appears once the changes are resolved.'}</p>}</details>
    <span className="tw-badge">Analysis {analysisCalls} call · Resolution {resolution?.resolver.called ? '1 call' : '0 calls'} · prompt compiled locally{verifyAvailable ? ' · AI check after generation' : ''}</span>
  </>;
}
