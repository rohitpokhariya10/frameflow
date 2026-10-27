/**
 * The parent keys this by the analysis revision: a new analysis or a saved correction starts a fresh draft, while a
 * refresh of the same revision keeps what is being edited.
 *
 * Step 6 of a protected template: its words and logo slots. The server's local recognizer (no AI provider, nothing sent
 * anywhere) reads the confirmed regions; every word keeps the recognizer's own box and a measured style, and every logo
 * becomes its own replaceable slot. The administrator corrects text, geometry and style, marks claims and legal text as
 * protected, and approves or rejects each one before variations are made.
 */
import { useMemo, useState } from 'react';
import { CheckCircle2, Plus, RefreshCw, RotateCcw, Save, ScanText, Upload, XCircle } from 'lucide-react';
import { analysisReviewed, catalogFont, LOW_WORD_CONFIDENCE, TEXT_FONTS, WORD_ROLE_LABELS, type DetectedWord, type LogoSlot, type ProtectedTemplateView, type TextAnalysis, type WordRole, type WordStyle } from '@frameflow/shared';
import { Alert, Badge, fmtDate } from '../templateStudio/ui';
import { FontPicker } from '../fonts/FontPicker';
import { newLineId, newWordId, protectedFileUrl, wordsApi } from './api';

type Act = (work: () => Promise<void>, done?: string) => Promise<void>;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const reviewTone = (s: DetectedWord['review']['status']) => s === 'approved' ? 'ok' : s === 'rejected' ? 'danger' : 'warn';
const REVIEW_LABEL = { 'needs-review': 'Needs review', approved: 'Approved', rejected: 'Rejected' } as const;

