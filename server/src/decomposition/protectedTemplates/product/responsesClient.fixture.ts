/**
 * TEST FIXTURE: OpenAI Responses clients for the live product analyzer that never reach the network.
 *
 *   recorded  the RECORDED real answer of an approved request (made for a picture of `recordedSize`), answered for the
 *             picture actually sent: its word boxes (source pixels) scaled to the sent picture; every other box is a
 *             fraction and stays. It lets the live code path (downscaling, request, parsing, mapping back) run on a large
 *             upload with real content, free.
 *   failing   fails as the SDK does: a timeout, a connection error, an account without credit, a refused key.
 *
 * Each client records what it was sent (the picture's size, encoding and bytes) and how often it was called.
 */
import sharp from 'sharp';
import type OpenAI from 'openai';
import { APIConnectionError, APIConnectionTimeoutError, APIError } from 'openai';

type Sent = { width: number; height: number; mime: string; bytes: number; text: string };
type Client = Pick<OpenAI, 'responses'> & { calls: Sent[] };

async function sentOf(request: unknown): Promise<Sent> {
  const content = (request as { input: { content: { type: string; image_url?: string; text?: string }[] }[] }).input[0].content;
  const url = content.find(c => c.type === 'input_image')!.image_url!, [head, data] = url.split(','), bytes = Buffer.from(data, 'base64');
  const meta = await sharp(bytes).metadata();
  return { width: meta.width!, height: meta.height!, mime: head.slice(5, head.indexOf(';')), bytes: bytes.length, text: content.find(c => c.type === 'input_text')?.text ?? '' };
}

export function recordedResponsesClient(response: { output_text: string } & object, recordedSize: { width: number; height: number }): Client {
  const calls: Sent[] = [];
  return { calls, responses: { create: (async (request: unknown) => {
    const sent = await sentOf(request); calls.push(sent);
    const answer = JSON.parse(response.output_text) as { words?: { box: { x: number; y: number; width: number; height: number } }[] };
    const kx = sent.width / recordedSize.width, ky = sent.height / recordedSize.height;
    for (const w of answer.words ?? []) w.box = { ...w.box, x: w.box.x * kx, y: w.box.y * ky, width: w.box.width * kx, height: w.box.height * ky };
    return { ...response, output_text: JSON.stringify(answer) };
  }) as unknown as OpenAI['responses']['create'] } as OpenAI['responses'] };
}

export type FailingKind = 'timeout' | 'connection' | 'no-credit' | 'bad-key';
export function failingResponsesClient(kind: FailingKind): Client {
  const calls: Sent[] = [];
  return { calls, responses: { create: (async (request: unknown) => {
    calls.push(await sentOf(request));
    if (kind === 'timeout') throw new APIConnectionTimeoutError();
    if (kind === 'connection') throw new APIConnectionError({ message: undefined, cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
    if (kind === 'no-credit') throw APIError.generate(429, { error: { code: 'insufficient_quota', message: 'You exceeded your current quota, please check your plan and billing details.' } }, undefined, new Headers());
    throw APIError.generate(401, { error: { code: 'invalid_api_key', message: 'Incorrect API key provided: sk-test1234567890abcdef.' } }, undefined, new Headers());
  }) as unknown as OpenAI['responses']['create'] } as OpenAI['responses'] };
}
