import { useId } from 'react';
import { ImagePlus, RotateCcw } from 'lucide-react';
import { BRAND_LIMIT, FIELD_LIMIT, type ObjectAction, type ObjectEdit, type SceneDescription, type SceneDraft, type ScenePropertyKey, type SceneSlotMapping } from '@frameflow/shared';
import { groupedControls, sceneControls, setCorrection, setEdit, type SceneAnalysis, type SceneControl } from './smartEdit';

/** The id of an item's main input: a prompt part or a listed change leads here. */
export const smartFieldId = (id: string) => `sm-field-${id}`;
const ACTION_LABEL: Record<ObjectAction, string> = { keep: 'Keep', modify: 'Change', replace: 'Replace', remove: 'Remove' };

/**
 * The form of a smart edit: one card per item the analysis found in THIS image, grouped by what it is, each showing what
 * was detected (and how sure) apart from what the user asks. Keep is the default and means "inherit"; choosing it
 * explicitly protects the item from inferred changes. Text and logos can be kept or removed, never written.
 */
export function SmartEditPanel({ analysis, scene, mapping, draft, onDraft, locked, linked, onLink, slotLabels, productReference, productReferenceUrl, onProductReference, onReanalyze }: {
  analysis: SceneAnalysis; scene: SceneDescription; mapping?: SceneSlotMapping; draft: SceneDraft; onDraft: (next: SceneDraft) => void; locked: boolean; linked: string; onLink: (id: string) => void;
  slotLabels: Record<string, string>; productReference?: File; productReferenceUrl: string; onProductReference: (file: File | undefined, targetId?: string) => void; onReanalyze: () => void;
}) {
  const controls = sceneControls(scene, mapping), groups = groupedControls(controls);
  const ignored = analysis.scene!.objects.filter(o => draft.corrections[o.id]?.ignored);
  return <div className="sm-panel">
    <div className="sm-detected-head"><div><h3>What's in your image</h3><p className="tw-muted">Detected by AI ({analysis.calls === 1 ? '1 analysis call' : `${analysis.calls} analysis calls`}). Leave an item on Keep to inherit it as it is.</p></div>
      <button type="button" className="ws-btn ws-btn-quiet" disabled={locked} onClick={onReanalyze} title="Analyze this image again (one new call)"><RotateCcw size={14} /> Analyze again</button></div>
    {!!scene.uncertainties.length && <ul className="sm-uncertain" aria-label="What the analysis was unsure about">{scene.uncertainties.map(u => <li key={u}>{u}</li>)}</ul>}
    {groups.map(({ group, label, controls: items }) => <fieldset key={group} className="sm-group"><legend>{label}</legend>
      {items.map(control => <SmartControl key={control.id} control={control} edit={draft.edits[control.id]} draft={draft} onDraft={onDraft} locked={locked} linked={linked === control.id} onLink={onLink}
        slotLabel={control.slotId ? slotLabels[control.slotId] : undefined} productReference={draft.referenceFor === control.id ? productReference : undefined} productReferenceUrl={productReferenceUrl}
        otherPhoto={!!draft.referenceFor && draft.referenceFor !== control.id} onProductReference={onProductReference} />)}
    </fieldset>)}
    {!!ignored.length && <p className="tw-muted">Marked as wrong detections (left out): {ignored.map(o => <button type="button" key={o.id} className="ws-btn ws-btn-quiet" disabled={locked} onClick={() => onDraft(setCorrection(draft, o.id, { ...draft.corrections[o.id], ignored: undefined }))}>{o.label} · undo</button>)}</p>}
  </div>;
}

