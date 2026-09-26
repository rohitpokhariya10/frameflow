import { createHash } from 'node:crypto';
import { buildProviderInput, endpointRegistry } from './adapters.js';
import type { ProviderInputOptions } from './adapters.js';
import { providerInputHash } from './falClient.js';

// Bump when changing defaults or adopting a new deployment of the unversioned endpoint.
export const QWEN_REQUEST_VERSION = 'qwen-repro-v1';
export type QwenReproducibility = {
  requestVersion: string; model: string; modelVersion: 'unknown'; adapterVersion: string;
  sourceSha256: string; inputSha256: string; requestFingerprint: string;
  effectiveInput: Record<string, unknown>; sentSeed: number; returnedSeed?: number;
  returnedPrompt?: string; providerRequestId?: string; cachedFromJobId?: string;
};
/** Uses the exact wire settings, excluding the temporary upload URL and non-Qwen job options. */
export function prepareQwenRequest(inputSha256: string, sourceSha256: string, options: Omit<ProviderInputOptions, 'imageUrl'> = {}): QwenReproducibility {
  const { image_url: _url, seed: _seed, ...effective } = buildProviderInput('qwen', { ...options, imageUrl: 'https://fal.media/fingerprint-placeholder', seed: undefined });
  void _url; void _seed;
  const identity = { requestVersion: QWEN_REQUEST_VERSION, model: endpointRegistry.qwen.endpoint, modelVersion: 'unknown', sourceSha256, inputSha256, effective };
  const seedIdentity = providerInputHash('qwen', identity);
  const seed = options.seed ?? (createHash('sha256').update(seedIdentity).digest().readUInt32BE(0) & 0x7fffffff);
  // Validate explicit seeds through the same adapter before persisting a request.
  buildProviderInput('qwen', { ...options, imageUrl: 'https://fal.media/fingerprint-placeholder', seed });
  const effectiveInput = { ...effective, seed };
  return { requestVersion: QWEN_REQUEST_VERSION, model: endpointRegistry.qwen.endpoint, modelVersion: 'unknown', adapterVersion: endpointRegistry.qwen.adapterVersion,
    sourceSha256, inputSha256, sentSeed: seed, effectiveInput, requestFingerprint: providerInputHash('qwen', { ...identity, effective: effectiveInput }) };
}
