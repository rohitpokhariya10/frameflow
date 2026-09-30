import { useRef, useState, type ReactNode } from 'react';
import { isTemplateColor } from '@frameflow/shared';
import { completeNumber } from '../../components/ui/NumberField';
import { assets, decodeImage } from '../../lib/assets/runtimeAssets';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export function Section({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  return <section className="tpl-section"><h3>{title}{note && <span> {note}</span>}</h3>{children}</section>;
}
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="tpl-field"><span>{label}</span>{children}</label>;
}

/**
 * A number typed as text: every complete value inside the range is applied as it is typed, and an unfinished one
 * ("0.", "-") is kept only in the box until it is finished or the box is left. `digits` is what is shown, not stored.
 */
export function NumberInput({ label, value, min, max, step = 1, digits = 2, suffix, onChange }: { label: string; value: number; min: number; max: number; step?: number; digits?: number; suffix?: string; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const within = (number: number) => number >= min && number <= max;
  return <Field label={label}><span className="tpl-number">
    <input type="text" inputMode="decimal" role="spinbutton" aria-valuenow={value} aria-valuemin={min} aria-valuemax={max} value={draft ?? String(Number(value.toFixed(digits)))}
      onChange={(event) => { setDraft(event.target.value); const number = completeNumber(event.target.value); if (number !== null && within(number)) onChange(number); }}
      onBlur={() => setDraft(null)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault(); setDraft(null);
          onChange(Math.max(min, Math.min(max, Number((value + (event.key === 'ArrowUp' ? step : -step)).toFixed(6)))));
        }
        if (event.key === 'Enter') event.currentTarget.blur();
      }} />
    {suffix && <span>{suffix}</span>}
  </span></Field>;
}

export function ColorInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return <Field label={label}><span className="tpl-color">
    <input type="color" aria-label={`${label} picker`} value={value.toLowerCase()} onChange={event => { setDraft(null); onChange(event.target.value.toUpperCase()); }} />
    <input type="text" aria-label={`${label} hex`} value={draft ?? value} maxLength={7} onBlur={() => setDraft(null)}
      onChange={(event) => { setDraft(event.target.value); if (isTemplateColor(event.target.value)) onChange(event.target.value.toUpperCase()); }} />
  </span></Field>;
}

export function Select<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: readonly (T | { value: T; label: string })[]; onChange: (value: T) => void }) {
  const items = options.map(option => typeof option === 'object' ? option : { value: option, label: String(option) });
  return <Field label={label}><select value={String(value)} onChange={event => onChange(items.find(item => String(item.value) === event.target.value)!.value)}>
    {items.map(item => <option key={String(item.value)} value={String(item.value)}>{item.label}</option>)}
  </select></Field>;
}

/** Stores a chosen picture in this browser's asset store and reports its id. Nothing is uploaded anywhere. */
export function ImagePicker({ label, assetId, onChange, allowRemove = true }: { label: string; assetId: string | null; onChange: (assetId: string | null) => void; allowRemove?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const choose = async (file?: File) => {
    setError('');
    if (!file) return;
    if (!IMAGE_TYPES.includes(file.type) || file.size > MAX_IMAGE_BYTES) { setError('Choose a PNG, JPEG or WebP image up to 25 MB.'); return; }
    try { await decodeImage(file); } catch { setError('This image could not be read, or it is too large.'); return; }
    const id = `template-asset-${crypto.randomUUID()}`;
    try { await assets.putAsset(id, file); } catch { setError('This image could not be saved in your browser. Try a smaller one.'); return; }
    onChange(id);
  };
  return <div className="tpl-field"><span>{label}</span><span className="tpl-row">
    <button type="button" className="ws-btn" onClick={() => input.current?.click()}>{assetId ? 'Replace image' : 'Choose image'}</button>
    {assetId && allowRemove && <button type="button" className="ws-btn ws-btn-quiet" onClick={() => onChange(null)}>Remove</button>}
    <input ref={input} type="file" accept={IMAGE_TYPES.join(',')} hidden aria-label={label} onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = ''; }} />
    {error && <span role="alert" className="ws-error-text">{error}</span>}
  </span></div>;
}

export const percent = (value: number) => `${(value * 100).toFixed(2)}%`;
