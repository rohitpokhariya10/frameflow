/**
 * Edit Your Creative: a saved creative made into editable layers and opened in the visual editor, as one guided step for
 * anyone. Every action is the existing Decompose & Edit chain, run in order:
 *
 *   explain     the layer template made from the saved creative (free; the same one again for the same saved version),
 *               its elements found from the creative's own composition (free), and the server's cost estimate — shown
 *               before anything is spent
 *   working     what was found accepted as it is and the default elements chosen (as "Save and choose what to decompose"
 *               does), the cost estimated again (a higher one is shown and confirmed again), the AI separation started with
 *               that approval and waited for, then the editing document made (free)
 *   done        Open Visual Editor (the existing editor, on that document) or Review Layers (the existing Inspect screen)
 *
 * A creative separated before reopens its layers (Continue Editing) without a new request; one changed since says so and
 * asks again before a new paid separation.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Layers3, PenTool, RefreshCw, Sparkles, X } from 'lucide-react';
import { decomposesObject, type ReuseAspectRatio, type ReuseOutput } from '@frameflow/shared';
import { productApi, type PrepareEstimate, type ProductView } from './api';

const STAGES = ['Preparing your creative', 'Separating visual elements', 'Preparing editable layers'] as const;
type Phase =
  | { kind: 'idle' }
  | { kind: 'explain'; checking: boolean; layersId?: string; estimate?: PrepareEstimate; note?: string }
  | { kind: 'working'; layersId: string; at: number }
  | { kind: 'done'; layersId: string; runId: string }
  | { kind: 'failed'; message: string; detail?: string; layersId?: string };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const money = (usd: number) => `$${usd.toFixed(2)}`;
const plain = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The template's state, read until `done` says so (or the wait is long enough to say so). */
async function waitFor(id: string, done: (v: ProductView) => boolean, timeoutMs: number) {
  const t0 = Date.now();
  for (;;) {
    const v = await productApi.get(id);
    if (done(v)) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error('This is taking longer than usual. Your creative is saved; try again in a moment.');
    await sleep(1200);
  }
}

