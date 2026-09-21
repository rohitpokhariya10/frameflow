import { createTextElement, type CanvasSize, type TextElement, type QuietRegion } from '@frameflow/shared';
import { autoLayout, type MeasureText } from '../../lib/layout/autoLayout';
export type EventContent = Record<'eyebrow' | 'title' | 'date' | 'venue', string>;
export const emptyContent: EventContent = { eyebrow: '', title: '', date: '', venue: '' };
export function quietRegion(canvas: CanvasSize): QuietRegion {
  return canvas.width > canvas.height ? { x: .42, y: .15, width: .5, height: .7 } : { x: .15, y: .25, width: .7, height: .55 };
}
export function composeText(content: EventContent, canvas: CanvasSize, measure: MeasureText, id: () => string) {
  const q = quietRegion(canvas);
  const specs = [{ role: 'eyebrow', y: 0, height: .13, size: 24 }, { role: 'title', y: .16, height: .34, size: 72 }, { role: 'date', y: .55, height: .14, size: 30 }, { role: 'venue', y: .73, height: .27, size: 26 }] as const;
  const elements: TextElement[] = []; const unresolved: string[] = [];
  for (const spec of specs) {
    if (!content[spec.role]) continue;
    const region = { x: q.x * canvas.width, y: (q.y + q.height * spec.y) * canvas.height, width: q.width * canvas.width, height: q.height * spec.height * canvas.height };
    const element: TextElement = { ...createTextElement(spec.role === 'title' ? 'heading' : 'body', canvas, id()), role: spec.role,
      text: content[spec.role], x: region.x, y: region.y, width: region.width, align: canvas.width > canvas.height ? 'left' : 'center',
      fontSize: Math.max(8, Math.round(spec.size * Math.min(canvas.width, canvas.height) / 1080)), fill: '#1F2925', lineHeight: 1.2 };
    const fitted = autoLayout(element, canvas, measure, region);
    elements.push(fitted.element);
    if (fitted.status === 'unresolved') unresolved.push(spec.role);
  }
  return { elements, unresolved };
}