export function WordsAndLogos({ template: t, busy, act, apply, confirmed }: { template: ProtectedTemplateView; busy: boolean; act: Act; apply: (t: ProtectedTemplateView) => void; confirmed: boolean }) {
  const [draft, setDraft] = useState<TextAnalysis | undefined>(t.textAnalysis), [dirty, setDirty] = useState(false), [selected, setSelected] = useState<string | null>(null);
  const words = useMemo(() => new Map((draft?.words ?? []).map(w => [w.id, w])), [draft]);
  const change = (next: TextAnalysis) => { setDraft(next); setDirty(true); };
  const setWord = (id: string, patch: Partial<DetectedWord>) => draft && change({ ...draft, words: draft.words.map(w => w.id === id ? { ...w, ...patch } : w) });
  const setStyle = (id: string, patch: Partial<WordStyle>) => { const w = words.get(id); if (w) setWord(id, { style: { ...w.style, ...patch, fontMatch: 'admin' } }); };
  const setSlot = (id: string, patch: Partial<LogoSlot>) => draft && change({ ...draft, logoSlots: draft.logoSlots.map(l => l.id === id ? { ...l, ...patch } : l) });
  const save = () => act(async () => { if (draft) apply(await wordsApi.correct(t, draft)); }, 'Words and logos saved.');
  const analyse = () => act(async () => apply(await wordsApi.analyse(t)), t.textAnalysis ? 'Found again. Your corrections and reviews were kept for the words found again.' : 'Words and logos found. Review each one.');

  if (!confirmed) return <p className="ts-muted">Confirm the protected regions first: words are read inside them only.</p>;
  if (!draft) return <div className="sv-intro">
    <p>Reads every word inside the confirmed regions <strong>on this server</strong> with a local text recognizer ({'tesseract.js'}): no AI provider is called and nothing leaves this machine. Logos become separate image slots; a grid of logo cards becomes one slot per card. Every result is an estimate you review.</p>
    <button type="button" className="ws-btn ws-btn-primary" disabled={busy} onClick={() => void analyse()}><ScanText size={15} aria-hidden="true" />Find words and logos (local, free)</button>
  </div>;

  const size = t.source, sel = selected ? words.get(selected) ?? draft.logoSlots.find(l => l.id === selected) : undefined;
  const pending = draft.words.filter(w => w.review.status === 'needs-review').length + draft.logoSlots.filter(l => l.review.status === 'needs-review').length;
  const approveAll = () => change({ ...draft, words: draft.words.map(w => w.review.status === 'needs-review' ? { ...w, review: { status: 'approved' } } : w), logoSlots: draft.logoSlots.map(l => l.review.status === 'needs-review' ? { ...l, review: { status: 'approved' } } : l) });
  const addWord = (groupId: string) => {
    const g = draft.groups.find(x => x.id === groupId)!, last = words.get(g.lines.at(-1)!.wordIds.at(-1)!)!;
    const id = newWordId(), line = { id: newLineId(), wordIds: [id] }, box = { ...last.box, y: last.box.y + last.box.height * 1.2 };
    const word: DetectedWord = { ...last, id, text: 'Word', recognized: { text: 'Word', confidence: 1, mode: 'admin' }, box, lineId: line.id, order: draft.words.length, confidence: 1, styleConfidence: 1, review: { status: 'approved' }, origin: 'admin', role: 'copy', protected: false };
    change({ ...draft, words: [...draft.words, word], groups: draft.groups.map(x => x.id === groupId ? { ...x, lines: [...x.lines, line] } : x) });
    setSelected(id);
  };
  const removeWord = (id: string) => { change({ ...draft, words: draft.words.filter(w => w.id !== id), groups: draft.groups.map(g => ({ ...g, lines: g.lines.map(l => ({ ...l, wordIds: l.wordIds.filter(x => x !== id) })) })) }); setSelected(null); };
  const problems = t.wordProblems ?? [];
  return <div className="sv-words">
    <p className="ts-hint">Read by {draft.engine.name} {draft.engine.version} ({draft.engine.model}) on {fmtDate(draft.analyzedAt)}, on this server. {draft.words.length} words in {draft.groups.length} phrases, {draft.logoSlots.length} logo slots. Boxes are the recognizer's own; styles and fonts are measured estimates (the closest font the editor has).</p>
    {t.stale.textAnalysis && <Alert tone="warn">The regions changed after the words were found. Find them again (your corrections are kept for words found again).</Alert>}
    <div className="sv-annotate">
      <figure className="sv-figure" style={{ aspectRatio: `${size.width} / ${size.height}` }}>
        <img src={protectedFileUrl(t.id, t.source.inputFile)} alt="Source creative with the words and logos found" />
        <svg viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none" aria-label="Words and logo slots on the creative" role="img">
          {draft.logoSlots.map(l => <rect key={l.id} className={`sv-box sv-logo${l.id === selected ? ' is-selected' : ''}${l.review.status === 'rejected' ? ' is-rejected' : ''}`} x={l.box.x} y={l.box.y} width={l.box.width} height={l.box.height}
            transform={l.box.rotation ? `rotate(${l.box.rotation} ${l.box.x + l.box.width / 2} ${l.box.y + l.box.height / 2})` : undefined} onClick={() => setSelected(l.id)}><title>{l.label}</title></rect>)}
          {draft.words.map(w => <rect key={w.id} className={`sv-box sv-word${w.id === selected ? ' is-selected' : ''}${w.review.status === 'rejected' ? ' is-rejected' : ''}${w.confidence < LOW_WORD_CONFIDENCE ? ' is-low' : ''}`} x={w.box.x} y={w.box.y} width={w.box.width} height={w.box.height}
            transform={w.box.rotation ? `rotate(${w.box.rotation} ${w.box.x + w.box.width / 2} ${w.box.y + w.box.height / 2})` : undefined} onClick={() => setSelected(w.id)}><title>{w.text}</title></rect>)}
        </svg>
      </figure>
      <aside className="sv-side">
        <h4>Words ({draft.words.length})</h4>
        <ol className="sv-groups" aria-label="Phrases">{draft.groups.map(g => <li key={g.id}>
          <div className="sv-group-head"><strong>{g.label}</strong><small>{t.elements.find(e => e.id === g.elementId)?.label.slice(0, 40)} · {g.align}</small>
            <button type="button" className="ws-link" onClick={() => addWord(g.id)}><Plus size={12} aria-hidden="true" />Add a word</button></div>
          {g.lines.map((line, li) => <ul key={line.id} className="sv-line" aria-label={`Line ${li + 1} of ${g.label}`}>{line.wordIds.map(id => words.get(id)).filter((w): w is DetectedWord => !!w).map(w =>
            <li key={w.id} className={w.id === selected ? 'is-selected' : undefined}>
              <button type="button" className="sv-word-pick" aria-pressed={w.id === selected} onClick={() => setSelected(w.id)} aria-label={`Select word ${w.text}`}>{w.text}</button>
              <Badge tone={w.confidence < LOW_WORD_CONFIDENCE ? 'warn' : 'neutral'}>{pct(w.confidence)}</Badge>
              {w.protected && <Badge tone="accent">{WORD_ROLE_LABELS[w.role]}</Badge>}
              <Badge tone={reviewTone(w.review.status)}>{REVIEW_LABEL[w.review.status]}</Badge>
            </li>)}</ul>)}
        </li>)}</ol>
        <h4>Logo slots ({draft.logoSlots.length})</h4>
        <ul className="sv-logos" aria-label="Logo slots">{draft.logoSlots.map(l => <li key={l.id} className={l.id === selected ? 'is-selected' : undefined}>
          <button type="button" className="sv-logo-pick" aria-pressed={l.id === selected} onClick={() => setSelected(l.id)} aria-label={`Select logo ${l.label}`}>
            <img src={protectedFileUrl(t.id, l.replacement?.file ?? l.original.file)} alt="" /></button>
          <span>{l.label}<small>{l.detection === 'tile-grid' ? 'card of a logo grid' : l.detection === 'element' ? 'whole region' : 'drawn by hand'}{l.replacement ? ' · replaced' : ''}</small></span>
          <Badge tone={reviewTone(l.review.status)}>{REVIEW_LABEL[l.review.status]}</Badge>
        </li>)}</ul>
      </aside>
    </div>
    {sel && 'text' in sel ? <WordDetail key={sel.id} word={sel} onText={text => setWord(sel.id, { text })} onWord={patch => setWord(sel.id, patch)} onStyle={patch => setStyle(sel.id, patch)} onRemove={sel.origin === 'admin' ? () => removeWord(sel.id) : undefined} />
      : sel ? <LogoDetail key={sel.id} slot={sel} templateId={t.id} dirty={dirty} busy={busy} onSlot={patch => setSlot(sel.id, patch)}
        onReplace={file => void act(async () => apply(await wordsApi.replaceLogo(t, sel.id, file)), 'Logo replaced; the original pixels are kept and can be restored.')}
        onRestore={() => void act(async () => apply(await wordsApi.restoreLogo(t, sel.id)), 'Original logo pixels restored.')} />
      : <p className="ts-hint">Select a word or a logo, on the creative or in the lists, to correct it.</p>}
    {problems.length > 0 && <ul className="pt-problems" aria-label="Word problems">{problems.slice(0, 30).map((p, i) => <li key={i} className={`is-${p.severity}`}>{p.message}</li>)}</ul>}
    <div className="ws-row">
      <button type="button" className="ws-btn" disabled={busy || !pending} onClick={approveAll}><CheckCircle2 size={15} aria-hidden="true" />Approve all remaining ({pending})</button>
      <button type="button" className="ws-btn ws-btn-primary" disabled={busy || !dirty} onClick={() => void save()}><Save size={15} aria-hidden="true" />Save words and logos</button>
      <button type="button" className="ws-btn ws-btn-quiet" disabled={busy || dirty} onClick={() => void analyse()}><RefreshCw size={14} aria-hidden="true" />Find again</button>
      {dirty ? <span className="ts-hint">Unsaved changes.</span> : analysisReviewed(draft) ? <Badge tone="ok">Every word and logo reviewed</Badge> : <span className="ts-hint">{pending} left to review before variations.</span>}
    </div>
    <details className="sv-history"><summary>Review history ({draft.history.length})</summary>
      <ol>{[...draft.history].reverse().slice(0, 40).map((e, i) => <li key={i}><time>{fmtDate(e.at)}</time> {e.action}{e.detail ? `: ${e.detail}` : ''}</li>)}</ol></details>
  </div>;
}

