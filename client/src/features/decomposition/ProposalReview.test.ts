import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DecompositionJobSummary } from '@frameflow/shared';
import { ProposalReview } from './ProposalReview';

it('shows discovered elements by name and keeps internal identifiers under Advanced inspection', () => {
  const proposal = (id: string, label: string, description: string) => ({ id, label, description, artifactId: `${id}-rgba`, alphaArtifactId: `${id}-alpha`, width: 256, height: 256, registered: true, warnings: [], provider: 'seedream' as const, zIndex: 1, requestFingerprint: 'fingerprint-abc' });
  const job = {
    id: 'job', revision: 4, sourceWidth: 256, sourceHeight: 256, sourcePreviewArtifactId: 'source', review: { gate: 'qwen-proposal-review', code: 'QWEN_PROPOSAL_REVIEW', message: 'Choose what to isolate.', actions: ['save-proposals', 'approve-proposals'], artifactIds: [] },
    proposals: [proposal('proposal-1', 'Woman holding phone', 'Young woman in a jacket'), proposal('proposal-2', 'PRO headline', 'Orange headline text')],
    proposalTargets: [
      { id: 'target-1', label: 'Woman holding phone', proposalIds: ['proposal-1'], approved: false, rejected: false, groupMode: 'single', role: 'unknown' },
      { id: 'target-background', label: 'Background', proposalIds: [], approved: false, rejected: false, groupMode: 'single', role: 'background', baseLayer: true }],
    discovery: { baseLayer: { artifactId: 'base', width: 256, height: 256, zIndex: 0, sourceRegistration: { method: 'full-canvas', providerWidth: 896, providerHeight: 1120, scaleX: 1, scaleY: 1 } } },
  } as unknown as DecompositionJobSummary;
  const html = renderToStaticMarkup(createElement(ProposalReview, { job, onSubmit: async () => {}, busy: false }));
  expect(html).toContain('Discovered elements');
  expect(html).toContain('Woman holding phone');
  expect(html).toContain('Young woman in a jacket');
  expect(html).toContain('Kept as the background layer');
  expect(html).toContain('<option value="shape">shape</option>');
  // Outside Advanced inspection, no proposal ids, fingerprints or providers are shown.
  // Visible text only: Advanced inspection removed, then markup (URLs, attributes) stripped.
  const defaultView = html.replace(/<details>[\s\S]*?<\/details>/g, '').replace(/<[^>]+>/g, ' ');
  for (const internal of ['proposal-1', 'proposal-2', 'fingerprint-abc', 'seedream', 'target-1']) expect(defaultView).not.toContain(internal);
});
