import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { ProviderError } from './adapters.js';

export const defaultMediaHosts = ['fal.media', '*.fal.media'] as const;
const apiHosts = ['queue.fal.run', 'rest.fal.ai', 'fal.run'];
export type NetworkPolicy = { mediaHosts?: readonly string[]; timeoutMs?: number; maxBytes?: number; maxUploadBytes?: number };
export type Address = { address: string; family: number };
type Resolver = (hostname: string) => Promise<Address[]>;
const resolveAddresses: Resolver = hostname => lookup(hostname, { all: true, verbatim: true });

/** Reject non-global addresses, including IPv4 mapped IPv6 and documentation networks. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    // Only global unicast. Excludes loopback, local, multicast, mapped IPv4 and metadata.
    return /^[23][0-9a-f]{3}:/.test(normalized) && !/^2001:(?:0:|db8:|10:|20:)/.test(normalized) && !normalized.startsWith('2002:');
  }
  return false;
}

export function assertTrustedUrl(raw: string, hosts: readonly string[]): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new ProviderError('UNTRUSTED_PROVIDER_URL', 'Provider media URL is invalid.'); }
  const host = url.hostname.toLowerCase();
  const allowed = hosts.some(pattern => pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) && host !== pattern.slice(2) : host === pattern);
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || isIP(host) || !allowed || raw.length > 8192) {
    throw new ProviderError('UNTRUSTED_PROVIDER_URL', 'Provider media must use a configured trusted HTTPS origin.');
  }
  return url;
}

export async function resolveTrustedUrl(raw: string, hosts: readonly string[], resolve: Resolver = resolveAddresses): Promise<{ url: URL; address: Address }> {
  const url = assertTrustedUrl(raw, hosts);
  const addresses = await resolve(url.hostname);
  if (!addresses.length || addresses.some(result => !isPublicAddress(result.address))) throw new ProviderError('UNTRUSTED_PROVIDER_URL', 'Provider host resolved to a non-public address.');
  return { url, address: addresses.find(result => result.family === 4) ?? addresses[0] };
}

export async function consumeBounded(chunks: AsyncIterable<Uint8Array>, maxBytes: number, declaredLength?: string | null): Promise<Buffer> {
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)) throw new ProviderError('PROVIDER_RESPONSE_LIMIT', 'Provider response exceeds the configured size limit.');
  const buffers: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of chunks) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new ProviderError('PROVIDER_RESPONSE_LIMIT', 'Provider response exceeds the configured size limit.');
    buffers.push(Buffer.from(chunk));
  }
  if (declaredLength && bytes !== Number(declaredLength)) throw new ProviderError('PROVIDER_PARTIAL_DOWNLOAD', 'Provider download was incomplete.', true);
  return Buffer.concat(buffers, bytes);
}

export function httpProviderError(status: number, retryAfter: string | null = null): ProviderError {
  const seconds = Number(retryAfter);
  const retryAfterMs = retryAfter ? Math.min(60_000, Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now())) : undefined;
  if (status === 401 || status === 403) return new ProviderError('PROVIDER_AUTH', 'The fal key or account does not permit this request.', false, status);
  if (status === 402) return new ProviderError('PROVIDER_CREDITS', 'The fal account has insufficient credits.', false, status);
  if (status === 404 || status === 410) return new ProviderError('PROVIDER_UNAVAILABLE', 'The endpoint or retained provider artifact is unavailable.', false, status);
  if (status === 422 || status === 400) return new ProviderError('PROVIDER_REJECTED', 'The provider rejected the image or request. Check the saved input and provider account.', false, status);
  if (status === 429) return new ProviderError('PROVIDER_RATE_LIMIT', 'The provider rate limit was reached.', true, status, retryAfterMs);
  return new ProviderError('PROVIDER_NETWORK', `Provider returned HTTP ${status}.`, status >= 500, status, retryAfterMs);
}

/** HTTPS connects to the already-validated address while verifying TLS against the original hostname. */
async function pinnedRequest(raw: string, init: RequestInit, policy: NetworkPolicy, hosts: readonly string[]): Promise<Response> {
  const timeoutMs = policy.timeoutMs ?? 30_000;
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(init.signal ? [init.signal] : [])]);
  const resolution = resolveTrustedUrl(raw, hosts);
  const { url, address } = await new Promise<Awaited<ReturnType<typeof resolveTrustedUrl>>>((resolve, reject) => {
    const abort = () => reject(new ProviderError('PROVIDER_NETWORK', 'Provider DNS lookup timed out.', true));
    signal.addEventListener('abort', abort, { once: true });
    resolution.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
  const headers = new Headers(init.headers);
  headers.set('accept-encoding', 'identity');
  const outgoing = init.body === undefined || init.body === null ? undefined : init.body instanceof Blob ? Buffer.from(await init.body.arrayBuffer()) : typeof init.body === 'string' ? Buffer.from(init.body) : init.body instanceof Uint8Array ? Buffer.from(init.body) : undefined;
  if (init.body && !outgoing) throw new ProviderError('INVALID_PROVIDER_INPUT', 'Unsupported upload body.');
  if (outgoing && outgoing.length > (policy.maxUploadBytes ?? 128 * 1024 * 1024)) throw new ProviderError('PROVIDER_UPLOAD_LIMIT', 'Provider input exceeds the upload limit.');
  if (outgoing) headers.set('content-length', String(outgoing.length));
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: init.method ?? 'GET', headers: Object.fromEntries(headers), signal,
      // agent:false ensures an earlier pooled socket cannot bypass this lookup.
      agent: false,
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address: address.address, family: address.family }]);
        else callback(null, address.address, address.family);
      },
    }, response => {
      const status = response.statusCode ?? 502;
      if (status >= 300 && status < 400) {
        response.destroy();
        reject(new ProviderError('PROVIDER_REDIRECT', 'Provider redirects are disabled. Configure the actual trusted media origin.'));
        return;
      }
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(response.headers)) {
        if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      if (responseHeaders.get('content-encoding') && responseHeaders.get('content-encoding') !== 'identity') {
        response.destroy(); reject(new ProviderError('PROVIDER_ENCODING', 'Compressed provider transport responses are not accepted.')); return;
      }
      consumeBounded(response, policy.maxBytes ?? 2 * 1024 * 1024, responseHeaders.get('content-length')).then(body => {
        resolve(new Response(status === 204 || status === 205 || status === 304 ? null : new Uint8Array(body), { status, headers: responseHeaders }));
      }, error => { response.destroy(); reject(error); });
    });
    req.on('error', () => reject(new ProviderError('PROVIDER_NETWORK', 'Provider connection failed or timed out.', true)));
    if (outgoing) req.write(outgoing);
    req.end();
  });
}

