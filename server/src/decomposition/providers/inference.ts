import type { Model, ProviderInputOptions, ProviderLayerMetadata } from './adapters.js';
import type { ImageTransform } from '../image/coordinates.js';

/** Images remain local buffers; only the server transport uploads them. */
export type InferenceRequest = {
  image: Buffer;
  mask?: Buffer;
  prompt?: string;
  negativePrompt?: string;
  numInferenceSteps?: number;
  guidanceScale?: number;
  acceleration?: ProviderInputOptions['acceleration'];
  points?: ProviderInputOptions['points'];
  boxes?: ProviderInputOptions['boxes'];
  numLayers?: number;
  maxMasks?: number;
  seed?: number;
  highResolutionMatte?: boolean;
  imageSize?: ProviderInputOptions['imageSize'];
  enhancePromptMode?: ProviderInputOptions['enhancePromptMode'];
  /** Stable phase/object identity for the step record; excluded from inference cache identity. */
  key?: string;
  /** Local provenance only; never sent as an undocumented fal input field. */
  transform?: ImageTransform;
};
export type InferenceOutput = Buffer[] & { scores?: number[]; boxes?: [number, number, number, number][]; requestId?: string; seed?: number; layers?: ProviderLayerMetadata[] };
export type Infer = (model: Model, request: InferenceRequest) => Promise<InferenceOutput>;
