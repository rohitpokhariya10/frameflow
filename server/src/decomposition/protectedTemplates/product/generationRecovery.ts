/** Read-only legacy recovery. Do not infer a paid response from a request file or from its estimated cost. */
import { statSync } from 'node:fs';
import { sha256 } from '../pixels.js';
import type { ProtectedStore } from '../store.js';
import type { ProductImageOperation } from './imageOperation.js';
import type { VariationJob, VariationPlan } from './variations.js';
import { ARTWORK_COST_USD } from './artwork.js';
import { productMix, productReusePrompt, productFamily } from './reuse.js';
export function legacyProductOperations(store: ProtectedStore, id: string, job: VariationJob, slots: { slotId: string; label: string; box: { width: number; height: number } }[], plans: VariationPlan[]): ProductImageOperation[] {
  const prefix = `pvar-${job.id.slice(3)}-product-`, files = store.files(id, prefix).filter(f => f.endsWith('-artwork-openai-request.json'));
  const time = (f: string) => statSync(store.path(id, f)).mtimeMs;
  const requests = files.map(file => ({ file, at: time(file), parts: file.slice(prefix.length).match(/^(\d+)-(\d+)-attempt-([a-f0-9]+)-/) })).filter(r => r.parts).sort((a, b) => a.at - b.at);
  return requests.flatMap((r, n) => {
    const index = Number(r.parts![1]), k = Number(r.parts![2]), slot = slots[k], plan = plans[index];
    if (!slot || !plan) return [];
    const responseFile = r.file.replace('-request.json', '-response.json'), request = JSON.parse(store.read(id, r.file).toString());
    const response = store.has(id, responseFile) ? JSON.parse(store.read(id, responseFile).toString()) : undefined;
    const label = productMix(slots, index)[k], prompt = request.prompt;
    // Only the unchanged, known generation scheme is recoverable. Never guess a product's label.
    if (prompt !== productReusePrompt(label, productFamily(slots.map(s => s.label)), plan.kind, index)) return [];
    const candidates = response?.images === 1 ? store.files(id, `pvarproduct-${job.id.slice(3)}-${index}-`).filter(f => f.endsWith('.png') && time(f) >= time(responseFile) && time(f) < (requests[n + 1]?.at ?? Infinity)) : [];
    const file = candidates.length === 1 ? candidates[0] : undefined, bytes = file ? store.read(id, file) : undefined;
    const valid = bytes && bytes.length >= 24 && bytes.subarray(1, 4).toString() === 'PNG' && file!.endsWith(`${sha256(bytes).slice(0, 12)}.png`);
    const rejection = !response && /^429\b/.test(job.results.find(result => result.index === index)?.error ?? '');
    const u = response?.usage;
    const costUsd = u ? ((u.input_tokens_details?.text_tokens ?? u.input_tokens ?? 0) * 5 + (u.input_tokens_details?.image_tokens ?? 0) * 8 + (u.output_tokens ?? 0) * 30) / 1e6 : undefined;
    return [{ id: `legacy-${index}-${k}-${r.parts![3]}`, index, slotId: slot.slotId, label, model: request.model, prompt, startedAt: new Date(r.at).toISOString(), estimateUsd: ARTWORK_COST_USD,
      status: valid ? 'ready' as const : response || rejection ? 'failed' as const : 'unknown' as const, legacy: true,
      ...(response?.requestId ? { requestId: response.requestId } : {}), ...(costUsd !== undefined ? { costUsd } : {}),
      ...(valid ? { asset: { file: file!, width: bytes!.readUInt32BE(16), height: bytes!.readUInt32BE(20) } } : { failure: { code: response ? 'LEGACY_OUTPUT_UNMAPPED' : rejection ? 'LEGACY_HTTP_429' : 'LEGACY_OUTCOME_UNKNOWN', outcome: response ? 'received' as const : rejection ? 'rejected' as const : 'unknown' as const, details: { type: 'LegacyRecord', ...(rejection ? { status: 429 } : {}) }, message: response ? 'A successful legacy response has no uniquely matched saved image. Manual asset review is required; it will not be resubmitted.' : rejection ? 'The variation recorded an HTTP 429 rejection. Check account credit and limits before approving a new attempt. Billing is not confirmed by this record.' : 'No completed response was recorded. Provider completion and billing are unknown. No automatic retry was made.' } }) }];
  });
}
export function imageAccounting(operations: ProductImageOperation[]) {
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  return { usageCostUsd: round(operations.reduce((sum, o) => sum + (o.costUsd ?? 0), 0)),
    uncertainCostUsd: round(operations.filter(o => o.costUsd === undefined && ['running', 'unknown'].includes(o.status)).reduce((sum, o) => sum + o.estimateUsd, 0)),
    estimatedCostUsd: round(operations.filter(o => o.costUsd === undefined && !['running', 'unknown'].includes(o.status)).reduce((sum, o) => sum + o.estimateUsd, 0)) };
}
