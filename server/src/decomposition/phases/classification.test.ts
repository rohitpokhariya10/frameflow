import { describe, expect, it } from 'vitest';
import type { ProposalReviewTarget, ProposalSummary } from '@frameflow/shared';
import { classifyTarget } from './classification.js';

const target = (label: string, extra: Partial<ProposalReviewTarget> = {}): ProposalReviewTarget => ({ id: 't', label, proposalIds: [], approved: true, rejected: false, groupMode: 'single', role: 'unknown', provenance: { operation: 'discovered', sourceRevision: 0, createdAt: '' }, ...extra });

describe('scene element classification', () => {
  // Names and descriptions as returned live by Seedream for the poster.
  it.each([
    ['Woman holding phone', 'Full young female figure wearing a purple jacket', 'IMAGE_OBJECT'],
    ['Orange iPhone 17 Pro', 'Orange iPhone 17 Pro smartphone held by the person', 'IMAGE_OBJECT'],
    ['PRO headline', 'Uppercase PRO text title with an orange gradient', 'TEXT'],
    ['Product description body text', 'English product description paragraph', 'TEXT'],
    ['Designer signature', 'Handwritten-style signature text', 'TEXT'],
    ['Bottom specification text group', 'Four specification texts on the bottom panel', 'TEXT'],
    ['Orange main background panel', 'Rounded rectangle main panel with an orange gradient', 'SHAPE'],
    ['Bottom specification panel', 'Orange rounded rectangle specification bar', 'SHAPE'],
    ['Blurred studio background', 'Soft interior backdrop', 'BACKGROUND'],
  ])('%s → %s', (label, description, kind) => {
    expect(classifyTarget(target(label, { description })).kind).toBe(kind);
  });

  it('keeps ambiguous discovered elements reviewable instead of guessing', () => {
    // Name carries no type; description mentions a rectangle, text and a phone.
    expect(classifyTarget(target('Product name tag', { description: 'Rounded rectangle text tag reading iphone 17 Pro' }))).toMatchObject({ kind: 'UNKNOWN', reasons: expect.arrayContaining(['CONFLICTING_DESCRIPTION_EVIDENCE']) });
    expect(classifyTarget(target('Text badge'))).toMatchObject({ kind: 'UNKNOWN', reasons: expect.arrayContaining(['CONFLICTING_NAME_EVIDENCE']) });
    expect(classifyTarget(target('Layer 3'))).toMatchObject({ kind: 'UNKNOWN', reasons: ['NO_TYPE_EVIDENCE'] });
  });

  it('uses explicit user types, the base layer, and user isolation intent first', () => {
    expect(classifyTarget(target('Product name tag', { role: 'text' }))).toMatchObject({ kind: 'TEXT', confidence: 'user', source: 'user-role' });
    expect(classifyTarget(target('PRO headline', { role: 'object' })).kind).toBe('IMAGE_OBJECT');
    expect(classifyTarget(target('Orange panel', { role: 'foreground' })).kind).toBe('IMAGE_OBJECT');
    expect(classifyTarget(target('Background', { baseLayer: true, role: 'background' }))).toMatchObject({ kind: 'BACKGROUND', source: 'base-layer' });
    expect(classifyTarget(target('woman_with_phone', { groupMode: 'group' }))).toMatchObject({ kind: 'IMAGE_OBJECT', source: 'user-intent' });
    expect(classifyTarget(target('board', { provenance: { operation: 'target-label', sourceRevision: 0, createdAt: '' } })).kind).toBe('IMAGE_OBJECT');
    expect(classifyTarget(target('New target', { provenance: { operation: 'user-created', sourceRevision: 1, createdAt: '' } })).kind).toBe('IMAGE_OBJECT');
  });

  it('reads member proposal names when the target label is generic', () => {
    const proposals = [{ id: 'p1', label: 'PRO headline', artifactId: 'a', width: 1, height: 1, registered: true, warnings: [] }] as ProposalSummary[];
    expect(classifyTarget(target('Layer 1', { proposalIds: ['p1'] }), proposals).kind).toBe('TEXT');
  });
});
