/**
 * Scan & Review: the poster with a box over every word, logo and text plate the scan found, the list of them by category,
 * and the selected one's details. Corrections (text, box, category, style), additions, deletions, splitting and joining
 * words, and approvals change a draft; "Save changes" sends the whole draft. Coordinates are source pixels throughout:
 * the overlay is an SVG whose viewBox is the source, so zoom never reaches a stored value.
 */
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { CheckCheck, Plus, Save, Scissors, Trash2, Link2, Undo2 } from 'lucide-react';
import {
  GRAPHIC_CATEGORIES, LOW_WORD_CONFIDENCE, MASTER_CATEGORY_LABELS, OFFER_FONTS, offerWeights, TEXT_CATEGORIES,
  type DetectedWord, type LogoSlot, type MasterCategory, type SourceBox, type TextPlate, type WordGroup, type WordStyle,
} from '@frameflow/shared';
import { masterFileUrl, type MasterView, type ReviewDraft } from './api';

type Selection = { kind: 'word' | 'logo' | 'plate'; id: string } | null;
const hex10 = () => Array.from(crypto.getRandomValues(new Uint8Array(5)), b => b.toString(16).padStart(2, '0')).join('');
const statusOf = (s: { review: { status: string }; confidence: number }, low: number) => s.review.status === 'rejected' ? 'rejected' : s.review.status === 'approved' ? 'approved' : s.confidence < low ? 'uncertain' : 'pending';
const round = (v: number) => Math.round(v * 10) / 10;

export function draftOf(v: MasterView): ReviewDraft {
  const a = v.template.textAnalysis!;
  return structuredClone({ words: a.words, groups: a.groups, logoSlots: a.logoSlots, plates: a.plates ?? [] });
}

