import { useFonts } from '../fonts/useFonts';
import { useLayoutEffect, useMemo, useRef } from 'react';
import type { Rect as KonvaRect } from 'konva/lib/shapes/Rect';
import type { Text as KonvaText } from 'konva/lib/shapes/Text';
import type { Transformer as KonvaTransformer } from 'konva/lib/shapes/Transformer';
import { Rect, Text, Transformer } from 'react-konva/lib/ReactKonvaCore';
import 'konva/lib/shapes/Rect';
import 'konva/lib/shapes/Text';
import 'konva/lib/shapes/Transformer';
import { clamp, recoverablePosition, TEXT_LIMITS, type CanvasSize, type TextElement } from '@frameflow/shared';
import { useAppDispatch } from '../../store';
import { textMoved, textWidthResized } from '../../store/editorSlice';
import { elementSelected } from '../../store/uiSlice';
import { textDisplay } from '../text/textGeometry';
import { focusCanvas } from '../text/useTextActions';

/** A text drawn without interaction (previews, comparisons), by the same display rules as the editable node. */
export function StaticText({ element, name }: { element: TextElement; name: string }) {
  const fonts = useFonts([{ family: element.fontFamily, weight: element.fontWeight, text: element.text }]);
  const display = useMemo(() => { void fonts.revision; return textDisplay(element); }, [element, fonts.revision]);
  if (element.visible === false) return null;
  return <>
    {display.box && <Rect x={element.x} y={element.y} rotation={display.rotation} {...display.box} listening={false} />}
    <Text key={fonts.revision} name={name} {...display.props} x={element.x} y={element.y} rotation={display.rotation} offsetY={display.offsetY} listening={false} />
  </>;
}

/** raiseHandles: keep the selection handles above later elements, for designs that interleave text and layers. */
interface Props { element: TextElement; selected: boolean; canvas: CanvasSize; variantId: string; zoom: number; raiseHandles?: boolean }

export function TextElementNode({ element, selected, canvas, variantId, zoom, raiseHandles = false }: Props) {
  const nodeRef = useRef<KonvaText>(null);
  const boxRef = useRef<KonvaRect>(null);
  const transformerRef = useRef<KonvaTransformer>(null);
  const dispatch = useAppDispatch();
  // Free text: its own style. A fixed text box: wrapped, shrunk or cut for display by the shared overflow policy.
  const fonts = useFonts([{ family: element.fontFamily, weight: element.fontWeight, text: element.text }]);
  const display = useMemo(() => { void fonts.revision; return textDisplay(element); }, [element, fonts.revision]);
  useLayoutEffect(() => {
    if (selected && nodeRef.current && transformerRef.current) {
      transformerRef.current.nodes([nodeRef.current]);
      if (raiseHandles) transformerRef.current.moveToTop();
      transformerRef.current.forceUpdate();
    }
  }, [selected, display, raiseHandles]);
  if (element.visible === false) return null;

  const select = () => { dispatch(elementSelected(element.id)); focusCanvas(); };
  function keepRecoverable(node: KonvaText) {
    node.position(recoverablePosition(node.position(), { width: node.width(), height: node.height() }, canvas));
  }
  function normalizeWidth() {
    const node = nodeRef.current;
    if (!node) return;
    node.width(clamp(node.width() * node.scaleX(), TEXT_LIMITS.minWidth, TEXT_LIMITS.maxWidth));
    node.scale({ x: 1, y: 1 });
  }
  /** The filled box behind the text follows it while it is dragged or resized. */
  const followBox = (node: KonvaText) => { boxRef.current?.setAttrs({ x: node.x(), y: node.y(), width: node.width() }); };
  return <>
    {display.box && <Rect ref={boxRef} name="text-box" x={element.x} y={element.y} rotation={display.rotation} {...display.box} listening={false} />}
    <Text key={fonts.revision} ref={nodeRef} id={element.id} name="editable-text" {...display.props} x={element.x} y={element.y} rotation={display.rotation} offsetY={display.offsetY}
      draggable onMouseDown={select} onTouchStart={select} onClick={select} onTap={select}
      onDragStart={select}
      onDragMove={(event) => { keepRecoverable(event.target as KonvaText); followBox(event.target as KonvaText); }}
      onDragEnd={(event) => {
        const node = event.target as KonvaText;
        keepRecoverable(node);
        // Node position is already in its parent's logical coordinate system, even at a scaled stage.
        dispatch(textMoved({ variantId, id: element.id, ...node.position(), timestamp: new Date().toISOString() }));
      }}
      onTransform={() => { normalizeWidth(); if (nodeRef.current) followBox(nodeRef.current); }}
      onTransformEnd={() => {
        const node = nodeRef.current;
        if (!node) return;
        normalizeWidth();
        keepRecoverable(node);
        dispatch(textWidthResized({ variantId, id: element.id, ...node.position(), width: node.width(), timestamp: new Date().toISOString() }));
      }}
      onMouseEnter={(event) => { const stage = event.target.getStage(); if (stage) stage.container().style.cursor = 'move'; }}
      onMouseLeave={(event) => { const stage = event.target.getStage(); if (stage) stage.container().style.cursor = ''; }}
    />
    {selected && <Transformer ref={transformerRef} name="text-transformer"
      enabledAnchors={['middle-left', 'middle-right']} rotateEnabled={false} flipEnabled={false} keepRatio={false}
      anchorSize={8} anchorCornerRadius={2} anchorFill="#FFFFFF" anchorStroke="#285443" anchorStrokeWidth={1}
      borderStroke="#285443" borderStrokeWidth={1} padding={3}
      boundBoxFunc={(oldBox, nextBox) => nextBox.width < TEXT_LIMITS.minWidth * zoom || nextBox.width > TEXT_LIMITS.maxWidth * zoom ? oldBox : nextBox}
    />}
  </>;
}
