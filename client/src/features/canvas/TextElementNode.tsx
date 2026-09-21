import { useLayoutEffect, useRef } from 'react';
import type { Text as KonvaText } from 'konva/lib/shapes/Text';
import type { Transformer as KonvaTransformer } from 'konva/lib/shapes/Transformer';
import { Text, Transformer } from 'react-konva/lib/ReactKonvaCore';
import 'konva/lib/shapes/Text';
import 'konva/lib/shapes/Transformer';
import { clamp, recoverablePosition, TEXT_LIMITS, type CanvasSize, type TextElement } from '@frameflow/shared';
import { useAppDispatch } from '../../store';
import { textMoved, textWidthResized } from '../../store/editorSlice';
import { elementSelected } from '../../store/uiSlice';
import { textNodeStyle } from '../text/textGeometry';
import { focusCanvas } from '../text/useTextActions';

interface Props { element: TextElement; selected: boolean; canvas: CanvasSize; variantId: string; zoom: number }

export function TextElementNode({ element, selected, canvas, variantId, zoom }: Props) {
  const nodeRef = useRef<KonvaText>(null);
  const transformerRef = useRef<KonvaTransformer>(null);
  const dispatch = useAppDispatch();
  useLayoutEffect(() => {
    if (selected && nodeRef.current && transformerRef.current) {
      transformerRef.current.nodes([nodeRef.current]);
      transformerRef.current.forceUpdate();
    }
  }, [selected, element.width, element.text, element.fontFamily, element.fontSize, element.fontWeight, element.lineHeight]);

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
  return <>
    <Text ref={nodeRef} id={element.id} name="editable-text" {...textNodeStyle(element)} x={element.x} y={element.y}
      draggable onMouseDown={select} onTouchStart={select} onClick={select} onTap={select}
      onDragStart={select}
      onDragMove={(event) => keepRecoverable(event.target as KonvaText)}
      onDragEnd={(event) => {
        const node = event.target as KonvaText;
        keepRecoverable(node);
        // Node position is already in its parent's logical coordinate system, even at a scaled stage.
        dispatch(textMoved({ variantId, id: element.id, ...node.position(), timestamp: new Date().toISOString() }));
      }}
      onTransform={normalizeWidth}
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
