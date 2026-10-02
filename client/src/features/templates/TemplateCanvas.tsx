import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Group as KonvaGroup } from 'konva/lib/Group';
import type { Transformer as KonvaTransformer } from 'konva/lib/shapes/Transformer';
import { Circle, Ellipse, Group, Image as KonvaImage, Layer, Rect, Stage, Text, Transformer } from 'react-konva/lib/ReactKonvaCore';
import 'konva/lib/Group';
import 'konva/lib/shapes/Circle';
import 'konva/lib/shapes/Ellipse';
import 'konva/lib/shapes/Image';
import 'konva/lib/shapes/Rect';
import 'konva/lib/shapes/Text';
import 'konva/lib/shapes/Transformer';
import { boxCenter, canvasColor, imageFit, textBlock, type CanvasSize, type ImageFit, type PixelBox, type ResolvedElement, type TextFit } from '@frameflow/shared';
import { layerBitmap } from '../canvas/DesignLayerNode';
import { shapeFillProps } from '../canvas/layerGeometry';
import { calculateFitZoom } from '../canvas/viewport';
import { templateTextProps } from './templateText';

/** What the pointer may do to an element: everything while authoring, only what the template opened in a creative. */
export type PointerPermission = { move: boolean; resize: boolean; rotate: boolean };
export const LOCKED_POINTER: PointerPermission = { move: false, resize: false, rotate: false };
/**
 * The smallest an element can be resized to while authoring, in screen pixels, so it can still be grabbed. This is a
 * rule of this canvas only; the stored layout has no such minimum.
 */
const MIN_ELEMENT_SCREEN_PX = 20;
const ACCENT = '#285443';

/** The decoded picture of an asset, or why there is none: still loading, or missing from this browser. */
function useBitmap(assetId: string | null) {
  const [loaded, setLoaded] = useState<{ id: string; image?: HTMLImageElement } | null>(null);
  useEffect(() => {
    if (!assetId) return;
    let cancelled = false;
    void layerBitmap(assetId).then(image => { if (!cancelled) setLoaded({ id: assetId, image }); }).catch(() => { if (!cancelled) setLoaded({ id: assetId }); });
    return () => { cancelled = true; };
  }, [assetId]);
  const current = assetId && loaded?.id === assetId ? loaded : null;
  return { image: current?.image, missing: !!current && !current.image };
}

/** A picture inside its fixed box: cropped (cover) or letterboxed (contain) around the focal point, never stretched. */
function FittedImage({ assetId, width, height, fit, focalX, focalY, cornerRadius = 0, opacity = 1, placeholder, themed }: {
  assetId: string | null; width: number; height: number; fit: ImageFit; focalX: number; focalY: number; cornerRadius?: number; opacity?: number; placeholder?: string; themed?: boolean;
}) {
  const { image, missing } = useBitmap(assetId);
  if (image) {
    const { crop, dest } = imageFit({ width: image.naturalWidth, height: image.naturalHeight }, { width, height }, fit, focalX, focalY);
    return <KonvaImage name="template-image" image={image} {...dest} crop={crop} cornerRadius={cornerRadius} opacity={opacity} listening={false} />;
  }
  if (!placeholder) return null;
  // An empty slot, or a picture that is not in this browser's storage: the slot is still drawn, at its place and size.
  const size = themed ? Math.max(16, Math.min(24, Math.min(width, height) * 0.07)) : Math.max(10, Math.min(width, height) * 0.12);
  return <>
    <Rect name="template-image-placeholder" width={width} height={height} fill={themed ? "#B9AA8E22" : "#EEF0EC"} stroke={themed ? "#C6B99D" : "#9AA39D"} strokeWidth={2} dash={[10, 8]} cornerRadius={cornerRadius} listening={false} />
    <Text text={missing ? `${placeholder}\n(image missing)` : placeholder} width={width} height={height} align="center" verticalAlign="middle" fontFamily="Inter" fontSize={size} fill={themed ? "#AB9B83" : "#626C65"} listening={false} />
  </>;
}

