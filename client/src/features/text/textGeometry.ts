import { Text } from 'konva/lib/shapes/Text';
import { recoverablePosition, type CanvasSize, type TextElement } from '@frameflow/shared';

export const textNodeStyle = (element: TextElement) => ({
  text: element.text, width: element.width, fontSize: element.fontSize,
  fontFamily: element.fontFamily, fontStyle: String(element.fontWeight),
  fill: element.fill, align: element.align, lineHeight: element.lineHeight,
  letterSpacing: element.letterSpacing, wrap: 'word' as const,
});

/** Public Konva measurement, using the exact renderer configuration and loaded fonts. */
export function textHeight(element: TextElement) {
  const node = new Text(textNodeStyle(element));
  const height = node.height();
  node.destroy();
  return Math.max(height, element.fontSize * element.lineHeight);
}

export function boundTextPosition(element: TextElement, canvas: CanvasSize, position = { x: element.x, y: element.y }) {
  return recoverablePosition(position, { width: element.width, height: textHeight(element) }, canvas);
}
