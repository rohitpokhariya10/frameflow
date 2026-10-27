// Minimal types for the parts of opentype.js 2.x this app uses.
declare module "opentype.js" {
  export interface PathCommand {
    type: string;
    x?: number;
    y?: number;
    x1?: number;
    y1?: number;
    x2?: number;
    y2?: number;
  }
  export class Path {
    commands: PathCommand[];
    /** Avoid: 2.0.0 emits "NaN" for some coordinates; use pathData() in compose/text.ts. */
    toPathData(decimalPlaces?: number): string;
  }
  export interface Glyph {
    index: number;
    advanceWidth?: number;
  }
  export interface RenderOptions {
    kerning?: boolean;
    letterSpacing?: number;
    features?: Record<string, boolean>;
  }
  export class Font {
    unitsPerEm: number;
    charToGlyphIndex(char: string): number;
    ascender: number;
    descender: number;
    charToGlyph(char: string): Glyph;
    getAdvanceWidth(text: string, fontSize: number, options?: RenderOptions): number;
    getPath(text: string, x: number, y: number, fontSize: number, options?: RenderOptions): Path;
  }
  export function parse(buffer: ArrayBuffer): Font;
  const opentype: { parse: typeof parse };
  export default opentype;
}
