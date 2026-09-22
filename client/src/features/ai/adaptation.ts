import { clamp, TEXT_LIMITS, type AdaptFormat, type CanvasSize, type DesignVariant, type TextElement } from '@frameflow/shared';
import { autoLayout, type MeasureText } from '../../lib/layout/autoLayout';
import { safeRegion, type LayoutRegion } from '../../lib/layout/constants';
import { quietRegion } from './composition';

export function adaptationRegion(canvas: CanvasSize, format: AdaptFormat) {
  if (format !== 'custom') return quietRegion(canvas);
  const safe = safeRegion(canvas);
  return { x: safe.x / canvas.width, y: safe.y / canvas.height, width: safe.width / canvas.width, height: safe.height / canvas.height };
}
/** Copy every element by identity. Typography/content remain authoritative in the app. */
export function adaptText(source: DesignVariant, target: CanvasSize, format: AdaptFormat, measure: MeasureText) {
  const safe = safeRegion(target), q = adaptationRegion(target, format);
  const scale = format === 'custom' ? Math.min(target.width / source.canvas.width, target.height / source.canvas.height)
    : Math.min(target.width, target.height) / Math.min(source.canvas.width, source.canvas.height);
  const slots = { eyebrow: [0, .13], title: [.16, .34], date: [.55, .14], venue: [.73, .27] } as const;
  const unresolved = new Set<string>();
  const placed: { element: TextElement; bounds: LayoutRegion }[] = [];
  const elements = source.elements.map((original) => {
    let element: TextElement = { ...original, x: original.x / source.canvas.width * target.width,
      y: original.y / source.canvas.height * target.height, width: clamp(original.width / source.canvas.width * target.width, TEXT_LIMITS.minWidth, safe.width),
      fontSize: clamp(original.fontSize * scale, TEXT_LIMITS.minFontSize, TEXT_LIMITS.maxFontSize) };
    let region = safe;
    if (format !== 'custom' && original.role in slots) {
      const [offset, height] = slots[original.role as keyof typeof slots];
      const peers = source.elements.filter((item) => item.role === original.role);
      const index = peers.findIndex((item) => item.id === original.id);
      const row = q.height * height * target.height / peers.length;
      region = { x: q.x * target.width, y: (q.y + q.height * offset) * target.height + index * row,
        width: q.width * target.width, height: row * .94 };
      element = { ...element, x: region.x, y: region.y, width: region.width, align: format === 'landscape' ? 'left' : 'center' };
    } else {
      element.x = clamp(element.x, safe.x, safe.x + safe.width - element.width);
      element.y = clamp(element.y, safe.y, safe.y + safe.height);
    }
    const result = autoLayout(element, target, measure, region);
    element = result.element;
    if (result.status === 'unresolved') unresolved.add(original.id);
    if (element.text) {
      try {
        const measurement = measure(element);
        const bounds = { x: element.x, y: element.y, width: measurement.width, height: measurement.height };
        const overlaps = (a: LayoutRegion, b: LayoutRegion) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
        for (const previous of placed) {
          if (!overlaps(bounds, previous.bounds)) continue;
          const nextY = previous.bounds.y + previous.bounds.height + 8;
          // Custom boxes can move below an earlier box; reserved semantic slots stay fixed.
          if (region === safe && nextY + bounds.height <= safe.y + safe.height) { element = { ...element, y: nextY }; bounds.y = nextY; }
          else { unresolved.add(original.id); unresolved.add(previous.element.id); }
        }
        // A move may meet another earlier box. Flag any residual collision truthfully.
        for (const previous of placed) if (overlaps(bounds, previous.bounds)) { unresolved.add(original.id); unresolved.add(previous.element.id); }
        placed.push({ element, bounds });
      } catch { unresolved.add(original.id); }
    }
    return element;
  });
  return { elements, unresolved: [...unresolved] };
}
