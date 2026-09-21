import { useEffect, useState } from 'react';
import { Image as KonvaImage } from 'react-konva/lib/ReactKonvaCore';
import 'konva/lib/shapes/Image';
import type { CanvasSize, DesignVariant } from '@frameflow/shared';
import { assets, decodeImage } from '../../lib/assets/runtimeAssets';

export function imagePlacement(image: CanvasSize, canvas: CanvasSize, fit: 'cover' | 'contain', focal = { x: .5, y: .5 }) {
  const scale = fit === 'cover' ? Math.max(canvas.width / image.width, canvas.height / image.height) : Math.min(canvas.width / image.width, canvas.height / image.height);
  const width = image.width * scale, height = image.height * scale;
  return { x: (canvas.width - width) * focal.x, y: (canvas.height - height) * focal.y, width, height };
}
export function BackgroundArtwork({ background, canvas, onError }: { background: NonNullable<DesignVariant['background']>; canvas: CanvasSize; onError: (message: string) => void }) {
  const [loaded, setLoaded] = useState<{ id: string; image: HTMLImageElement } | null>(null);
  useEffect(() => {
    let cancelled = false;
    onError('');
    void assets.getAsset(background.assetId).then(async (asset) => {
      if (!asset) throw new Error('missing');
      const image = await decodeImage(asset.blob);
      if (!cancelled) setLoaded({ id: background.assetId, image });
    }).catch(() => { if (!cancelled) onError('Artwork could not be recovered. Your text is safe. Generate replacement artwork in the AI tab.'); });
    return () => { cancelled = true; };
  }, [background.assetId, onError]);
  if (loaded?.id !== background.assetId) return null;
  return <KonvaImage name="background-artwork" image={loaded.image} listening={false}
    {...imagePlacement({ width: loaded.image.naturalWidth, height: loaded.image.naturalHeight }, canvas, background.fit, background.focalPoint)} />;
}
