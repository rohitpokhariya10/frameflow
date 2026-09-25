import { ImageValidationError } from './types.js';

let active = 0;
const pending: (() => void)[] = [];
/** Bound full-frame decoding independently from model concurrency and incoming HTTP requests. */
export async function withImageSlot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= 2) {
    if (pending.length >= 8) throw new ImageValidationError('IMAGE_BUSY', 'Image processing is busy; retry after the current uploads finish.');
    await new Promise<void>(resolve => pending.push(resolve));
  } else active++;
  try { return await work(); }
  finally {
    const next = pending.shift();
    if (next) next();
    else active--;
  }
}
