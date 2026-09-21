import { Text } from 'konva/lib/shapes/Text';
import { TEXT_FONTS, type TextElement } from '@frameflow/shared';
import { textNodeStyle } from '../../features/text/textGeometry';
import type { TextMeasurement } from './autoLayout';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Natural, unclipped Konva line boxes. No stage, fixed height, ellipsis, or private arrays. */
export function measureText(element: TextElement): TextMeasurement {
  const node = new Text(textNodeStyle(element));
  try {
    // Konva can omit a paragraph suffix when even one grapheme cannot fit.
    // Reject that case using public glyph metrics, rather than treating zero/partial height as success.
    const unique = new Set(Array.from(graphemes.segment(element.text), (part) => part.segment));
    const complete = [...unique].every((glyph) => glyph === '\n' || glyph === '\r\n'
      || node.measureSize(glyph).width + element.letterSpacing <= element.width);
    const height = node.height();
    return { width: Math.max(node.width(), node.getTextWidth()), height,
      lines: Math.round(height / (element.fontSize * element.lineHeight)), complete };
  } finally { node.destroy(); }
}

export async function ensureTextFont(element: TextElement) {
  if (!TEXT_FONTS.includes(element.fontFamily as typeof TEXT_FONTS[number])) throw new Error('Unsupported editor font.');
  const font = `${element.fontWeight} ${element.fontSize}px "${element.fontFamily}"`;
  const faces = await document.fonts.load(font);
  if (!faces.length || !document.fonts.check(font)) throw new Error('The selected font is not ready.');
}