function ElementContent({ element, fit, fontRevision }: { element: ResolvedElement; fit?: TextFit; fontRevision: number }) {
  const { width, height } = element.box;
  switch (element.type) {
    case 'background': return <>
      <Rect width={width} height={height} fill={element.color} listening={false} />
      <FittedImage assetId={element.assetId} width={width} height={height} fit={element.fit} focalX={element.focalX} focalY={element.focalY} />
    </>;
    case 'image': return <FittedImage assetId={element.assetId} width={width} height={height} fit={element.fit} focalX={element.focalX} focalY={element.focalY}
      cornerRadius={element.cornerRadiusPx} opacity={element.opacity} themed={!!element.themeRole} placeholder={element.themeRole ? element.name : `${element.name} · ${element.fit}`} />;
    case 'shape': {
      const stroke = element.stroke && element.strokeWidthPx > 0 ? { stroke: element.stroke, strokeWidth: element.strokeWidthPx } : {};
      // The same fill geometry the editor's shape layers use, so a gradient looks the same in both.
      const fill = (w: number, h: number, origin: 'top-left' | 'center') => shapeFillProps({ fill: element.fill, gradient: element.gradient, width: w, height: h }, origin);
      if (element.circle) return <Circle x={element.circle.x} y={element.circle.y} radius={element.circle.radius} {...fill(element.circle.radius * 2, element.circle.radius * 2, 'center')} opacity={element.opacity} {...stroke} listening={false} />;
      if (element.ellipse) return <Ellipse x={width / 2} y={height / 2} radiusX={width / 2} radiusY={height / 2} {...fill(width, height, 'center')} opacity={element.opacity} {...stroke} listening={false} />;
      return <Rect width={width} height={height} cornerRadius={element.cornerRadiusPx} {...fill(width, height, 'top-left')} opacity={element.opacity} {...stroke} listening={false} />;
    }
    case 'text': {
      // Without a measured fit (first paint), draw at the design size; the fit follows in the same frame.
      const drawn = fit ?? { fontPx: element.fontPx, lines: 1, visibleLines: 1, shrunk: false, truncated: false };
      const block = textBlock(element, drawn);
      if (drawn.truncated && ["headline", "offer-value", "cta", "offer-prefix", "offer-suffix", "date", "location"].includes(element.themeRole ?? "")) return <Text text={`Shorten ${element.name.toLowerCase()} to fit`} width={width} height={height} align="center" verticalAlign="middle" fontFamily="Inter" fontSize={Math.min(width / 18, height / 3)} fill={element.color} listening={false} />;
      return <>
        {element.backgroundColor && <Rect width={width} height={height} fill={element.backgroundColor} cornerRadius={element.cornerRadiusPx} listening={false} />}
        <Text key={fontRevision} name="template-text" {...templateTextProps(element, drawn.fontPx)} y={block.y} fill={element.color} listening={false}
          // Cut text: exactly the lines that fit, the last one ending with an ellipsis.
          {...(drawn.truncated ? { height: block.height + 0.5, ellipsis: true } : {})} />
      </>;
    }
  }
}

interface Props {
  fontRevision?: number; elements: ResolvedElement[]; fits: Map<string, TextFit>; canvas: CanvasSize;
  selectedId: string | null; onSelect: (id: string | null) => void;
  allows: (element: ResolvedElement) => PointerPermission;
  /**
   * A finished drag, resize or rotation, in canvas pixels: only the values that gesture changed. Returns the box as it
   * was stored (clamped, or unchanged when refused), so the node shows exactly what is saved.
   */
  onCommit: (id: string, change: Partial<PixelBox>) => PixelBox | undefined;
}

/**
 * Draws resolved template elements with Konva, at the logical canvas size scaled to fit the available space. The
 * canvas only reports pixels; converting them to normalized layout is the caller's one step (shared editing.ts).
 */
