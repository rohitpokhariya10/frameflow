import type { KeyboardEvent } from 'react';

export const isTypingTarget = (target: EventTarget | null) => target instanceof HTMLElement
  && Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'));

export function historyKey(event: KeyboardEvent): 'undo' | 'redo' | null {
  if (event.nativeEvent.isComposing || event.altKey || isTypingTarget(event.target) || !(event.metaKey || event.ctrlKey)) return null;
  if (event.key.toLowerCase() === 'z') return event.shiftKey ? 'redo' : 'undo';
  if (event.ctrlKey && event.key.toLowerCase() === 'y') return 'redo';
  return null;
}

/** Only the canvas or accessible element list owns destructive shortcuts. */
export function selectionKey(event: KeyboardEvent): 'delete' | 'deselect' | null {
  const target = event.target;
  if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey || !(target instanceof HTMLElement)) return null;
  if (isTypingTarget(target)) return null;
  if (event.key === 'Escape') return 'deselect';
  if ((event.key === 'Delete' || event.key === 'Backspace') && target.closest('[data-selection-owner]')) return 'delete';
  return null;
}
