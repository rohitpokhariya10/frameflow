/**
 * One protected element's details: what it is, where it is (exact source pixels), how the editor shows it (its original
 * pixels, its original file, or editable text the administrator types), and the administrator's review. Text is never
 * guessed from the image: it is typed here, or the element stays a visual copy.
 */
import { useId, useState } from 'react';
import { Trash2, Upload } from 'lucide-react';
import { editorFontFor, normalizeBox, PROTECTED_KIND_LABELS, TEXT_FONTS, type ProtectedKind, type ProtectedRepresentation, type ProtectedText, type SourceSize } from '@frameflow/shared';
import { protectedFileUrl, type ElementDraft } from './api';

const REPRESENTATIONS: { id: ProtectedRepresentation; label: string; hint: string }[] = [
  { id: 'raster', label: 'Original pixels', hint: 'A visual copy of this region of the creative. Exact where fully protected; not editable as text.' },
  { id: 'source-asset', label: 'Original file', hint: 'The uploaded file (for example the bank\'s logo PNG), byte for byte, fitted in the box.' },
  { id: 'native-text', label: 'Editable text', hint: 'Text you type below, typeset by the editor. Matches the original only as far as the font does.' },
];
export const defaultText = (box: { height: number }): ProtectedText => ({ value: '', fontFamily: 'Inter', fallbackFamily: 'Inter', fontSize: Math.max(8, Math.round(box.height * 0.7)), fontWeight: 600, lineHeight: 1.15,
  letterSpacing: 0, align: 'left', verticalAlign: 'top', color: '#111111' });
const num = (value: string, fallback: number) => { const n = Number(value); return value.trim() !== '' && Number.isFinite(n) ? n : fallback; };

