import type { DecompositionReview } from '@frameflow/shared';

/** A synchronous lock protects the interval before React paints a disabled button. */
export async function submitReviewOnce(
  lock: { current: boolean }, body: DecompositionReview,
  submit: (body: DecompositionReview) => void | Promise<void>,
  status: (value: { pending: boolean; error: string }) => void,
) {
  if (lock.current) return;
  lock.current = true;
  status({ pending: true, error: '' });
  try {
    await submit(body);
    status({ pending: false, error: '' });
  } catch (error) {
    status({ pending: false, error: error instanceof Error ? error.message : 'Review could not be saved. Reload the job and try again.' });
  } finally { lock.current = false; }
}
