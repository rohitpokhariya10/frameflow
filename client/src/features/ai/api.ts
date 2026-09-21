import { validGenerateRequest, validImageResponse, type GenerateRequest, type ImageResponse } from '@frameflow/shared';
const base = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');
export async function aiConfigured(signal?: AbortSignal): Promise<boolean> {
  const response = await fetch(`${base}/health`, { signal });
  if (!response.ok) throw new Error('Could not reach the image service. Please check your connection.');
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || !('aiConfigured' in value) || typeof value.aiConfigured !== 'boolean') throw new Error('The image service returned an invalid health response.');
  return value.aiConfigured;
}
export async function generateDesign(request: GenerateRequest, signal: AbortSignal): Promise<ImageResponse> {
  if (!validGenerateRequest(request)) throw new Error('Enter a visual prompt up to 2,000 characters and a valid format.');
  let response: Response;
  try { response = await fetch(`${base}/ai/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal }); }
  catch (error) { if (signal.aborted) throw error; throw new Error('Could not reach the image service. Your design is unchanged.', { cause: error }); }
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = value && typeof value === 'object' && 'error' in value && value.error && typeof value.error === 'object' && 'message' in value.error && typeof value.error.message === 'string' ? value.error.message.slice(0, 500) : 'The image service is temporarily unavailable. Your design is unchanged.';
    throw new Error(message);
  }
  if (!validImageResponse(value)) throw new Error('The image service returned invalid artwork. Your design is unchanged.');
  return value;
}
