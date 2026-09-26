import { createHash } from 'node:crypto';
import { createFalClient } from '@fal-ai/client';
import sharp from 'sharp';
import { endpointRegistry, normalizeProviderOutput, ProviderError } from './adapters.js';
import type { Model, NormalizedProviderOutput, ProviderInput } from './adapters.js';
import { createBoundedSdkFetch, downloadProviderImage } from './network.js';
import type { NetworkPolicy } from './network.js';

export type ProviderRequestRecord = {
  id: string; jobId: string; stepId: string; endpoint: string; inputHash: string; adapterVersion: string;
  status: 'SUBMITTING' | 'SUBMISSION_UNKNOWN' | 'QUEUED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  providerRequestId?: string; seed?: number; sentSeed?: number; returnedSeed?: number; output?: unknown; nextPollAt: number; attempts: number;
  createdAt: number; updatedAt: number; diagnostic?: string;
};
export type ProviderRepository = {
  getProviderRequest(stepId: string, inputHash: string): ProviderRequestRecord | undefined;
  reserveProviderRequest(input: { jobId: string; stepId: string; endpoint: string; inputHash: string; adapterVersion: string; seed?: number; sentSeed?: number }, maxGlobalCalls: number, maxConcurrent: number): ProviderRequestRecord;
  updateProviderRequest(id: string, patch: Partial<ProviderRequestRecord>): unknown;
};
export type FalTransport = {
  submit(endpoint: string, input: ProviderInput): Promise<{ requestId: string }>;
  status(endpoint: string, requestId: string): Promise<'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED'>;
  result(endpoint: string, requestId: string): Promise<unknown>;
  cancel(endpoint: string, requestId: string): Promise<void>;
  upload(bytes: Buffer, mime?: string): Promise<string>;
  download(url: string): Promise<Buffer>;
};

function validateRequestId(id: unknown): string {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new ProviderError('PROVIDER_SCHEMA_CHANGED', 'The provider returned an invalid request identifier.');
  return id;
}

function semaphore(maximum: number) {
  let active = 0;
  const waiters: (() => void)[] = [];
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    if (active >= maximum) await new Promise<void>(resolve => waiters.push(resolve));
    else active += 1;
    try { return await operation(); }
    finally { const next = waiters.shift(); if (next) next(); else active -= 1; }
  };
}

/** One server-side credential. SDK network calls use bounded, DNS-pinned HTTPS with automatic submission retries disabled. */
export function createFalTransport(key: string, policy: NetworkPolicy = {}): FalTransport {
  if (!key.trim()) throw new ProviderError('PROVIDER_NOT_CONFIGURED', 'Set FAL_KEY in the server environment before running inference.');
  const client = createFalClient({ credentials: key, fetch: createBoundedSdkFetch(policy), retry: { maxRetries: 0 } });
  const downloadSlot = semaphore(2);
  const uploadSlot = semaphore(2);
  // Explicit public access is needed by the hosted model input fetchers. Durable output stays owner-only locally.
  const lifecycle = { expiresIn: '1d' as const, initialAcl: { default: 'allow' as const, rules: [] } };
  return {
    async submit(endpoint, input) {
      const response = await client.queue.submit(endpoint, { input, storageSettings: lifecycle, startTimeout: 300 });
      return { requestId: validateRequestId(response.request_id) };
    },
    async status(endpoint, requestId) {
      const response = await client.queue.status(endpoint, { requestId: validateRequestId(requestId), logs: false });
      if (!['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED'].includes(response.status)) throw new ProviderError('PROVIDER_SCHEMA_CHANGED', 'Unknown provider queue state.');
      return response.status;
    },
    async result(endpoint, requestId) { return (await client.queue.result(endpoint, { requestId: validateRequestId(requestId) })).data; },
    async cancel(endpoint, requestId) { await client.queue.cancel(endpoint, { requestId: validateRequestId(requestId) }); },
    async upload(bytes, mime = 'image/png') {
      if (bytes.length > (policy.maxUploadBytes ?? 128 * 1024 * 1024)) throw new ProviderError('PROVIDER_UPLOAD_LIMIT', 'Image exceeds the provider upload limit.');
      return uploadSlot(() => client.storage.upload(new Blob([new Uint8Array(bytes)], { type: mime }), { lifecycle }));
    },
    async download(url) { return downloadSlot(() => downloadProviderImage(url, policy)); },
  };
}

