/**
 * Phase 2: a creative of a saved master. The master's saved background and artwork, with every word, logo and plate as
 * its own element on top, at its saved coordinates; the panel lists them as the master's own groups and slots. Edits are
 * saved to the creative (never to the master) a moment after each change. Nothing here runs OCR, a decomposition or any
 * AI request: the creative is made from the master's stored files.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlignCenter, AlignLeft, AlignRight, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Copy, Eye, EyeOff, ImagePlus, Layers3, Palette, Plus, RotateCcw, Split, Undo2, Upload, Wand2 } from 'lucide-react';
import {
  alignGroup, applyTypographyPreset, GRAPHIC_CATEGORIES, masterCreativeIssues, MASTER_CATEGORY_LABELS, MATCHED_EDGE_NOTE, OFFER_FONTS, offerHasItalic, offerWeights, reflowLine, rewriteGroup, TEXT_CATEGORIES, TYPOGRAPHY_PRESETS,
  type CreativeImage, type CreativeInstance, type CreativeText, type CreativeTextStyle, type MasterSnapshot, type OfferWeight,
} from '@frameflow/shared';
import { Alert } from '../templateStudio/ui';
import { masterApi, masterFileUrl, type CreativeSummary, type MasterView } from './api';
import { CreativeCanvas, type Selected } from './CreativeCanvas';
import { loadCreativeFonts, measureAdvance } from './creativeText';

const hex10 = () => Array.from(crypto.getRandomValues(new Uint8Array(5)), b => b.toString(16).padStart(2, '0')).join('');
const round = (v: number) => Math.round(v * 10) / 10;

export function CreativeStudio({ masterId, creativeId, onBack, onOpenEditor, onAi, onOpenRun }: { masterId: string; creativeId?: string; onBack: () => void; onOpenEditor: (masterId: string, creativeId: string) => Promise<void>; onAi?: () => void;
  /** Send to Decomposition: the decomposition run made from this creative, shown in the run dashboard. */
  onOpenRun?: (runId: string) => Promise<void> }) {
  const [view, setView] = useState<MasterView>(), [snapshot, setSnapshot] = useState<MasterSnapshot>(), [creative, setCreative] = useState<CreativeInstance>();
  const [sending, setSending] = useState(false);
  const [list, setList] = useState<CreativeSummary[]>([]), [error, setError] = useState(''), [notice, setNotice] = useState(''), [saveState, setSaveState] = useState<'saved' | 'saving' | 'unsaved' | 'error'>('saved');
  const [fontsRevision, setFontsRevision] = useState(0), [fontsFailed, setFontsFailed] = useState(false), [selected, setSelected] = useState<Selected>(null), [history, setHistory] = useState<CreativeInstance[]>([]);
  const latest = useRef<CreativeInstance | undefined>(undefined), saving = useRef<Promise<void> | null>(null), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Unsaved changes since the last save or load: a flush with none writes nothing (no new revision).
  const dirty = useRef(false);
  const stageBox = useRef<HTMLDivElement>(null), [stageWidth, setStageWidth] = useState(640);

  const open = useCallback(async (cid?: string) => {
    setError('');
    const v = await masterApi.get(masterId);
    setView(v);
    // Reuse: a new creative from the latest revision, or the one asked for. The master's files are read, nothing else runs.
    const c = cid ? await masterApi.getCreative(masterId, cid) : await masterApi.createCreative(masterId);
    const snap = await masterApi.snapshot(masterId, c.masterRevision);
    setSnapshot(snap); setCreative(c); latest.current = c; dirty.current = false; setHistory([]); setSelected(null); setSaveState('saved');
    setList((await masterApi.creatives(masterId)).creatives);
  }, [masterId]);
  const opened = useRef(false);
  useEffect(() => { if (opened.current) return; opened.current = true; void open(creativeId).catch((e: Error) => setError(e.message)); }, [open, creativeId]);
  useLayoutEffect(() => {
    const el = stageBox.current; if (!el) return;
    const ro = new ResizeObserver(() => setStageWidth(Math.max(260, Math.min(820, el.clientWidth - 28))));
    ro.observe(el); return () => ro.disconnect();
  }, [snapshot]);
  // Fonts: every face the creative draws with, from its own file, before measuring or drawing.
  const fontKey = creative ? JSON.stringify([...new Set(creative.texts.map(t => `${t.style.fontFamily}:${t.style.fontWeight}:${t.style.fontStyle}`))]) : '';
  useEffect(() => {
    if (!creative) return;
    let live = true;
    void loadCreativeFonts(creative).then(ok => { if (live) { setFontsFailed(!ok); setFontsRevision(r => r + 1); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontKey]);

  /** Saves the latest state a moment after the last change; a change made while saving is saved right after. */
  const flushRef = useRef<() => Promise<void>>(async () => undefined);
  const schedule = useCallback(() => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => { void flushRef.current().catch(() => undefined); }, 900); }, []);
  const flush = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = undefined; }
    while (saving.current) await saving.current;
    const c = latest.current;
    if (!c || !dirty.current) return;
    dirty.current = false;
    const work = (async () => {
      setSaveState('saving');
      try {
        const saved = await masterApi.saveCreative(c);
        const now = latest.current!;
        latest.current = { ...now, revision: saved.revision, updatedAt: saved.updatedAt };
        setCreative(latest.current);
        setSaveState(now === c ? 'saved' : 'unsaved');
        if (now !== c) schedule();
      } catch (e) { dirty.current = true; setSaveState('error'); setError(e instanceof Error ? e.message : 'Could not save the creative.'); throw e; }
    })();
    saving.current = work.then(() => undefined, () => undefined).finally(() => { saving.current = null; });
    await work;
  }, [schedule]);
  useEffect(() => { flushRef.current = flush; }, [flush]);
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); void flushRef.current().catch(() => undefined); } }, []);
  const update = (next: CreativeInstance, remember = true) => {
    if (remember && creative) setHistory(h => [...h.slice(-30), creative]);
    latest.current = next; dirty.current = true; setCreative(next); setSaveState('unsaved'); schedule();
  };

  const issues = useMemo(() => creative && fontsRevision ? masterCreativeIssues(creative, measureAdvance) : [], [creative, fontsRevision]);
  if (error && !creative) return <div className="ot-page"><Alert>{error}</Alert><button type="button" className="ws-btn" onClick={onBack}>Back</button></div>;
  if (!creative || !snapshot || !view) return <div className="ot-page"><p className="ot-muted" role="status">Loading the saved template…</p></div>;

  const c = creative;
  const setText = (id: string, patch: Partial<CreativeText>) => update({ ...c, texts: c.texts.map(t => t.id === id ? { ...t, ...patch } : t) });
  const setTextStyle = (id: string, patch: Partial<CreativeTextStyle>) => update({ ...c, texts: c.texts.map(t => t.id === id ? { ...t, style: { ...t.style, ...patch } } : t) });
  const setImage = (id: string, patch: Partial<CreativeImage>) => update({ ...c, images: c.images.map(i => i.id === id ? { ...i, ...patch } : i) });
  const move = (sel: NonNullable<Selected>, dx: number, dy: number) => {
    if (sel.kind === 'text') { const t = c.texts.find(x => x.id === sel.id)!; setText(sel.id, { x: t.x + dx, baselineY: t.baselineY + dy }); }
    else if (sel.kind === 'image') { const i = c.images.find(x => x.id === sel.id)!; setImage(sel.id, { box: { ...i.box, x: i.box.x + dx, y: i.box.y + dy } }); }
    else update({ ...c, shapes: c.shapes.map(s => s.id === sel.id ? { ...s, box: { ...s.box, x: s.box.x + dx, y: s.box.y + dy } } : s) });
  };
  const replaceImage = async (img: CreativeImage, file: File) => {
    const { asset, hasAlpha } = await masterApi.uploadAsset(c, file, file.name);
    setImage(img.id, { asset, hidden: false });
    if (!hasAlpha) setNotice(`${file.name} has no transparency: its own background shows as a box in the slot.`);
  };
  const addText = () => {
    const groupId = `cg-${hex10()}`, size = Math.round(Math.min(c.canvas.width, c.canvas.height) * 0.05);
    const text: CreativeText = { id: `ct-${hex10()}`, wordId: null, groupId, line: 0, order: c.texts.length, text: 'New text', x: c.canvas.width * 0.12, baselineY: c.canvas.height * 0.5, rotation: 0,
      style: { fontFamily: 'Poppins', fontWeight: 700, fontStyle: 'normal', fontSize: size, letterSpacing: 0, color: '#000000', opacity: 1 }, hidden: false, locked: false, z: 1 + Math.max(0, ...c.texts.map(t => t.z), ...c.images.map(i => i.z)) };
    update({ ...c, groups: [...c.groups, { id: groupId, label: 'Added text', category: 'supporting', masterGroupId: null, align: 'left' }], texts: [...c.texts, text] });
    setSelected({ kind: 'text', id: text.id });
  };
  const addPicture = async (file: File) => {
    const { asset } = await masterApi.uploadAsset(c, file, file.name), w = c.canvas.width * 0.25, h = w * (asset.kind === 'creative' ? asset.height / asset.width : 1);
    const img: CreativeImage = { id: `ci-${hex10()}`, slotId: null, category: 'graphic', label: file.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 60) || 'Picture', box: { x: c.canvas.width * 0.6, y: c.canvas.height * 0.1, width: w, height: h, rotation: 0 },
      asset, hidden: false, locked: false, z: 1 + Math.max(0, ...c.texts.map(t => t.z), ...c.images.map(i => i.z)) };
    update({ ...c, images: [...c.images, img] }); setSelected({ kind: 'image', id: img.id });
  };
  // Colours used by the texts and plates, near-identical ones as one, for a one-step change everywhere (teal to black).
  const near = (a: string, b: string) => [1, 3, 5].every(i => Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)) <= 18);
  const colours = [...c.texts.filter(t => !t.hidden).map(t => t.style.color), ...c.shapes.filter(s => !s.hidden).map(s => s.fill)].reduce<string[]>((acc, col) => acc.some(a => near(a, col)) ? acc : [...acc, col], []);
  const recolour = (from: string, to: string) => update({ ...c, texts: c.texts.map(t => near(t.style.color, from) ? { ...t, style: { ...t.style, color: to } } : t), shapes: c.shapes.map(s => near(s.fill, from) ? { ...s, fill: to } : s) });
  /** The newest revision's background for this creative (refused when that revision also changes text or logos). */
  const rebase = async () => {
    setError('');
    try {
      await flush();
      const next = await masterApi.rebase(latest.current ?? c), snap = await masterApi.snapshot(masterId, next.masterRevision);
      setSnapshot(snap); setCreative(next); latest.current = next; dirty.current = false; setHistory([]); setSaveState('saved');
      setNotice(`This creative now uses version ${next.masterRevision} of the template. Only its background changed.`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not update the background.'); }
  };
  const openEditor = async () => { setError(''); try { await flush(); await onOpenEditor(masterId, c.id); } catch (e) { setError(e instanceof Error ? e.message : 'Could not open the editor.'); } };
  /** The saved creative as decomposition layers (made on the server from its own elements: no AI, no cost); the creative is not changed. */
  const sendToDecomposition = async () => {
    if (!onOpenRun || sending) return;
    setError(''); setSending(true);
    try { await flush(); const { runId } = await masterApi.decompose(latest.current ?? c); await onOpenRun(runId); }
    catch (e) { setError(e instanceof Error ? `Could not send the creative to decomposition: ${e.message}` : 'Could not send the creative to decomposition.'); }
    finally { setSending(false); }
  };

  const textCats = TEXT_CATEGORIES.map(cat => ({ cat, groups: c.groups.filter(g => g.category === cat && c.texts.some(t => t.groupId === g.id)) })).filter(x => x.groups.length);
  const otherGroups = c.groups.filter(g => !TEXT_CATEGORIES.includes(g.category) && c.texts.some(t => t.groupId === g.id));
  const logoCats = GRAPHIC_CATEGORIES.map(cat => ({ cat, images: c.images.filter(i => i.category === cat) })).filter(x => x.images.length);
  return <div className="ot-page">
    <div className="ot-head">
      <div className="ot-row">
        <button type="button" className="ws-btn ws-btn-quiet" onClick={() => void flush().catch(() => undefined).finally(onBack)}><ArrowLeft size={15} aria-hidden="true" />Templates</button>
        <div className="ot-title"><p className="ot-kicker">Creative from “{view.template.name}” · master revision {c.masterRevision}</p>
          <h2><input aria-label="Creative name" value={c.name} maxLength={120} onChange={e => update({ ...c, name: e.target.value }, false)} style={{ font: 'inherit', border: 0, background: 'transparent', maxWidth: Math.max(220, c.name.length * 13) }} /></h2></div>
      </div>
      <div className="ot-row">
        {onAi && <button type="button" className="ws-btn" onClick={() => void flush().then(onAi).catch((e: Error) => setError(e.message))}>Generate AI Variations</button>}
        <span className={`ot-chip${saveState === 'saved' ? ' is-ok' : saveState === 'error' ? ' is-warn' : ''}`} role="status" data-testid="creative-save-state">{{ saved: `Saved · revision ${c.revision}`, saving: 'Saving…', unsaved: 'Unsaved changes', error: 'Not saved' }[saveState]}</span>
        <button type="button" className="ws-btn" disabled={!history.length} onClick={() => { const prev = history[history.length - 1]; setHistory(h => h.slice(0, -1)); update({ ...prev, revision: c.revision }, false); }}><Undo2 size={14} aria-hidden="true" />Undo</button>
        <button type="button" className="ws-btn" onClick={() => void (async () => { await flush(); const copy = await masterApi.duplicate(c); setNotice(`Saved a copy: ${copy.name}.`); setList((await masterApi.creatives(masterId)).creatives); })().catch((e: Error) => setError(e.message))}><Copy size={14} aria-hidden="true" />Duplicate</button>
        {onOpenRun && <button type="button" className="ws-btn" disabled={sending} aria-busy={sending} title="Each text, logo, shape and the background as its own layer, in the decomposition workspace. Free: no AI request. This creative stays as it is."
          onClick={() => void sendToDecomposition()}><Split size={14} aria-hidden="true" />{sending ? 'Preparing layers…' : 'Send to Decomposition'}</button>}
        <button type="button" className="ws-btn ws-btn-primary" onClick={() => void openEditor()}><Layers3 size={15} aria-hidden="true" />Open in Editor</button>
      </div>
    </div>
    {c.backgroundColor && <label className="ot-colour">Background colour <input type="color" aria-label="Creative background colour" value={c.backgroundColor} onChange={e => update({ ...c, backgroundColor: e.target.value })} />
      {c.images.some(i => i.artwork && !i.hidden) && <span className="ot-small ot-muted">Shows around the template artwork; the artwork keeps its colours (hide or replace it under Other graphics).</span>}</label>}
    {c.origin.kind === 'ai'
      ? <p className="ot-zero ot-muted" data-testid="reuse-facts"><span className="ot-chip is-ok">AI design, saved</span><span className="ot-chip">Editing uses no AI</span><span className="ot-chip">No new scan</span>
        <span>This creative has its own size and background. Every word, logo and shape is its own element; changes are saved to this creative only.</span></p>
      : <p className="ot-zero ot-muted" data-testid="reuse-facts"><span className="ot-chip is-ok">Saved layers reused</span><span className="ot-chip">No new scan</span><span className="ot-chip">No decomposition</span><span className="ot-chip">No AI generation</span>
        <span>The master’s saved background and every element’s saved coordinates; changes are saved to this creative only.</span></p>}
    {view.latestRevision && c.masterRevision < view.latestRevision.revision && <Alert tone="warn"><span data-testid="newer-revision">This creative uses version {c.masterRevision} of the template; version {view.latestRevision.revision} is newer.
      If only the background changed there (for example a repaired clean background), use it here: your text, fonts, logos and positions stay as they are.</span>
      <div className="ot-row" style={{ marginTop: 8 }}><button type="button" className="ws-btn" onClick={() => void rebase()}>Use the newer background</button></div></Alert>}
    {error && <Alert>{error}</Alert>}
    {notice && <Alert tone="ok">{notice}</Alert>}
    {fontsFailed && <Alert tone="warn">A font could not be loaded from its file; the preview may draw it in a fallback face. Choose another font for those words.</Alert>}
    <div className="ot-work">
      <div className="ot-stage" ref={stageBox}>
        <CreativeCanvas snapshot={snapshot} creative={c} fontsRevision={fontsRevision} width={stageWidth} selected={selected} onSelect={setSelected} onMove={move} />
      </div>
      <div className="ot-panel" aria-label="Creative content">
        <section>
          <h3>Colours <Palette size={14} aria-hidden="true" /></h3>
          <p className="ot-muted">Change a colour everywhere it is used (text and plates).</p>
          <div className="ot-row">{colours.map(col => <label key={col} className="ot-colour" title={`Change ${col} everywhere`}>
            <input type="color" value={col} aria-label={`Replace colour ${col}`} onChange={e => recolour(col, e.target.value)} /><span className="ot-small">{col}</span></label>)}</div>
          <details className="ot-more"><summary>Suggest styles (local presets, no AI)</summary>
            <div className="ot-row">{TYPOGRAPHY_PRESETS.map(p => <button key={p.id} type="button" className="ws-btn" title={p.summary} onClick={() => update({ ...c, texts: applyTypographyPreset(c, p.id, snapshot) })}><Wand2 size={13} aria-hidden="true" />{p.name}</button>)}</div>
            <p className="ot-muted">Fixed rules on the same saved artwork: they change fonts or colours, never the text or the background.</p>
          </details>
        </section>
        {[...textCats.map(x => ({ title: MASTER_CATEGORY_LABELS[x.cat], groups: x.groups })), ...(otherGroups.length ? [{ title: 'Other text', groups: otherGroups }] : [])].map(sec => <section key={sec.title}>
          <h4>{sec.title}</h4>
          {sec.groups.map(g => <GroupFields key={g.id} creative={c} groupId={g.id} selected={selected} onSelect={setSelected} setText={setText} setTextStyle={setTextStyle} update={update} />)}
        </section>)}
        {logoCats.map(sec => <section key={sec.cat}>
          <h4>{MASTER_CATEGORY_LABELS[sec.cat]} ({sec.images.length})</h4>
          {sec.images.map(img => {
            const slot = img.slotId ? snapshot.logoSlots.find(l => l.id === img.slotId) : undefined, masterFile = slot ? slot.replacement?.file ?? slot.original.file : undefined;
            return <div key={img.id} className={`ot-logo${selected?.id === img.id ? ' is-selected' : ''}`} data-testid="logo-slot">
              <button type="button" style={{ padding: 0, border: 0, background: 'none' }} onClick={() => setSelected({ kind: 'image', id: img.id })}><img src={masterFileUrl(masterId, img.asset.file)} alt={img.label} style={{ opacity: img.hidden ? 0.35 : 1 }} /></button>
              <div style={{ display: 'grid', gap: 4 }}>
                <span className="ot-small">{img.label}{img.artwork ? ' · from this template' : img.asset.kind === 'creative' ? (img.asset.originalName?.includes(MATCHED_EDGE_NOTE) ? ' · edge matched to the background' : ' · replaced') : ''}{img.hidden ? ' · hidden' : ''}</span>
                <div className="ot-row">
                  <label className="ws-btn"><Upload size={13} aria-hidden="true" />Replace<input type="file" hidden accept="image/png,image/jpeg,image/webp" aria-label={`Replace ${img.label}`} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void replaceImage(img, f).catch((er: Error) => setError(er.message)); }} /></label>
                  {masterFile && img.asset.kind === 'creative' && <button type="button" className="ws-btn ws-btn-quiet" onClick={() => setImage(img.id, { asset: { kind: 'master', file: masterFile } })}><RotateCcw size={13} aria-hidden="true" />Restore</button>}
                  <button type="button" className="ws-btn ws-btn-quiet" aria-label={img.hidden ? `Show ${img.label}` : `Hide ${img.label}`} onClick={() => setImage(img.id, { hidden: !img.hidden })}>{img.hidden ? <Eye size={13} aria-hidden="true" /> : <EyeOff size={13} aria-hidden="true" />}</button>
                </div>
                {selected?.id === img.id && <BoxFields box={img.box} onBox={box => setImage(img.id, { box })} />}
              </div>
            </div>;
          })}
        </section>)}
        <section>
          <h4>Add</h4>
          <div className="ot-row">
            <button type="button" className="ws-btn" onClick={addText}><Plus size={14} aria-hidden="true" />Add text</button>
            <label className="ws-btn"><ImagePlus size={14} aria-hidden="true" />Add picture (badge, QR code, logo)<input type="file" hidden accept="image/png,image/jpeg,image/webp" aria-label="Add picture" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void addPicture(f).catch((er: Error) => setError(er.message)); }} /></label>
          </div>
        </section>
        {issues.length > 0 && <section aria-label="Layout checks">
          <h4>Layout checks</h4>
          <ul className="ot-issues">{issues.slice(0, 12).map((i, k) => <li key={k} className={`is-${i.severity}`}>{i.message}</li>)}</ul>
          <p className="ot-muted">Measured with the real fonts. Move or resize the elements, or use “Fix spacing” on a line.</p>
        </section>}
        {list.length > 1 && <section>
          <h4>Other creatives of this master</h4>
          <ul className="ot-list">{list.filter(x => x.id !== c.id).slice(0, 12).map(x => <li key={x.id}><button type="button" className="ot-item" onClick={() => void flush().catch(() => undefined).then(() => open(x.id)).catch((e: Error) => setError(e.message))}>
            <span className="ot-dot is-approved" aria-hidden="true" /><span>{x.name}</span><span className="ot-chip">r{x.revision}</span></button></li>)}</ul>
        </section>}
      </div>
    </div>
  </div>;
}

