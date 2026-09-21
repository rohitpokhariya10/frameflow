import { deflateSync } from 'node:zlib';
import type { GenerateRequest } from '@frameflow/shared';

/** Deterministic test artwork constructed locally; never a Gemini response or stored base64 fixture. */
export function mockPng(width = 4, height = 5): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const content = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of content) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, content, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((1 + width * 3) * height, 230);
  for (let row = 0; row < height; row++) pixels[row * (1 + width * 3)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

export const mockRequest: GenerateRequest = {
  prompt: 'Ivory florals and warm gold accents', target: { width: 1080, height: 1350 },
  styleBrief: { theme: 'Elegant wedding', palette: ['ivory', 'gold'], motifs: ['florals'], mood: 'refined' },
  quietRegion: { x: 0.15, y: 0.25, width: 0.7, height: 0.55 },
};
