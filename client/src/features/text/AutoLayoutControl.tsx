import { useMemo, useState } from 'react';
import { useStore } from 'react-redux';
import { ScanLine } from 'lucide-react';
import type { TextElement, DesignVariant } from '@frameflow/shared';
import { selectActiveVariant, useAppDispatch, useAppSelector, type RootState } from '../../store';
import { textAutoLayoutApplied } from '../../store/editorSlice';
import { autoLayout, textOverflows, type LayoutResult } from '../../lib/layout/autoLayout';
import { safeRegion } from '../../lib/layout/constants';
import { ensureTextFont, measureText } from '../../lib/layout/measureText';

function feedback(result: LayoutResult, original: TextElement) {
  if (result.status === 'unchanged') return original.text === '' ? 'Add text to use Auto Layout.' : 'This text already fits.';
  if (result.status === 'unresolved') return result.reason;
  const changes = result.changes.filter((change) => change !== 'font-reduced').map((change) => ({ wrapped: 'Rewrapped', widened: 'Widened', moved: 'Moved' })[change]);
  if (result.changes.includes('font-reduced')) changes.push(`Font reduced from ${Number(original.fontSize.toFixed(2))} to ${Number(result.element.fontSize.toFixed(2))}`);
  return `Text fitted within the frame. ${changes.length ? changes.join(' · ') + '.' : ''}`;
}

export function AutoLayoutControl({ element }: { element: TextElement }) {
  const variant = useAppSelector(selectActiveVariant);
  const dispatch = useAppDispatch();
  const store = useStore<RootState>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ variant: DesignVariant; message: string; unresolved: boolean } | null>(null);
  const currentNotice = notice?.variant === variant ? notice : null;
  const overflow = useMemo(() => textOverflows(element, safeRegion(variant.canvas), measureText), [element, variant.canvas]);
  async function fit() {
    setBusy(true);
    try {
      await ensureTextFont(element);
      // A font load may finish after typing, resizing, or switching selection.
      const state = store.getState();
      const current = selectActiveVariant(state);
      if (current !== variant || state.ui.selectedElementId !== element.id) return;
      const result = autoLayout(element, variant.canvas, measureText);
      if (result.status === 'fitted') {
        const { x, y, width, fontSize } = result.element;
        dispatch(textAutoLayoutApplied({ variantId: variant.id, id: element.id, expectedRevision: variant.revision,
          layout: { x, y, width, fontSize }, timestamp: new Date().toISOString() }));
      }
      setNotice({ variant: selectActiveVariant(store.getState()), message: feedback(result, element), unresolved: result.status === 'unresolved' });
    } catch {
      setNotice({ variant, message: 'The selected font could not be loaded. Please try again.', unresolved: true });
    } finally { setBusy(false); }
  }
  return <div className="auto-layout-control">
    <button className="button auto-layout-button" disabled={busy} onClick={() => void fit()}><ScanLine size={14} />{busy ? 'Fitting…' : 'Auto Layout'}</button>
    <p className="inspector-hint">Fit within the frame. Keep every word.</p>
    {overflow && !currentNotice?.unresolved && <p className="layout-warning">Text extends outside the safe frame.</p>}
    <p className={`layout-feedback${currentNotice?.unresolved ? ' layout-warning' : ''}`} role="status" aria-live="polite">{currentNotice?.message ?? ''}</p>
  </div>;
}
