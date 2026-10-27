/** Paid image attempts are never retried here. Store only allowlisted diagnostics, never provider bodies or headers. */
import { randomUUID } from 'node:crypto';
import { networkCause, openAIFailureSummary, type NetworkCause } from '../../../services/openAIRequestDiagnostics.js';
import type { ArtworkGenerator } from './artwork.js';

export interface ImageFailure { code: string; message: string; outcome: 'unknown' | 'rejected' | 'received'; details: NetworkCause; requestId?: string }
export class ImageOperationError extends Error {
  constructor(public readonly failure: ImageFailure) { super(failure.message); this.name = 'ImageOperationError'; }
}
export function imageFailure(error: unknown, received = false, requestId?: string): ImageFailure {
  if (error instanceof ImageOperationError) return error.failure;
  const details = networkCause(error), status = details.status;
  if (error instanceof Error && ['AbortError', 'TimeoutError', 'ImageTimeout'].includes(error.name)) details.type = error.name;
  const kinds = JSON.stringify(details);
  const code = received ? 'IMAGE_VALIDATION_FAILED' : status ? `OPENAI_HTTP_${status}` : /Timeout|TIMEDOUT|TIMEOUT/.test(kinds) ? 'IMAGE_TIMEOUT' : /Abort/.test(kinds) ? 'IMAGE_ABORTED' : 'IMAGE_TRANSPORT_INTERRUPTED';
  const outcome = received ? 'received' : status && status < 500 ? 'rejected' : 'unknown';
  const reason = received ? 'The image was received but could not be validated. Its saved output was retained.' : status ? openAIFailureSummary(details) : code === 'IMAGE_TIMEOUT' ? 'Image request timed out.' : code === 'IMAGE_ABORTED' ? 'Image request was aborted.' : `Image connection or response body was interrupted${details.cause?.code ? ` (${details.cause.code})` : ''}.`;
  return { code, outcome, details, ...(requestId ?? details.requestId ? { requestId: requestId ?? details.requestId } : {}), message: `${reason}${outcome === 'unknown' ? ' Provider completion and billing are unknown.' : ''} No automatic retry was made.` };
}
export interface ProductImageOperation {
  id: string; index: number; slotId: string; label: string; model: string; prompt: string;
  status: 'running' | 'received' | 'ready' | 'failed' | 'unknown'; startedAt: string; finishedAt?: string;
  estimateUsd: number; costUsd?: number; requestId?: string; rawFile?: string;
  asset?: { file: string; width: number; height: number }; failure?: ImageFailure;
  legacy?: boolean;
  /** The approval this attempt was counted against (absent on attempts made before approvals were recorded). */
  authorizationId?: string;
}
export const operationId = () => randomUUID();
const NO_CREDIT = /credit_balance_exhausted|insufficient_quota|no credits? (left|remaining)/i;
/**
 * What a failed attempt means for the rest of its batch. A received image rejected by the local checks blocks only its own
 * slot; credit exhaustion, a provider refusal or error, and an interrupted connection stop every further submission.
 */
export function failureKind(failure: ImageFailure): 'insufficient-credits' | 'provider-failure' | 'connection-interrupted' | 'image-rejected' {
  if (failure.outcome === 'received') return 'image-rejected';
  if (failure.details.status === 429 && NO_CREDIT.test(`${JSON.stringify(failure.details)} ${failure.message}`)) return 'insufficient-credits';
  return failure.details.status ? 'provider-failure' : 'connection-interrupted';
}
/** Image requests in flight at once, across all jobs and templates of this server: FRAMEFLOW_PRODUCT_IMAGE_CONCURRENCY, 1–4, default 2. */
export const imageConcurrency = () => Math.min(4, Math.max(1, Math.floor(Number(process.env.FRAMEFLOW_PRODUCT_IMAGE_CONCURRENCY)) || 2));
let inFlight = 0;
const waiting: (() => void)[] = [];
/** Runs `work` once a permit is free. A released permit is handed straight to the next waiter, so the cap is never exceeded. */
export async function limitedImage<T>(work: () => Promise<T>): Promise<T> {
  if (inFlight < imageConcurrency()) inFlight++; else await new Promise<void>(resolve => waiting.push(resolve));
  try { return await work(); } finally { const next = waiting.shift(); if (next) next(); else inFlight--; }
}
/** A bounded wait also protects injected/non-SDK providers. Timeout never schedules another request. */
export async function boundedImage(generator: ArtworkGenerator, input: Parameters<ArtworkGenerator['generate']>[0], save: Parameters<ArtworkGenerator['generate']>[1], timeoutMs = 240_000) {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([generator.generate({ ...input, signal: controller.signal }, save), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); const e = new Error('Image deadline exceeded'); e.name = 'ImageTimeout'; reject(new ImageOperationError(imageFailure(e))); }, timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
