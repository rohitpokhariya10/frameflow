import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import opentype from "opentype.js";
const { parse } = opentype;
import { describe, expect, it } from "vitest";
import { FONT_CATALOG } from "./fonts/catalog.js";

import { BUNDLED_DIR as DIR } from "./fonts/library.js";

describe("font catalogue", () => {
  it("has unique families with descriptions and uses", () => {
    const names = FONT_CATALOG.map((f) => f.family.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    for (const f of FONT_CATALOG) {
      expect(f.description.length, f.family).toBeGreaterThan(20);
      expect(f.bestFor.length, f.family).toBeGreaterThan(0);
    }
  });

  it("every face exists, ships its licence, and renders with our text engine", () => {
    for (const f of FONT_CATALOG) {
      for (const [, file] of f.faces) {
        const abs = path.join(DIR, file);
        expect(existsSync(abs), file).toBe(true);
        expect(existsSync(path.join(path.dirname(abs), "OFL.txt")), `${file} licence`).toBe(true);
        const buf = readFileSync(abs);
        const font = parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        expect(font.getPath("Instant CASHBACK 1,999", 0, 0, 72).commands.length, file).toBeGreaterThan(0);
      }
    }
  });
});

describe("glyph path output", () => {
  it("never emits NaN (opentype.js 2.0 toPathData does for some positions)", async () => {
    const { pathData } = await import("./compose/text.js");
    const buf = readFileSync(path.join(DIR, "poppins/Poppins-Bold.ttf"));
    const font = parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const p = font.getPath("INSTANT CASHBACK Ab UPI par bhi", 300, 58, 40);
    expect(p.toPathData(2)).toContain("NaN"); // the upstream bug this guards against
    const d = pathData(p.commands);
    expect(d).not.toContain("NaN");
    expect(d.match(/M/g)!.length).toBe(p.commands.filter((c) => c.type === "M").length);
  });
});
