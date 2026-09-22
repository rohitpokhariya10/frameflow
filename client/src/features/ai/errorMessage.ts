/** Keep service diagnostics in the API; show only owned product copy in the editor. */
export function imageErrorMessage(value: unknown, status: number): string {
  const code = value && typeof value === 'object' && 'error' in value && value.error && typeof value.error === 'object' && 'code' in value.error ? value.error.code : undefined;
  if (code === 'ADAPT_UNAVAILABLE') return 'Adaptation is unavailable right now. You can still edit and export this design.';
  if (code === 'NOT_CONFIGURED' || code === 'CONFIGURATION' || code === 'MODEL_UNAVAILABLE') return 'AI artwork is unavailable right now. You can still edit and export. Ask the app owner to check the connection.';
  if (status === 429) return 'AI is busy or its usage limit has been reached. Please wait a minute before trying again.';
  if (code === 'TIMEOUT' || status === 504) return 'This took longer than expected. Your design is unchanged. Wait a moment before trying again.';
  if (code === 'PROVIDER_REFUSAL' || code === 'NO_IMAGE') return 'This artwork could not be created. Try a different visual description.';
  if (code === 'INVALID_REFERENCE') return 'The source artwork could not be used. Reload the design or replace its artwork and retry.';
  if (code === 'INVALID_REQUEST' || code === 'TOO_LARGE') return 'Check your visual description and canvas size, then try again.';
  return 'The image service is temporarily unavailable. Your design is unchanged. Please try again later.';
}
