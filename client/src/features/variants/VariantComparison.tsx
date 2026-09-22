import { useLayoutEffect, useRef, useState } from 'react';
import { Layer, Rect, Stage, Text } from 'react-konva/lib/ReactKonvaCore';
import type { DesignVariant } from '@frameflow/shared';
import { BackgroundArtwork } from '../canvas/BackgroundArtwork';
import { textNodeStyle } from '../text/textGeometry';

function VariantCard({ variant, label }: { variant: DesignVariant; label: string }) {
  const holder = useRef<HTMLDivElement>(null), [zoom, setZoom] = useState(.1), [error, setError] = useState('');
  useLayoutEffect(() => {
    const node = holder.current; if (!node) return;
    const fit = () => setZoom(Math.max(.01, Math.min(node.clientWidth / variant.canvas.width, node.clientHeight / variant.canvas.height)));
    const observer = new ResizeObserver(fit); observer.observe(node); fit(); return () => observer.disconnect();
  }, [variant.canvas]);
  return <section className="variant-card" aria-label={`${label} version`}>
    <div className="variant-card-heading"><strong>{label}</strong><span>{variant.canvas.width} × {variant.canvas.height}</span></div>
    <div className="variant-card-body" ref={holder}><div data-testid={`${label.toLowerCase()}-frame`} style={{ width: variant.canvas.width * zoom, height: variant.canvas.height * zoom }}>
      <Stage width={variant.canvas.width * zoom} height={variant.canvas.height * zoom} scaleX={zoom} scaleY={zoom} listening={false}>
        <Layer listening={false} clipWidth={variant.canvas.width} clipHeight={variant.canvas.height}>
          <Rect width={variant.canvas.width} height={variant.canvas.height} fill={variant.canvas.backgroundColor} />
          {variant.background && <BackgroundArtwork background={variant.background} canvas={variant.canvas} onError={setError} />}
          {variant.elements.map((element) => <Text key={element.id} name="comparison-text" {...textNodeStyle(element)} x={element.x} y={element.y} listening={false} />)}
        </Layer>
      </Stage>
    </div></div>
    {error && <p className="ai-notice" role="alert">{error}</p>}
  </section>;
}
export function VariantComparison({ source, target }: { source: DesignVariant; target: DesignVariant }) {
  return <div className="variant-comparison" aria-label="Source and target comparison"><VariantCard variant={source} label="Source" /><VariantCard variant={target} label="Target" /></div>;
}