function SmartControl({ control, edit, draft, onDraft, locked, linked, onLink, slotLabel, productReference, productReferenceUrl, otherPhoto, onProductReference }: {
  control: SceneControl; edit?: ObjectEdit; draft: SceneDraft; onDraft: (next: SceneDraft) => void; locked: boolean; linked: boolean; onLink: (id: string) => void; slotLabel?: string;
  productReference?: File; productReferenceUrl: string; otherPhoto: boolean; onProductReference: (file: File | undefined, targetId?: string) => void;
}) {
  const uid = useId(), action = edit?.action ?? 'keep', correction = draft.corrections[control.id] ?? {};
  const choose = (next: ObjectAction) => onDraft(setEdit(draft, control.id, next === 'keep' ? { action: 'keep' } : next === 'remove' ? { action: 'remove' } : { action: next, ...(edit?.action === next ? edit : {}) }));
  const update = (patch: Partial<ObjectEdit>) => onDraft(setEdit(draft, control.id, { ...(edit ?? { action }), ...patch }));
  const hint = !edit ? 'Inherited: kept as detected unless a change you ask for needs it to change.' : action === 'keep' ? 'You chose to keep it exactly: inferred changes will not touch it.' : action === 'remove' ? 'It will be removed and the scene continued where it was.' : '';
  return <article className={`sm-card${linked ? ' is-linked' : ''}${edit && action !== 'keep' ? ' is-changed' : ''}`} aria-label={control.label} onMouseEnter={() => onLink(control.id)} onMouseLeave={() => onLink('')}>
    <header><h4>{control.label}</h4><div className="sm-chips">{slotLabel && <span className="sm-chip" title="The saved template field it fills">{slotLabel}</span>}{control.relation && <span className="sm-chip">{control.relation}</span>}
      {control.uncertain && <span className="sm-chip is-warn" title="The analysis was not sure about this item">uncertain</span>}{control.corrected && <span className="sm-chip is-info">corrected by you</span>}</div></header>
    <dl className="sm-detected"><div><dt>Detected</dt><dd>{control.current}</dd></div>{control.identity && <div><dt>Brand</dt><dd>{control.identity}</dd></div>}
      {control.details.map(d => <div key={d}><dt>{d.split(':')[0]}</dt><dd>{d.split(':').slice(1).join(':').trim()}</dd></div>)}</dl>
    <div className="sm-actions" role="radiogroup" aria-label={`What to do with ${control.label}`}>{control.actions.map(a => <label key={a} className={action === a ? 'is-on' : ''}>
      <input type="radio" name={`${uid}-action`} value={a} checked={action === a} disabled={locked} onChange={() => choose(a)} onFocus={() => onLink(control.id)} {...(a === action && action !== 'modify' && action !== 'replace' ? { id: smartFieldId(control.id) } : {})} />{ACTION_LABEL[a]}</label>)}</div>
    {hint && <p className="tw-muted sm-hint">{hint}</p>}
    {(action === 'modify' || action === 'replace') && <div className="sm-inputs">
      {action === 'modify' && control.properties.length > 0 && <label className="tw-field"><span>Property</span>
        <select value={edit?.property ?? ''} disabled={locked} onChange={e => update({ property: (e.target.value || undefined) as ScenePropertyKey | undefined })}><option value="">Overall look</option>{control.properties.map(p => <option key={p.key} value={p.key}>{p.label} (now: {p.value})</option>)}</select></label>}
      <label className="tw-field"><span>{action === 'replace' ? 'Replace with' : 'Change to'}{action === 'replace' && productReference ? <small> optional with a photo</small> : null}</span>
        <input id={smartFieldId(control.id)} aria-label={`${control.label}: ${action === 'replace' ? 'replace with' : 'change to'}`} maxLength={FIELD_LIMIT} value={edit?.value ?? ''} disabled={locked}
          placeholder={action === 'replace' ? 'Describe what replaces it' : 'Describe the new look'} onFocus={() => onLink(control.id)} onChange={e => update({ value: e.target.value })} /></label>
      {control.brandable && <label className="tw-field"><span>Brand <small>optional</small></span><input aria-label={`${control.label}: brand`} maxLength={BRAND_LIMIT} value={edit?.brand ?? ''} disabled={locked} placeholder="Only if you know it"
        title="Shown only as the product would plainly carry it. A brand alone asks what the product becomes." onChange={e => update({ brand: e.target.value || undefined })} /></label>}
      {control.brandable && action === 'replace' && <div className="tw-field"><span>Product photo <small>optional</small></span>
        <label className="ws-btn tw-upload"><ImagePlus size={15} /> {productReference ? 'Replace photo' : 'Add product photo'}<input className="tw-file" aria-label={`${control.label}: product photo`} type="file" accept="image/png,image/jpeg,image/webp" disabled={locked || otherPhoto}
          onChange={e => onProductReference(e.target.files?.[0], control.id)} /></label>
        {productReference && <span className="tw-reference-chip">{productReferenceUrl && <img src={productReferenceUrl} alt="" />}{productReference.name}<button type="button" className="ws-btn ws-btn-quiet" disabled={locked} onClick={() => onProductReference(undefined)}>Remove</button></span>}
        <small>{otherPhoto ? 'One product photo per edit: it is attached to another item.' : 'Sent as a second image. It is analyzed with your words; a mismatch is asked about, never guessed.'}</small></div>}
    </div>}
    {control.type === 'object' && <details className="sm-correct"><summary>Correct the detection</summary>
      <label className="tw-field"><span>It is</span><input aria-label={`${control.label}: corrected description`} maxLength={120} value={correction.description ?? ''} placeholder={control.current} disabled={locked}
        onChange={e => onDraft(setCorrection(draft, control.id, { ...correction, description: e.target.value || undefined }))} /></label>
      {control.brandable && <label className="tw-field"><span>Its brand</span><input aria-label={`${control.label}: corrected brand`} maxLength={60} value={correction.brand ?? ''} placeholder={control.identity ?? 'Unknown'} disabled={locked}
        onChange={e => onDraft(setCorrection(draft, control.id, { ...correction, brand: e.target.value || undefined }))} /></label>}
      <label className="tw-check"><input type="checkbox" checked={!!correction.ignored} disabled={locked} onChange={e => onDraft(setEdit(setCorrection(draft, control.id, { ...correction, ignored: e.target.checked || undefined }), control.id, undefined))} />Not in the image (a wrong detection)</label>
    </details>}
  </article>;
}
