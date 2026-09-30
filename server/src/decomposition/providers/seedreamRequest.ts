import { buildProviderInput, endpointRegistry } from './adapters.js';
import type { ProviderInputOptions } from './adapters.js';
import { providerInputHash } from './falClient.js';

// Bump when changing defaults, the discovery contract, or adopting a new deployment of the unversioned endpoint.
export const SEEDREAM_REQUEST_VERSION = 'seedream-layerize-v1';
export type SeedreamOptions = Pick<ProviderInputOptions, 'prompt' | 'imageSize' | 'enhancePromptMode' | 'width' | 'height'>;
export type SeedreamReproducibility = {
  requestVersion: string; model: string; modelVersion: 'unknown'; adapterVersion: string;
  sourceSha256: string; inputSha256: string; requestFingerprint: string;
  effectiveInput: Record<string, unknown>;
  /** The endpoint exposes no seed; identical fingerprints reuse the persisted response instead of re-sampling. */
  deterministic: false;
  providerRequestId?: string; cachedFromJobId?: string;
};
/** Fingerprints the exact wire settings, excluding the temporary upload URL. */
export function prepareSeedreamRequest(inputSha256: string, sourceSha256: string, options: SeedreamOptions = {}): SeedreamReproducibility {
  const { image_url: _url, ...effectiveInput } = buildProviderInput('seedream', { ...options, imageUrl: 'https://fal.media/fingerprint-placeholder' });
  void _url;
  const identity = { requestVersion: SEEDREAM_REQUEST_VERSION, model: endpointRegistry.seedream.endpoint, modelVersion: 'unknown', sourceSha256, inputSha256, effective: effectiveInput };
  return { requestVersion: SEEDREAM_REQUEST_VERSION, model: endpointRegistry.seedream.endpoint, modelVersion: 'unknown', adapterVersion: endpointRegistry.seedream.adapterVersion,
    sourceSha256, inputSha256, effectiveInput, deterministic: false, requestFingerprint: providerInputHash('seedream', identity) };
}
