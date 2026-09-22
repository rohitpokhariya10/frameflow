import { afterEach, expect, it, vi } from 'vitest';
import { createDocument } from '../../store/editorSlice';
import { downloadPng, exportFilename, exportPng } from './exportPng';
vi.mock('../text/fonts', () => ({ loadEditorFonts: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each([
  [1080, 1350, 'poster'], [1600, 900, 'landscape'], [1080, 1080, 'square'],
  [1080, 1920, 'story'], [1000, 1000, 'custom'], [4096, 256, 'custom'], [256, 4096, 'custom'],
])('names a %i × %i export without user text or IDs', (width, height, format) => {
  expect(exportFilename({ width, height })).toBe(`frameflow-${format}-${width}x${height}.png`);
});
it('rejects invalid dimensions before allocating or loading resources', async () => {
  const variant = createDocument('test', '2026-09-22T00:00:00.000Z').variants[0];
  variant.canvas.width = 4097;
  await expect(exportPng(variant)).rejects.toThrow('valid size');
});
for (const fails of [false, true]) it(`cleans the anchor and download URL when click ${fails ? 'fails' : 'succeeds'}`, () => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { setTimeout });
  const anchor = { href: '', download: '', click: vi.fn(() => { if (fails) throw new Error('blocked'); }), remove: vi.fn() };
  vi.stubGlobal('document', { createElement: () => anchor, body: { append: vi.fn() } });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:export');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  const start = () => downloadPng(new Blob(['png'], { type: 'image/png' }), 'frameflow-poster-1080x1350.png');
  if (fails) expect(start).toThrow('Allow downloads'); else start();
  expect(anchor.remove).toHaveBeenCalledOnce(); expect(revoke).not.toHaveBeenCalled();
  vi.runAllTimers(); expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:export');
});
