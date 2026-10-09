import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { networkCause, openAIFailureSummary, openAIRequestDiagnostics } from './openAIRequestDiagnostics.js';

describe('safe OpenAI transport diagnostics', () => {
  it('captures SDK, fetch and aggregate socket causes without their private messages or properties', () => {
    const privateText = 'Bearer fixture-private-credential data:image/png;base64,PRIVATEIMAGE';
    const socket = (code: string) => Object.assign(new Error(privateText), { code, syscall: 'connect', headers: { authorization: privateText }, body: privateText });
    const aggregate = new AggregateError([socket('ENETUNREACH'), socket('ETIMEDOUT')], privateText);
    const error = new OpenAI.APIConnectionError({ cause: new TypeError(privateText, { cause: aggregate }) });
    const diagnostics = openAIRequestDiagnostics(error, { baseURL: 'https://user:password@api.openai.com/v1?token=private', elapsedMs: 1740, timeoutMs: 180000, imageBytes: 100, requestBytes: 300 });
    expect(diagnostics).toMatchObject({ endpointHost: 'api.openai.com', elapsedMs: 1740, maxRetries: 0,
      error: { type: 'APIConnectionError', cause: { type: 'TypeError', cause: { type: 'AggregateError', errors: [{ code: 'ENETUNREACH', syscall: 'connect' }, { code: 'ETIMEDOUT' }] } } } });
    expect(JSON.stringify(diagnostics)).not.toMatch(/private|password|Bearer|base64|PRIVATEIMAGE|headers|body|stack/i);
    expect(openAIFailureSummary(diagnostics.error)).toContain('ENETUNREACH, ETIMEDOUT');
  });
  it('retains HTTP status and SDK request ID without the provider error body or echoed key', () => {
    const error = OpenAI.APIError.generate(401, { error: { message: 'private-credential', code: 'invalid_api_key' } }, '', new Headers({ 'x-request-id': 'req_test123', 'authorization': 'private-credential' }));
    expect(networkCause(error)).toEqual({ type: 'AuthenticationError', status: 401, code: 'invalid_api_key', requestId: 'req_test123' });
    expect(openAIFailureSummary(networkCause(error))).toBe('HTTP 401 (invalid_api_key)');
    expect(openAIFailureSummary(networkCause(new OpenAI.APIConnectionTimeoutError()))).toBe('Request timed out');
    // The live 429 of 2026-10-08 (req_f2cef169…): a billing state, said plainly.
    const noCredit = networkCause(OpenAI.APIError.generate(429, { error: { message: 'private', code: 'credit_balance_exhausted' } }, '', new Headers({ 'x-request-id': 'req_test429' })));
    expect(noCredit).toEqual({ type: 'RateLimitError', status: 429, code: 'credit_balance_exhausted', requestId: 'req_test429' });
    expect(openAIFailureSummary(noCredit)).toBe('HTTP 429 (credit_balance_exhausted) — the OpenAI account has no credit left; add credit in OpenAI billing, then try again');
    expect(openAIFailureSummary({ type: 'RateLimitError', status: 429, code: 'rate_limit_exceeded' })).toBe('HTTP 429 (rate_limit_exceeded)');
  });
  it('records the remote endpoint and upload progress of a failed socket, never the local address', () => {
    const socketError = Object.assign(new Error('other side closed'), { name: 'SocketError', code: 'UND_ERR_SOCKET',
      socket: { localAddress: '192.168.1.33', localPort: 50123, remoteAddress: '2606:4700:7::f3', remotePort: 443, remoteFamily: 'IPv6', bytesWritten: 1015775, bytesRead: 0 } });
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', syscall: 'connect', address: '127.0.0.1', port: 8080 });
    const error = new OpenAI.APIConnectionError({ cause: new TypeError('fetch failed', { cause: new AggregateError([socketError, refused]) }) });
    const cause = networkCause(error).cause?.cause;
    expect(cause?.errors).toEqual([
      { type: 'Error', code: 'UND_ERR_SOCKET', address: '2606:4700:7::f3', port: 443, family: 'IPv6', bytesWritten: 1015775, bytesRead: 0 },
      { type: 'Error', code: 'ECONNREFUSED', syscall: 'connect', address: '127.0.0.1', port: 8080 },
    ]);
    expect(JSON.stringify(networkCause(error))).not.toMatch(/192\.168|50123/);
    expect(networkCause(Object.assign(new Error('x'), { address: 'api.openai.com:443 Bearer private', port: -1, socket: { remoteFamily: 'private', bytesWritten: 1.5 } }))).toEqual({ type: 'Error' });
  });
  it('bounds cyclic/deep aggregate errors and rejects arbitrary diagnostic strings', () => {
    const error = Object.assign(new Error('private'), { code: 'sk-test-credential', requestID: 'Bearer private', cause: undefined as unknown });
    error.cause = error;
    expect(networkCause(error)).toEqual({ type: 'Error', cause: { type: 'Error', truncated: true } });
    expect(networkCause(new AggregateError(Array.from({ length: 100 }, () => error))).errors).toHaveLength(8);
    const deep = (n: number): Error => new Error('private', n ? { cause: deep(n - 1) } : undefined);
    expect(JSON.stringify(networkCause(deep(100))).length).toBeLessThan(400);
  });
});