function BoxFields({ box, onBox }: { box: { x: number; y: number; width: number; height: number; rotation: number }; onBox: (b: typeof box) => void }) {
  const f = (k: keyof typeof box, l: string) => <label className="ot-field"><span>{l}</span><input type="number" value={round(box[k])} onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) onBox({ ...box, [k]: v }); }} /></label>;
  return <details className="ot-more"><summary>Position and size (source pixels)</summary><div className="ot-fields is-four">{f('x', 'X')}{f('y', 'Y')}{f('width', 'W')}{f('height', 'H')}</div></details>;
}

/** One group of the master: each word as its own field (text, colour, font, size, weight), a rewrite of the whole group, its plate. */
function GroupFields({ creative: c, groupId, selected, onSelect, setText, setTextStyle, update }: {
  creative: CreativeInstance; groupId: string; selected: Selected; onSelect: (s: Selected) => void;
  setText: (id: string, p: Partial<CreativeText>) => void; setTextStyle: (id: string, p: Partial<CreativeTextStyle>) => void; update: (c: CreativeInstance) => void;
}) {
  const group = c.groups.find(g => g.id === groupId)!, words = c.texts.filter(t => t.groupId === groupId).sort((a, b) => a.line - b.line || a.order - b.order);
  const lines = [...new Set(words.map(w => w.line))];
  const [rewriting, setRewriting] = useState(false), [copy, setCopy] = useState(''), [warnings, setWarnings] = useState<string[]>([]);
  const plate = c.shapes.find(s => s.groupId === groupId);
  const groupColour = words.every(w => w.style.color === words[0]?.style.color) ? words[0]?.style.color : undefined;
  return <div style={{ display: 'grid', gap: 6, paddingBottom: 6 }} data-testid="text-group">
    <div className="ot-row" style={{ justifyContent: 'space-between' }}>
      <strong className="ot-small">{group.label.slice(0, 48)}</strong>
      <span className="ot-row">
        {groupColour && <label className="ot-colour" title="Colour of the whole group"><input type="color" aria-label={`Colour of ${group.label}`} value={groupColour} onChange={e => update({ ...c, texts: c.texts.map(t => t.groupId === groupId ? { ...t, style: { ...t.style, color: e.target.value } } : t) })} /></label>}
        <button type="button" className="ws-btn ws-btn-quiet" onClick={() => { setCopy(lines.map(n => words.filter(w => w.line === n).map(w => w.text).join(' ')).join('\n')); setRewriting(!rewriting); setWarnings([]); }}>Rewrite</button>
      </span>
    </div>
    <div className="ot-row" role="group" aria-label={`Layout of ${group.label}`}>
      {(['left', 'center', 'right'] as const).map(a => { const Icon = a === 'left' ? AlignLeft : a === 'center' ? AlignCenter : AlignRight; return <button key={a} type="button" className={`ws-btn ws-btn-quiet${group.align === a ? ' is-on' : ''}`} aria-pressed={group.align === a} aria-label={`Align ${a}`} title={`Align the group ${a} (used when rewriting or fixing spacing)`}
        onClick={() => update(alignGroup(c, groupId, a, measureAdvance))}><Icon size={13} aria-hidden="true" /></button>; })}
      <span className="ot-small ot-muted" style={{ marginLeft: 6 }}>Move</span>
      {([[0, -1, ArrowUp, 'up'], [0, 1, ArrowDown, 'down'], [-1, 0, ArrowLeft, 'left'], [1, 0, ArrowRight, 'right']] as const).map(([dx, dy, Icon, name]) => <button key={name} type="button" className="ws-btn ws-btn-quiet" aria-label={`Move ${group.label} ${name}`}
        onClick={() => { const step = Math.max(c.canvas.width, c.canvas.height) * 0.01; update({ ...c, texts: c.texts.map(t => t.groupId === groupId ? { ...t, x: t.x + dx * step, baselineY: t.baselineY + dy * step } : t), shapes: c.shapes.map(sh => sh.groupId === groupId ? { ...sh, box: { ...sh.box, x: sh.box.x + dx * step, y: sh.box.y + dy * step } } : sh) }); }}><Icon size={13} aria-hidden="true" /></button>)}
    </div>
    {rewriting && <div style={{ display: 'grid', gap: 6 }}>
      <label className="ot-field"><span>New copy (one line per row; every word stays its own text)</span><textarea rows={Math.max(2, lines.length + 1)} value={copy} aria-label={`New copy for ${group.label}`} onChange={e => setCopy(e.target.value)} /></label>
      <div className="ot-row">
        <button type="button" className="ws-btn ws-btn-primary" onClick={() => { const r = rewriteGroup(c, groupId, copy, measureAdvance, { newId: () => `ct-${hex10()}` }); setWarnings(r.warnings); update({ ...c, texts: r.texts, shapes: r.shapes }); setRewriting(false); }}>Apply</button>
        <button type="button" className="ws-btn ws-btn-quiet" onClick={() => setRewriting(false)}>Cancel</button>
      </div>
    </div>}
    {warnings.length > 0 && <ul className="ot-issues">{warnings.map((w, i) => <li key={i} className="is-warning">{w}</li>)}</ul>}
    {words.map(w => {
      const sel = selected?.kind === 'text' && selected.id === w.id, weights = offerWeights(w.style.fontFamily);
      return <div key={w.id} className={`ot-word${sel ? ' is-selected' : ''}`} data-testid="word-field">
        <input type="text" value={w.text} aria-label={`Word “${w.text}”`} onFocus={() => onSelect({ kind: 'text', id: w.id })} onChange={e => setText(w.id, { text: e.target.value.replace(/\n/g, ' ') })} />
        <input type="color" value={w.style.color} aria-label={`Colour of “${w.text}”`} onChange={e => setTextStyle(w.id, { color: e.target.value })} />
        <button type="button" className="ws-btn ws-btn-quiet" aria-label={w.hidden ? `Show “${w.text}”` : `Hide “${w.text}”`} onClick={() => setText(w.id, { hidden: !w.hidden })}>{w.hidden ? <Eye size={13} aria-hidden="true" /> : <EyeOff size={13} aria-hidden="true" />}</button>
        {sel && <div className="ot-word-style">
          <select aria-label={`Font of “${w.text}”`} value={w.style.fontFamily} onChange={e => { const ws = offerWeights(e.target.value); setTextStyle(w.id, { fontFamily: e.target.value, fontWeight: (ws.includes(w.style.fontWeight) ? w.style.fontWeight : ws[ws.length - 1]) as OfferWeight, fontStyle: w.style.fontStyle === 'italic' && offerHasItalic(e.target.value) ? 'italic' : 'normal' }); }}>
            {OFFER_FONTS.map(f => <option key={f.family}>{f.family}</option>)}</select>
          <input type="number" min="4" aria-label={`Size of “${w.text}”`} value={round(w.style.fontSize)} onChange={e => setTextStyle(w.id, { fontSize: Math.max(4, Number(e.target.value) || 4) })} />
          <select aria-label={`Weight of “${w.text}”`} value={w.style.fontWeight} onChange={e => setTextStyle(w.id, { fontWeight: Number(e.target.value) as OfferWeight })}>{weights.map(x => <option key={x} value={x}>{x === 400 ? 'Regular' : x === 600 ? 'Semibold' : 'Bold'}</option>)}</select>
          <button type="button" className="ws-btn ws-btn-quiet" disabled={!offerHasItalic(w.style.fontFamily, w.style.fontWeight)} aria-pressed={w.style.fontStyle === 'italic'} onClick={() => setTextStyle(w.id, { fontStyle: w.style.fontStyle === 'italic' ? 'normal' : 'italic' })}><em>I</em></button>
          <div className="ot-row" style={{ gridColumn: '1 / -1' }}>
            <button type="button" className="ws-btn ws-btn-quiet" title="Space the words of this line again around its anchor" onClick={() => update({ ...c, texts: reflowLine(c, groupId, w.line, measureAdvance) })}>Fix spacing</button>
            <button type="button" className="ws-btn ws-btn-quiet" onClick={() => update({ ...c, texts: c.texts.filter(t => t.id !== w.id) })}>Remove word</button>
          </div>
        </div>}
      </div>;
    })}
    {plate && <div className="ot-row"><span className="ot-small">Plate</span>
      <label className="ot-colour"><input type="color" aria-label={`Plate colour of ${group.label}`} value={plate.fill} onChange={e => update({ ...c, shapes: c.shapes.map(s => s.id === plate.id ? { ...s, fill: e.target.value } : s) })} /></label>
      {plate.stroke && <label className="ot-colour"><input type="color" aria-label={`Plate outline of ${group.label}`} value={plate.stroke.color} onChange={e => update({ ...c, shapes: c.shapes.map(s => s.id === plate.id ? { ...s, stroke: { ...s.stroke!, color: e.target.value } } : s) })} /><span className="ot-small">outline</span></label>}
      <button type="button" className="ws-btn ws-btn-quiet" onClick={() => update({ ...c, shapes: c.shapes.map(s => s.id === plate.id ? { ...s, hidden: !s.hidden } : s) })}>{plate.hidden ? 'Show plate' : 'Hide plate'}</button>
    </div>}
  </div>;
}
