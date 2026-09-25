import { createFalClient } from '@fal-ai/client';
import { describe, expect, it, vi } from 'vitest';
import { assertTrustedUrl, consumeBounded, createBoundedSdkFetch, isPublicAddress, resolveTrustedUrl } from './network.js';
import { ProviderError } from './adapters.js';

describe('bounded provider networking', () => {
  it('rejects private, metadata, mapped, documentation and deceptive hosts', async () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '172.16.1.1', '192.168.0.2', '169.254.169.254', '100.64.0.1', '0.0.0.0', '192.0.2.3', '::1', '::ffff:8.8.8.8', 'fc00::1', 'fe80::1', '2001:db8::1']) expect(isPublicAddress(address)).toBe(false);
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
    for (const url of ['http://v3b.fal.media/image.png', 'https://v3b.fal.media.evil.test/image.png', 'https://evil.test/image.png', 'https://127.0.0.1/image.png', 'https://user:secret@v3b.fal.media/image.png', 'https://v3b.fal.media:444/image.png']) expect(() => assertTrustedUrl(url, ['*.fal.media'])).toThrow();
    await expect(resolveTrustedUrl('https://v3b.fal.media/image.png', ['*.fal.media'], async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }])).rejects.toThrow(/non-public/);
    const resolved = await resolveTrustedUrl('https://v3b.fal.media/image.png', ['*.fal.media'], async () => [{ address: '8.8.8.8', family: 4 }]);
    expect(resolved.address).toEqual({ address: '8.8.8.8', family: 4 });
  });

  it('bounds streaming before full buffering and catches short bodies', async () => {
    let consumed = 0;
    async function* chunks() { for (let i = 0; i < 10; i++) { consumed++; yield Buffer.alloc(10); } }
    await expect(consumeBounded(chunks(), 25)).rejects.toThrow(/limit/);
    expect(consumed).toBe(3);
    await expect(consumeBounded(chunks(), 50, '100')).rejects.toThrow(/limit/);
    await expect(consumeBounded(chunks(), 200, '120')).rejects.toThrow(/incomplete/);
  });

  it('prevents SDK internal hidden submission retries even on 500 and network failures', async () => {
    for (const failure of [new Response('{}', { status: 500 }), new Error('raw connection secret-bearing URL')]) {
      const request = vi.fn(async () => { if (failure instanceof Error) throw failure; return failure; });
      const client = createFalClient({ credentials: 'offline-test-placeholder', fetch: createBoundedSdkFetch({}, request), retry: { maxRetries: 0 } });
      await expect(client.queue.submit('fal-ai/qwen-image-layered', { input: { image_url: 'https://v3b.fal.media/test.png' } })).rejects.toBeInstanceOf(ProviderError);
      expect(request).toHaveBeenCalledTimes(1);
    }
  });
});
