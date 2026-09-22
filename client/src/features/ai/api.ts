import { validAdaptRequest, type AdaptRequest, validGenerateRequest, validImageResponse, type GenerateRequest, type ImageResponse } from '@frameflow/shared';
import { imageErrorMessage } from './errorMessage';
const base = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');
export async function aiConfigured(signal?: AbortSignal): Promise<boolean> {
  const response = await fetch(`${base}/health`, { signal });
  if (!response.ok) throw new Error('Could not reach the image service. Please check your connection.');
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || !('aiConfigured' in value) || typeof value.aiConfigured !== 'boolean') throw new Error('Could not check AI availability. Please try again.');
  return value.aiConfigured;
}
export async function generateDesign(request: GenerateRequest, signal: AbortSignal): Promise<ImageResponse> {
  if (!validGenerateRequest(request)) throw new Error('Enter a visual prompt up to 2,000 characters and a valid format.');
  return requestImage('generate', request, signal);
}
export async function adaptDesign(request: AdaptRequest, signal: AbortSignal): Promise<ImageResponse> {
  if (!validAdaptRequest(request)) throw new Error('Choose a valid target and source reference.');
  return requestImage('adapt', request, signal);
}
async function requestImage(operation: 'generate' | 'adapt', request: GenerateRequest | AdaptRequest, signal: AbortSignal): Promise<ImageResponse> {
  let response: Response;
  try { response = await fetch(`${base}/ai/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal }); }
  catch (error) { if (signal.aborted) throw error; throw new Error('Could not reach the image service. Your design is unchanged.', { cause: error }); }
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(imageErrorMessage(value, response.status));
  }
  if (!validImageResponse(value)) throw new Error('The image service returned invalid artwork. Your design is unchanged.');
  return value;
}