export function ReviewWorkspace({ view, busy, onSave, onApproveAll, onContinue }: {
  view: MasterView; busy: boolean;
  onSave: (draft: ReviewDraft) => Promise<void>; onApproveAll: (includeUncertain: boolean) => Promise<void>; onContinue: () => void;
}) {
  const [draft, setDraft] = useState<ReviewDraft>(() => draftOf(view)), [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<Selection>(null), [drawing, setDrawing] = useState<'word' | 'logo' | null>(null);
  const size = { width: view.template.source.width, height: view.template.source.height };
  const change = (next: ReviewDraft) => { setDraft(next); setDirty(true); };
  const word = selected?.kind === 'word' ? draft.words.find(w => w.id === selected.id) : undefined;
  const logo = selected?.kind === 'logo' ? draft.logoSlots.find(l => l.id === selected.id) : undefined;
  const plate = selected?.kind === 'plate' ? draft.plates.find(p => p.id === selected.id) : undefined;
  const pending = [...draft.words, ...draft.logoSlots, ...draft.plates].filter(i => i.review.status === 'needs-review');
  const uncertain = [...draft.words.filter(w => w.confidence < LOW_WORD_CONFIDENCE), ...draft.logoSlots.filter(l => l.confidence < 0.6), ...draft.plates.filter(p => p.confidence < 0.6)].filter(i => i.review.status === 'needs-review');

  const setWord = (id: string, patch: Partial<DetectedWord>) => change({ ...draft, words: draft.words.map(w => w.id === id ? { ...w, ...patch } : w) });
  const setStyle = (id: string, patch: Partial<WordStyle>) => change({ ...draft, words: draft.words.map(w => w.id === id ? { ...w, style: { ...w.style, ...patch, fontMatch: 'admin' } } : w) });
  const setLogo = (id: string, patch: Partial<LogoSlot>) => change({ ...draft, logoSlots: draft.logoSlots.map(l => l.id === id ? { ...l, ...patch } : l) });
  const setPlate = (id: string, patch: Partial<TextPlate>) => change({ ...draft, plates: draft.plates.map(p => p.id === id ? { ...p, ...patch } : p) });
  const setGroup = (id: string, patch: Partial<WordGroup>) => change({ ...draft, groups: draft.groups.map(g => g.id === id ? { ...g, ...patch } : g) });
  const setBox = (sel: NonNullable<Selection>, box: SourceBox) => sel.kind === 'word' ? setWord(sel.id, { box }) : sel.kind === 'logo' ? setLogo(sel.id, { box }) : setPlate(sel.id, { box });
  const review = (sel: NonNullable<Selection>, status: 'approved' | 'rejected' | 'needs-review') => sel.kind === 'word' ? setWord(sel.id, { review: { status } }) : sel.kind === 'logo' ? setLogo(sel.id, { review: { status } }) : setPlate(sel.id, { review: { status } });

  const removeWord = (id: string) => {
    const groups = draft.groups.map(g => ({ ...g, lines: g.lines.map(l => ({ ...l, wordIds: l.wordIds.filter(x => x !== id) })).filter(l => l.wordIds.length) })).filter(g => g.lines.length);
    change({ ...draft, words: draft.words.filter(w => w.id !== id), groups, plates: draft.plates.filter(p => groups.some(g => g.id === p.groupId)) }); setSelected(null);
  };
  /** Splits a word at its spaces (or in two at the middle), sharing its box by the share of letters. */
  const splitWord = (w: DetectedWord) => {
    const parts = w.text.trim().includes(' ') ? w.text.trim().split(/\s+/) : [w.text.slice(0, Math.ceil(w.text.length / 2)), w.text.slice(Math.ceil(w.text.length / 2))].filter(Boolean);
    if (parts.length < 2) return;
    const total = parts.reduce((s, p) => s + p.length, 0) + (parts.length - 1) * 0.5;
    let x = w.box.x;
    const made = parts.map((text, i) => {
      const width = w.box.width * (text.length / total);
      const next: DetectedWord = { ...w, id: i ? `pw-${hex10()}` : w.id, text, box: { ...w.box, x, width }, review: { status: 'needs-review' }, origin: i ? 'admin' : w.origin, style: { ...w.style, originDx: i ? 0 : w.style.originDx } };
      x += width + (w.box.width * 0.5) / total; return next;
    });
    const groups = draft.groups.map(g => ({ ...g, lines: g.lines.map(l => ({ ...l, wordIds: l.wordIds.flatMap(id => id === w.id ? made.map(m => m.id) : [id]) })) }));
    change({ ...draft, words: draft.words.flatMap(x2 => x2.id === w.id ? made : [x2]), groups });
  };
  /** Joins a word with the next word on its line ("NO-" + "COST"): one word, one box. */
  const joinNext = (w: DetectedWord) => {
    const line = draft.groups.find(g => g.id === w.groupId)?.lines.find(l => l.id === w.lineId), k = line?.wordIds.indexOf(w.id) ?? -1, nextId = line?.wordIds[k + 1];
    const next = nextId && draft.words.find(x => x.id === nextId);
    if (!next) return;
    const x0 = Math.min(w.box.x, next.box.x), y0 = Math.min(w.box.y, next.box.y), x1 = Math.max(w.box.x + w.box.width, next.box.x + next.box.width), y1 = Math.max(w.box.y + w.box.height, next.box.y + next.box.height);
    const joined: DetectedWord = { ...w, text: `${w.text}${next.text}`, box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0, rotation: w.box.rotation }, review: { status: 'needs-review' } };
    const groups = draft.groups.map(g => ({ ...g, lines: g.lines.map(l => ({ ...l, wordIds: l.wordIds.filter(id => id !== next.id) })) }));
    change({ ...draft, words: draft.words.filter(x => x.id !== next.id).map(x => x.id === w.id ? joined : x), groups });
  };
  const addAt = (kind: 'word' | 'logo', box: SourceBox) => {
    if (kind === 'logo') {
      const slot: LogoSlot = { id: `pl-${hex10()}`, label: 'Added logo', elementId: 'new', box, normalized: { x: 0, y: 0, width: 0, height: 0 },
        original: { file: '', sha256: '', mime: 'image/png', width: 0, height: 0, bytes: 0, hasAlpha: true, placement: { x: 0, y: 0, width: 0, height: 0 } }, detection: 'admin', confidence: 1, order: draft.logoSlots.length,
        locked: false, replaceable: true, review: { status: 'approved' }, category: 'graphic' };
      change({ ...draft, logoSlots: [...draft.logoSlots, slot] }); setSelected({ kind: 'logo', id: slot.id }); return;
    }
    const groupId = `pg-${hex10()}`, lineId = `pn-${hex10()}`, size0 = Math.max(8, box.height * 0.78);
    const w: DetectedWord = { id: `pw-${hex10()}`, text: 'Text', recognized: { text: 'Text', confidence: 1, mode: 'admin' }, box, normalized: { x: 0, y: 0, width: 0, height: 0 }, elementId: 'new', groupId, lineId, order: draft.words.length,
      style: { fontFamily: 'Inter', fontMatch: 'admin', fontSize: size0, fontWeight: 600, fontStyle: 'normal', color: '#000000', opacity: 1, lineHeight: 1.2, letterSpacing: 0, baseline: box.height * 0.8, align: 'left' },
      confidence: 1, styleConfidence: 1, role: 'copy', review: { status: 'approved' }, locked: false, protected: false, origin: 'admin' };
    change({ ...draft, words: [...draft.words, w], groups: [...draft.groups, { id: groupId, elementId: 'new', label: 'Added text', lines: [{ id: lineId, wordIds: [w.id] }], align: 'left', category: 'supporting' }] });
    setSelected({ kind: 'word', id: w.id });
  };

  // The list: text by category and group, graphics by category.
  const sections = useMemo(() => {
    const textSections = TEXT_CATEGORIES.map(cat => ({ cat, groups: draft.groups.filter(g => (g.category ?? 'supporting') === cat) })).filter(s => s.groups.length);
    const logoSections = GRAPHIC_CATEGORIES.map(cat => ({ cat, slots: draft.logoSlots.filter(l => (l.category ?? 'graphic') === cat) })).filter(s => s.slots.length);
    return { textSections, logoSections };
  }, [draft]);
  const wordOf = (id: string) => draft.words.find(w => w.id === id);

  return <div className="ot-work">
    <div className="ot-stage">
      <div className="ot-stage-toolbar">
        <span className="ot-muted">{drawing ? `Drag on the poster to place the new ${drawing}.` : 'Click any box to check it. Drag a selected box to move it; drag its corner to resize.'}</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="ws-btn" aria-pressed={drawing === 'word'} onClick={() => setDrawing(drawing === 'word' ? null : 'word')}><Plus size={14} aria-hidden="true" />Add text</button>
        <button type="button" className="ws-btn" aria-pressed={drawing === 'logo'} onClick={() => setDrawing(drawing === 'logo' ? null : 'logo')}><Plus size={14} aria-hidden="true" />Add logo / graphic</button>
      </div>
      <PosterOverlay imageUrl={masterFileUrl(view.template.id, view.template.source.inputFile)} size={size} draft={draft} selected={selected} onSelect={s => { setSelected(s); setDrawing(null); }}
        onBox={setBox} drawing={drawing} onDrawn={(kind, box) => { addAt(kind, box); setDrawing(null); }} />
    </div>
    <div className="ot-panel" aria-label="Detected elements">
      <section>
        <h3>Detected elements <span className="ot-chip">{draft.words.filter(w => w.review.status !== 'rejected').length} words · {draft.logoSlots.filter(l => l.review.status !== 'rejected').length} logos</span></h3>
        <p className="ot-muted">{pending.length ? `${pending.length} to check${uncertain.length ? `, ${uncertain.length} uncertain (orange)` : ''}. Approve the confident ones together, then look at the rest.` : 'Everything is checked.'}{dirty ? ' You have unsaved changes.' : ''}</p>
        <div className="ot-row">
          <button type="button" className="ws-btn" disabled={busy || dirty || !pending.length} onClick={() => void onApproveAll(false)}><CheckCheck size={14} aria-hidden="true" />Approve all confident</button>
          <button type="button" className="ws-btn" disabled={busy || dirty || !pending.length} onClick={() => window.confirm(`Approve all ${pending.length} remaining elements, including ${uncertain.length} uncertain one(s)?`) && void onApproveAll(true)}>Approve all</button>
          <button type="button" className="ws-btn ws-btn-primary" disabled={busy || !dirty} onClick={() => void onSave(draft).then(() => setDirty(false))}><Save size={14} aria-hidden="true" />Save changes</button>
          {dirty && <button type="button" className="ws-btn ws-btn-quiet" disabled={busy} onClick={() => { setDraft(draftOf(view)); setDirty(false); setSelected(null); }}><Undo2 size={14} aria-hidden="true" />Discard</button>}
        </div>
      </section>
      {word || logo || plate ? <section aria-label="Selected element">
        {word && <WordDetails word={word} group={draft.groups.find(g => g.id === word.groupId)} onWord={p => setWord(word.id, p)} onStyle={p => setStyle(word.id, p)} onGroup={p => setGroup(word.groupId, p)}
          onReview={s => review({ kind: 'word', id: word.id }, s)} onDelete={() => removeWord(word.id)} onSplit={() => splitWord(word)} onJoin={() => joinNext(word)} />}
        {logo && <LogoDetails slot={logo} templateId={view.template.id} onSlot={p => setLogo(logo.id, p)} onReview={s => review({ kind: 'logo', id: logo.id }, s)} onDelete={() => { change({ ...draft, logoSlots: draft.logoSlots.filter(l => l.id !== logo.id) }); setSelected(null); }} />}
        {plate && <PlateDetails plate={plate} onPlate={p => setPlate(plate.id, p)} onReview={s => review({ kind: 'plate', id: plate.id }, s)} onDelete={() => { change({ ...draft, plates: draft.plates.filter(p => p.id !== plate.id) }); setSelected(null); }} />}
      </section> : null}
      {sections.textSections.map(({ cat, groups }) => <section key={cat}>
        <h4>{MASTER_CATEGORY_LABELS[cat]}</h4>
        <ul className="ot-list">{groups.flatMap(g => g.lines.flatMap(l => l.wordIds)).map(id => wordOf(id)).filter((w): w is DetectedWord => !!w).map(w => {
          const st = statusOf(w, LOW_WORD_CONFIDENCE);
          return <li key={w.id}><button type="button" className="ot-item" aria-pressed={selected?.id === w.id} onClick={() => setSelected({ kind: 'word', id: w.id })}>
            <span className={`ot-dot is-${st}`} aria-hidden="true" /><span>{w.text}</span><span className={`ot-chip${st === 'uncertain' ? ' is-warn' : st === 'approved' ? ' is-ok' : ''}`}>{st === 'uncertain' ? `${Math.round(w.confidence * 100)}%` : st}</span></button></li>;
        })}
          {draft.plates.filter(p => groups.some(g => g.id === p.groupId)).map(p => <li key={p.id}><button type="button" className="ot-item" aria-pressed={selected?.id === p.id} onClick={() => setSelected({ kind: 'plate', id: p.id })}>
            <span className={`ot-dot is-${statusOf(p, 0.6)}`} aria-hidden="true" /><span>Plate behind the text <span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 3, background: p.fill, verticalAlign: 'middle' }} /></span><span className="ot-chip">{p.review.status === 'needs-review' ? 'check' : p.review.status}</span></button></li>)}
        </ul>
      </section>)}
      {sections.logoSections.map(({ cat, slots }) => <section key={cat}>
        <h4>{MASTER_CATEGORY_LABELS[cat]}</h4>
        <ul className="ot-list">{slots.map(l => {
          const st = statusOf(l, 0.6);
          return <li key={l.id}><button type="button" className="ot-item" aria-pressed={selected?.id === l.id} onClick={() => setSelected({ kind: 'logo', id: l.id })}>
            {l.original.file ? <img src={masterFileUrl(view.template.id, l.original.file)} alt="" /> : <span className={`ot-dot is-${st}`} aria-hidden="true" />}<span>{l.label}</span><span className={`ot-chip${st === 'uncertain' ? ' is-warn' : st === 'approved' ? ' is-ok' : ''}`}>{st}</span></button></li>;
        })}</ul>
      </section>)}
      <section>
        <button type="button" className="ws-btn ws-btn-primary ws-btn-large" disabled={busy || dirty || pending.length > 0} onClick={onContinue}>Continue: prepare the background</button>
        {(dirty || pending.length > 0) && <p className="ot-muted">{dirty ? 'Save your changes first.' : 'Approve or reject every element to continue.'}</p>}
      </section>
    </div>
  </div>;
}