export function providerInputHash(model: Model, identity: unknown): string {
  const canonical = (value: unknown): string => {
    if (value === undefined) return 'null';
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
    return JSON.stringify(value);
  };
  return createHash('sha256').update(canonical({ model, adapterVersion: endpointRegistry[model].adapterVersion, identity })).digest('hex');
}

type AdvanceInput = {
  jobId: string; stepId: string; model: Model; input: ProviderInput;
  /** Hash immutable image/mask bytes, transforms and settings, excluding temporary upload URLs. */
  inputHash: string;
  cancelled?: boolean;
};
export type ProviderAdvance =
  | { state: 'pending'; nextPollAt: number; request: ProviderRequestRecord }
  | { state: 'completed'; output: NormalizedProviderOutput; request: ProviderRequestRecord };

/** One scheduling tick. No busy waiting and no replay of an accepted or ambiguous paid request. */
export class DurableFalClient {
  private readonly now: () => number;
  private readonly random: () => number;
  constructor(private readonly repository: ProviderRepository, readonly transport: FalTransport, private readonly options: { maxGlobalCalls: number; maxConcurrent?: number; phaseTimeoutMs?: number; maxLookupRetries?: number; now?: () => number; random?: () => number }) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  private update(record: ProviderRequestRecord, patch: Partial<ProviderRequestRecord>) {
    const updated = { ...patch, updatedAt: this.now() };
    this.repository.updateProviderRequest(record.id, updated);
    Object.assign(record, updated);
  }

  private nextPoll(record: ProviderRequestRecord, retryAfterMs?: number): number {
    const age = Math.max(0, this.now() - record.createdAt);
    const backoff = Math.min(15_000, 2000 * (1 + age / 30_000));
    return this.now() + Math.round(Math.max(retryAfterMs ?? 0, backoff * (0.85 + this.random() * 0.3)));
  }

  async cancel(record: ProviderRequestRecord): Promise<void> {
    let diagnostic = 'CANCELLED';
    if (record.providerRequestId && !['COMPLETED', 'CANCELLED', 'FAILED'].includes(record.status)) {
      try { await this.transport.cancel(record.endpoint, record.providerRequestId); }
      catch { diagnostic = 'CANCEL_REQUEST_UNCONFIRMED'; }
    }
    this.update(record, { status: 'CANCELLED', diagnostic });
  }

