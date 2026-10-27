/**
 * Step 3, Choose what to decompose: after the review, the person decides which visual elements become image layers of
 * their own (cut out, the background rebuilt behind them) and which stay part of the background picture. Text, bank and
 * payment logos and QR codes are never decomposed: they are taken off the picture and kept as editable layers. A brand
 * logo or graphic can be its own layer or stay in the picture. The choice is saved with the template (later preparations
 * and a detection run again keep it); "Continue to Decomposition" starts the existing preparation.
 *
 * Where the server has it, the decomposition is AI's (the OpenAI planner writes the instructions, Seedream Layerize splits
 * the picture without its text and logos): offered first, with its cost, used only after the person confirms it; the
 * decomposition on this computer stays available, free.
 */
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, CheckSquare, Layers, Scissors, Sparkles, Square } from 'lucide-react';
import { decomposesObject, type ProductObject } from '@frameflow/shared';
import { productApi, productFileUrl, type PrepareEstimate, type ProductView } from './api';

type Row = { key: string; kind: 'object' | 'logo'; id: string; label: string; group: string; box: { x: number; y: number; width: number; height: number }; on: boolean };
const GROUPS: { id: string; label: string; hint: string }[] = [
  { id: 'characters', label: 'Characters', hint: 'Cut out so they can be moved or replaced.' },
  { id: 'products', label: 'Products', hint: 'Cut out so they can be moved or replaced.' },
  { id: 'stands', label: 'Stands and podiums', hint: 'Ticked: a layer of its own under the products. Unticked: part of the background.' },
  { id: 'graphics', label: 'Decorations and frames', hint: 'Usually part of the background; tick one to move or hide it on its own.' },
  { id: 'brand', label: 'Brand logos and graphics', hint: 'Always restored as separate editable layers, outside image decomposition.' },
];
const groupOf = (o: ProductObject) => (o.kind === 'character' ? 'characters' : o.kind === 'product' ? 'products' : o.kind === 'podium' ? 'stands' : 'graphics');

