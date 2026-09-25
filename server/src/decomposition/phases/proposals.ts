import sharp from 'sharp';
import { decodeMask, measureMask } from '../image/masks.js';
import type { Mask } from '../image/masks.js';
import { ProviderError } from '../providers/adapters.js';
import type { Infer } from '../providers/inference.js';

export type LayerProposal = {
  id: string;
  label: string;
  rgba: Buffer;
  width: number;
  height: number;
  alpha: Mask;
  registered: boolean;
  warnings: string[];
};

/** Qwen proposes geometry only. Its RGB is never used for visible extraction. */
export async function createLayerProposals(analysis: Buffer, infer: Infer, count = 4): Promise<{ proposals: LayerProposal[]; warnings: string[] }> {
  const source = await sharp(analysis).metadata();
  const warnings: string[] = [];
  let outputs: Buffer[];
  try { outputs = await infer('qwen', { image: analysis, numLayers: Math.min(6, Math.max(1, count)), key: 'phase03-proposals' }); }
  catch (error) {
    if (!(error instanceof ProviderError) || !['PROVIDER_EMPTY_OUTPUT', 'PROVIDER_INVALID_IMAGE', 'PROVIDER_UNAVAILABLE', 'PROVIDER_SCHEMA_CHANGED', 'PROVIDER_CANDIDATE_LIMIT'].includes(error.code)) throw error;
    return { proposals: [], warnings: ['PROPOSAL_UNRELIABLE', error.code] };
  }
  if (!outputs.length || outputs.length > 6) return { proposals: [], warnings: ['PROPOSAL_UNRELIABLE'] };
  const proposals: LayerProposal[] = [];
  for (const [index, rgba] of outputs.entries()) {
    try {
      const metadata = await sharp(rgba, { limitInputPixels: 12_000_000, failOn: 'warning' }).metadata();
      if (!metadata.hasAlpha || !metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) throw new Error('Invalid proposal.');
      const alpha = await decodeMask(rgba, { encoding: 'alpha' });
      const area = measureMask(alpha).areaFraction;
      const registered = metadata.width === source.width && metadata.height === source.height;
      const defects = [...(!registered ? ['PROPOSAL_GEOMETRY_MISMATCH'] : []), ...(area === 0 || area === 1 ? ['PROPOSAL_NON_OBJECT_SUPPORT'] : [])];
      proposals.push({ id: `proposal-${index + 1}`, label: `Object ${index + 1}`, rgba, alpha, width: metadata.width, height: metadata.height, registered, warnings: defects });
      if (defects.length) warnings.push('PROPOSAL_UNRELIABLE');
    } catch { warnings.push('PROPOSAL_UNRELIABLE'); }
  }
  if (!proposals.length) warnings.push('PROPOSAL_UNRELIABLE');
  return { proposals, warnings: [...new Set(warnings)] };
}
