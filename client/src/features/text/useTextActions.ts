import { TEXT_LIMITS, type TextChanges, type TextElement, type TextKind } from '@frameflow/shared';
import { selectActiveVariant, useAppDispatch, useAppSelector } from '../../store';
import { textAdded, textDeleted, textDuplicated, textMoved, textUpdated, textWidthResized } from '../../store/editorSlice';
import { elementSelected, tabChanged } from '../../store/uiSlice';
import { boundTextPosition } from './textGeometry';
import { measuredWords } from './measuredWords';

export const focusCanvas = () => document.getElementById('canvas-interaction')?.focus({ preventScroll: true });

export function useTextActions() {
  const dispatch = useAppDispatch();
  const variant = useAppSelector(selectActiveVariant);
  const target = (id: string) => ({ variantId: variant.id, id, timestamp: new Date().toISOString() });
  return {
    add(kind: TextKind) {
      if (variant.elements.length >= TEXT_LIMITS.maxElements) return;
      const id = crypto.randomUUID();
      dispatch(textAdded({ ...target(id), kind }));
      dispatch(elementSelected(id));
      dispatch(tabChanged('text'));
      focusCanvas();
    },
    update(id: string, changes: TextChanges, editSession?: string) {
      // (A product template's word: its drawn width before and after, measured, so the rest of its line follows exactly.)
      const element = variant.productTemplate ? variant.elements.find((e): e is TextElement => e.id === id && e.type === 'text') : undefined;
      const measured = element ? measuredWords([{ element, changes }]) : undefined;
      dispatch(textUpdated({ ...target(id), changes, editSession, ...(measured ? { measured } : {}) }));
    },
    move(element: TextElement, position: { x: number; y: number }, editSession?: string) {
      dispatch(textMoved({ ...target(element.id), ...boundTextPosition(element, variant.canvas, position), editSession }));
    },
    resize(element: TextElement, width: number, editSession?: string) {
      dispatch(textWidthResized({ ...target(element.id), width, ...boundTextPosition({ ...element, width }, variant.canvas), editSession }));
    },
    duplicate(element: TextElement) {
      if (variant.elements.length >= TEXT_LIMITS.maxElements) return;
      const newId = crypto.randomUUID();
      let position = boundTextPosition(element, variant.canvas, { x: element.x + TEXT_LIMITS.duplicateOffset, y: element.y + TEXT_LIMITS.duplicateOffset });
      if (position.x === element.x && position.y === element.y) {
        position = boundTextPosition(element, variant.canvas, { x: element.x - TEXT_LIMITS.duplicateOffset, y: element.y - TEXT_LIMITS.duplicateOffset });
      }
      dispatch(textDuplicated({ ...target(element.id), newId, ...position }));
      dispatch(elementSelected(newId));
      focusCanvas();
    },
    remove(id: string) {
      dispatch(textDeleted(target(id)));
      dispatch(elementSelected(null));
      focusCanvas();
    },
    select(id: string | null) { dispatch(elementSelected(id)); },
  };
}
