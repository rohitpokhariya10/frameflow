import { useId, useRef, useState } from 'react';
import { clamp } from '@frameflow/shared';

interface Props { label: string; value: number; min?: number; max?: number; onCommit: (value: number, session: string) => void; onEndSession: () => void }
export function completeNumber(draft: string): number | null {
  if (!/^-?(?:\d+|\d*\.\d+)$/.test(draft)) return null;
  const number = Number(draft);
  return Number.isFinite(number) ? number : null;
}

/** Preserve editing strings while complete supported values immediately reach the document. */
export function NumberField({ label, value, min, max, onCommit, onEndSession }: Props) {
  const id = useId();
  const session = useRef('');
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState('');
  function publish(number: number) {
    session.current ||= crypto.randomUUID();
    onCommit(number, session.current);
  }
  function step(direction: number) {
    const next = clamp(value + direction, min ?? -Infinity, max ?? Infinity);
    setDraft(String(next)); setError(''); publish(next);
  }
  function finish() {
    const number = draft === null ? value : completeNumber(draft);
    if (number === null) setError('Enter a finite number. The last valid value was restored.');
    else if (number < (min ?? -Infinity) || number > (max ?? Infinity)) setError('Value is outside the supported range. The last valid value was restored.');
    else setError('');
    setDraft(null); session.current = ''; onEndSession();
  }
  return <div className="number-field">
    <label htmlFor={id}>{label}</label>
    <div className="number-input"><input ref={input} id={id} type="text" role="spinbutton" inputMode="decimal" aria-valuenow={value} aria-valuemin={min} aria-valuemax={max}
      value={draft ?? Number(value.toFixed(2))} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}
      title="Logical pixels; valid values update immediately. Arrow keys adjust by one."
      onFocus={() => { session.current = crypto.randomUUID(); }}
      onChange={(event) => {
        const next = event.target.value; setDraft(next); setError('');
        const number = completeNumber(next);
        if (number !== null && number >= (min ?? -Infinity) && number <= (max ?? Infinity)) publish(number);
      }} onBlur={finish}
      onKeyDown={(event) => {
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          step(event.key === 'ArrowUp' ? 1 : -1);
        }
        if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
        if (event.key === 'Escape') { event.stopPropagation(); setDraft(null); setError(''); session.current = ''; onEndSession(); }
      }} />
      <div className="number-steppers">{[1, -1].map((direction) => <button key={direction} type="button" tabIndex={-1}
        aria-label={`${direction === 1 ? 'Increase' : 'Decrease'} ${label}`} onMouseDown={(event) => event.preventDefault()}
        onClick={() => { input.current?.focus(); step(direction); }}>{direction === 1 ? '▴' : '▾'}</button>)}</div>
    </div>
    {error && <span id={`${id}-error`} className="field-error" role="alert">{error}</span>}
  </div>;
}
