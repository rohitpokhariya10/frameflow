import { CANVAS_PRESETS, type CanvasSize, type DesignVariant } from '@frameflow/shared';

export function formatLabel(canvas: CanvasSize) {
  return CANVAS_PRESETS.find((preset) => preset.width === canvas.width && preset.height === canvas.height)?.name ?? 'Custom';
}

/** Presentation only: persisted names and source relationships stay untouched. */
export function variantLabel(variant: DesignVariant, index: number) {
  const kind = variant.decomposition ? `Layers on ${variant.decomposition.mode === 'blank' ? 'blank canvas' : 'original'}` : variant.sourceVariantId ? 'Adapted' : 'Original';
  return `${index + 1}. ${formatLabel(variant.canvas)} · ${kind} · ${variant.canvas.width} × ${variant.canvas.height}`;
}
