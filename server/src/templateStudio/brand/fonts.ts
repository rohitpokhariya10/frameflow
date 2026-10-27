
/**
 * Minimal reader for TrueType/OpenType font files: verifies the sfnt header and
 * table directory, and reads the family name, weight, and italic flag. Only
 * single-font TTF/OTF is accepted because the server-side text renderer needs
 * them; WOFF/WOFF2 and collections are rejected with a clear message.
 */

export const MAX_FONT_BYTES = 15 * 1024 * 1024;

export class FontRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FontRejectedError";
  }
}

export interface FontInfo {
  format: "ttf" | "otf";
  family: string;
  subfamily: string | null;
  weight: number;
  style: "normal" | "italic";
}

export function readFontInfo(buf: Buffer): FontInfo {
  if (buf.length < 12) throw new FontRejectedError("The file is too small to be a font.");
  if (buf.length > MAX_FONT_BYTES) throw new FontRejectedError("Font files must be under 15 MB.");

  const tag = buf.toString("latin1", 0, 4);
  const version = buf.readUInt32BE(0);
  let format: FontInfo["format"];
  if (version === 0x00010000 || tag === "true") format = "ttf";
  else if (tag === "OTTO") format = "otf";
  else if (tag === "wOFF" || tag === "wOF2") {
    throw new FontRejectedError("WOFF/WOFF2 web fonts aren't supported for poster export. Upload the TTF or OTF version.");
  } else if (tag === "ttcf") {
    throw new FontRejectedError("Font collections (.ttc) aren't supported. Upload the individual TTF or OTF file.");
  } else {
    throw new FontRejectedError("This file is not a TrueType or OpenType font.");
  }

  const numTables = buf.readUInt16BE(4);
  if (numTables === 0 || numTables > 200 || 12 + numTables * 16 > buf.length) {
    throw new FontRejectedError("The font's table directory is invalid.");
  }
  const tables = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const offset = buf.readUInt32BE(rec + 8);
    const length = buf.readUInt32BE(rec + 12);
    if (offset + length > buf.length) throw new FontRejectedError("The font file is truncated or corrupt.");
    tables.set(buf.toString("latin1", rec, rec + 4), { offset, length });
  }

  const names = readNames(buf, tables.get("name"));
  const family = (names.get(16) ?? names.get(1))?.trim();
  if (!family) throw new FontRejectedError("The font has no family name.");
  const subfamily = (names.get(17) ?? names.get(2))?.trim() ?? null;

  let weight = 400;
  let italic = /italic|oblique/i.test(subfamily ?? "");
  const os2 = tables.get("OS/2");
  if (os2 && os2.length >= 64) {
    const w = buf.readUInt16BE(os2.offset + 4);
    if (w >= 1 && w <= 1000) weight = w;
    const fsSelection = buf.readUInt16BE(os2.offset + 62);
    italic = italic || (fsSelection & 0x1) === 1;
  }

  return { format, family: family.slice(0, 80), subfamily: subfamily?.slice(0, 80) ?? null, weight, style: italic ? "italic" : "normal" };
}

function readNames(buf: Buffer, table: { offset: number; length: number } | undefined): Map<number, string> {
  const out = new Map<number, string>();
  if (!table || table.length < 6) return out;
  const base = table.offset;
  const count = buf.readUInt16BE(base + 2);
  const strings = base + buf.readUInt16BE(base + 4);
  for (let i = 0; i < count; i++) {
    const rec = base + 6 + i * 12;
    if (rec + 12 > base + table.length) break;
    const platform = buf.readUInt16BE(rec);
    const encoding = buf.readUInt16BE(rec + 2);
    const language = buf.readUInt16BE(rec + 4);
    const nameId = buf.readUInt16BE(rec + 6);
    const length = buf.readUInt16BE(rec + 8);
    const offset = strings + buf.readUInt16BE(rec + 10);
    if (![1, 2, 16, 17].includes(nameId) || offset + length > buf.length) continue;

    let value: string | null = null;
    if (platform === 3 && (encoding === 1 || encoding === 10) && length % 2 === 0 && (language === 0x409 || !out.has(nameId))) {
      // UTF-16BE; decode a copy so the caller's buffer is never mutated.
      value = Buffer.from(buf.subarray(offset, offset + length)).swap16().toString("utf16le");
    } else if (platform === 1 && encoding === 0 && !out.has(nameId)) {
      value = buf.toString("latin1", offset, offset + length);
    }
    if (value) out.set(nameId, value.replace(/\0/g, ""));
  }
  return out;
}
