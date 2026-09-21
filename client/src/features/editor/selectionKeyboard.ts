import type { KeyboardEvent } from 'react';

/** Only the canvas or accessible element list owns destructive shortcuts. */
export function selectionKey(event: KeyboardEvent): 'delete' | 'deselect' | null {
  const target = event.target;
  if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey || !(target instanceof HTMLElement)) return null;
  if (target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return null;
  if (event.key === 'Escape') return 'deselect';
  if ((event.key === 'Delete' || event.key === 'Backspace') && target.closest('[data-selection-owner]')) return 'delete';
  return null;
}