export function ProductSelect({ view, onBack, onStarted, onError }: { view: ProductView; onBack: () => void; onStarted: (v: ProductView) => void; onError: (m: string) => void }) {
  const id = view.template.id, W = view.template.source.width, H = view.template.source.height;
  const initial = useMemo<Row[]>(() => [
    ...view.product.objects.filter(o => !o.hidden && o.kind !== 'brand-logo').map(o => ({ key: `o-${o.id}`, kind: 'object' as const, id: o.id, label: o.label, group: groupOf(o), box: o.box,
      on: o.kind === 'podium' ? o.layer === 'own' : decomposesObject(o) })),
    ...view.logos.filter(l => !l.removed && (l.category === 'brand-logo' || l.category === 'badge')).map(l => ({ key: `l-${l.id}`, kind: 'logo' as const, id: l.id, label: l.label, group: 'brand', box: l.box, on: true })),
  ], [view]);
  const [rows, setRows] = useState(initial), [busy, setBusy] = useState(false), [focus, setFocus] = useState<string>();
  const [estimate, setEstimate] = useState<PrepareEstimate>(), [confirmAi, setConfirmAi] = useState(false), [selectionRevision, setSelectionRevision] = useState<number>();
  useEffect(() => { void productApi.estimate(id).then(setEstimate).catch(() => undefined); }, [id, view.template.revision]);
  const ai = estimate?.ai, aiReady = !!ai?.configured && ai.elements > 0;
  const set = (key: string, on: boolean) => setRows(r => r.map(x => (x.key === key && x.kind !== 'logo' ? { ...x, on } : x)));
  const all = (on: boolean) => setRows(r => r.map(x => ({ ...x, on: x.kind === 'logo' || on })));
  const always = view.logos.filter(l => !l.removed && l.category !== 'brand-logo' && l.category !== 'badge');
  const cut = rows.filter(r => r.on && r.kind === 'object'), kept = rows.filter(r => !r.on && r.kind === 'object');
  const go = async (withAi = false) => {
    setBusy(true); onError('');
    try {
      const v = await productApi.select(id, { expectedRevision: selectionRevision ?? view.template.revision, objects: rows.filter(r => r.kind === 'object').map(r => ({ id: r.id, decompose: r.on })), logos: rows.filter(r => r.kind === 'logo').map(r => ({ slotId: r.id, separate: r.on })) });
      setSelectionRevision(v.template.revision);
      // (The cost is estimated again for the elements now chosen; the approval sent is that estimate's most.)
      const approve = withAi ? ai?.maxUsd ?? 0 : 0;
      const current = withAi ? await productApi.estimate(id) : undefined;
      if (current && current.ai.maxUsd > approve) { setEstimate(current); throw new Error('The selected elements increased the estimate. Review the new cost and confirm again.'); }
      onStarted((await productApi.prepare(id, { expectedRevision: v.template.revision, ...(withAi ? { engine: 'ai' as const, approveUsd: approve } : {}) })).template);
    } catch (e) { onError(e instanceof Error ? e.message : 'Could not start the decomposition.'); }
    finally { setBusy(false); setConfirmAi(false); }
  };
  const pct = (b: Row['box']) => ({ x: (b.x / W) * 100, y: (b.y / H) * 100, w: (b.width / W) * 100, h: (b.height / H) * 100 });
  return <div className="prt-select">
    <section className="prt-pane prt-select-list" aria-label="Elements to decompose">
      <div className="ot-row prt-select-all">
        <button type="button" className="ws-btn ws-btn-quiet" onClick={() => all(true)}><CheckSquare size={14} aria-hidden="true" />Select all</button>
        <button type="button" className="ws-btn ws-btn-quiet" onClick={() => all(false)}><Square size={14} aria-hidden="true" />Deselect all</button>
      </div>
      {GROUPS.map(g => { const list = rows.filter(r => r.group === g.id); if (!list.length) return null;
        return <section key={g.id} aria-label={g.label}><h3>{g.label}<span className="ot-chip">{list.filter(r => r.on).length}/{list.length}</span></h3><p className="ot-muted ot-small">{g.hint}</p>
          <ul className="prt-select-rows">{list.map(r => <li key={r.key} className={focus === r.key ? 'is-focus' : ''} onMouseEnter={() => setFocus(r.key)} onMouseLeave={() => setFocus(undefined)}>
            <label className="ot-check"><input type="checkbox" checked={r.on} disabled={r.kind === 'logo'} onChange={e => set(r.key, e.target.checked)} aria-label={`${r.kind === 'logo' ? 'Separate' : 'Decompose'} ${r.label}`} /><span>{r.label}</span></label></li>)}</ul></section>; })}
      <section aria-label="Always editable layers" className="prt-select-always">
        <h3>Always editable layers</h3>
        <p className="ot-muted ot-small">{view.counts.text} text block{view.counts.text === 1 ? '' : 's'} ({view.counts.words} words){always.length ? ` and ${always.length} bank, payment or QR logo${always.length === 1 ? '' : 's'}` : ''}: never sent to image decomposition. They are taken off the picture and kept as editable layers, so nothing is baked into the background or shown twice.</p>
      </section>
    </section>
    <section className="prt-pane prt-select-preview" aria-label="Preview of the choice">
      <div className="prt-select-stage" style={{ aspectRatio: `${W} / ${H}`, width: `min(100%, calc((100vh - 300px) * ${(W / H).toFixed(4)}))` }}>
        <img src={productFileUrl(id, view.template.source.inputFile)} alt="Your creative" draggable={false} />
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {rows.map(r => { const b = pct(r.box); return <rect key={r.key} x={b.x} y={b.y} width={b.w} height={b.h} className={`prt-select-box${r.on ? ' is-on' : ''}${focus === r.key ? ' is-focus' : ''}`} vectorEffect="non-scaling-stroke"
            onClick={() => set(r.key, !r.on)} onMouseEnter={() => setFocus(r.key)} onMouseLeave={() => setFocus(undefined)} />; })}
        </svg>
      </div>
      <p className="ot-muted ot-small"><span className="prt-key is-on" aria-hidden="true" /> Decomposed into its own layer <span className="prt-key" aria-hidden="true" /> Stays in the background. Click a box to switch it.</p>
    </section>
    <aside className="prt-pane prt-select-summary" aria-label="What happens next">
      <h3><Layers size={15} aria-hidden="true" />What happens next</h3>
      <ul className="prt-facts">
        <li><strong>{cut.length}</strong> element{cut.length === 1 ? '' : 's'} cut out as image layers, with the background rebuilt behind {cut.length === 1 ? 'it' : 'them'} (an estimate where it was never visible; you check it next).</li>
        <li><strong>{kept.length}</strong> left in the background picture exactly as {kept.length === 1 ? 'it is' : 'they are'}: {kept.length === 1 ? 'it moves' : 'they move'} with the background and cannot be moved or replaced on {kept.length === 1 ? 'its' : 'their'} own.</li>
        <li>Text and logos become editable layers; none of them stay in the background.</li>
      </ul>
      {aiReady && ai && <section className="prt-ai-choice" aria-label="Decompose with AI">
        <p className="ot-small"><strong>Decompose with AI</strong> — {ai.offline ? <>an <strong>offline stand-in</strong> (no OpenAI, no Seedream: for testing only).</> : <>an OpenAI planner writes the instructions and <strong>Seedream Layerize</strong> splits the picture into layers. Only the picture without its text and logos is sent, with the elements’ names and boxes — never the words.</>}</p>
        {!confirmAi ? <button type="button" className="ws-btn ws-btn-primary ws-btn-large" disabled={busy || !cut.length} onClick={() => (ai.offline ? void go(true) : setConfirmAi(true))}><Sparkles size={15} aria-hidden="true" />{busy ? 'Starting…' : ai.offline ? 'Decompose with AI (offline stand-in, free)' : `Decompose with AI… (about $${ai.expectedUsd.toFixed(2)})`}</button>
          : <div className="prt-confirm" role="group" aria-label="Confirm the cost"><p>Spend about <strong>${ai.expectedUsd.toFixed(2)}</strong> (at most ${ai.maxUsd.toFixed(2)}) on {ai.note}</p>
            <div className="ot-row"><button type="button" className="ws-btn ws-btn-primary" disabled={busy || !cut.length} onClick={() => void go(true)}>Yes, decompose with AI</button><button type="button" className="ws-btn ws-btn-quiet" onClick={() => setConfirmAi(false)}>Cancel</button></div></div>}
      </section>}
      <button type="button" className={`ws-btn${aiReady ? '' : ' ws-btn-primary ws-btn-large'}`} disabled={busy || !cut.length || view.product.variation?.decompositionEngine === 'ai'} onClick={() => void go()}><Scissors size={15} aria-hidden="true" />{busy ? 'Starting…' : aiReady ? 'Continue to Decomposition on this computer (free)' : 'Continue to Decomposition'}</button>
      {!cut.length && <p className="ot-muted ot-small">Choose at least one element to decompose.</p>}
      <button type="button" className="ws-btn ws-btn-quiet" onClick={onBack}><ArrowLeft size={14} aria-hidden="true" />Back to the review</button>
      {view.product.variation?.decompositionEngine === 'ai' && <p className="ot-muted">This variation requires OpenAI + Seedream decomposition. Local preparation will not be used as a fallback.</p>}
      {!aiReady && <p className="ot-muted ot-small">{view.product.variation?.decompositionEngine === 'ai' ? 'AI decomposition must be available to continue.' : ai && ai.configured && !ai.elements ? 'Every element already has its own layer: decomposition runs on this computer and is free.' : 'Decomposition runs on this computer and is free.'}{ai && !ai.configured ? ' (AI decomposition — OpenAI planner and Seedream Layerize — is not set up on this server: it needs OPENAI_API_KEY and FAL_KEY.)' : ''}</p>}
    </aside>
  </div>;
}
