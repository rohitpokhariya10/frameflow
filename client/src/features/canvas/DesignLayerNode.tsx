import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Group as KonvaGroup } from 'konva/lib/Group';
import type { Transformer as KonvaTransformer } from 'konva/lib/shapes/Transformer';
import { Circle, Ellipse, Group, Image as KonvaImage, Rect, Transformer } from 'react-konva/lib/ReactKonvaCore';
import 'konva/lib/Group';
import 'konva/lib/shapes/Circle';
import 'konva/lib/shapes/Ellipse';
import 'konva/lib/shapes/Image';
import 'konva/lib/shapes/Rect';
import 'konva/lib/shapes/Transformer';
import { LAYER_LIMITS, type DesignLayer } from '@frameflow/shared';
import { useAppDispatch } from '../../store';
import { layerUpdated } from '../../store/editorSlice';
import { elementSelected } from '../../store/uiSlice';
import { assets, decodeImage } from '../../lib/assets/runtimeAssets';
import { focusCanvas } from '../text/useTextActions';
import { cornerRadius, layerImageProps, shapeFillProps, strokeProps } from './layerGeometry';

/** Decoded layer bitmaps, shared by all nodes and export for the lifetime of the page. */
const bitmaps = new Map<string, Promise<HTMLImageElement>>();
export function layerBitmap(assetId: string) {
  let pending = bitmaps.get(assetId);
  if (!pending) {
    pending = assets.getAsset(assetId).then(asset => { if (!asset) throw new Error('Missing layer image'); return decodeImage(asset.blob); });
    pending.catch(() => bitmaps.delete(assetId));
    bitmaps.set(assetId, pending);
  }
  return pending;
}

/** raiseHandles: keep the selection handles above later elements, for designs that interleave text and layers. */
interface Props { layer: DesignLayer; selected: boolean; variantId: string; raiseHandles?: boolean }

export function DesignLayerNode({ layer, selected, variantId, raiseHandles = false }: Props) {
  const dispatch = useAppDispatch();
  const groupRef = useRef<KonvaGroup>(null);
  const transformerRef = useRef<KonvaTransformer>(null);
  const [image, setImage] = useState<{ id: string; bitmap: HTMLImageElement } | null>(null);
  const assetId = layer.type === 'image' ? layer.assetId : undefined;
  useEffect(() => {
    if (!assetId) return;
    let cancelled = false;
    void layerBitmap(assetId).then(bitmap => { if (!cancelled) setImage({ id: assetId, bitmap }); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [assetId]);
  useLayoutEffect(() => {
    if (selected && groupRef.current && transformerRef.current) { transformerRef.current.nodes([groupRef.current]); if (raiseHandles) transformerRef.current.moveToTop(); transformerRef.current.forceUpdate(); }
  }, [selected, layer.width, layer.height, layer.rotation, image, raiseHandles]);
  if (!layer.visible) return null;
  const select = () => { dispatch(elementSelected(layer.id)); focusCanvas(); };
  const commit = (changes: Parameters<typeof layerUpdated>[0]['changes']) => dispatch(layerUpdated({ variantId, id: layer.id, changes, timestamp: new Date().toISOString() }));
  return <>
    <Group ref={groupRef} id={layer.id} name="design-layer" x={layer.x} y={layer.y} rotation={layer.rotation} opacity={layer.opacity}
      draggable={!layer.locked} listening onMouseDown={select} onTouchStart={select} onClick={select} onTap={select} onDragStart={select}
      onDragEnd={(event) => { const node = event.target as KonvaGroup; commit({ x: node.x(), y: node.y() }); }}
      onTransformEnd={() => {
        const node = groupRef.current; if (!node) return;
        const width = Math.max(LAYER_LIMITS.minSide, layer.width * node.scaleX()), height = Math.max(LAYER_LIMITS.minSide, layer.height * node.scaleY());
        node.scale({ x: 1, y: 1 });
        commit({ x: node.x(), y: node.y(), width, height, rotation: ((node.rotation() + 540) % 360) - 180 });
      }}>
      {layer.type === 'image'
        ? layer.assetId === undefined
          // An empty image slot: it keeps its place and size, and takes a picture with Replace image.
          ? <Rect name="layer-image-slot" width={layer.width} height={layer.height} fill="#EEF0EC" stroke="#9AA39D" strokeWidth={2} dash={[10, 8]} cornerRadius={Math.min(layer.radius ?? 0, layer.width / 2, layer.height / 2)} />
          : image?.id === layer.assetId && <>
            {/* A fitted picture may not fill its box: the whole box stays the layer's frame and hit area. */}
            {layer.fit && <Rect width={layer.width} height={layer.height} fill="transparent" />}
            <KonvaImage name="layer-image" image={image.bitmap} {...layerImageProps(layer, image.bitmap)} />
          </>
        : layer.shapeType === 'circle'
          ? <Circle name="layer-shape" x={layer.width / 2} y={layer.height / 2} radius={Math.min(layer.width, layer.height) / 2} {...shapeFillProps({ ...layer, width: Math.min(layer.width, layer.height), height: Math.min(layer.width, layer.height) }, 'center')} {...strokeProps(layer)} />
        : layer.shapeType === 'ellipse'
          ? <Ellipse name="layer-shape" x={layer.width / 2} y={layer.height / 2} radiusX={layer.width / 2} radiusY={layer.height / 2} {...shapeFillProps(layer, 'center')} {...strokeProps(layer)} />
          : <Rect name="layer-shape" width={layer.width} height={layer.height} cornerRadius={cornerRadius(layer)} {...shapeFillProps(layer)} {...strokeProps(layer)} />}
    </Group>
    {selected && !layer.locked && <Transformer ref={transformerRef} name="layer-transformer" rotateEnabled keepRatio={layer.type === 'image' && !layer.fit} flipEnabled={false}
      anchorSize={8} anchorCornerRadius={2} anchorFill="#FFFFFF" anchorStroke="#285443" anchorStrokeWidth={1} borderStroke="#285443" borderStrokeWidth={1}
      boundBoxFunc={(oldBox, nextBox) => Math.abs(nextBox.width) < 4 || Math.abs(nextBox.height) < 4 ? oldBox : nextBox} />}
  </>;
}
