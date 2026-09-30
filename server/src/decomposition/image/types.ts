export type Rect = { x: number; y: number; width: number; height: number };
/** Masks use white = included/editable, black = excluded/protected. */
export type Mask = { data: Uint8Array; width: number; height: number };
export type Point = { x: number; y: number };

export class ImageValidationError extends Error {
  readonly retryable = false;
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ImageValidationError';
  }
}

export function assertSize(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 12_000_000) {
    throw new ImageValidationError('IMAGE_DIMENSIONS', 'Image dimensions must be positive integers within the 12 megapixel limit.');
  }
}

export function assertMask(mask: Mask, binary = false): void {
  assertSize(mask.width, mask.height);
  if (mask.data.length !== mask.width * mask.height) throw new ImageValidationError('MASK_DIMENSIONS', 'Mask data does not match its dimensions.');
  if (binary && mask.data.some(value => value !== 0 && value !== 255)) throw new ImageValidationError('MASK_NOT_BINARY', 'Ownership/edit masks must contain only black and white pixels.');
}

export function assertSameSize(a: { width: number; height: number }, b: { width: number; height: number }): void {
  if (a.width !== b.width || a.height !== b.height) throw new ImageValidationError('IMAGE_ALIGNMENT', 'Image and mask dimensions differ; review the model output alignment.');
}
