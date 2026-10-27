/**
 * The live product analyzer's request and its failures, free (fake clients, no network):
 *
 * - a full-size upload (the LG creative at 4096 px, as uploaded in the dev server on 2026-10-22, where the whole 9.4 MB
 *   PNG was sent and the request timed out at exactly 120 s) is sent to the model at most 2048 px on its longest side;
 *   the RECORDED real answer, given for that picture, comes back in the creative's own pixels;
 * - a timeout is reported as a timeout (the SDK's timeout error is a plain "Error" by name: it was reported as
 *   PROVIDER_ERROR), and connection errors, an account without credit and a refused key each in their own words, with
 *   what was sent and how long it waited saved for a look; a key in a provider message never reaches a file.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { decodeRgba } from '../../server/src/decomposition/protectedTemplates/pixels.js';
import { liveProductAnalyzer, PRODUCT_ANALYSIS_MAX_SIDE, PRODUCT_ANALYSIS_TIMEOUT_MS, ProductAnalysisError, replayProductAnalyzer } from '../../server/src/decomposition/protectedTemplates/product/analyzer.js';
import { detectProduct } from '../../server/src/decomposition/protectedTemplates/product/detect.js';
import { findSheetCreatives } from '../../server/src/decomposition/protectedTemplates/product/sheet.js';
import { failingResponsesClient, recordedResponsesClient } from '../../server/src/decomposition/protectedTemplates/product/responsesClient.fixture.js';
import { fakeRecognizer } from '../../server/src/textRecognition/recognizer.js';
import { HAS_PRIVATE_FIXTURES } from './privateFixtures.js';

const RECORDED = 'tests/fixtures/recorded/ganesh-lg-gpt-5.6-sol-2026-10-22';
const crop = async () => { const sheet = readFileSync('Ganesh-Chaturthi.png'), c = findSheetCreatives(await decodeRgba(sheet)).boxes[0]; return sharp(sheet).extract({ left: c.x, top: c.y, width: c.width, height: c.height }).png({ compressionLevel: 9 }).toBuffer(); };
const detect = async (png: Buffer, analyzer: ReturnType<typeof liveProductAnalyzer>, saved: Map<string, object>) => detectProduct({ template: { id: 'pt-test', source: { sha256: 'test' } } as never, source: await decodeRgba(png), png,
  recognizer: fakeRecognizer([]), analyzer, store: () => undefined, save: (f, v) => saved.set(f, v), at: '2026-10-22T00:00:00.000Z' });

describe.skipIf(!HAS_PRIVATE_FIXTURES)('the live product analyzer: what it sends and how it fails', { timeout: 180_000 }, () => {
  it('sends a 4096 px upload at 2048 px, and reads the recorded real answer back in the creative’s own pixels', async () => {
    const small = await crop(), big = await sharp(small).resize(4096, null, { kernel: 'lanczos3' }).png().toBuffer(), size = await sharp(big).metadata();
    expect([size.width, size.height]).toEqual([4096, 4089]);
    const response = JSON.parse(readFileSync(`${RECORDED}.response.json`, 'utf8')), client = recordedResponsesClient(response, { width: 607, height: 606 });
    const saved = new Map<string, object>(), r = await detect(big, liveProductAnalyzer({ client }), saved);
    // Sent once, at most 2048 px, under 4 MB; the request says the sent picture's size.
    expect(client.calls).toHaveLength(1);
    expect(Math.max(client.calls[0].width, client.calls[0].height)).toBe(PRODUCT_ANALYSIS_MAX_SIDE);
    expect(client.calls[0].bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(client.calls[0].text).toBe(`Source size: ${client.calls[0].width} × ${client.calls[0].height} pixels.`);
    expect(saved.get('product.request.json')).toMatchObject({ timeoutMs: PRODUCT_ANALYSIS_TIMEOUT_MS, input: { width: 2048, source: { width: 4096, height: 4089 } } });
    // The whole detection, as with the small creative: Ganesha, 12 products (the TV's soundbar, subwoofer and two satellite
    // speakers are advertised one by one: each its own), 42 words.
    expect(r.ai).toMatchObject({ status: 'done', model: 'gpt-5.6-sol' });
    expect(r.objects.filter(o => o.kind === 'character')).toHaveLength(1);
    expect(r.objects.filter(o => o.kind === 'product')).toHaveLength(12);
    expect(r.analysis.words).toHaveLength(42);
    // A word's box in the creative's pixels: where the same word is in the small creative, scaled by 4096 / 607.
    const replayed = await detectProduct({ template: { id: 'pt-test', source: { sha256: 'test' } } as never, source: await decodeRgba(small), png: small, recognizer: fakeRecognizer([]),
      analyzer: replayProductAnalyzer({ response, model: 'gpt-5.6-sol', imageSha256: createHash('sha256').update(small).digest('hex') }), store: () => undefined, save: () => undefined, at: '2026-10-22T00:00:00.000Z' });
    for (const text of ['grand', 'Bappa', '₹26,000']) {
      const a = replayed.analysis.words.find(w => w.text === text)!, b = r.analysis.words.find(w => w.text === text)!, k = 4096 / 607;
      expect(Math.abs(b.box.x - a.box.x * k), text).toBeLessThan(8); expect(Math.abs(b.box.y - a.box.y * k), text).toBeLessThan(8);
      expect(Math.abs(b.box.width - a.box.width * k), text).toBeLessThan(12);
    }
  });

  it('a small creative is sent as it is (the recorded replay reads the same answer as before)', async () => {
    const small = await crop(), response = JSON.parse(readFileSync(`${RECORDED}.response.json`, 'utf8')), client = recordedResponsesClient(response, { width: 607, height: 606 });
    const r = await detect(small, liveProductAnalyzer({ client }), new Map());
    expect([client.calls[0].width, client.calls[0].height, client.calls[0].mime]).toEqual([607, 606, 'image/png']);
    expect(r.analysis.words).toHaveLength(42);
  });

  for (const [kind, code, words] of [
    ['timeout', 'TIMEOUT', /timed out: OpenAI sent no answer within 300 s.*may still have processed \(and billed\) it/],
    ['connection', 'CONNECTION', /could not reach OpenAI \(connection error: ECONNRESET\)/],
    ['no-credit', 'NO_CREDIT', /no credit left \(HTTP 429, insufficient_quota\)/],
    ['bad-key', 'AUTHORIZATION', /refused the API key \(HTTP 401\)/],
  ] as const) it(`reports ${kind} as ${code}, in plain words, with what was sent and how long it waited`, async () => {
    const big = await sharp(await crop()).resize(4096, null).png().toBuffer(), saved = new Map<string, object>(), client = failingResponsesClient(kind);
    const error = await liveProductAnalyzer({ client }).analyze(big, 'image/png', (f, v) => saved.set(f, v)).catch(e => e);
    expect(error).toBeInstanceOf(ProductAnalysisError);
    expect(error.code).toBe(code);
    expect(error.message).toMatch(words);
    expect(error.message).toContain('No automatic retry was made.');
    expect(error.details.sent).toMatchObject({ width: 2048, source: { width: 4096, height: 4089 } });
    const record = saved.get('product.error.json') as Record<string, unknown>;
    expect(record).toMatchObject({ code, model: 'gpt-5.6-sol', retried: false, timeoutMs: PRODUCT_ANALYSIS_TIMEOUT_MS, sent: { width: 2048 } });
    expect(record.elapsedMs).toEqual(expect.any(Number));
    expect(record.errorClass).toMatch(/^API|Error$/);
    expect(JSON.stringify(record)).not.toMatch(/sk-test1234567890/);
    // Through detection: failed, its cause kept for the review screen; the local reading is no AI detection.
    const r = await detect(big, liveProductAnalyzer({ client: failingResponsesClient(kind) }), new Map());
    expect(r.ai).toMatchObject({ status: 'failed', code, sent: { width: 2048, source: { width: 4096 } } });
    expect(r.objects.filter(o => o.kind === 'character' || o.kind === 'product')).toHaveLength(0);
  });
});
