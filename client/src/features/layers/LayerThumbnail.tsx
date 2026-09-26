import { useEffect, useId, useState } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import type { DesignLayer } from '@frameflow/shared';
import { assets } from '../../lib/assets/runtimeAssets';
import { cornerRadius, shapeFillProps } from '../canvas/layerGeometry';

/** A compact preview of the editable layer, using only its existing local asset. */
export function LayerThumbnail({ layer }: { layer: DesignLayer }) {
  const assetId = layer.type === 'image' ? layer.assetId : undefined;
  const [image, setImage] = useState<{ id: string; url: string } | null>(null);
  const gradientId = useId();
  useEffect(() => {
    if (!assetId) return;
    let cancelled = false, url: string | undefined;
    void assets.getAsset(assetId).then(asset => {
      if (!asset || cancelled) return;
      url = URL.createObjectURL(asset.blob);
      setImage({ id: assetId, url });
    }).catch(() => undefined);
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [assetId]);
  if (layer.type === 'image') return <span className="layer-thumbnail" aria-hidden="true">
    {image?.id === layer.assetId ? <img src={image.url} alt="" draggable={false} /> : <ImageIcon size={18} />}
  </span>;
  const fill = shapeFillProps(layer);
  const style = { fill: layer.gradient ? `url(#${gradientId})` : layer.fill, stroke: layer.stroke?.color, strokeWidth: layer.stroke?.width };
  return <span className="layer-thumbnail" aria-hidden="true"><svg viewBox={`0 0 ${layer.width} ${layer.height}`}>
    {layer.gradient && <defs><linearGradient id={gradientId} gradientUnits="userSpaceOnUse"
      x1={fill.fillLinearGradientStartPoint?.x} y1={fill.fillLinearGradientStartPoint?.y}
      x2={fill.fillLinearGradientEndPoint?.x} y2={fill.fillLinearGradientEndPoint?.y}>
      <stop offset="0" stopColor={layer.gradient.from} /><stop offset="1" stopColor={layer.gradient.to} />
    </linearGradient></defs>}
    {layer.shapeType === 'ellipse'
      ? <ellipse cx={layer.width / 2} cy={layer.height / 2} rx={layer.width / 2} ry={layer.height / 2} {...style} />
      : <rect width={layer.width} height={layer.height} rx={cornerRadius(layer)} {...style} />}
  </svg></span>;
}
