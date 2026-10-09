import { isIP } from 'node:net';

/** Allowlisted transport facts only: SDK messages can echo keys, headers and request bodies. */
export interface NetworkCause {
  type: string;
  code?: string;
  syscall?: string;
  status?: number;
  requestId?: string;
  /** The remote end of a failed connect or socket (undici's SocketError), and how far the upload got. Never the local address. */
  address?: string;
  port?: number;
  family?: string;
  bytesWritten?: number;
  bytesRead?: number;
  cause?: NetworkCause;
  errors?: NetworkCause[];
  truncated?: boolean;
}
export interface OpenAIRequestDiagnostics {
  endpointHost: string;
  elapsedMs: number;
  timeoutMs: number;
  maxRetries: 0;
  imageBytes: number;
  requestBytes: number;
  error: NetworkCause;
}
const token = (v: unknown) => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(v) && !/^sk_/i.test(v) ? v : undefined;
const requestId = (v: unknown) => typeof v === 'string' && /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|req_[A-Za-z0-9_-]{1,96})$/i.test(v) ? v : undefined;
const ip = (v: unknown) => typeof v === 'string' && isIP(v) ? v : undefined;
const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
/** Node's connect errors carry address/port; undici's SocketError carries a socket summary. */
function endpoint(e: { address?: unknown; port?: unknown; socket?: unknown }): Partial<NetworkCause> {
  const s = (e.socket && typeof e.socket === 'object' ? e.socket : {}) as { remoteAddress?: unknown; remotePort?: unknown; remoteFamily?: unknown; bytesWritten?: unknown; bytesRead?: unknown };
  const address = ip(e.address) ?? ip(s.remoteAddress), port = count(e.port) ?? count(s.remotePort);
  const family = s.remoteFamily === 'IPv4' || s.remoteFamily === 'IPv6' ? s.remoteFamily : undefined, bytesWritten = count(s.bytesWritten), bytesRead = count(s.bytesRead);
  return { ...(address ? { address } : {}), ...(port !== undefined ? { port } : {}), ...(family ? { family } : {}),
    ...(bytesWritten !== undefined ? { bytesWritten } : {}), ...(bytesRead !== undefined ? { bytesRead } : {}) };
}
/** Includes AggregateError.errors and non-enumerable Error.cause, with cycle/size limits. No raw messages or stacks. */
export function networkCause(error: unknown): NetworkCause {
  const seen = new Set<object>();
  let remaining = 32;
  const visit = (value: unknown, depth: number): NetworkCause => {
    if (!value || typeof value !== 'object') return { type: 'UnknownError' };
    if (seen.has(value) || depth > 6 || --remaining < 0) return { type: 'Error', truncated: true };
    seen.add(value);
    const e = value as { constructor?: { name?: string }; name?: unknown; code?: unknown; syscall?: unknown; status?: unknown; requestID?: unknown; request_id?: unknown; address?: unknown; port?: unknown; socket?: unknown; cause?: unknown; errors?: unknown };
    const type = token(e.constructor?.name) ?? token(e.name) ?? 'Error';
    const code = token(e.code), syscall = token(e.syscall), id = requestId(e.requestID ?? e.request_id);
    return { type, ...(code ? { code } : {}), ...(syscall ? { syscall } : {}), ...(typeof e.status === 'number' && e.status >= 100 && e.status <= 599 ? { status: e.status } : {}),
      ...(id ? { requestId: id } : {}), ...endpoint(e), ...(e.cause ? { cause: visit(e.cause, depth + 1) } : {}),
      ...(Array.isArray(e.errors) ? { errors: e.errors.slice(0, 8).map(item => visit(item, depth + 1)), ...(e.errors.length > 8 ? { truncated: true } : {}) } : {}) };
  };
  return visit(error, 0);
}
export function openAIRequestDiagnostics(error: unknown, context: Omit<OpenAIRequestDiagnostics, 'endpointHost' | 'error' | 'maxRetries'> & { baseURL?: string }): OpenAIRequestDiagnostics {
  let endpointHost = 'unknown';
  try { endpointHost = new URL(context.baseURL ?? 'https://api.openai.com/v1').host; } catch { /* Never persist a malformed URL. */ }
  return { endpointHost, elapsedMs: context.elapsedMs, timeoutMs: context.timeoutMs, maxRetries: 0, imageBytes: context.imageBytes, requestBytes: context.requestBytes, error: networkCause(error) };
}
/** Account states the user must fix in OpenAI billing; retrying the request cannot help. */
const NO_CREDIT = new Set(['credit_balance_exhausted', 'insufficient_quota']);
export function openAIFailureSummary(error: NetworkCause): string {
  if (error.status) return `HTTP ${error.status}${error.code ? ` (${error.code})` : ''}${error.code && NO_CREDIT.has(error.code) ? ' — the OpenAI account has no credit left; add credit in OpenAI billing, then try again' : ''}`;
  const codes = new Set<string>();
  const walk = (e: NetworkCause) => { if (e.code) codes.add(e.code); if (e.cause) walk(e.cause); e.errors?.forEach(walk); };
  walk(error);
  const kind = /Timeout/.test(error.type) ? 'Request timed out' : 'Connection error';
  return `${kind}${codes.size ? ` (${[...codes].join(', ')})` : ''}`;
}
