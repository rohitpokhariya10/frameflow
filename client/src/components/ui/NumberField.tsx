import { useId, useState } from 'react';
import { clamp } from '@frameflow/shared';

interface Props { label: string; value: number; min?: number; max?: number; onCommit: (value: number) => void }

/** Draft text stays local, so an empty/partial number never reaches the document. */
export function NumberField({ label, value, min, max, onCommit }: Props) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState('');
  function commit() {
    if (draft === null) return;
    const number = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(number)) {
      setError('Enter a finite number.');
    } else {
      onCommit(clamp(number, min ?? -Infinity, max ?? Infinity));
      setError('');
    }
    setDraft(null);
  }
  return <div className="number-field">
    <label htmlFor={id}>{label}</label>
    <input id={id} type="number" step="any" min={min} max={max}
      value={draft ?? Number(value.toFixed(2))} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}
      title={min !== undefined && max !== undefined ? `${min}–${max} logical pixels; applied on Enter or blur` : 'Logical pixels; applied on Enter or blur'}
      onChange={(event) => { setDraft(event.target.value); setError(''); }} onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
        if (event.key === 'Escape') { event.stopPropagation(); setDraft(null); setError(''); }
      }} />
    {error && <span id={`${id}-error`} className="field-error" role="alert">{error}</span>}
  </div>;
}