export function EditYourCreative({ templateId, draftId, ratio, output, onOpenRunInEditor, onOpenTemplate }: {
  templateId: string; draftId: string; ratio: ReuseAspectRatio; output: ReuseOutput;
  onOpenRunInEditor: (runId: string) => Promise<void>; onOpenTemplate: (id: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' }), [loaded, setLoaded] = useState<ProductView>(), [opening, setOpening] = useState(false), [made, setMade] = useState<string>();
  const busy = useRef(false), live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  // The layer template of this creative: the one made here (always for the saved version shown), else the recorded one
  // (this saved version, or an earlier one).
  const known = output.decomposition, current = !!made || (!!known && known.creativeId === output.creativeId && known.creativeRevision === output.creativeRevision);
  const target = made ?? known?.templateId;
  const refresh = useCallback(async () => {
    if (!target) return;
    try { const v = await productApi.get(target); if (live.current) setLoaded(v); } catch { /* gone: decomposed again when asked */ }
  }, [target]);
  useEffect(() => { if (target) void productApi.get(target).then(v => { if (live.current) setLoaded(v); }).catch(() => undefined); }, [target]);
  const existing = target && loaded?.template.id === target ? loaded : undefined;
  const ready = !!existing && (existing.stage === 'prepared' || existing.stage === 'ready');

  /** Stage A: the free checks, then the cost (nothing paid yet). */
  const explain = async () => {
    if (busy.current) return;
    busy.current = true; setPhase({ kind: 'explain', checking: true });
    try {
      const { templateId: layersId } = await productApi.reuseDecompose(templateId, draftId, ratio);
      if (live.current) setMade(layersId);
      const v = await waitFor(layersId, x => x.stage !== 'detecting', 120000);
      if (v.stage === 'detect-failed') throw new Error(v.product.detection?.error ?? 'We couldn’t read the elements of your creative.');
      if (v.stage === 'prepared' || v.stage === 'ready') { await done(layersId); return; }
      if (v.stage === 'preparing') { await follow(layersId, 1); return; }
      const estimate = await productApi.estimate(layersId);
      if (live.current) setPhase({ kind: 'explain', checking: false, layersId, estimate });
    } catch (e) { if (live.current) setPhase({ kind: 'failed', message: 'We couldn’t get your creative ready for layers.', detail: plain(e) }); }
    finally { busy.current = false; void refresh(); }
  };
  /** Stage B: the approved separation, each status shown while its request runs. */
  const confirm = async (layersId: string, approved: number) => {
    if (busy.current) return;
    busy.current = true; setPhase({ kind: 'working', layersId, at: 0 });
    try {
      let v = await productApi.get(layersId);
      if (v.stage === 'review' || v.stage === 'changed') {
        // What was found, as it is (the creative's own composition), and the default elements to separate.
        v = await productApi.review(layersId, { expectedRevision: v.template.revision,
          objects: v.product.objects.map(o => ({ id: o.id, kind: o.kind, label: o.label, box: o.box, accepted: true, ...(o.hidden ? { hidden: true } : {}), ...(o.kind === 'podium' ? { layer: o.layer ?? null } : {}) })),
          texts: v.texts.map(t => ({ groupId: t.id, box: t.box, removed: t.removed, category: t.category, accepted: true })),
          logos: v.logos.filter(l => l.category === 'brand-logo' || l.category === 'partner-logo' || l.category === 'qr' || l.category === 'badge').map(l => ({ slotId: l.id, removed: l.removed, category: l.category as 'brand-logo' | 'partner-logo' | 'qr' | 'badge', label: l.label, box: l.box, accepted: true })),
          dismissMissingText: true });
        v = await productApi.select(layersId, { expectedRevision: v.template.revision,
          objects: v.product.objects.filter(o => !o.hidden && o.kind !== 'brand-logo').map(o => ({ id: o.id, decompose: o.kind === 'podium' ? o.layer === 'own' : decomposesObject(o) })),
          logos: v.logos.filter(l => !l.removed && (l.category === 'brand-logo' || l.category === 'badge')).map(l => ({ slotId: l.id, separate: true })) });
      }
      // The cost for the elements now chosen: more than approved is shown and confirmed again (nothing started).
      const estimate = await productApi.estimate(layersId);
      if (estimate.ai.maxUsd > approved + 1e-9) { if (live.current) setPhase({ kind: 'explain', checking: false, layersId, estimate, note: 'The estimate changed for the elements found. Please review the new cost.' }); return; }
      if (v.stage !== 'preparing' && v.stage !== 'prepared' && v.stage !== 'ready') await productApi.prepare(layersId, { expectedRevision: v.template.revision, engine: 'ai', approveUsd: approved });
      await follow(layersId, 1);
    } catch (e) { if (live.current) setPhase({ kind: 'failed', message: 'We couldn’t separate your creative into layers. Your saved creative is unchanged.', detail: plain(e), layersId }); }
    finally { busy.current = false; void refresh(); }
  };
  /** The separation followed to its end, then the editing document made (inside an entry point that holds `busy`). */
  const follow = async (layersId: string, at: number) => {
    setPhase({ kind: 'working', layersId, at });
    const v = await waitFor(layersId, x => x.stage !== 'preparing', 15 * 60000);
    if (v.stage !== 'prepared' && v.stage !== 'ready') throw new Error(v.product.preparing?.error ?? 'The separation did not finish.');
    await done(layersId);
  };
  /** A separation still running (after a reload): followed to its end. */
  const finish = async (layersId: string, at: number) => {
    if (busy.current) return;
    busy.current = true;
    try { await follow(layersId, at); }
    catch (e) { if (live.current) setPhase({ kind: 'failed', message: 'We couldn’t separate your creative into layers. Your saved creative is unchanged.', detail: plain(e), layersId }); }
    finally { busy.current = false; void refresh(); }
  };
  const done = async (layersId: string) => {
    setPhase({ kind: 'working', layersId, at: 2 });
    const r = await productApi.openEditor(layersId);
    if (live.current) setPhase({ kind: 'done', layersId, runId: r.runId });
  };
  /** The existing editor on the layers' editing document (made again only if it was never made). */
  const openEditor = async (layersId: string, runId?: string) => {
    if (opening) return;
    setOpening(true);
    try { await onOpenRunInEditor(runId ?? (await productApi.openEditor(layersId)).runId); }
    catch (e) { setPhase({ kind: 'failed', message: 'We couldn’t open the visual editor.', detail: plain(e), layersId }); }
    finally { if (live.current) setOpening(false); }
  };
  // A separation still running (the page was reloaded meanwhile): followed again, nothing started twice.
  const running = current && existing?.stage === 'preparing' ? existing.template.id : undefined;
  useEffect(() => { if (running && !busy.current) void finish(running, 1); }, [running]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => { if (!busy.current) setPhase({ kind: 'idle' }); };
  const est = phase.kind === 'explain' ? phase.estimate?.ai : undefined, available = !!est?.configured && est.elements > 0;

  return <section className="sr-edit" aria-label="Edit Your Creative">
    <h4><Layers3 size={17} aria-hidden="true" />Edit Your Creative</h4>
    <p className="sr-edit-sub">Want to customize individual products, text, or logos? Turn your creative into editable layers.</p>
    {ready && current ? <>
      <button type="button" className="ws-btn ws-btn-primary sr-edit-btn" disabled={opening} onClick={() => void openEditor(existing!.template.id)}><PenTool size={16} aria-hidden="true" />{opening ? 'Opening your editing workspace…' : existing!.product.editorDraft?.creativeId ? 'Continue Editing' : 'Open Visual Editor'}</button>
      <p className="sr-edit-note is-ok">Your creative is already separated into layers — no new cost. <button type="button" className="ws-btn ws-btn-quiet prt-inline" onClick={() => onOpenTemplate(existing!.template.id)}>Review Layers</button></p>
    </> : <>
      {!current && ready && <div className="sr-edit-changed" role="note"><p>You changed your creative after it was separated into layers. To edit the new version, separate it again (you’ll see the cost first). Your earlier edits stay available.</p>
        <button type="button" className="ws-btn ws-btn-quiet prt-inline" disabled={opening} onClick={() => void openEditor(existing!.template.id)}>Continue editing the earlier version</button></div>}
      <button type="button" className="ws-btn ws-btn-primary sr-edit-btn" disabled={phase.kind === 'explain' || phase.kind === 'working'} onClick={() => void explain()}><Layers3 size={16} aria-hidden="true" />{!current && ready ? 'Decompose Again' : 'Decompose into Layers'}</button>
      <p className="sr-edit-note">Separates the creative into individual elements so you can move, resize, and edit them.</p>
    </>}

    {phase.kind !== 'idle' && <div className="sr-modal-backdrop" onClick={phase.kind === 'explain' || phase.kind === 'failed' || phase.kind === 'done' ? close : undefined}>
      <div className="sr-modal sr-layers-modal" role="dialog" aria-modal="true" aria-labelledby="sr-layers-title" aria-busy={phase.kind === 'working' || (phase.kind === 'explain' && phase.checking)} onClick={e => e.stopPropagation()}>
        {(phase.kind === 'explain' || phase.kind === 'failed' || phase.kind === 'done') && <button type="button" className="sr-modal-x" aria-label="Close" onClick={close}><X size={18} /></button>}

        {phase.kind === 'explain' && <>
          <span className="sr-modal-icon" aria-hidden="true"><Layers3 size={22} /></span>
          <h3 id="sr-layers-title">Make Your Creative Editable</h3>
          <p>We’ll separate your creative into individual layers so you can adjust products, text, and other elements in the visual editor.</p>
          {phase.note && <p className="sr-modal-warn" role="status">{phase.note}</p>}
          <dl className="sr-cost">
            <div><dt>What happens</dt><dd>Each product, Ganesh Ji and the decorations become their own layers; your text and logos stay editable. Your saved creative isn’t changed.</dd></div>
            <div><dt>Estimated cost</dt><dd>{phase.checking ? <span className="sr-checking"><span className="sr-dot-spin" aria-hidden="true" />Checking your creative (free)…</span>
              : est ? (available ? <><strong>about {money(est.expectedUsd)}</strong> (at most {money(est.maxUsd)}){est.offline ? ' · test provider, nothing is charged' : ''}</> : 'Not available') : '—'}</dd></div>
            {!phase.checking && est && available && <div><dt>What runs</dt><dd>{est.offline ? 'A test stand-in for the AI (no network)' : `One new paid AI request (OpenAI plan, then Seedream), ${est.elements} element${est.elements === 1 ? '' : 's'}`}</dd></div>}
          </dl>
          {!phase.checking && est && !available && <p className="sr-modal-warn" role="alert">Layer separation isn’t available on this server right now. Your creative is saved — try again later.</p>}
          <div className="sr-modal-actions">
            <button type="button" className="ws-btn ws-btn-primary ws-btn-large" disabled={phase.checking || !available || !phase.layersId} onClick={() => phase.layersId && est && void confirm(phase.layersId, est.maxUsd)}><Sparkles size={16} aria-hidden="true" />{est && available && !est.offline ? `Make Editable · about ${money(est.expectedUsd)}` : 'Make Editable'}</button>
            <button type="button" className="ws-btn ws-btn-quiet" onClick={close}>Cancel</button>
          </div>
        </>}

        {phase.kind === 'working' && <div className="sr-layers-working">
          <span className="sr-spinner" aria-hidden="true" />
          <h3 id="sr-layers-title">Making your creative editable</h3>
          <ol className="sr-progress">{STAGES.map((s, i) => <li key={s} className={i < phase.at ? 'is-done' : i === phase.at ? 'is-current' : ''} aria-current={i === phase.at ? 'step' : undefined}>
            <span aria-hidden="true">{i < phase.at ? <Check size={13} /> : i === phase.at ? <span className="sr-dot-spin" /> : null}</span>{s}{i === phase.at ? '…' : ''}</li>)}</ol>
          <p className="sr-status" role="status">{STAGES[phase.at]}…</p>
          <p className="sr-hint">{phase.at === 1 ? 'Separating takes a minute or two. Your creative is saved; you can keep this open.' : 'Your creative is saved.'}</p>
        </div>}

        {phase.kind === 'done' && <>
          <span className="sr-modal-icon is-ok" aria-hidden="true"><Check size={22} /></span>
          <h3 id="sr-layers-title">Your Creative Is Ready to Edit!</h3>
          <p>Your creative has been separated into editable elements.</p>
          <div className="sr-modal-actions">
            <button type="button" className="ws-btn ws-btn-primary ws-btn-large" autoFocus disabled={opening} onClick={() => void openEditor(phase.layersId, phase.runId)}><PenTool size={16} aria-hidden="true" />{opening ? 'Opening your editing workspace…' : 'Open Visual Editor'}</button>
            <button type="button" className="ws-btn" onClick={() => onOpenTemplate(phase.layersId)}>Review Layers</button>
          </div>
        </>}

        {phase.kind === 'failed' && <>
          <span className="sr-modal-icon is-bad" aria-hidden="true"><X size={22} /></span>
          <h3 id="sr-layers-title">Something went wrong</h3>
          <p>{phase.message}</p>
          {phase.detail && <details className="sr-details"><summary>Technical details</summary><p>{phase.detail}</p></details>}
          <div className="sr-modal-actions">
            <button type="button" className="ws-btn ws-btn-primary" onClick={() => void explain()}><RefreshCw size={15} aria-hidden="true" />Try Again</button>
            {phase.layersId && <button type="button" className="ws-btn" onClick={() => onOpenTemplate(phase.layersId!)}>Review Layers</button>}
            <button type="button" className="ws-btn ws-btn-quiet" onClick={close}>Close</button>
          </div>
        </>}
      </div>
    </div>}
  </section>;
}
