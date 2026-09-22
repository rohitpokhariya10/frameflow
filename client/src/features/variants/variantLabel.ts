import { CANVAS_PRESETS, type CanvasSize, type DesignVariant } from '@frameflow/shared';

export function formatLabel(canvas: CanvasSize) {
  return CANVAS_PRESETS.find((preset) => preset.width === canvas.width && preset.height === canvas.height)?.name ?? 'Custom';
}

/** Presentation only: persisted names and source relationships stay untouched. */
export function variantLabel(variant: DesignVariant, index: number) {
  return `${index + 1}. ${formatLabel(variant.canvas)} · ${variant.sourceVariantId ? 'Adapted' : 'Original'} · ${variant.canvas.width} × ${variant.canvas.height}`;
}
