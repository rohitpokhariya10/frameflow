import { expect, it } from 'vitest';
import { createDocument } from '../../store/editorSlice';
import { variantLabel } from './variantLabel';

it('keeps version choices distinct without repeated dimensions or internal IDs', () => {
  const source = createDocument('project', '2026-09-22T00:00:00.000Z').variants[0];
  expect(variantLabel(source, 0)).toBe('1. Poster · Original · 1080 × 1350');
  const adapted = { ...source, sourceVariantId: source.id, id: 'internal-target-id', name: 'Landscape · 1600×900', canvas: { ...source.canvas, width: 1600, height: 900 } };
  expect(variantLabel(adapted, 1)).toBe('2. Landscape · Adapted · 1600 × 900');
  expect(variantLabel(adapted, 2)).toBe('3. Landscape · Adapted · 1600 × 900');
  adapted.canvas.width = 1000;
  expect(variantLabel(adapted, 2)).toBe('3. Custom · Adapted · 1000 × 900');
  expect(adapted.name).toBe('Landscape · 1600×900');
});
