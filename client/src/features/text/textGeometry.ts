import { Text } from 'konva/lib/shapes/Text';
import { fontStack, isTextBox, recoverablePosition, textBlock, textBoxOf, type CanvasSize, type TextElement } from '@frameflow/shared';
import { fitTemplateText, templateTextProps } from '../templates/templateText';

export const textNodeStyle = (element: TextElement) => ({
  text: element.text, width: element.width, fontSize: element.fontSize,
  fontFamily: ['Inter', 'Lora'].includes(element.fontFamily) && !/[\u0900-\u097f]/u.test(element.text) ? element.fontFamily : fontStack(element.fontFamily), fontStyle: String(element.fontWeight),
  fill: element.fill, align: element.align, lineHeight: element.lineHeight,
  letterSpacing: element.letterSpacing, wrap: 'word' as const,
});

/**
 * How a text is drawn. Free text: its own style, as always. A fixed text box (a text with a height): by the shared
 * overflow policy, with the same functions Template Studio draws with, so it wraps inside its box, is drawn smaller
 * or is cut with an ellipsis for display only. The stored text and font size are never changed by this.
 * offsetY places the drawn lines inside the box (vertical alignment) along the text's own, possibly rotated, axis.
 */
export function textDisplay(element: TextElement) {
  const rotation = element.rotation ?? 0;
  if (!isTextBox(element)) return { props: textNodeStyle(element), rotation, offsetY: 0, box: undefined, truncated: false };
  const resolved = textBoxOf(element), fit = fitTemplateText(resolved), block = textBlock(resolved, fit);
  return {
    props: { ...templateTextProps(resolved, fit.fontPx), fill: element.fill, ...(fit.truncated ? { height: block.height + 0.5, ellipsis: true } : {}) },
    rotation, offsetY: -block.y, truncated: fit.truncated,
    // The filled box behind the text (a CTA's button), the size of the fixed box.
    box: element.box?.fill ? { width: element.width, height: element.height, fill: element.box.fill, cornerRadius: Math.min(element.box.radius, element.width / 2, element.height / 2) } : undefined,
  };
}

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
