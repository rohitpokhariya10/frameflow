/**
 * Step 2, Review: what was found in the creative, as one editable state. Three panes: the elements in their groups (what
 * needs a look first), the creative with a box per element (select, move, resize, draw a new one; zoom), and the selected
 * element (its name, what it is, approve or remove). Undo and redo cover every change; nothing is sent until "Prepare".
 *
 * Shortcuts: Delete removes, Enter approves, arrows nudge (Shift: 10 px), Ctrl/Cmd+Z undo, Shift+Ctrl/Cmd+Z or Ctrl+Y
 * redo, + and − zoom, Esc deselects.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { AlertTriangle, Check, Keyboard, Minus, Plus, Redo2, RotateCcw, SquareDashedMousePointer, Trash2, Undo2, Wand2 } from 'lucide-react';
import { MASTER_CATEGORY_LABELS, TEXT_CATEGORIES, type MasterCategory, type PixelRect, type ProductObjectKind } from '@frameflow/shared';
import { productApi, productFileUrl, type ProductView } from './api';

type ObjItem = { key: string; id?: string; kind: ProductObjectKind; label: string; box: PixelRect; accepted: boolean; attention?: string; removed: boolean; hidden?: boolean; layer?: 'own' | 'background' };
type TextItem = { key: string; category: MasterCategory; text: string; original: string; removed: boolean; accepted: boolean; attention: boolean; box: PixelRect; confidence: number; overlaps?: string[]; isNew?: boolean };
/** One word of a block: its text, box and block (`moveTo`: another block's key, or 'new' for a block of its own). */
type WordItem = { key: string; group: string; line: number; text: string; original: string; box: PixelRect; originalBox: PixelRect; removed: boolean; originallyRemoved: boolean; attention: boolean; moveTo?: string };
type LogoItem = { key: string; slotId?: string; category: 'brand-logo' | 'partner-logo' | 'qr' | 'badge'; label: string; box: PixelRect; removed: boolean; accepted: boolean; attention: boolean; file?: string; replacement?: string | null };
type Draft = { objects: ObjItem[]; texts: TextItem[]; words: WordItem[]; logos: LogoItem[]; dismissMissing: boolean };
type Sel = { type: 'object' | 'text' | 'word' | 'logo' | 'missing'; key: string } | null;
type Kind = ProductObjectKind | 'bank-logo' | 'text';

