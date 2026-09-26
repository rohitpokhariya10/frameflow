import type { Model, ProviderInputOptions } from './adapters.js';
import type { ImageTransform } from '../image/coordinates.js';

/** Images remain local buffers; only the server transport uploads them. */
export type InferenceRequest = {
  image: Buffer;
  mask?: Buffer;
  prompt?: string;
  points?: ProviderInputOptions['points'];
  boxes?: ProviderInputOptions['boxes'];
  numLayers?: number;
  maxMasks?: number;
  seed?: number;
  highResolutionMatte?: boolean;
  /** Stable phase/object/attempt identity, included in the durable execution hash. */
  key?: string;
  /** Local provenance only; never sent as an undocumented fal input field. */
  transform?: ImageTransform;
};
export type InferenceOutput = Buffer[] & { scores?: number[]; boxes?: [number, number, number, number][]; requestId?: string };
export type Infer = (model: Model, request: InferenceRequest) => Promise<InferenceOutput>;