export function TemplateCanvas({ fontRevision = 0, elements, fits, canvas, selectedId, onSelect, allows, onCommit }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const transformerRef = useRef<KonvaTransformer>(null);
  const nodes = useRef(new Map<string, KonvaGroup>());
  const [zoom, setZoom] = useState(0.4);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    // The observer reports the size once as soon as it starts observing, and again whenever the space changes.
    const observer = new ResizeObserver(() => setZoom(calculateFitZoom(canvas, { width: viewport.clientWidth, height: viewport.clientHeight })));
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [canvas]);
  const selected = elements.find(element => element.id === selectedId);
  const permission = selected ? allows(selected) : LOCKED_POINTER;
  useLayoutEffect(() => {
    const transformer = transformerRef.current, node = selectedId ? nodes.current.get(selectedId) : undefined;
    if (!transformer) return;
    transformer.nodes(node ? [node] : []);
    transformer.forceUpdate();
    transformer.getLayer()?.batchDraw();
  }, [selectedId, elements, fits, zoom]);

  /** Puts a node back on the stored box: Konva moved it during the gesture, and what is stored may be clamped. */
  const place = (node: KonvaGroup, box: PixelBox) => {
    const center = boxCenter(box);
    node.setAttrs({ x: center.x, y: center.y, offsetX: box.width / 2, offsetY: box.height / 2, rotation: box.rotation, scaleX: 1, scaleY: 1 });
  };
  return <div ref={viewportRef} className="tpl-viewport" data-testid="template-viewport" onMouseDown={(event) => { if (event.target === event.currentTarget) onSelect(null); }}>
    <div className="tpl-canvas-frame" data-testid="template-canvas" data-logical-width={canvas.width} data-logical-height={canvas.height} style={{ width: canvas.width * zoom, height: canvas.height * zoom, background: canvasColor(elements) }}>
      <Stage width={canvas.width * zoom} height={canvas.height * zoom} scaleX={zoom} scaleY={zoom} onMouseDown={(event) => { if (event.target === event.target.getStage()) onSelect(null); }}>
        <Layer clipWidth={canvas.width} clipHeight={canvas.height}>
          {elements.map((element) => {
            const { box } = element, center = boxCenter(box), allowed = allows(element);
            const select = () => onSelect(element.id);
            return <Group key={element.id} id={element.id} name={`template-element template-element-${element.type}`}
              ref={(node) => { if (node) nodes.current.set(element.id, node); else nodes.current.delete(element.id); }}
              // A box turns about its centre, so the node's origin is the centre.
              x={center.x} y={center.y} offsetX={box.width / 2} offsetY={box.height / 2} rotation={box.rotation}
              draggable={allowed.move} onMouseDown={select} onTouchStart={select} onDragStart={select}
              onDragMove={(event) => {
                // Keep the box on the canvas while it is dragged (node positions are logical pixels at any zoom).
                const node = event.target;
                node.position({ x: Math.max(box.width / 2, Math.min(canvas.width - box.width / 2, node.x())), y: Math.max(box.height / 2, Math.min(canvas.height - box.height / 2, node.y())) });
              }}
              onDragEnd={(event) => {
                const node = event.target as KonvaGroup;
                place(node, onCommit(element.id, { x: node.x() - box.width / 2, y: node.y() - box.height / 2 }) ?? box);
              }}
              onTransformEnd={(event) => {
                const node = event.target as KonvaGroup;
                const width = Math.max(1, box.width * Math.abs(node.scaleX())), height = Math.max(1, box.height * Math.abs(node.scaleY()));
                const change: Partial<PixelBox> = {
                  ...(allowed.resize ? { x: node.x() - width / 2, y: node.y() - height / 2, width, height } : {}),
                  ...(allowed.rotate ? { rotation: node.rotation() } : {}),
                };
                place(node, onCommit(element.id, change) ?? box);
              }}>
              {/* The whole box is the element's hit area and the frame the selection handles follow. */}
              <Rect width={box.width} height={box.height} fill="transparent" />
              <ElementContent fontRevision={fontRevision} element={element} fit={fits.get(element.id)} />
            </Group>;
          })}
          <Transformer ref={transformerRef} name="template-transformer" resizeEnabled={permission.resize} rotateEnabled={permission.rotate} keepRatio={false} flipEnabled={false} rotationSnaps={[-90, 0, 90, 180]}
            anchorSize={9} anchorCornerRadius={2} anchorFill="#FFFFFF" anchorStroke={ACCENT} anchorStrokeWidth={1} borderStroke={ACCENT} borderStrokeWidth={1.5} borderDash={permission.move || permission.resize || permission.rotate ? undefined : [6, 4]}
            boundBoxFunc={(oldBox, nextBox) => Math.abs(nextBox.width) < MIN_ELEMENT_SCREEN_PX || Math.abs(nextBox.height) < MIN_ELEMENT_SCREEN_PX ? oldBox : nextBox} />
        </Layer>
      </Stage>
    </div>
  </div>;
}
