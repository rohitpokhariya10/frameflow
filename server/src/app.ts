import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { validGenerateRequest } from '@frameflow/shared';
import { geminiProvider } from './providers/geminiProvider.js';
import { AiError, generateArtwork, type GenerateImage } from './services/aiService.js';

export interface ServerConfig { apiKey?: string; model: string; timeoutMs: number; clientOrigin?: string; trustProxyHops: number }
export function readConfig(env = process.env): ServerConfig {
  const timeoutMs = Number(env.AI_TIMEOUT_MS ?? 120000);
  const trustProxyHops = Number(env.TRUST_PROXY_HOPS ?? 0);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180000) throw new Error('AI_TIMEOUT_MS must be 1000–180000.');
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 2) throw new Error('TRUST_PROXY_HOPS must be 0–2.');
  return { apiKey: env.GEMINI_API_KEY?.trim(), model: env.GEMINI_IMAGE_MODEL?.trim() || 'gemini-3.1-flash-image', timeoutMs, clientOrigin: env.CLIENT_ORIGIN, trustProxyHops };
}
export function createApp(config: ServerConfig, provider?: GenerateImage, log: (event: object) => void = console.info) {
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
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', aiConfigured: Boolean(config.apiKey), aiAvailable: Boolean(config.apiKey) }));
  app.use(express.json({ limit: '24kb', strict: true }));
  const generate = provider ?? (config.apiKey ? geminiProvider(config.apiKey, config.model) : undefined);
  let active = 0;
  const limiter = rateLimit({ windowMs: 60_000, limit: 3, standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (_req, _res, next) => next(new AiError('RATE_LIMIT', 'Please wait a minute before generating again.', 429, true)) });
  app.post('/api/ai/generate', limiter, async (req, res, next) => {
    const started = Date.now(); const requestId = res.locals.requestId as string;
    let admitted = false;
    const controller = new AbortController();
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnected);
    try {
      if (!validGenerateRequest(req.body)) throw new AiError('INVALID_REQUEST', 'Enter a visual prompt up to 2,000 characters and valid canvas dimensions and text region.', 400);
      if (!config.apiKey || !generate) throw new AiError('NOT_CONFIGURED', 'AI generation is not configured for this environment.', 503);
      if (active >= 2) throw new AiError('BUSY', 'The image service is handling other designs. Please try shortly.', 429, true);
      active++; admitted = true;
      const result = await generateArtwork(req.body, requestId, config.model, config.timeoutMs, generate, controller.signal);
      log({ requestId, durationMs: Date.now() - started, outcome: 'success' });
      if (!res.destroyed) res.json(result);
    } catch (error) {
      log({ requestId, durationMs: Date.now() - started, outcome: error instanceof AiError ? error.code : 'failure' });
      if (!res.destroyed) next(error);
    } finally { if (admitted) active--; res.off('close', disconnected); }
  });
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