function num(value: string, fallback: number) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function WordDetail({ word: w, onText, onWord, onStyle, onRemove }: { word: DetectedWord; onText: (t: string) => void; onWord: (p: Partial<DetectedWord>) => void; onStyle: (p: Partial<WordStyle>) => void; onRemove?: () => void }) {
  const box = (key: keyof DetectedWord['box'], v: string) => onWord({ box: { ...w.box, [key]: num(v, w.box[key]) } });
  return <section className="sv-detail" aria-label={`Word ${w.text}`}>
    <div className="sv-detail-head"><h4>Word “{w.text}”</h4><small>read as “{w.recognized.text}” with {pct(w.recognized.confidence)} confidence ({w.recognized.mode}) · style {pct(w.styleConfidence)} · {w.origin === 'admin' ? 'added by hand' : 'found by the recognizer'}</small></div>
    <div className="sv-fields">
      <div className="ts-field"><label htmlFor="sv-word-text">Text, exactly as it appears</label><input id="sv-word-text" value={w.text} maxLength={80} onChange={e => onText(e.target.value.replace(/\s+/g, ''))} /></div>
      <div className="ts-field"><label htmlFor="sv-word-role">What it is</label><select id="sv-word-role" value={w.role} onChange={e => { const role = e.target.value as WordRole; onWord({ role, protected: role !== 'copy' ? true : w.protected }); }}>
        {Object.entries(WORD_ROLE_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select></div>
      <label className="ts-check"><input type="checkbox" checked={w.protected} onChange={e => onWord({ protected: e.target.checked })} /><span>Protected: no variation or suggestion may change its text</span></label>
      <label className="ts-check"><input type="checkbox" checked={w.locked} onChange={e => onWord({ locked: e.target.checked })} /><span>Locked in the editor</span></label>
    </div>
    <div className="sv-fields sv-geometry" role="group" aria-label="Original position (source pixels)">
      {(['x', 'y', 'width', 'height', 'rotation'] as const).map(k => <div key={k} className="ts-field"><label htmlFor={`sv-word-${k}`}>{k === 'rotation' ? 'Rotation (°)' : `${k[0].toUpperCase()}${k.slice(1)} (source px)`}</label>
        <input id={`sv-word-${k}`} type="number" step={k === 'rotation' ? 0.5 : 1} value={Math.round(w.box[k] * 10) / 10} onChange={e => box(k, e.target.value)} /></div>)}
    </div>
    <div className="sv-fields" role="group" aria-label="Style">
      <div className="ts-field"><label htmlFor="sv-word-font">Font (closest the editor has)</label><select id="sv-word-font" value={w.style.fontFamily} onChange={e => onStyle({ fontFamily: e.target.value })}>
        {!TEXT_FONTS.some(f => f === w.style.fontFamily) && <option value={w.style.fontFamily}>{w.style.fontFamily}</option>}{TEXT_FONTS.map(f => <option key={f} value={f}>{f}</option>)}</select>
        <FontPicker value={w.style.fontFamily} onChange={fontFamily => onStyle({ fontFamily, ...(w.style.fontStyle === 'italic' && !catalogFont(fontFamily)?.italic ? { fontStyle: 'normal' as const } : {}) })} /></div>
      <div className="ts-field"><label htmlFor="sv-word-size">Size (source px)</label><input id="sv-word-size" type="number" min={1} max={4096} value={w.style.fontSize} onChange={e => onStyle({ fontSize: num(e.target.value, w.style.fontSize) })} /></div>
      <div className="ts-field"><label htmlFor="sv-word-weight">Weight</label><select id="sv-word-weight" value={w.style.fontWeight} onChange={e => onStyle({ fontWeight: Number(e.target.value) as WordStyle['fontWeight'] })}><option value={400}>Regular</option><option value={600}>Semibold</option><option value={700}>Bold</option></select></div>
      <label className="ts-check"><input type="checkbox" checked={w.style.fontStyle === 'italic'} onChange={e => onStyle({ fontStyle: e.target.checked ? 'italic' : 'normal' })} /><span>Italic</span></label>
      <div className="ts-field"><label htmlFor="sv-word-color">Colour</label><input id="sv-word-color" type="color" value={w.style.color} onChange={e => onStyle({ color: e.target.value })} /></div>
      <div className="ts-field"><label htmlFor="sv-word-baseline">Baseline (px below the box top)</label><input id="sv-word-baseline" type="number" value={w.style.baseline} onChange={e => onStyle({ baseline: num(e.target.value, w.style.baseline) })} /></div>
    </div>
    <div className="ws-row" role="group" aria-label="Review">
      <button type="button" className="ws-btn" aria-pressed={w.review.status === 'approved'} onClick={() => onWord({ review: { status: 'approved' } })}><CheckCircle2 size={14} aria-hidden="true" />Approve word</button>
      <button type="button" className="ws-btn" aria-pressed={w.review.status === 'rejected'} onClick={() => onWord({ review: { status: 'rejected' } })}><XCircle size={14} aria-hidden="true" />Reject (not a word)</button>
      {w.review.status !== 'needs-review' && <button type="button" className="ws-link" onClick={() => onWord({ review: { status: 'needs-review' } })}>Review again</button>}
      {onRemove && <button type="button" className="ws-link" onClick={onRemove}>Remove this word</button>}
    </div>
  </section>;
}

function LogoDetail({ slot: l, templateId, dirty, busy, onSlot, onReplace, onRestore }: { slot: LogoSlot; templateId: string; dirty: boolean; busy: boolean; onSlot: (p: Partial<LogoSlot>) => void; onReplace: (f: File) => void; onRestore: () => void }) {
  return <section className="sv-detail" aria-label={`Logo ${l.label}`}>
    <div className="sv-detail-head"><h4>{l.label}</h4><small>{l.original.width}×{l.original.height} source pixels at {Math.round(l.box.x)}, {Math.round(l.box.y)} · exact source pixels, never resampled</small></div>
    <div className="sv-logo-compare"><figure><img src={protectedFileUrl(templateId, l.original.file)} alt={`${l.label}: original pixels`} /><figcaption>Original pixels</figcaption></figure>
      {l.replacement && <figure><img src={protectedFileUrl(templateId, l.replacement.file)} alt={`${l.label}: replacement`} /><figcaption>Replacement · {l.replacement.originalName ?? l.replacement.file}{l.replacement.hasAlpha ? '' : ' · no transparency'}</figcaption></figure>}</div>
    <div className="sv-fields">
      <div className="ts-field"><label htmlFor="sv-logo-label">Name</label><input id="sv-logo-label" value={l.label} maxLength={120} onChange={e => onSlot({ label: e.target.value })} /></div>
      <label className="ts-check"><input type="checkbox" checked={l.locked} onChange={e => onSlot({ locked: e.target.checked })} /><span>Locked in the editor</span></label>
      <label className="ts-check"><input type="checkbox" checked={l.replaceable} onChange={e => onSlot({ replaceable: e.target.checked })} /><span>Replaceable</span></label>
    </div>
    <div className="ws-row">
      <button type="button" className="ws-btn" aria-pressed={l.review.status === 'approved'} onClick={() => onSlot({ review: { status: 'approved' } })}><CheckCircle2 size={14} aria-hidden="true" />Approve logo</button>
      <button type="button" className="ws-btn" aria-pressed={l.review.status === 'rejected'} onClick={() => onSlot({ review: { status: 'rejected' } })}><XCircle size={14} aria-hidden="true" />Reject (not a logo)</button>
      <label className={`ws-btn${dirty || busy || !l.replaceable ? ' is-disabled' : ''}`}><Upload size={14} aria-hidden="true" />Replace logo…<input type="file" hidden accept="image/png,image/jpeg,image/webp" aria-label={`Replacement for ${l.label}`} disabled={dirty || busy || !l.replaceable}
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onReplace(f); }} /></label>
      {l.replacement && <button type="button" className="ws-btn ws-btn-quiet" disabled={dirty || busy} onClick={onRestore}><RotateCcw size={14} aria-hidden="true" />Restore original</button>}
      {dirty && <span className="ts-hint">Save first to replace a logo.</span>}
    </div>
  </section>;
}
