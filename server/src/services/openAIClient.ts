import OpenAI from 'openai';
/** Shared server-only SDK construction. No automatic provider retries. */
export const createOpenAIClient = (apiKey: string | undefined, timeout = 120_000) => new OpenAI({ apiKey, maxRetries: 0, timeout });
