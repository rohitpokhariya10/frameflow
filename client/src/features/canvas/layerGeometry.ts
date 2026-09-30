import { imageFit, type ImageLayerElement, type ShapeLayerElement } from '@frameflow/shared';

/**
 * Where a layer's picture is drawn inside its box. Without a fit it is stretched to the box, as layers always were. With
 * one (an image slot from a template) it is cropped (cover) or letterboxed (contain) around the focal point, never distorted.
 */
export function layerImageProps(layer: Pick<ImageLayerElement, 'width' | 'height' | 'fit' | 'focalPoint' | 'radius'>, bitmap: { naturalWidth: number; naturalHeight: number }) {
  if (!layer.fit) return { width: layer.width, height: layer.height };
  const { crop, dest } = imageFit({ width: bitmap.naturalWidth, height: bitmap.naturalHeight }, layer, layer.fit, layer.focalPoint?.x, layer.focalPoint?.y);
  return { ...dest, crop, cornerRadius: Math.min(layer.radius ?? 0, dest.width / 2, dest.height / 2) };
}

/** Ellipse nodes draw around their center; rectangles and SVG thumbnails use a top-left origin. */
export function shapeFillProps(layer: Pick<ShapeLayerElement, 'fill' | 'gradient' | 'width' | 'height'>, origin: 'top-left' | 'center' = 'top-left') {
  if (!layer.gradient) return { fill: layer.fill };
  const radians = (layer.gradient.angle * Math.PI) / 180, dx = Math.cos(radians), dy = Math.sin(radians);
  const half = (Math.abs(dx) * layer.width + Math.abs(dy) * layer.height) / 2;
  const cx = origin === 'center' ? 0 : layer.width / 2, cy = origin === 'center' ? 0 : layer.height / 2;
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
