import type { CanvasSize } from '@frameflow/shared';

export const VIEWPORT = { padding: 48, minZoom: 0.01, maxZoom: 2, zoomStep: 1.2 } as const;

/** Only returns a display scale. Never changes document dimensions or positions. */
export function calculateFitZoom(canvas: CanvasSize, viewport: CanvasSize, padding = VIEWPORT.padding): number {
  if (canvas.width <= 0 || canvas.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return VIEWPORT.minZoom;
  return Math.max(VIEWPORT.minZoom, Math.min(
    (viewport.width - padding * 2) / canvas.width,
    (viewport.height - padding * 2) / canvas.height,
    1,
  ));
}