export function ElementPanel({ templateId, element, size, onChange, onDelete, onUpload, uploading }: {
  templateId: string; element: ElementDraft; size: SourceSize; onChange: (next: ElementDraft) => void; onDelete: () => void; onUpload?: (file: File) => void; uploading?: boolean;
}) {
  const id = useId(), [showText, setShowText] = useState(!!element.text || element.representation === 'native-text');
  const b = element.box, n = normalizeBox(b, size), text = element.text ?? defaultText(b);
  const set = (change: Partial<ElementDraft>) => onChange({ ...element, ...change, review: change.review ?? (change.box || change.representation || change.mask || change.text ? { status: 'needs-review' } : element.review) });
  const setBox = (key: keyof ElementDraft['box'], value: string) => set({ box: { ...b, [key]: num(value, b[key]) } });
  const setText = (change: Partial<ProtectedText>) => set({ text: { ...text, ...change } });
  const field = (label: string, key: keyof ElementDraft['box'], step = 1) => <label className="pt-num">{label}<input type="number" step={step} aria-label={`${label} (source pixels)`} value={Math.round(b[key] * 100) / 100} onChange={e => setBox(key, e.target.value)} /></label>;
  return <div className="pt-element" aria-label={`Protected element ${element.label}`}>
    <div className="ts-form-grid">
      <div className="ts-field"><label htmlFor={`${id}-label`}>Name</label><input id={`${id}-label`} value={element.label} maxLength={120} onChange={e => set({ label: e.target.value })} /></div>
      <div className="ts-field"><label htmlFor={`${id}-kind`}>Kind</label><select id={`${id}-kind`} value={element.kind} onChange={e => set({ kind: e.target.value as ProtectedKind })}>
        {(Object.keys(PROTECTED_KIND_LABELS) as ProtectedKind[]).map(k => <option key={k} value={k}>{PROTECTED_KIND_LABELS[k]}</option>)}</select></div>
    </div>
    <fieldset className="ts-fieldset"><legend>Position in source pixels</legend>
      <div className="pt-geometry">{field('X', 'x')}{field('Y', 'y')}{field('Width', 'width')}{field('Height', 'height')}{field('Rotation °', 'rotation', 0.5)}</div>
      <small className="ts-hint" data-testid="normalized">Normalized: x {n.x.toFixed(4)} · y {n.y.toFixed(4)} · w {n.width.toFixed(4)} · h {n.height.toFixed(4)} (fractions of {size.width}×{size.height})</small>
    </fieldset>
    <fieldset className="ts-fieldset"><legend>Shown in the editor as</legend>
      {REPRESENTATIONS.map(r => <label key={r.id} className="ts-check"><input type="radio" name={`${id}-rep`} checked={element.representation === r.id} disabled={r.id === 'source-asset' && !element.sourceAsset}
        onChange={() => { set({ representation: r.id }); if (r.id === 'native-text') setShowText(true); }} /><span>{r.label}{r.id === 'source-asset' && !element.sourceAsset ? ' (upload the file first)' : ''}<small>{r.hint}</small></span></label>)}
    </fieldset>
    {element.representation !== 'source-asset' && <div className="ts-form-grid">
      <div className="ts-field"><label htmlFor={`${id}-mask`}>Mask</label><select id={`${id}-mask`} value={element.mask.mode} onChange={e => set({ mask: { ...element.mask, mode: e.target.value as 'difference' | 'opaque' } })}>
        <option value="difference">Only what differs from the base (text and logo shapes)</option><option value="opaque">The whole region (keeps its background patch)</option></select></div>
      {element.mask.mode === 'difference' && <div className="ts-field"><label htmlFor={`${id}-threshold`}>Sensitivity: {element.mask.threshold}</label>
        <input id={`${id}-threshold`} type="range" min={4} max={120} value={element.mask.threshold} onChange={e => set({ mask: { ...element.mask, threshold: Number(e.target.value) } })} />
        <small>Lower keeps fainter edges and shadows; higher keeps only strong contrast.</small></div>}
    </div>}
    {element.raster && <figure className="pt-preview-chip"><img src={protectedFileUrl(templateId, element.raster.file)} alt={`Preserved pixels of ${element.label}`} />
      <figcaption>Preserved pixels · {element.raster.placement.width}×{element.raster.placement.height} px · {element.raster.opaquePercent}% fully protected{element.raster.protectedPercent > element.raster.opaquePercent ? `, ${Math.round((element.raster.protectedPercent - element.raster.opaquePercent) * 10) / 10}% edge pixels (estimated)` : ''}</figcaption></figure>}
    {onUpload && <div className="pt-upload-row">
      <label className="ws-btn"><Upload size={14} aria-hidden="true" />{element.sourceAsset ? 'Replace original file' : 'Upload original file'}<input type="file" hidden accept="image/png,image/webp,image/jpeg" aria-label={`Original file for ${element.label}`} disabled={uploading} onChange={e => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ''; }} /></label>
      {element.sourceAsset && <span className="ts-hint">{element.sourceAsset.originalName ?? element.sourceAsset.file} · {element.sourceAsset.width}×{element.sourceAsset.height}{element.sourceAsset.hasAlpha ? ' · transparent' : ' · opaque'} · sha256 {element.sourceAsset.sha256.slice(0, 10)}…</span>}
      {element.sourceAsset && Math.abs(element.sourceAsset.width / element.sourceAsset.height - b.width / b.height) > 0.01 && <button type="button" className="ws-btn ws-btn-quiet" onClick={() => {
        const w = b.height * element.sourceAsset!.width / element.sourceAsset!.height; set({ box: { ...b, x: b.x + (b.width - w) / 2, width: w } });
      }}>Match the box to the file's shape</button>}
    </div>}
    <details className="pt-text" open={showText} onToggle={e => setShowText((e.target as HTMLDetailsElement).open)}>
      <summary>Text and style {element.representation === 'native-text' ? '(required for editable text)' : '(optional: lets this slot take new text later)'}</summary>
      <div className="ts-field"><label htmlFor={`${id}-text`}>Text, exactly as it appears</label><textarea id={`${id}-text`} rows={2} maxLength={5000} value={text.value} onChange={e => setText({ value: e.target.value })} /></div>
      <div className="ts-form-grid">
        <div className="ts-field"><label htmlFor={`${id}-font`}>Font family</label><input id={`${id}-font`} list={`${id}-fonts`} value={text.fontFamily} maxLength={120} onChange={e => setText({ fontFamily: e.target.value })} />
          <datalist id={`${id}-fonts`}>{TEXT_FONTS.map(f => <option key={f} value={f} />)}</datalist>
          <small>{text.fontFamily && editorFontFor(text) !== text.fontFamily ? `The editor does not have it: it uses ${editorFontFor(text)}.` : 'Available in the editor.'}</small></div>
        <div className="ts-field"><label htmlFor={`${id}-fallback`}>Fallback font</label><select id={`${id}-fallback`} value={text.fallbackFamily} onChange={e => setText({ fallbackFamily: e.target.value })}>{TEXT_FONTS.map(f => <option key={f}>{f}</option>)}</select></div>
        <label className="pt-num">Size (px)<input type="number" aria-label="Font size (source pixels)" min={1} value={text.fontSize} onChange={e => setText({ fontSize: num(e.target.value, text.fontSize) })} /></label>
        <label className="pt-num">Weight<select aria-label="Font weight" value={text.fontWeight} onChange={e => setText({ fontWeight: Number(e.target.value) as 400 | 600 | 700 })}><option value={400}>Regular</option><option value={600}>Semibold</option><option value={700}>Bold</option></select></label>
        <label className="pt-num">Line height<input type="number" aria-label="Line height" step={0.05} min={0.5} max={4} value={text.lineHeight} onChange={e => setText({ lineHeight: num(e.target.value, text.lineHeight) })} /></label>
        <label className="pt-num">Letter spacing (px)<input type="number" aria-label="Letter spacing (source pixels)" step={0.5} value={text.letterSpacing} onChange={e => setText({ letterSpacing: num(e.target.value, text.letterSpacing) })} /></label>
        <label className="pt-num">Align<select aria-label="Text alignment" value={text.align} onChange={e => setText({ align: e.target.value as ProtectedText['align'] })}><option value="left">Left</option><option value="center">Centre</option><option value="right">Right</option></select></label>
        <label className="pt-num">Vertical<select aria-label="Vertical alignment" value={text.verticalAlign} onChange={e => setText({ verticalAlign: e.target.value as ProtectedText['verticalAlign'] })}><option value="top">Top</option><option value="middle">Middle</option><option value="bottom">Bottom</option></select></label>
        <label className="pt-num">Colour<input type="color" aria-label="Text colour" value={text.color} onChange={e => setText({ color: e.target.value })} /></label>
      </div>
      {element.text && element.representation !== 'native-text' && <button type="button" className="ws-link" onClick={() => { const { text: _t, ...rest } = element; void _t; onChange({ ...rest, review: { status: 'needs-review' } }); }}>Remove the text details</button>}
    </details>
    <div className="pt-row">
      <label className="ts-check"><input type="checkbox" checked={element.locked} onChange={e => set({ locked: e.target.checked })} /><span>Locked in the editor</span></label>
      <label className="ts-check"><input type="checkbox" checked={element.replaceable} onChange={e => set({ replaceable: e.target.checked })} /><span>Replaceable when the template is reused</span></label>
    </div>
    <div className="ts-field"><label htmlFor={`${id}-note`}>Note (optional)</label><input id={`${id}-note`} maxLength={500} value={element.note ?? ''} onChange={e => set({ note: e.target.value || undefined })} /></div>
    <div className="pt-row pt-review">
      <label className="ts-check"><input type="checkbox" checked={element.review.status === 'approved'} onChange={e => onChange({ ...element, review: e.target.checked ? { status: 'approved' } : { status: 'needs-review' } })} />
        <span><strong>Reviewed</strong><small>The box covers exactly this protected content{element.representation === 'native-text' ? ', and the text and style are right' : ''}.</small></span></label>
      <button type="button" className="ws-btn ws-btn-quiet" onClick={onDelete}><Trash2 size={14} aria-hidden="true" />Delete</button>
    </div>
    {element.origin !== 'admin' && <p className="ts-hint">{element.origin === 'saved-analysis' ? 'Suggested from the template\'s earlier saved analysis: an approximate box. Check it.' : 'From the Template Studio poster\'s own text and logo.'}</p>}
  </div>;
}
