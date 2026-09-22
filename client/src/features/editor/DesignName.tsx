import { useRef, useState } from 'react';
import { selectDocument, useAppDispatch, useAppSelector } from '../../store';
import { DEFAULT_DESIGN_NAME, documentRenamed } from '../../store/editorSlice';

export function DesignName() {
  const { name } = useAppSelector(selectDocument);
  const dispatch = useAppDispatch();
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const displayName = name.trim() || DEFAULT_DESIGN_NAME;

  return <input className="project-name" aria-label="Design name" title={displayName}
    value={draft ?? displayName} maxLength={10_000} autoComplete="off" spellCheck={false}
    onFocus={(event) => { cancelled.current = false; setDraft(displayName); event.currentTarget.select(); }}
    onChange={(event) => setDraft(event.target.value)}
    onBlur={(event) => {
      if (!cancelled.current) dispatch(documentRenamed({ name: event.currentTarget.value, timestamp: new Date().toISOString() }));
      setDraft(null);
    }}
    onKeyDown={(event) => {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (event.key !== 'Enter' && event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      cancelled.current = event.key === 'Escape';
      event.currentTarget.blur();
    }} />;
}
