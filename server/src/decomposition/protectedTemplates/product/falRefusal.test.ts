import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../providers/adapters.js';
import type { FalTransport } from '../../providers/falClient.js';
import { AiDecompositionError, createProductLayerizer, standInProductLayerizer, type DecompositionRequest } from './aiDecompose.js';

// fal is contacted first, and for free (the picture's upload): a refused key or account, or no key, stops the AI
// decomposition before the OpenAI planner is paid for, and says what fal said and what to change. Fakes only: no network.
const request = async (): Promise<DecompositionRequest> => ({
  image: await sharp({ create: { width: 512, height: 512, channels: 3, background: '#bdf0dc' } }).composite([{ input: await sharp({ create: { width: 160, height: 200, channels: 3, background: '#c9922e' } }).png().toBuffer(), left: 170, top: 150 }]).png().toBuffer(),
  width: 512, height: 512, elements: [{ id: 'e1', kind: 'product', label: 'Box', box: { x: 170, y: 150, width: 160, height: 200 }, decompose: true }], excluded: { textBlocks: 0, words: 0, logos: [] },
});
function providers(refusal?: ProviderError) {
  const order: string[] = [], saved = new Map<string, unknown>(), blobs = new Map<string, Buffer>();
  let answer: Awaited<ReturnType<ReturnType<typeof standInProductLayerizer>['decompose']>> | undefined;
  const transport: FalTransport = {
    async upload(bytes) { order.push('upload'); if (refusal) throw refusal; blobs.set('https://fixture.invalid/input', bytes); return 'https://fixture.invalid/input'; },
    async submit(_endpoint, input) { order.push(`submit ${String((input as { image_url?: string }).image_url)}`); return { requestId: 'fixture-seedream-1' }; },
    async status() { return 'COMPLETED'; },
    async result() { return { layers: answer!.layers.map((l, i) => { const url = `https://fixture.invalid/layer-${i}`; blobs.set(url, l.png); return { image: { url }, z_index: l.zIndex, name: l.name }; }) }; },
    async download(url) { const bytes = blobs.get(url); if (!bytes) throw new Error('Unknown fixture URL'); return bytes; },
    async cancel() { throw new Error('Unexpected cancellation'); },
  };
  const planner = { model: 'test planner (no network or charges)', offline: false, async plan(r: DecompositionRequest, save: (file: string, value: object) => void) {
    order.push('plan'); answer = await standInProductLayerizer().decompose(r, save); return { plan: answer.plan, responseId: 'fixture-plan-1' };
  } };
  return { order, saved, save: (file: string, value: object) => { saved.set(file, value); }, planner, transport };
}
/** The failure a promise must end in (a success fails the test). */
const failure = (promise: Promise<unknown>) => promise.then(() => { throw new Error('expected the decomposition to fail'); }, (error: unknown) => error as AiDecompositionError);
const refused = (status: number, msg: string) => Object.assign(new ProviderError('PROVIDER_AUTH', 'The fal key or account does not permit this request.', false, status), { providerDetail: { status, messages: [{ msg }] } });

describe('fal refusals in the AI decomposition', () => {
  it('stops at the free upload when the fal account is locked: no planner, no submission, fal\'s words and the fix', async () => {
    const p = providers(refused(403, 'User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing.'));
    const layerizer = createProductLayerizer({ planner: p.planner, transport: () => p.transport });
    const error = await failure(layerizer.decompose(await request(), p.save));
    expect(error).toBeInstanceOf(AiDecompositionError);
    expect(error.code).toBe('FAL_UPLOAD_FAILED');
    expect(error.message).toMatch(/fal said: “User is locked\. Reason: Exhausted balance/);
    expect(error.message).toMatch(/top up at fal\.ai\/dashboard\/billing/);
    expect(error.message).toMatch(/Nothing was sent to OpenAI or Seedream, and nothing was charged/);
    expect(p.order).toEqual(['upload']);
    expect(p.saved.get('seedream-upload-error.json')).toMatchObject({ code: 'PROVIDER_AUTH', status: 403, detail: { messages: [{ msg: expect.stringMatching(/Exhausted balance/) }] } });
  });

  it('says to replace the key when fal does not know it', async () => {
    const p = providers(refused(401, 'Invalid Key Authorization header format.'));
    const error = await failure(createProductLayerizer({ planner: p.planner, transport: () => p.transport }).decompose(await request(), p.save));
    expect(error.message).toMatch(/FAL_KEY is not a valid, active fal key/);
    expect(p.order).toEqual(['upload']);
  });

  it('stops before the planner without a fal key', async () => {
    const p = providers();
    const error = await failure(createProductLayerizer({ planner: p.planner, transport: () => { throw new ProviderError('PROVIDER_NOT_CONFIGURED', 'Set FAL_KEY in the server environment before running inference.'); } }).decompose(await request(), p.save));
    expect(error.code).toBe('FAL_NOT_CONFIGURED');
    expect(p.order).toEqual([]);
  });

  it('uploads first, then plans, then submits that upload once', async () => {
    const p = providers();
    const result = await createProductLayerizer({ planner: p.planner, transport: () => p.transport, pollIntervalMs: 0 }).decompose(await request(), p.save);
    expect(p.order).toEqual(['upload', 'plan', 'submit https://fixture.invalid/input']);
    expect(result.layers.length).toBeGreaterThan(0);
    expect(result.seedream.requestId).toBe('fixture-seedream-1');
  });
});
