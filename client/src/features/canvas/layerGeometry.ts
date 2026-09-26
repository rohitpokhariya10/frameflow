import type { ShapeLayerElement } from '@frameflow/shared';

/** Konva fill props for a shape layer: a solid fill, or a two-stop linear gradient along `angle` (degrees). */
export function shapeFillProps(layer: Pick<ShapeLayerElement, 'fill' | 'gradient' | 'width' | 'height'>) {
  if (!layer.gradient) return { fill: layer.fill };
  const radians = (layer.gradient.angle * Math.PI) / 180, dx = Math.cos(radians), dy = Math.sin(radians);
  const half = (Math.abs(dx) * layer.width + Math.abs(dy) * layer.height) / 2, cx = layer.width / 2, cy = layer.height / 2;
  return {
    fillLinearGradientStartPoint: { x: cx - dx * half, y: cy - dy * half },
    fillLinearGradientEndPoint: { x: cx + dx * half, y: cy + dy * half },
    fillLinearGradientColorStops: [0, layer.gradient.from, 1, layer.gradient.to],
  };
}
export function strokeProps(layer: Pick<ShapeLayerElement, 'stroke'>) {
  return layer.stroke && layer.stroke.width > 0 ? { stroke: layer.stroke.color, strokeWidth: layer.stroke.width } : {};
}
/** Corner radius never exceeds half the shorter side. */
export const cornerRadius = (layer: Pick<ShapeLayerElement, 'shapeType' | 'radius' | 'width' | 'height'>) =>
  layer.shapeType === 'rounded-rectangle' ? Math.min(layer.radius, layer.width / 2, layer.height / 2) : 0;