/** Throws our non-SDK error BEFORE SDK response handling: its internal submission retry policy cannot double-submit. */
export function createBoundedSdkFetch(policy: NetworkPolicy = {}, requestImpl = pinnedRequest): typeof fetch {
  return async (input, init = {}) => {
    const raw = input instanceof Request ? input.url : String(input);
    try {
      const response = await requestImpl(raw, init, policy, [...apiHosts, ...(policy.mediaHosts ?? defaultMediaHosts)]);
      if (!response.ok) throw httpProviderError(response.status, response.headers.get('retry-after'));
      return response;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      // Do not preserve raw messages, headers or cause chains containing URLs/keys.
      throw new ProviderError('PROVIDER_NETWORK', 'Provider connection failed or timed out.', true);
    }
  };
}

export async function downloadProviderImage(url: string, policy: NetworkPolicy = {}): Promise<Buffer> {
  const response = await pinnedRequest(url, {}, { maxBytes: 128 * 1024 * 1024, timeoutMs: 60_000, ...policy }, policy.mediaHosts ?? defaultMediaHosts);
  if (!response.ok) throw httpProviderError(response.status, response.headers.get('retry-after'));
  const mime = response.headers.get('content-type')?.split(';')[0];
  if (mime && !['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'].includes(mime)) throw new ProviderError('PROVIDER_INVALID_IMAGE', 'Provider download is not a supported image.');
  return Buffer.from(await response.arrayBuffer());
}
