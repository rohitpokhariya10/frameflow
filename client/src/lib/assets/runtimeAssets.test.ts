import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageResponse } from '@frameflow/shared';
import { abortable, assets, decodeImage, storeGeneratedImage } from './runtimeAssets';

const response: ImageResponse = {
  requestId: 'mock-request',
  // Synthetic decoder input only. Actual PNG decoding is verified in Chrome.
  image: { base64: btoa('mock-image-bytes'), mimeType: 'image/png', width: 400, height: 500 },
  generation: { mode: 'live', model: 'mocked-provider', requestedAspectRatio: '4:5', promptUsed: 'Artwork only' },
};
let decode: ReturnType<typeof vi.fn>;
let revoke: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  decode = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('window', { Image: class {
    src = '';
    naturalWidth = 400;
    naturalHeight = 500;
    decode = decode;
  } });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:runtime-only');
  revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('generated artwork runtime resource lifecycle', () => {
  it('exits a stalled browser operation on abort and removes its listener', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = abortable(new Promise<never>(() => {}), controller.signal);
    const assertion = expect(pending).rejects.toBe('timeout');
    controller.abort('timeout');
    await assertion;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('cleans a browser write that completes after cancellation', async () => {
    const controller = new AbortController();
    let finish!: () => void;
    const put = vi.spyOn(assets, 'putAsset').mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const remove = vi.spyOn(assets, 'deleteAsset').mockResolvedValue(undefined);
    const pending = storeGeneratedImage(response, 'late-artwork', controller.signal);
    const assertion = expect(pending).rejects.toBe('timeout');
    await vi.waitFor(() => expect(put).toHaveBeenCalledOnce());
    controller.abort('timeout'); finish();
    await assertion;
    expect(remove).toHaveBeenCalledExactlyOnceWith('late-artwork');
  });

  it('does not begin an image write when cancellation happened during decoding', async () => {
    const controller = new AbortController();
    decode.mockImplementation(async () => { controller.abort('cancelled'); });
    const put = vi.spyOn(assets, 'putAsset');
    await expect(storeGeneratedImage(response, 'cancelled-artwork', controller.signal)).rejects.toBe('cancelled');
    expect(put).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledOnce();
  });
  it('releases its temporary URL after successful decoding', async () => {
    const image = await decodeImage(new Blob(['image']));
    expect(image.naturalWidth).toBe(400);
    expect(decode).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:runtime-only');
  });

  it('releases its temporary URL and does not persist when decoding fails', async () => {
    decode.mockRejectedValue(new Error('invalid image'));
    const put = vi.spyOn(assets, 'putAsset');
    await expect(storeGeneratedImage(response, 'artwork')).rejects.toThrow('could not be decoded');
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:runtime-only');
    expect(put).not.toHaveBeenCalled();
  });

  it('rejects metadata dimensions that do not match the decoded image', async () => {
    const put = vi.spyOn(assets, 'putAsset');
    await expect(storeGeneratedImage({ ...response, image: { ...response.image, width: 401 } }, 'artwork')).rejects.toThrow('could not be decoded');
    expect(revoke).toHaveBeenCalledOnce();
    expect(put).not.toHaveBeenCalled();
  });

  it('persists only decoded bytes as a Blob under a stable asset ID', async () => {
    const put = vi.spyOn(assets, 'putAsset').mockResolvedValue(undefined);
    await storeGeneratedImage(response, 'stable-artwork');
    expect(put).toHaveBeenCalledOnce();
    const [id, blob] = put.mock.calls[0];
    expect(id).toBe('stable-artwork');
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('image/png');
    expect(await blob.text()).toBe('mock-image-bytes');
  });

  it('reports failed IndexedDB storage instead of resolving a preview-ready asset', async () => {
    vi.spyOn(assets, 'putAsset').mockRejectedValue(new Error('QuotaExceededError'));
    await expect(storeGeneratedImage(response, 'artwork')).rejects.toThrow('Free browser storage and try again. Your design is unchanged.');
    expect(revoke).toHaveBeenCalledOnce();
  });
});
