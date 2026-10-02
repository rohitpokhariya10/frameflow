import { Text } from 'konva/lib/shapes/Text';
import { fontStack, fitText, textFitInput, type ResolvedElement, type ResolvedText, type TextFit } from '@frameflow/shared';

/** The Konva text configuration of a template text at a font size: the same for measuring and for drawing. */
export const templateTextProps = (element: ResolvedText, fontPx: number) => ({
  text: element.text, width: element.box.width, fontSize: fontPx, fontFamily: fontStack(element.fontFamily), fontStyle: String(element.fontWeight),
  align: element.align, lineHeight: element.lineHeight, letterSpacing: element.letterSpacing * fontPx, wrap: 'word' as const,
});

/** The overflow policy (shared textFit.ts) with real line counts: Konva wraps the text with the loaded fonts, as it will draw it. */
export function fitTemplateText(element: ResolvedText): TextFit {
  if (!element.text.trim()) return { fontPx: element.fontPx, lines: 0, visibleLines: 0, shrunk: false, truncated: false };
  const node = new Text(templateTextProps(element, element.fontPx));
  try {
    return fitText(textFitInput(element), (fontPx) => {
      node.setAttrs({ fontSize: fontPx, letterSpacing: element.letterSpacing * fontPx });
      return Math.max(1, Math.round(node.height() / (fontPx * element.lineHeight)));
    });
  } finally { node.destroy(); }
}
/** The fit of every text element, by element id. */
export function fitTemplateTexts(elements: readonly ResolvedElement[]): Map<string, TextFit> {
  return new Map(elements.filter((element): element is ResolvedText => element.type === 'text').map(element => [element.id, fitTemplateText(element)]));
}
