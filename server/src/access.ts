/**
 * Who may use a deployed FrameFlow. The app has no accounts, and its template, decomposition and AI routes start paid
 * OpenAI and fal work, so a public deployment is closed with one shared password: FRAMEFLOW_ACCESS_PASSWORD (user name
 * FRAMEFLOW_ACCESS_USER, default "frameflow"). It is HTTP Basic: the browser asks once and sends it with every request
 * of the app (pages, assets, API calls, downloads), so the frontend needs no change. /api/health stays open for the
 * host's health check, and an address with 20 failed attempts in 15 minutes is refused until they expire.
 *
 * Fail-safe: a production server that holds a paid provider key but has no password refuses every API request that
 * changes something (every paid operation is a POST), so a visitor can look around but cannot spend.
 * The origin rules (CLIENT_ORIGIN) still apply on top of both.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler, Response } from 'express';

export interface AccessConfig { user: string; password?: string; lockChanges: boolean }
const PAID_KEYS = ['OPENAI_API_KEY', 'FAL_KEY', 'GEMINI_API_KEY', 'CLOUDFLARE_API_TOKEN'];
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MAX_FAILURES = 20, WINDOW_MS = 15 * 60_000;

export function readAccessConfig(env: NodeJS.ProcessEnv = process.env): AccessConfig {
  const password = env.FRAMEFLOW_ACCESS_PASSWORD?.trim() || undefined, paid = PAID_KEYS.some(key => env[key]?.trim());
  return { user: env.FRAMEFLOW_ACCESS_USER?.trim() || 'frameflow', password, lockChanges: !password && paid && env.NODE_ENV === 'production' };
}

/** One line for the startup log. */
export function describeAccess(access: AccessConfig) {
  return access.password ? 'password required (FRAMEFLOW_ACCESS_PASSWORD)'
    : access.lockChanges ? 'OPEN, but API changes are refused: paid AI keys are set without FRAMEFLOW_ACCESS_PASSWORD' : 'open (no access password)';
}

const digest = (value: string) => createHash('sha256').update(value).digest();
const refuse = (res: Response, status: number, code: string, message: string) =>
  void res.status(status).json({ error: { code, message, retryable: status === 429, requestId: res.locals.requestId } });

export function accessGate(access: AccessConfig): RequestHandler {
  if (access.password) {
    const expected = digest(`${access.user}:${access.password}`), failures = new Map<string, { count: number; until: number }>();
    return (req, res, next) => {
      if (req.path === '/api/health') return next();
      const now = Date.now(), ip = req.ip ?? '', seen = failures.get(ip), current = seen && seen.until > now ? seen : undefined;
      if (current && current.count >= MAX_FAILURES) return refuse(res, 429, 'RATE_LIMIT', 'Too many failed sign-in attempts. Try again in 15 minutes.');
      const header = req.headers.authorization ?? '', given = /^Basic /i.test(header) ? Buffer.from(header.slice(6), 'base64').toString('utf8') : '';
      if (timingSafeEqual(digest(given), expected)) return next();
      if (failures.size > 10_000) for (const [key, value] of failures) if (value.until <= now) failures.delete(key);
      failures.set(ip, current ? { count: current.count + 1, until: current.until } : { count: 1, until: now + WINDOW_MS });
      res.setHeader('WWW-Authenticate', 'Basic realm="FrameFlow", charset="UTF-8"');
      refuse(res, 401, 'UNAUTHORIZED', 'Sign in to use FrameFlow.');
    };
  }
  return (req, res, next) => access.lockChanges && req.path.startsWith('/api/') && !READS.has(req.method)
    ? refuse(res, 403, 'ACCESS_PASSWORD_REQUIRED', 'This server has paid AI keys but no access password. Set FRAMEFLOW_ACCESS_PASSWORD to use it.')
    : next();
}