function Coordinates({ box, onBox }: { box: SourceBox; onBox: (b: SourceBox) => void }) {
  const field = (key: keyof SourceBox, label: string) => <label className="ot-field"><span>{label}</span><input type="number" step="1" aria-label={`${label} (source pixels)`} value={round(box[key])} onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) onBox({ ...box, [key]: v }); }} /></label>;
  return <details className="ot-more"><summary>Coordinates (source pixels)</summary><div className="ot-fields is-four">{field('x', 'X')}{field('y', 'Y')}{field('width', 'Width')}{field('height', 'Height')}{field('rotation', 'Rotation')}</div></details>;
}
function ReviewButtons({ status, onReview }: { status: string; onReview: (s: 'approved' | 'rejected' | 'needs-review') => void }) {
  return <div className="ot-row">
    <button type="button" className={`ws-btn${status === 'approved' ? ' ws-btn-primary' : ''}`} onClick={() => onReview('approved')}>Approve</button>
    <button type="button" className={`ws-btn${status === 'rejected' ? ' ws-btn-danger' : ''}`} title="Not replaceable content: it stays in the artwork" onClick={() => onReview('rejected')}>Keep in artwork</button>
    {status !== 'needs-review' && <button type="button" className="ws-btn ws-btn-quiet" onClick={() => onReview('needs-review')}>Undo</button>}
  </div>;
}
function WordDetails({ word, group, onWord, onStyle, onGroup, onReview, onDelete, onSplit, onJoin }: {
  word: DetectedWord; group?: WordGroup; onWord: (p: Partial<DetectedWord>) => void; onStyle: (p: Partial<WordStyle>) => void; onGroup: (p: Partial<WordGroup>) => void;
  onReview: (s: 'approved' | 'rejected' | 'needs-review') => void; onDelete: () => void; onSplit: () => void; onJoin: () => void;
}) {
  const weights = offerWeights(word.style.fontFamily);
  return <>
    <h3>Word <span className="ot-chip">{word.recognized.mode === 'admin' ? 'added by you' : `read as “${word.recognized.text}” · ${Math.round(word.recognized.confidence * 100)}%`}</span></h3>
    <label className="ot-field"><span>Text (one word; a space splits it)</span><input value={word.text} aria-label="Word text" onChange={e => onWord({ text: e.target.value })} /></label>
    {group && <label className="ot-field"><span>Group “{group.label.slice(0, 40)}” is</span><select value={group.category ?? 'supporting'} aria-label="Category" onChange={e => onGroup({ category: e.target.value as MasterCategory })}>{TEXT_CATEGORIES.map(c => <option key={c} value={c}>{MASTER_CATEGORY_LABELS[c]}</option>)}</select></label>}
    <ReviewButtons status={word.review.status} onReview={onReview} />
    <details className="ot-more"><summary>Font and colour (estimated from the poster)</summary>
      <div className="ot-fields">
        <label className="ot-field"><span>Font</span><select value={word.style.fontFamily} onChange={e => { const w2 = offerWeights(e.target.value); onStyle({ fontFamily: e.target.value, fontWeight: w2.includes(word.style.fontWeight) ? word.style.fontWeight : w2[w2.length - 1] }); }}>{OFFER_FONTS.map(f => <option key={f.family}>{f.family}</option>)}</select></label>
        <label className="ot-field"><span>Weight</span><select value={word.style.fontWeight} onChange={e => onStyle({ fontWeight: Number(e.target.value) as 400 | 600 | 700 })}>{weights.map(w => <option key={w} value={w}>{w}</option>)}</select></label>
        <label className="ot-field"><span>Size (px)</span><input type="number" min="1" value={round(word.style.fontSize)} onChange={e => onStyle({ fontSize: Math.max(1, Number(e.target.value) || 1) })} /></label>
        <label className="ot-field"><span>Colour</span><span className="ot-colour"><input type="color" value={word.style.color} onChange={e => onStyle({ color: e.target.value })} /><input type="text" value={word.style.color} onChange={e => /^#[\da-f]{6}$/i.test(e.target.value) && onStyle({ color: e.target.value })} /></span></label>
      </div>
    </details>
    <Coordinates box={word.box} onBox={box => onWord({ box })} />
    <div className="ot-row">
      <button type="button" className="ws-btn" onClick={onSplit}><Scissors size={14} aria-hidden="true" />Split</button>
      <button type="button" className="ws-btn" onClick={onJoin}><Link2 size={14} aria-hidden="true" />Join with next word</button>
      <button type="button" className="ws-btn ws-btn-danger" onClick={onDelete}><Trash2 size={14} aria-hidden="true" />Delete</button>
    </div>
  </>;
}
function LogoDetails({ slot, templateId, onSlot, onReview, onDelete }: { slot: LogoSlot; templateId: string; onSlot: (p: Partial<LogoSlot>) => void; onReview: (s: 'approved' | 'rejected' | 'needs-review') => void; onDelete: () => void }) {
  return <>
    <h3>Logo or graphic {slot.original.file && <img src={masterFileUrl(templateId, slot.original.file)} alt="" style={{ height: 28, maxWidth: 120, objectFit: 'contain' }} />}</h3>
    <label className="ot-field"><span>Name</span><input value={slot.label} aria-label="Logo name" maxLength={80} onChange={e => onSlot({ label: e.target.value })} /></label>
    <label className="ot-field"><span>Kind</span><select value={slot.category ?? 'graphic'} aria-label="Kind" onChange={e => onSlot({ category: e.target.value as MasterCategory })}>{GRAPHIC_CATEGORIES.map(c => <option key={c} value={c}>{MASTER_CATEGORY_LABELS[c]}</option>)}</select></label>
    <ReviewButtons status={slot.review.status} onReview={onReview} />
    <Coordinates box={slot.box} onBox={box => onSlot({ box })} />
    <div className="ot-row"><button type="button" className="ws-btn ws-btn-danger" onClick={onDelete}><Trash2 size={14} aria-hidden="true" />Delete</button></div>
  </>;
}
function PlateDetails({ plate, onPlate, onReview, onDelete }: { plate: TextPlate; onPlate: (p: Partial<TextPlate>) => void; onReview: (s: 'approved' | 'rejected' | 'needs-review') => void; onDelete: () => void }) {
  return <>
    <h3>Plate behind text</h3>
    <p className="ot-muted">A solid shape behind a line (a pill or a button). It becomes its own shape, so its colour can change in a creative.</p>
    <div className="ot-fields">
      <label className="ot-field"><span>Fill</span><span className="ot-colour"><input type="color" value={plate.fill} onChange={e => onPlate({ fill: e.target.value })} /><input type="text" value={plate.fill} onChange={e => /^#[\da-f]{6}$/i.test(e.target.value) && onPlate({ fill: e.target.value })} /></span></label>
      <label className="ot-field"><span>Outline</span><span className="ot-colour"><input type="color" value={plate.stroke?.color ?? '#000000'} onChange={e => onPlate({ stroke: { color: e.target.value, width: plate.stroke?.width ?? 2 } })} />
        <input type="number" min="0" max="40" aria-label="Outline width" value={plate.stroke?.width ?? 0} onChange={e => { const w = Number(e.target.value); onPlate({ stroke: w > 0 ? { color: plate.stroke?.color ?? '#000000', width: w } : null }); }} /></span></label>
      <label className="ot-field"><span>Corner radius</span><input type="number" min="0" value={round(plate.radius)} onChange={e => onPlate({ radius: Math.max(0, Number(e.target.value) || 0) })} /></label>
    </div>
    <ReviewButtons status={plate.review.status} onReview={onReview} />
    <Coordinates box={plate.box} onBox={box => onPlate({ box })} />
    <div className="ot-row"><button type="button" className="ws-btn ws-btn-danger" onClick={onDelete}><Trash2 size={14} aria-hidden="true" />Delete</button></div>
  </>;
}

/** The poster in source pixels with its boxes: select, move, resize, or draw a new one. */
function PosterOverlay({ imageUrl, size, draft, selected, onSelect, onBox, drawing, onDrawn }: {
  imageUrl: string; size: { width: number; height: number }; draft: ReviewDraft; selected: Selection; onSelect: (s: Selection) => void;
  onBox: (sel: NonNullable<Selection>, box: SourceBox) => void; drawing: 'word' | 'logo' | null; onDrawn: (kind: 'word' | 'logo', box: SourceBox) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ mode: 'move' | 'resize' | 'draw'; start: { x: number; y: number }; box: SourceBox; now?: SourceBox } | null>(null);
  const point = (e: ReactPointerEvent) => { const m = svg.current!.getScreenCTM()!.inverse(), p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m); return { x: p.x, y: p.y }; };
  const boxOfSelected = (): SourceBox | undefined => !selected ? undefined : selected.kind === 'word' ? draft.words.find(w => w.id === selected.id)?.box : selected.kind === 'logo' ? draft.logoSlots.find(l => l.id === selected.id)?.box : draft.plates.find(p => p.id === selected.id)?.box;
  const current = drag?.now ?? boxOfSelected();
  const handle = Math.max(10, size.width / 120);
  const items = [
    ...draft.plates.map(p => ({ sel: { kind: 'plate' as const, id: p.id }, box: p.box, cls: 'is-plate', status: p.review.status, label: 'Plate' })),
    ...draft.logoSlots.map(l => ({ sel: { kind: 'logo' as const, id: l.id }, box: l.box, cls: `is-logo${l.confidence < 0.6 && l.review.status === 'needs-review' ? ' is-uncertain' : ''}`, status: l.review.status, label: l.label })),
    ...draft.words.map(w => ({ sel: { kind: 'word' as const, id: w.id }, box: w.box, cls: w.confidence < LOW_WORD_CONFIDENCE && w.review.status === 'needs-review' ? 'is-uncertain' : '', status: w.review.status, label: w.text })),
  ];
  return <div className="ot-poster" data-testid="review-poster">
    <svg ref={svg} viewBox={`0 0 ${size.width} ${size.height}`} role="img" aria-label="Poster with detected elements" style={{ cursor: drawing ? 'crosshair' : undefined }}
      onPointerDown={e => { if (!drawing) return; const p = point(e); (e.target as Element).setPointerCapture?.(e.pointerId); setDrag({ mode: 'draw', start: p, box: { x: p.x, y: p.y, width: 1, height: 1, rotation: 0 } }); }}
      onPointerMove={e => {
        if (!drag) return;
        const p = point(e), dx = p.x - drag.start.x, dy = p.y - drag.start.y;
        if (drag.mode === 'move') setDrag({ ...drag, now: { ...drag.box, x: drag.box.x + dx, y: drag.box.y + dy } });
        else if (drag.mode === 'resize') setDrag({ ...drag, now: { ...drag.box, width: Math.max(4, drag.box.width + dx), height: Math.max(4, drag.box.height + dy) } });
        else setDrag({ ...drag, now: { x: Math.min(drag.start.x, p.x), y: Math.min(drag.start.y, p.y), width: Math.abs(dx), height: Math.abs(dy), rotation: 0 } });
      }}
      onPointerUp={() => {
        if (!drag) return;
        if (drag.mode === 'draw') { if (drag.now && drag.now.width > 6 && drag.now.height > 6 && drawing) onDrawn(drawing, roundBox(drag.now)); }
        else if (drag.now && selected) onBox(selected, roundBox(drag.now));
        setDrag(null);
      }}>
      <image href={imageUrl} x="0" y="0" width={size.width} height={size.height} />
      {items.map(it => {
        const isSel = selected?.kind === it.sel.kind && selected.id === it.sel.id, b = isSel && current ? current : it.box;
        return <rect key={`${it.sel.kind}-${it.sel.id}`} className={`ot-box ${it.cls}${it.status === 'rejected' ? ' is-rejected' : ''}${isSel ? ' is-selected' : ''}`} x={b.x} y={b.y} width={b.width} height={b.height}
          transform={b.rotation ? `rotate(${b.rotation} ${b.x + b.width / 2} ${b.y + b.height / 2})` : undefined} data-label={it.label}
          onPointerDown={e => { if (drawing) return; e.stopPropagation(); onSelect(it.sel); if (isSel) { (e.target as Element).setPointerCapture?.(e.pointerId); setDrag({ mode: 'move', start: point(e), box: it.box }); } }}><title>{it.label}</title></rect>;
      })}
      {selected && current && !drawing && <rect className="ot-handle" x={current.x + current.width - handle / 2} y={current.y + current.height - handle / 2} width={handle} height={handle}
        onPointerDown={e => { e.stopPropagation(); (e.target as Element).setPointerCapture?.(e.pointerId); setDrag({ mode: 'resize', start: point(e), box: current }); }} />}
      {drag?.mode === 'draw' && drag.now && <rect className="ot-box is-selected" x={drag.now.x} y={drag.now.y} width={drag.now.width} height={drag.now.height} />}
    </svg>
  </div>;
}
const roundBox = (b: SourceBox): SourceBox => ({ x: round(b.x), y: round(b.y), width: round(b.width), height: round(b.height), rotation: b.rotation });
