import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DecompositionJobSummary } from '@frameflow/shared';
import { MaskReview } from './MaskReview';

it('restores saved guidance while keeping raw filenames in Advanced inspection', () => {
  const candidate = { id: 'candidate-8', label: 'Object 8', maskArtifactId: 'native-mask', overlayArtifactId: 'overlay', selected: false, statistics: { area: 30000, areaFraction: 0.45 }, warnings: [] };
  const job = { id: 'review-job', revision: 9, candidates: [candidate], artifacts: [{ artifactId: 'overlay', relativePath: '04-sam2/candidate-007-overlay.png' }], reviewSubmission: { expectedRevision: 8, action: 'accept-masks', objects: [{ id: candidate.id, candidateId: candidate.id, selected: true, label: 'person', points: [{ x: 100, y: 100, label: 1 }, { x: 0, y: 0, label: 0 }] }] } } as DecompositionJobSummary;
  const html = renderToStaticMarkup(createElement(MaskReview, { job, candidates: [candidate], sourceId: 'source', width: 256, height: 256, onSubmit: () => {}, busy: false }));
  expect(html).toContain('Object 8 — Inspect target');
  expect(html).not.toContain('candidate-007-overlay.png');
  expect(html).toContain('Advanced / raw proposals');
  expect(html).toContain('1 positive / 1 negative');
  expect(html).toContain('Selected ownership for candidate-8');
  expect(html).toContain('value="person"');
  expect(html).toContain('Included in refinement');
});