const KIND_OPTIONS: { value: Kind; label: string }[] = [
  { value: 'product', label: 'Product' }, { value: 'character', label: 'Character' }, { value: 'brand-logo', label: 'Brand logo (part of the design)' },
  { value: 'bank-logo', label: 'Bank or payment logo (editable)' }, { value: 'podium', label: 'Podium or stand' }, { value: 'frame', label: 'Frame or border' }, { value: 'decoration', label: 'Decoration' },
];
/** What "Add" can draw: an object, a logo, or text the detection missed. */
const ADD_OPTIONS: { value: Kind; label: string }[] = [...KIND_OPTIONS, { value: 'text', label: 'Text the detection missed' }];
const sameBox = (a: PixelRect, b: PixelRect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const GROUP_OF = (t: 'object' | 'text' | 'word' | 'logo' | 'missing' | Kind): string => t === 'character' ? 'characters' : t === 'product' ? 'products' : t === 'text' ? 'text' : t === 'brand-logo' || t === 'bank-logo' || t === 'logo' ? 'logos' : 'background';
const GROUPS = [{ id: 'characters', label: 'Characters' }, { id: 'products', label: 'Products' }, { id: 'text', label: 'Text' }, { id: 'logos', label: 'Logos' }, { id: 'background', label: 'Background & decorations' }];
let seq = 0;
const newKey = (p: string) => `${p}-new-${++seq}`;

function initial(v: ProductView): Draft {
  return {
    objects: v.product.objects.map(o => ({ key: o.id, id: o.id, kind: o.kind, label: o.label, box: { ...o.box }, accepted: o.review.status !== 'attention', attention: o.review.status === 'attention' ? o.review.reason : undefined, removed: false, ...(o.hidden ? { hidden: true } : {}), ...(o.layer ? { layer: o.layer } : {}) })),
    texts: v.texts.map(t => ({ key: t.id, category: t.category, text: t.text, original: t.text, removed: t.removed, accepted: !t.attention, attention: t.attention, ...(t.overlaps ? { overlaps: t.overlaps } : {}), box: t.box, confidence: t.confidence })),
    words: v.texts.flatMap(t => (t.wordList ?? []).map(w => ({ key: w.id, group: t.id, line: w.line, text: w.text, original: w.text, box: { ...w.box }, originalBox: { ...w.box }, removed: w.removed, originallyRemoved: w.removed, attention: w.attention }))),
    logos: v.logos.filter(l => l.category === 'brand-logo' || l.category === 'partner-logo' || l.category === 'qr' || l.category === 'badge').map(l => ({ key: l.id, slotId: l.id, category: l.category as LogoItem['category'], label: l.label, box: { ...l.box }, removed: l.removed, accepted: !l.attention, attention: l.attention, file: l.file })),
    dismissMissing: false,
  };
}

export function ProductReview({ view, onSaved, onError }: { view: ProductView; onSaved: (v: ProductView, prepare: boolean) => Promise<void>; onError: (message: string) => void }) {
  const W = view.template.source.width, H = view.template.source.height, id = view.template.id;
  const [draft, setDraft] = useState<Draft>(() => initial(view)), [undo, setUndo] = useState<Draft[]>([]), [redo, setRedo] = useState<Draft[]>([]);
  const [sel, setSel] = useState<Sel>(null), [zoom, setZoom] = useState(1), [adding, setAdding] = useState<Kind | null>(null), [busy, setBusy] = useState(false), [showKeys, setShowKeys] = useState(false);
  // Text blocks opened into their words (in the list and on the picture), and the corrections preview.
  const [expanded, setExpanded] = useState<Set<string>>(new Set()), [preview, setPreview] = useState(false), [uploading, setUploading] = useState(false);
  const toggleBlock = (key: string) => setExpanded(e => { const n = new Set(e); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  // 100 %: the whole creative in view (as wide as the pane, as tall as the screen allows).
  const scroller = useRef<HTMLDivElement>(null), [room, setRoom] = useState({ width: 600, height: 600 });
  useEffect(() => { const el = scroller.current; if (!el) return; const measure = () => setRoom({ width: Math.max(200, el.clientWidth - 12), height: Math.max(320, window.innerHeight - el.getBoundingClientRect().top - 70) });
    const ro = new ResizeObserver(measure); ro.observe(el); window.addEventListener('resize', measure); measure(); return () => { ro.disconnect(); window.removeEventListener('resize', measure); }; }, []);
  const fit = Math.min(room.width / W, room.height / H);
  const svg = useRef<SVGSVGElement>(null), drag = useRef<{ mode: 'move' | 'resize' | 'draw'; corner?: string; start: { x: number; y: number }; before: Draft; box: PixelRect; sel: NonNullable<Sel> } | null>(null);
  const change = useCallback((next: (d: Draft) => Draft) => { setDraft(d => { setUndo(u => [...u.slice(-80), d]); setRedo([]); return next(d); }); }, []);
  const missing = useMemo(() => draft.dismissMissing ? [] : view.product.detection?.missingText ?? [], [draft.dismissMissing, view.product.detection?.missingText]);

  // --- What needs a look -------------------------------------------------------------------------------------------
  const attention = useMemo(() => [
    ...draft.objects.filter(o => !o.removed && !o.accepted && o.attention).map(o => ({ sel: { type: 'object' as const, key: o.key }, label: o.label, reason: o.attention! })),
    ...draft.texts.filter(t => !t.removed && !t.accepted && t.attention).map(t => ({ sel: { type: 'text' as const, key: t.key }, label: t.text.split('\n')[0].slice(0, 50), reason: t.overlaps ? `${t.overlaps.slice(0, 3).join(', ')}: set again, these would be drawn over other words — probably misread. Open the block's words to remove or correct them.` : `Read with ${Math.round(t.confidence * 100)}% certainty: check the wording.` })),
    ...draft.logos.filter(l => !l.removed && !l.accepted && l.attention).map(l => ({ sel: { type: 'logo' as const, key: l.key }, label: l.label, reason: 'Check that this is a logo.' })),
    ...missing.map((m, i) => ({ sel: { type: 'missing' as const, key: `missing-${i}` }, label: m.text.slice(0, 50), reason: 'Seen but not read as text: it will stay part of the background.' })),
  ], [draft, missing]);
  const approveAll = () => change(d => ({ ...d, objects: d.objects.map(o => ({ ...o, accepted: true })), texts: d.texts.map(t => ({ ...t, accepted: true })), logos: d.logos.map(l => ({ ...l, accepted: true })), dismissMissing: true }));

  // --- Selection helpers ---------------------------------------------------------------------------------------------
  const selected = sel?.type === 'object' ? draft.objects.find(o => o.key === sel.key) : undefined, selText = sel?.type === 'text' ? draft.texts.find(t => t.key === sel.key) : undefined, selLogo = sel?.type === 'logo' ? draft.logos.find(l => l.key === sel.key) : undefined;
  const selWord = sel?.type === 'word' ? draft.words.find(w => w.key === sel.key) : undefined;
  /** A block's words changed one by one (text, box, removal or block): its wording is then edited word by word only. */
  const wordEdited = (w: WordItem) => w.text !== w.original || !sameBox(w.box, w.originalBox) || w.removed !== w.originallyRemoved || !!w.moveTo;
  const blockHasWordEdits = (key: string) => draft.words.some(w => w.group === key && wordEdited(w));
  const boxOf = (s: NonNullable<Sel>): PixelRect | undefined => s.type === 'object' ? draft.objects.find(o => o.key === s.key)?.box : s.type === 'text' ? draft.texts.find(t => t.key === s.key)?.box : s.type === 'word' ? draft.words.find(w => w.key === s.key)?.box : s.type === 'logo' ? draft.logos.find(l => l.key === s.key)?.box : missing[Number(s.key.slice(8))]?.box;
  const setBox = (s: NonNullable<Sel>, box: PixelRect) => setDraft(d => ({ ...d, objects: s.type === 'object' ? d.objects.map(o => (o.key === s.key ? { ...o, box, accepted: true } : o)) : d.objects, texts: s.type === 'text' ? d.texts.map(t => (t.key === s.key ? { ...t, box, accepted: true } : t)) : d.texts, words: s.type === 'word' ? d.words.map(w => (w.key === s.key ? { ...w, box } : w)) : d.words, logos: s.type === 'logo' ? d.logos.map(l => (l.key === s.key ? { ...l, box, accepted: true } : l)) : d.logos }));
  const remove = (s: NonNullable<Sel>) => change(d => ({ ...d, objects: d.objects.map(o => (s.type === 'object' && o.key === s.key ? { ...o, removed: true } : o)), texts: d.texts.map(t => (s.type === 'text' && t.key === s.key ? { ...t, removed: true } : t)), words: d.words.map(w => (s.type === 'word' && w.key === s.key ? { ...w, removed: true } : w)), logos: d.logos.map(l => (s.type === 'logo' && l.key === s.key ? { ...l, removed: true } : l)), dismissMissing: s.type === 'missing' ? true : d.dismissMissing }));
  const setWord = (key: string, patch: Partial<WordItem>, undoable = true) => (undoable ? change : (f: (d: Draft) => Draft) => setDraft(f))(d => ({ ...d, words: d.words.map(w => (w.key === key ? { ...w, ...patch } : w)) }));
  const replaceLogo = async (key: string, file?: File) => {
    if (!file) return;
    setUploading(true); onError('');
    try { const r = await productApi.reviewAsset(id, file); change(d => ({ ...d, logos: d.logos.map(l => (l.key === key ? { ...l, replacement: r.file, accepted: true } : l)) })); }
    catch (e) { onError(e instanceof Error ? e.message : 'The picture could not be used.'); }
    finally { setUploading(false); }
  };
  const accept = (s: NonNullable<Sel>) => change(d => ({ ...d, objects: d.objects.map(o => (s.type === 'object' && o.key === s.key ? { ...o, accepted: true } : o)), texts: d.texts.map(t => (s.type === 'text' && t.key === s.key ? { ...t, accepted: true } : t)), logos: d.logos.map(l => (s.type === 'logo' && l.key === s.key ? { ...l, accepted: true } : l)), dismissMissing: s.type === 'missing' ? true : d.dismissMissing }));
  /** What an element is: an object's kind, or across to a bank logo (an overlay) and back. */
  const retype = (s: NonNullable<Sel>, kind: Kind) => change(d => {
    if (kind === 'text') return d;
    if (s.type === 'object') {
      const o = d.objects.find(x => x.key === s.key)!;
      if (kind !== 'bank-logo') return { ...d, objects: d.objects.map(x => (x.key === s.key ? { ...x, kind, accepted: true } : x)) };
      const key = newKey('logo'); setSel({ type: 'logo', key });
      return { ...d, objects: d.objects.map(x => (x.key === s.key ? { ...x, removed: true } : x)), logos: [...d.logos, { key, category: 'partner-logo', label: o.label, box: o.box, removed: false, accepted: true, attention: false }] };
    }
    if (s.type === 'logo' && kind !== 'bank-logo') {
      const l = d.logos.find(x => x.key === s.key)!, key = newKey('object'); setSel({ type: 'object', key });
      return { ...d, logos: d.logos.map(x => (x.key === s.key ? { ...x, removed: true } : x)), objects: [...d.objects, { key, kind, label: l.label, box: l.box, accepted: true, removed: false }] };
    }
    return d;
  });

  // --- Keyboard ------------------------------------------------------------------------------------------------------
  const doUndo = useCallback(() => setUndo(u => { if (!u.length) return u; setDraft(d => { setRedo(r => [...r, d]); return u[u.length - 1]; }); return u.slice(0, -1); }), []);
  const doRedo = useCallback(() => setRedo(r => { if (!r.length) return r; setDraft(d => { setUndo(u => [...u, d]); return r[r.length - 1]; }); return r.slice(0, -1); }), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.closest('input, textarea, select') || e.target.isContentEditable);
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') { if (typing) return; e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); return; }
      if (mod && e.key.toLowerCase() === 'y') { if (typing) return; e.preventDefault(); doRedo(); return; }
      if (typing) return;
      if (e.key === 'Escape') { setSel(null); setAdding(null); return; }
      if (e.key === '+' || e.key === '=') { setZoom(z => Math.min(4, z * 1.25)); return; }
      if (e.key === '-') { setZoom(z => Math.max(0.5, z / 1.25)); return; }
      if (!sel) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(sel); setSel(null); return; }
      if (e.key === 'Enter') { e.preventDefault(); accept(sel); return; }
      const step = e.shiftKey ? 10 : 1, move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      const b = boxOf(sel);
      if (move && b && (sel.type === 'object' || sel.type === 'logo' || sel.type === 'text' || sel.type === 'word')) { e.preventDefault(); change(d => d); setBox(sel, clamp({ ...b, x: b.x + move[0], y: b.y + move[1] }, W, H)); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // --- Canvas pointer ----------------------------------------------------------------------------------------------
  const point = (e: { clientX: number; clientY: number }) => { const m = svg.current!.getScreenCTM()!.inverse(), p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m); return { x: Math.round(p.x), y: Math.round(p.y) }; };
  const down = (e: ReactPointerEvent, s: NonNullable<Sel>, mode: 'move' | 'resize', corner?: string) => {
    e.stopPropagation(); setSel(s);
    const b = boxOf(s);
    if (!b || (s.type !== 'object' && s.type !== 'logo' && s.type !== 'text' && s.type !== 'word')) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { mode, corner, start: point(e), before: draft, box: { ...b }, sel: s };
  };
  const startDraw = (e: ReactPointerEvent) => {
    if (!adding) { setSel(null); return; }
    const type = adding === 'bank-logo' ? 'logo' : adding === 'text' ? 'text' : 'object', p = point(e), key = newKey(type), s: NonNullable<Sel> = { type, key }, box = { x: p.x, y: p.y, width: 1, height: 1 };
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const before = draft;
    setDraft(d => adding === 'bank-logo' ? { ...d, logos: [...d.logos, { key, category: 'partner-logo', label: 'Logo', box, removed: false, accepted: true, attention: false }] }
      : adding === 'text' ? { ...d, texts: [...d.texts, { key, category: 'supporting', text: '', original: '', removed: false, accepted: true, attention: false, box, confidence: 1, isNew: true }] }
      : { ...d, objects: [...d.objects, { key, kind: adding, label: KIND_OPTIONS.find(k => k.value === adding)!.label.split(' (')[0], box, accepted: true, removed: false, ...(adding === 'podium' ? { layer: 'own' as const } : {}) }] });
    setSel(s); drag.current = { mode: 'draw', start: p, before, box, sel: s };
  };
  const moveDrag = (e: ReactPointerEvent) => {
    const g = drag.current; if (!g) return;
    const p = point(e), dx = p.x - g.start.x, dy = p.y - g.start.y, b = g.box;
    let next: PixelRect;
    if (g.mode === 'move') next = { ...b, x: b.x + dx, y: b.y + dy };
    else if (g.mode === 'draw') next = { x: Math.min(g.start.x, p.x), y: Math.min(g.start.y, p.y), width: Math.abs(dx), height: Math.abs(dy) };
    else {
      const c = g.corner!, x0 = c.includes('w') ? b.x + dx : b.x, x1 = c.includes('e') ? b.x + b.width + dx : b.x + b.width, y0 = c.includes('n') ? b.y + dy : b.y, y1 = c.includes('s') ? b.y + b.height + dy : b.y + b.height;
      next = { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
    }
    setBox(g.sel, clamp({ ...next, width: Math.max(4, next.width), height: Math.max(4, next.height) }, W, H));
  };
  const upDrag = () => {
    const g = drag.current; drag.current = null;
    if (!g) return;
    if (g.mode === 'draw') {
      setAdding(null);
      const b = boxOf(g.sel);
      if (!b || b.width < 8 || b.height < 8) { setDraft(g.before); setSel(null); return; }
    }
    setUndo(u => [...u.slice(-80), g.before]); setRedo([]);
  };

  // --- Save ----------------------------------------------------------------------------------------------------------
  const save = async (prepare: boolean) => {
    setBusy(true); onError('');
    try {
      const v = await productApi.review(id, {
        expectedRevision: view.template.revision,
        objects: draft.objects.filter(o => !o.removed).map(o => ({ ...(o.id ? { id: o.id } : {}), kind: o.kind, label: o.label, box: o.box, accepted: prepare || o.accepted, ...(o.hidden ? { hidden: true } : {}), ...(o.kind === 'podium' ? { layer: o.layer ?? null } : {}) })),
        // A block changed word by word keeps its words' boxes (its own box and wording are not sent again).
        texts: draft.texts.filter(t => !t.isNew).map(t => (blockHasWordEdits(t.key) ? { groupId: t.key, removed: t.removed, category: t.category, accepted: prepare || t.accepted }
          : { groupId: t.key, box: t.box, removed: t.removed, category: t.category, ...(t.text !== t.original ? { text: t.text } : {}), accepted: prepare || t.accepted })),
        words: draft.words.filter(wordEdited).map(w => ({ wordId: w.key, ...(w.text !== w.original ? { text: w.text } : {}), ...(!sameBox(w.box, w.originalBox) ? { box: w.box } : {}), ...(w.removed !== w.originallyRemoved ? { removed: w.removed } : {}), ...(w.moveTo ? { groupId: w.moveTo } : {}) })),
        newTexts: draft.texts.filter(t => t.isNew && !t.removed && t.text.trim()).map(t => ({ text: t.text.trim(), box: t.box, category: t.category })),
        logos: draft.logos.filter(l => l.slotId || !l.removed).map(l => ({ ...(l.slotId ? { slotId: l.slotId } : {}), removed: l.removed, category: l.category, label: l.label, box: l.box, accepted: prepare || l.accepted, ...(l.replacement !== undefined ? { replacement: l.replacement } : {}) })),
        dismissMissingText: prepare || draft.dismissMissing,
      });
      await onSaved(v, prepare);
    } catch (e) { onError(e instanceof Error ? e.message : 'The review could not be saved.'); }
    finally { setBusy(false); }
  };

  // --- Render --------------------------------------------------------------------------------------------------------
  const items = (group: string) => [
    ...draft.objects.filter(o => !o.removed && GROUP_OF(o.kind) === group).map(o => ({ sel: { type: 'object' as const, key: o.key }, label: o.label, flag: !o.accepted && !!o.attention, sub: KIND_OPTIONS.find(k => k.value === o.kind)?.label.split(' (')[0] ?? o.kind })),
    ...(group === 'text' ? draft.texts.filter(t => !t.removed).map(t => ({ sel: { type: 'text' as const, key: t.key }, label: t.text.split('\n')[0].slice(0, 40) || '(empty)', flag: !t.accepted && t.attention, sub: MASTER_CATEGORY_LABELS[t.category] })) : []),
    ...(group === 'logos' ? draft.logos.filter(l => !l.removed).map(l => ({ sel: { type: 'logo' as const, key: l.key }, label: l.label, flag: !l.accepted && l.attention, sub: l.category === 'qr' ? 'QR code' : l.category === 'badge' ? 'Badge' : 'Bank or payment logo' })) : []),
  ];
  const removed = [...draft.objects.filter(o => o.removed && o.id).map(o => ({ type: 'object' as const, key: o.key, label: o.label })), ...draft.texts.filter(t => t.removed).map(t => ({ type: 'text' as const, key: t.key, label: t.original.split('\n')[0].slice(0, 40) })), ...draft.logos.filter(l => l.removed && l.slotId).map(l => ({ type: 'logo' as const, key: l.key, label: l.label }))];
  const putBack = (r: { type: 'object' | 'text' | 'logo'; key: string }) => change(d => ({ ...d, objects: d.objects.map(o => (r.type === 'object' && o.key === r.key ? { ...o, removed: false } : o)), texts: d.texts.map(t => (r.type === 'text' && t.key === r.key ? { ...t, removed: false } : t)), logos: d.logos.map(l => (r.type === 'logo' && l.key === r.key ? { ...l, removed: false } : l)) }));
  const isSel = (s: NonNullable<Sel>) => sel?.type === s.type && sel.key === s.key;
  const boxes = [
    ...draft.objects.filter(o => !o.removed).map(o => ({ s: { type: 'object' as const, key: o.key }, box: o.box, group: GROUP_OF(o.kind), flag: !o.accepted && !!o.attention, label: o.label, editable: true })),
    ...draft.texts.filter(t => !t.removed).map(t => ({ s: { type: 'text' as const, key: t.key }, box: t.box, group: 'text', flag: !t.accepted && t.attention, label: t.text.split('\n')[0], editable: true })),
    ...draft.logos.filter(l => !l.removed).map(l => ({ s: { type: 'logo' as const, key: l.key }, box: l.box, group: 'logos', flag: !l.accepted && l.attention, label: l.label, editable: true })),
    ...missing.map((m, i) => ({ s: { type: 'missing' as const, key: `missing-${i}` }, box: m.box, group: 'missing', flag: true, label: m.text, editable: false })),
    // The words of opened blocks (and of the selected word's block), each its own box.
    ...draft.words.filter(w => !w.removed && (expanded.has(w.group) || selWord?.group === w.group)).map(w => ({ s: { type: 'word' as const, key: w.key }, box: w.box, group: 'word', flag: w.attention, label: w.text, editable: true })),
  ].sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height);
  const handle = 10 / zoom * Math.max(W, H) / 900;
  const focusedBox = sel ? boxes.find(b => isSel(b.s)) : undefined;
  const resizeDown = (event: ReactPointerEvent) => {
    if (focusedBox) down(event, focusedBox.s, 'resize', event.currentTarget.getAttribute('data-corner') ?? undefined);
  };

  const detectionReady = view.product.detection?.ai?.status === 'done';
  return <div className="prt-review">
    <aside className="prt-pane prt-list" aria-label="Elements found">
      {attention.length > 0 && <section className="prt-attention" aria-label="Needs a look">
        <h3><AlertTriangle size={15} aria-hidden="true" />Needs a look <span className="ot-chip is-warn">{attention.length}</span></h3>
        <ul className="ot-list">{attention.map(a => <li key={`${a.sel.type}-${a.sel.key}`}><button type="button" className="ot-item" aria-pressed={isSel(a.sel)} onClick={() => setSel(a.sel)}>
          <span className="ot-dot is-uncertain" aria-hidden="true" /><span><strong>{a.label}</strong><span className="prt-reason">{a.reason}</span></span><span /></button></li>)}</ul>
        <button type="button" className="ws-btn" onClick={approveAll}><Check size={14} aria-hidden="true" />They all look right</button>
      </section>}
      {GROUPS.map(g => { const list = items(g.id); return <section key={g.id} aria-label={g.label}>
        <h3><span className={`prt-swatch is-${g.id}`} aria-hidden="true" />{g.label}<span className="ot-chip">{list.length}</span></h3>
        {list.length ? <ul className="ot-list">{list.map(i => { const words = i.sel.type === 'text' ? draft.words.filter(w => w.group === i.sel.key) : [], open = expanded.has(i.sel.key);
          return <li key={`${i.sel.type}-${i.sel.key}`}><button type="button" className="ot-item" aria-pressed={isSel(i.sel)} onClick={() => setSel(i.sel)}>
          <span className={`ot-dot ${i.flag ? 'is-uncertain' : 'is-approved'}`} aria-hidden="true" /><span>{i.label}<span className="prt-reason">{i.sub}</span></span>{i.flag ? <span className="ot-chip is-warn">Check</span> : <span />}</button>
          {words.length > 0 && <button type="button" className="ws-btn ws-btn-quiet prt-words-toggle" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} the words of ${i.label}`} onClick={() => toggleBlock(i.sel.key)}>{open ? '▾' : '▸'} {words.length} word{words.length === 1 ? '' : 's'}{blockHasWordEdits(i.sel.key) ? ' · edited' : ''}</button>}
          {open && <ul className="prt-words" aria-label={`Words of ${i.label}`}>{words.map(w => <li key={w.key}><button type="button" className={`prt-word${w.removed ? ' is-removed' : ''}${wordEdited(w) ? ' is-edited' : ''}${w.attention ? ' is-flag' : ''}`} aria-pressed={isSel({ type: 'word', key: w.key })} aria-label={`Select word ${w.text}`} onClick={() => setSel({ type: 'word', key: w.key })}>{w.text}</button></li>)}</ul>}
          </li>; })}</ul>
          : <p className="ot-muted">{g.id === 'products' || g.id === 'characters' ? 'None found. Use “Add” above the picture to mark one.' : 'None.'}</p>}
      </section>; })}
      {removed.length > 0 && <details className="ot-more prt-removed"><summary>Removed ({removed.length})</summary><ul className="ot-list">{removed.map(r => <li key={`${r.type}-${r.key}`} className="prt-removed-item"><span>{r.label}</span><button type="button" className="ws-btn ws-btn-quiet" onClick={() => putBack(r)}><RotateCcw size={13} aria-hidden="true" />Put back</button></li>)}</ul></details>}
    </aside>

    <section className="prt-pane prt-stage" aria-label="Creative">
      <div className="ot-stage-toolbar prt-toolbar">
        <label className="prt-add"><SquareDashedMousePointer size={15} aria-hidden="true" /><span className="prt-sr">Add an element</span>
          <select aria-label="Add an element" value={adding ?? ''} onChange={e => { setAdding((e.target.value || null) as Kind | null); setSel(null); }}>
            <option value="">Add…</option>{ADD_OPTIONS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}</select></label>
        <button type="button" className="ws-btn ws-btn-quiet" aria-pressed={preview} onClick={() => setPreview(v => !v)}>{preview ? 'Hide corrections' : 'Preview corrections'}</button>
        <span className="prt-tool-gap" />
        <button type="button" className="ws-icon-button" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!undo.length} onClick={doUndo}><Undo2 size={16} /></button>
        <button type="button" className="ws-icon-button" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!redo.length} onClick={doRedo}><Redo2 size={16} /></button>
        <button type="button" className="ws-icon-button" aria-label="Zoom out" onClick={() => setZoom(z => Math.max(0.5, z / 1.25))}><Minus size={16} /></button>
        <button type="button" className="ws-btn ws-btn-quiet prt-zoom" aria-label="Fit to view" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
        <button type="button" className="ws-icon-button" aria-label="Zoom in" onClick={() => setZoom(z => Math.min(4, z * 1.25))}><Plus size={16} /></button>
        <button type="button" className="ws-icon-button" aria-label="Keyboard shortcuts" aria-expanded={showKeys} onClick={() => setShowKeys(s => !s)}><Keyboard size={16} /></button>
      </div>
      {showKeys && <p className="prt-keys">Delete removes · Enter approves · arrows move (Shift: 10 px) · Ctrl+Z undo · Ctrl+Shift+Z redo · + / − zoom · Esc deselects</p>}
      {adding && <p className="prt-hint" role="status">Drag on the picture to draw the {ADD_OPTIONS.find(k => k.value === adding)?.label.split(' (')[0].toLowerCase()}. Esc cancels.</p>}
      {preview && <p className="prt-hint" role="status">Preview: corrected and added text and replaced logos are drawn where they will be; removed words are greyed out. Nothing is saved until you save or prepare.</p>}
      <div className="prt-scroll" ref={scroller}>
        <svg ref={svg} viewBox={`0 0 ${W} ${H}`} style={{ width: Math.round(W * fit * zoom), height: Math.round(H * fit * zoom) }} className={`prt-canvas${adding ? ' is-adding' : ''}`} role="img" aria-label={`${view.template.name} with a box per element`}
          onPointerDown={startDraw} onPointerMove={moveDrag} onPointerUp={upDrag} onPointerCancel={upDrag}>
          <image href={productFileUrl(id, view.template.source.inputFile)} width={W} height={H} />
          {boxes.map(b => <rect key={`${b.s.type}-${b.s.key}`} x={b.box.x} y={b.box.y} width={b.box.width} height={b.box.height} className={`prt-box is-${b.group}${b.flag ? ' is-flag' : ''}${isSel(b.s) ? ' is-selected' : ''}`}
            onPointerDown={e => down(e, b.s, 'move')}><title>{b.label}</title></rect>)}
          {preview && <g className="prt-preview" aria-hidden="true">
            {draft.logos.filter(l => !l.removed && l.replacement).map(l => <g key={l.key}><rect x={l.box.x} y={l.box.y} width={l.box.width} height={l.box.height} fill="#fff" /><image href={productFileUrl(id, l.replacement!)} x={l.box.x} y={l.box.y} width={l.box.width} height={l.box.height} preserveAspectRatio="xMidYMid meet" /></g>)}
            {draft.words.filter(w => w.removed && !w.originallyRemoved).map(w => <rect key={w.key} x={w.box.x} y={w.box.y} width={w.box.width} height={w.box.height} fill="#9ca3af" opacity={0.75} />)}
            {draft.words.filter(w => !w.removed && (w.text !== w.original || !sameBox(w.box, w.originalBox))).map(w => <g key={w.key}><rect x={w.box.x} y={w.box.y} width={w.box.width} height={w.box.height} fill="#fff" opacity={0.9} />
              <text x={w.box.x} y={w.box.y + w.box.height * 0.82} fontSize={w.box.height * 0.9} textLength={w.box.width} lengthAdjust="spacingAndGlyphs" fill="#111827">{w.text}</text></g>)}
            {draft.texts.filter(t => t.isNew && !t.removed && t.text.trim()).map(t => <g key={t.key}><rect x={t.box.x} y={t.box.y} width={t.box.width} height={t.box.height} fill="#fff" opacity={0.9} />
              <text x={t.box.x} y={t.box.y + t.box.height * 0.82} fontSize={t.box.height * 0.9} textLength={t.box.width} lengthAdjust="spacingAndGlyphs" fill="#111827">{t.text.trim()}</text></g>)}
          </g>}
          {focusedBox?.editable && ['nw', 'ne', 'sw', 'se'].map(c => <rect key={c} className="ot-handle" x={(c.includes('w') ? focusedBox.box.x : focusedBox.box.x + focusedBox.box.width) - handle / 2} y={(c.includes('n') ? focusedBox.box.y : focusedBox.box.y + focusedBox.box.height) - handle / 2}
            width={handle} height={handle} style={{ cursor: c === 'nw' || c === 'se' ? 'nwse-resize' : 'nesw-resize' }} data-corner={c} onPointerDown={resizeDown} />)}
        </svg>
      </div>
      <p className="ot-muted prt-legend"><span className="prt-swatch is-characters" />Characters <span className="prt-swatch is-products" />Products <span className="prt-swatch is-text" />Text <span className="prt-swatch is-logos" />Logos <span className="prt-swatch is-background" />Background · orange outline: needs a look</p>
    </section>

    <aside className="prt-pane prt-inspector" aria-label="Selected element">
      {!sel ? <section><h3>Select an element</h3><p className="ot-muted">Click a box on the picture or a name in the list. You can move a box, drag its corners, or draw a new one with “Add”.</p>
        <ul className="prt-facts"><li><strong>Text and logos</strong> stay editable and are excluded from image decomposition.</li><li><strong>Products and characters</strong> become their own layers, so you can swap them later.</li></ul></section>
        : sel.type === 'missing' ? <section><h3>Text that was not read</h3><p>“{missing[Number(sel.key.slice(8))]?.text}”</p><p className="ot-muted">It stays part of the background picture. If it should be editable, recreate it in the editor after saving.</p>
          <button type="button" className="ws-btn" onClick={() => accept(sel)}><Check size={14} aria-hidden="true" />OK</button></section>
        : selected ? <section>
          <h3>{selected.label}</h3>
          {selected.attention && !selected.accepted && <p className="prt-flag"><AlertTriangle size={14} aria-hidden="true" />{selected.attention}</p>}
          <label className="ot-field"><span>Name</span><input value={selected.label} maxLength={80} onChange={e => { const label = e.target.value; setDraft(d => ({ ...d, objects: d.objects.map(o => (o.key === selected.key ? { ...o, label } : o)) })); }} /></label>
          <label className="ot-field"><span>What is it?</span><select value={selected.kind} onChange={e => retype(sel, e.target.value as Kind)}>{KIND_OPTIONS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}</select></label>
          {/* (A small element — a soundbar a few pixels tall — is easier to place exactly by numbers than by dragging.) */}
          <div className="prt-box-fields">{(['x', 'y', 'width', 'height'] as const).map(k => <label key={k} className="ot-field"><span>{k === 'x' ? 'X' : k === 'y' ? 'Y' : k === 'width' ? 'Width' : 'Height'}</span>
            <input type="number" value={selected.box[k]} aria-label={`Box ${k}`} onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) { change(d => d); setBox(sel, clamp({ ...selected.box, [k]: v }, W, H)); } }} /></label>)}</div>
          {selected.kind === 'podium' ? <fieldset className="prt-stand-choice">
            <legend>How should it be kept?</legend>
            <label className="ot-check"><input type="radio" name={`layer-${selected.key}`} checked={selected.layer === 'own'} onChange={() => change(d => ({ ...d, objects: d.objects.map(o => (o.key === selected.key ? { ...o, layer: 'own' as const } : o)) }))} />
              <span><strong>Its own layer</strong> — a stand or riser products stand on. It can be moved or hidden on its own, and where products hide it, it is continued.</span></label>
            <label className="ot-check"><input type="radio" name={`layer-${selected.key}`} checked={selected.layer !== 'own'} onChange={() => change(d => ({ ...d, objects: d.objects.map(o => (o.key === selected.key ? { ...o, layer: 'background' as const } : o)) }))} />
              <span><strong>Part of the background</strong> — like the big shared podium. A stand found automatically inside this box stays in the background too.</span></label>
          </fieldset>
            : <p className="ot-muted">{selected.kind === 'product' || selected.kind === 'character' ? 'It gets its own layer and a slot, so you can put another picture in its place later.' : selected.kind === 'brand-logo' ? 'Part of the design: its own layer, replaceable in the editor.' : 'Part of the background: it stays where it is. Drawn over a product (a wall behind a TV, a panel it hangs on), it is taken out of that product, and what stands in front of it stays with the product.'}</p>}
          <Actions accepted={selected.accepted} onAccept={() => accept(sel)} onRemove={() => { remove(sel); setSel(null); }} removeLabel="Remove this box" />
        </section>
        : selWord ? <section>
          <h3>Word</h3>
          {selWord.attention && <p className="prt-flag"><AlertTriangle size={14} aria-hidden="true" />Read with low certainty: check the spelling.</p>}
          <label className="ot-field"><span>Word</span><input value={selWord.text} maxLength={80} aria-label="Word" onChange={e => setWord(selWord.key, { text: e.target.value.replace(/\s+/g, '') }, false)} /></label>
          <div className="prt-box-fields">{(['x', 'y', 'width', 'height'] as const).map(k => <label key={k} className="ot-field"><span>{k === 'x' ? 'X' : k === 'y' ? 'Y' : k === 'width' ? 'Width' : 'Height'}</span>
            <input type="number" value={selWord.box[k]} aria-label={`Word ${k}`} onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) setWord(selWord.key, { box: clamp({ ...selWord.box, [k]: v }, W, H) }); }} /></label>)}</div>
          <label className="ot-field"><span>Text block</span><select aria-label="Text block of the word" value={selWord.moveTo ?? selWord.group} onChange={e => setWord(selWord.key, { moveTo: e.target.value === selWord.group ? undefined : e.target.value })}>
            {draft.texts.filter(t => !t.isNew && !t.removed).map(t => <option key={t.key} value={t.key}>{t.text.split('\n')[0].slice(0, 40) || '(empty)'}</option>)}<option value="new">A block of its own</option></select></label>
          <p className="ot-muted">Stays an editable word. Its box says where its pixels are taken out of the picture; its neighbours do not move.</p>
          <div className="ot-row">
            {selWord.removed ? <button type="button" className="ws-btn" onClick={() => setWord(selWord.key, { removed: false })}><RotateCcw size={14} aria-hidden="true" />Put the word back</button>
              : <button type="button" className="ws-btn ws-btn-quiet" onClick={() => setWord(selWord.key, { removed: true })}><Trash2 size={14} aria-hidden="true" />Not a word: remove it</button>}
            {wordEdited(selWord) && <button type="button" className="ws-btn ws-btn-quiet" onClick={() => setWord(selWord.key, { text: selWord.original, box: { ...selWord.originalBox }, removed: selWord.originallyRemoved, moveTo: undefined })}>Undo changes to this word</button>}
          </div>
        </section>
        : selText?.isNew ? <section>
          <h3>Added text</h3>
          <label className="ot-field"><span>Text in the box</span><textarea rows={2} value={selText.text} maxLength={400} aria-label="Added text" onChange={e => { const text = e.target.value; setDraft(d => ({ ...d, texts: d.texts.map(t => (t.key === selText.key ? { ...t, text } : t)) })); }} /></label>
          <label className="ot-field"><span>Role</span><select value={selText.category} onChange={e => { const category = e.target.value as MasterCategory; change(d => ({ ...d, texts: d.texts.map(t => (t.key === selText.key ? { ...t, category } : t)) })); }}>
            {TEXT_CATEGORIES.map(c => <option key={c} value={c}>{MASTER_CATEGORY_LABELS[c]}</option>)}</select></label>
          <p className="ot-muted">Text the detection missed: type it as it appears. It becomes editable words, and its pixels in the box are taken out of the picture.</p>
          <Actions accepted onAccept={() => undefined} onRemove={() => { remove(sel); setSel(null); }} removeLabel="Remove the added text" />
        </section>
        : selText ? <section>
          <h3>Text</h3>
          {selText.attention && !selText.accepted && <p className="prt-flag"><AlertTriangle size={14} aria-hidden="true" />Read with {Math.round(selText.confidence * 100)}% certainty: check the wording.</p>}
          <label className="ot-field"><span>Wording</span><textarea rows={3} value={selText.text} maxLength={2000} disabled={blockHasWordEdits(selText.key)} onChange={e => { const text = e.target.value; setDraft(d => ({ ...d, texts: d.texts.map(t => (t.key === selText.key ? { ...t, text, accepted: true } : t)) })); }} /></label>
          {blockHasWordEdits(selText.key) && <p className="ot-muted">Its words were changed one by one: keep editing them in its word list.</p>}
          <button type="button" className="ws-btn ws-btn-quiet" aria-expanded={expanded.has(selText.key)} onClick={() => toggleBlock(selText.key)}>{expanded.has(selText.key) ? 'Hide its words' : 'Edit word by word'}</button>
          <label className="ot-field"><span>Role</span><select value={selText.category} onChange={e => { const category = e.target.value as MasterCategory; change(d => ({ ...d, texts: d.texts.map(t => (t.key === selText.key ? { ...t, category } : t)) })); }}>
            {TEXT_CATEGORIES.map(c => <option key={c} value={c}>{MASTER_CATEGORY_LABELS[c]}</option>)}</select></label>
          <p className="ot-muted">Stays editable text. Fix the wording here if it was read wrong; the font and colour are measured from the creative.</p>
          <Actions accepted={selText.accepted} onAccept={() => accept(sel)} onRemove={() => { remove(sel); setSel(null); }} removeLabel="Not text: part of the picture" />
        </section>
        : selLogo ? <section>
          <h3>{selLogo.label}</h3>
          <label className="ot-field"><span>Name</span><input value={selLogo.label} maxLength={80} onChange={e => { const label = e.target.value; setDraft(d => ({ ...d, logos: d.logos.map(l => (l.key === selLogo.key ? { ...l, label } : l)) })); }} /></label>
          <label className="ot-field"><span>What is it?</span><select value={selLogo.category === 'partner-logo' ? 'bank-logo' : selLogo.category} onChange={e => {
            const v = e.target.value; if (v === 'qr' || v === 'badge') change(d => ({ ...d, logos: d.logos.map(l => (l.key === selLogo.key ? { ...l, category: v } : l)) })); else retype(sel, v as Kind);
          }}><option value="bank-logo">Bank or payment logo (editable)</option><option value="qr">QR code (editable)</option><option value="badge">Offer badge (editable)</option>
            {KIND_OPTIONS.filter(k => k.value !== 'bank-logo').map(k => <option key={k.value} value={k.value}>{k.label}</option>)}</select></label>
          <div className="prt-logo-replace">
            <img src={productFileUrl(id, selLogo.replacement ?? selLogo.file ?? '')} alt="" />
            <span className="ot-row"><label className="ws-btn ws-btn-quiet prt-file">{uploading ? 'Uploading…' : selLogo.replacement ? 'Replace again' : 'Replace the picture'}<input type="file" accept="image/png,image/jpeg,image/webp" aria-label={`Replace the picture of ${selLogo.label}`} disabled={uploading} onChange={e => void replaceLogo(selLogo.key, e.target.files?.[0])} /></label>
              {selLogo.replacement && <button type="button" className="ws-btn ws-btn-quiet" onClick={() => change(d => ({ ...d, logos: d.logos.map(l => (l.key === selLogo.key ? { ...l, replacement: null } : l)) }))}>Use the original</button>}</span>
          </div>
          <p className="ot-muted">{selLogo.replacement ? 'Your picture is shown at this place; the original’s pixels are still taken out of the picture.' : 'Kept exactly as it is and replaceable later.'} Excluded from image decomposition.</p>
          <Actions accepted={selLogo.accepted} onAccept={() => accept(sel)} onRemove={() => { remove(sel); setSel(null); }} removeLabel="Not a logo" />
        </section> : null}
      <section className="prt-cta">
        <p>Your text and logos will be saved separately so you can edit them later. Next, you choose which characters, products, stands and graphics become image layers of their own.</p>
        {attention.length > 0 && <p className="ot-muted">{attention.length} item{attention.length === 1 ? '' : 's'} still need{attention.length === 1 ? 's' : ''} a look. Preparing uses them as they are.</p>}
        {!detectionReady && <p className="prt-flag" data-testid="prepare-needs-ai"><AlertTriangle size={14} aria-hidden="true" />Preparing needs a completed AI detection: the text was read on this computer only, and characters and products were not detected. Retry the AI analysis above.</p>}
        <button type="button" className="ws-btn ws-btn-primary ws-btn-large" disabled={busy || !detectionReady || !draft.objects.some(o => !o.removed && (o.kind === 'character' || o.kind === 'product'))} onClick={() => void save(true)}><Wand2 size={15} aria-hidden="true" />{busy ? 'Saving…' : 'Save and choose what to decompose'}</button>
        <button type="button" className="ws-btn ws-btn-quiet" disabled={busy} onClick={() => void save(false)}>Save and continue later</button>
        <p className="ot-muted">Nothing is decomposed yet: that starts after you choose.</p>
      </section>
    </aside>
  </div>;
}

function Actions({ accepted, onAccept, onRemove, removeLabel }: { accepted: boolean; onAccept: () => void; onRemove: () => void; removeLabel: string }) {
  return <div className="ot-row">
    {accepted ? <span className="ot-chip is-ok"><Check size={12} aria-hidden="true" /> Looks right</span> : <button type="button" className="ws-btn ws-btn-primary" onClick={onAccept}><Check size={14} aria-hidden="true" />Looks right</button>}
    <button type="button" className="ws-btn ws-btn-quiet" onClick={onRemove}><Trash2 size={14} aria-hidden="true" />{removeLabel}</button>
  </div>;
}
const clamp = (b: PixelRect, W: number, H: number): PixelRect => {
  const width = Math.min(W, Math.max(1, Math.round(b.width))), height = Math.min(H, Math.max(1, Math.round(b.height)));
  return { x: Math.min(W - width, Math.max(0, Math.round(b.x))), y: Math.min(H - height, Math.max(0, Math.round(b.y))), width, height };
};