  async advance(input: AdvanceInput): Promise<ProviderAdvance> {
    let record = this.repository.getProviderRequest(input.stepId, input.inputHash);
    if (input.cancelled) {
      if (record) await this.cancel(record);
      throw new ProviderError('JOB_CANCELLED', 'Decomposition was cancelled.');
    }
    if (!record) {
      const adapter = endpointRegistry[input.model];
      record = this.repository.reserveProviderRequest({ jobId: input.jobId, stepId: input.stepId, endpoint: adapter.endpoint, adapterVersion: adapter.adapterVersion, inputHash: input.inputHash, seed: typeof input.input.seed === 'number' ? input.input.seed : undefined, sentSeed: typeof input.input.seed === 'number' ? input.input.seed : undefined }, this.options.maxGlobalCalls, this.options.maxConcurrent ?? 2);
      // Persist SUBMITTING before contacting fal. Any crash after this point is ambiguous without an ID.
      try {
        const result = await this.transport.submit(record.endpoint, input.input);
        this.update(record, { providerRequestId: validateRequestId(result.requestId), status: 'QUEUED', nextPollAt: this.nextPoll(record) });
        return { state: 'pending', nextPollAt: record.nextPollAt, request: record };
      } catch (error) {
        const rejection = error instanceof ProviderError && error.status !== undefined && [400, 401, 402, 403, 404, 422, 429].includes(error.status);
        this.update(record, { status: rejection ? 'FAILED' : 'SUBMISSION_UNKNOWN', diagnostic: rejection ? error.code : 'SUBMISSION_UNKNOWN', nextPollAt: this.nextPoll(record, error instanceof ProviderError ? error.retryAfterMs : undefined) });
        if (rejection) throw error;
        throw new ProviderError('SUBMISSION_UNKNOWN', 'The provider may have accepted this request. Reconcile its request ID before attempting another paid call.');
      }
    }
    if (record.status === 'SUBMITTING' || record.status === 'SUBMISSION_UNKNOWN') {
      this.update(record, { status: 'SUBMISSION_UNKNOWN', diagnostic: 'SUBMISSION_UNKNOWN' });
      throw new ProviderError('SUBMISSION_UNKNOWN', 'A submission has no saved request ID. Reconcile it or explicitly authorize a new attempt.');
    }
    if (record.status === 'COMPLETED') {
      if (!record.output) throw new ProviderError('PROVIDER_OUTPUT_UNAVAILABLE', 'Saved provider output is unavailable.');
      return { state: 'completed', output: record.output as NormalizedProviderOutput, request: record };
    }
    if (record.status === 'FAILED' || record.status === 'CANCELLED') throw new ProviderError(record.diagnostic ?? 'PROVIDER_FAILED', 'This provider attempt has ended. Review the failure before explicitly retrying.');
    if (!record.providerRequestId) throw new ProviderError('SUBMISSION_UNKNOWN', 'No durable provider request identifier exists.');
    if (this.now() - record.createdAt > (this.options.phaseTimeoutMs ?? 300_000)) {
      await this.cancel(record);
      this.update(record, { status: 'FAILED', diagnostic: 'PROVIDER_DEADLINE' });
      throw new ProviderError('PROVIDER_DEADLINE', 'The model step exceeded its active deadline. Visible assets have been preserved.');
    }
    if (record.nextPollAt > this.now()) return { state: 'pending', nextPollAt: record.nextPollAt, request: record };
    try {
      const status = await this.transport.status(record.endpoint, record.providerRequestId);
      if (status !== 'COMPLETED') {
        this.update(record, { status: status === 'IN_QUEUE' ? 'QUEUED' : 'IN_PROGRESS', nextPollAt: this.nextPoll(record) });
        return { state: 'pending', nextPollAt: record.nextPollAt, request: record };
      }
      const output = normalizeProviderOutput(input.model, await this.transport.result(record.endpoint, record.providerRequestId));
      this.update(record, { status: 'COMPLETED', output, returnedSeed: output.seed, seed: output.seed ?? record.seed });
      return { state: 'completed', output, request: record };
    } catch (error) {
      const normalized = error instanceof ProviderError ? error : new ProviderError('PROVIDER_NETWORK', 'Provider lookup failed.', true);
      if (normalized.retryable && record.attempts < (this.options.maxLookupRetries ?? 3)) {
        this.update(record, { attempts: record.attempts + 1, nextPollAt: this.nextPoll(record, normalized.retryAfterMs), diagnostic: normalized.code });
        return { state: 'pending', nextPollAt: record.nextPollAt, request: record };
      }
      this.update(record, { status: 'FAILED', diagnostic: normalized.code });
      throw normalized;
    }
  }
}

/** Decode pixels, not provider width metadata. Call before persisting any provider image. */
export async function validateProviderImage(bytes: Buffer, model: Model, maxPixels = 12_000_000) {
  try {
    const decoder = sharp(bytes, { limitInputPixels: maxPixels, failOn: 'warning', animated: true });
    const metadata = await decoder.metadata();
    if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1 || metadata.depth !== 'uchar' || !metadata.width || !metadata.height || metadata.width > 4096 || metadata.height > 4096 || metadata.width * metadata.height > maxPixels) throw new Error();
    if (model === 'qwen' && !metadata.hasAlpha) throw new ProviderError('PROVIDER_INVALID_IMAGE', 'Qwen proposal has no alpha support.');
    await decoder.raw().toBuffer();
    return { width: metadata.width, height: metadata.height, format: metadata.format, hasAlpha: Boolean(metadata.hasAlpha) };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('PROVIDER_INVALID_IMAGE', 'Provider output failed full image decoding or image limits.');
  }
}
