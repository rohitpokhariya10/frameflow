import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { ADAPT_LIMITS, validAdaptRequest, validGenerateRequest, type ImageProvider } from '@frameflow/shared';
import { geminiProvider } from './providers/geminiProvider.js';
import { cloudflareImageProvider, cloudflareAdaptProvider, CLOUDFLARE_IMAGE_MODEL } from './providers/cloudflareImageProvider.js';
import { AiError, generateArtwork, adaptArtwork, type GenerateImage, type AdaptImage } from './services/aiService.js';

export interface ServerConfig { provider: ImageProvider; accountId?: string; apiKey?: string; model: string; timeoutMs: number; clientOrigin?: string; trustProxyHops: number }
export function readConfig(env = process.env): ServerConfig {
  const timeoutMs = Number(env.AI_TIMEOUT_MS ?? 120000);
  const trustProxyHops = Number(env.TRUST_PROXY_HOPS ?? 0);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180000) throw new Error('AI_TIMEOUT_MS must be 1000–180000.');
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 2) throw new Error('TRUST_PROXY_HOPS must be 0–2.');
  const provider = env.AI_PROVIDER?.trim() || 'gemini';
  if (provider !== 'gemini' && provider !== 'cloudflare') throw new Error('AI_PROVIDER must be gemini or cloudflare.');
  const common = { provider, timeoutMs, clientOrigin: env.CLIENT_ORIGIN, trustProxyHops };
  if (provider === 'cloudflare') {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
    const model = env.CLOUDFLARE_IMAGE_MODEL?.trim() || CLOUDFLARE_IMAGE_MODEL;
    if (accountId && !/^[a-zA-Z0-9_-]+$/.test(accountId)) throw new Error('CLOUDFLARE_ACCOUNT_ID must be a valid account identifier.');
    if (!/^@cf\/[a-z0-9-]+\/[a-z0-9.-]+$/.test(model)) throw new Error('CLOUDFLARE_IMAGE_MODEL must be a Workers AI model identifier.');
    return { ...common, provider, accountId, apiKey: env.CLOUDFLARE_API_TOKEN?.trim(), model };
  }
  return { ...common, provider, apiKey: env.GEMINI_API_KEY?.trim(), model: env.GEMINI_IMAGE_MODEL?.trim() || 'gemini-3.1-flash-image' };
}
export function createApp(config: ServerConfig, provider?: GenerateImage, log: (event: object) => void = console.info, adaptationProvider?: AdaptImage) {
  const app = express();
  app.disable('x-powered-by'); app.set('trust proxy', config.trustProxyHops);
  const origins = new Set(['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3001', 'http://127.0.0.1:3001', ...(config.clientOrigin ? [config.clientOrigin.replace(/\/$/, '')] : [])]);
  app.use((_req, res, next) => {
    res.locals.requestId = randomUUID(); res.setHeader('X-Request-Id', res.locals.requestId);
    next();
  });
  // Static module/font requests also carry Origin; CORS policy belongs to the API.
  app.use('/api', (req, _res, next) => {
    if (req.headers.origin && !origins.has(req.headers.origin)) return next(new AiError('ORIGIN_DENIED', 'This origin is not allowed.', 403));
    next();
  });
  app.use('/api', cors({ origin: [...origins], methods: ['GET', 'POST', 'OPTIONS'], credentials: false, exposedHeaders: ['X-Request-Id', 'Retry-After'] }));
  const configured = Boolean(config.apiKey && (config.provider === 'gemini' || config.accountId));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', aiConfigured: configured, aiAvailable: configured, provider: config.provider }));
  app.use('/api/ai/adapt', express.json({ limit: ADAPT_LIMITS.requestBytes, strict: true }));
  app.use(express.json({ limit: '24kb', strict: true }));
  const generate = provider ?? (configured ? config.provider === 'cloudflare'
    ? cloudflareImageProvider(config.accountId!, config.apiKey!, config.model) : geminiProvider(config.apiKey!, config.model) : undefined);
  const adapt = adaptationProvider ?? (configured && config.provider === 'cloudflare' ? cloudflareAdaptProvider(config.accountId!, config.apiKey!, config.model) : undefined);
  let active = 0;
  const limiter = rateLimit({ windowMs: 60_000, limit: 3, standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (_req, _res, next) => next(new AiError('RATE_LIMIT', 'Please wait a minute before generating again.', 429, true)) });
  for (const operation of ['generate', 'adapt'] as const) {
  app.post(`/api/ai/${operation}`, limiter, async (req, res, next) => {
    const started = Date.now(); const requestId = res.locals.requestId as string;
    let admitted = false;
    const controller = new AbortController();
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnected);
    try {
      const adapting = operation === 'adapt';
      if (adapting ? !validAdaptRequest(req.body) : !validGenerateRequest(req.body)) throw new AiError('INVALID_REQUEST', 'Enter a visual prompt up to 2,000 characters and valid canvas dimensions and text region.', 400);
      if (!configured || !generate) throw new AiError('NOT_CONFIGURED', 'AI generation is not configured for this environment.', 503);
      if (adapting && !adapt) throw new AiError('ADAPT_UNAVAILABLE', 'Reference-image adaptation is not available for the selected provider. Select Cloudflare to adapt artwork.', 503);
      if (active >= 2) throw new AiError('BUSY', 'The image service is handling other designs. Please try shortly.', 429, true);
      active++; admitted = true;
      const result = adapting
        ? await adaptArtwork(req.body, requestId, config.model, config.timeoutMs, adapt!, controller.signal, config.provider)
        : await generateArtwork(req.body, requestId, config.model, config.timeoutMs, generate, controller.signal, config.provider);
      log({ requestId, durationMs: Date.now() - started, outcome: 'success' });
      if (!res.destroyed) res.json(result);
    } catch (error) {
      log({ requestId, durationMs: Date.now() - started, outcome: error instanceof AiError ? error.code : 'failure',
        ...(error instanceof AiError && error.providerDiagnostic ? { provider: error.providerDiagnostic } : {}) });
      if (!res.destroyed) next(error);
    } finally { if (admitted) active--; res.off('close', disconnected); }
  });
  }
  const errors: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    // Express identifies error middleware by its four-argument signature.
    void next;
    const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
    const normalized = error instanceof AiError ? error : status === 413
      ? new AiError('TOO_LARGE', 'The request is too large.', 413)
      : status === 400 ? new AiError('INVALID_REQUEST', 'The request body is not valid JSON.', 400)
        : new AiError('INTERNAL', 'The image service is temporarily unavailable. Your design is unchanged.', 500, true);
    res.status(normalized.status).json({ error: { code: normalized.code, message: normalized.message, retryable: normalized.retryable, requestId: res.locals.requestId } });
  };
  app.use(errors);
  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'API route not available.', retryable: false, requestId: res.locals.requestId } }));
  return app;
}
