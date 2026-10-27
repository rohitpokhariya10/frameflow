import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ExperimentTabs, filterSavedRuns, SavedRunBrowser } from './ExperimentNavigation';
import type { ExperimentRun } from './layerizeExperiment';
const run: ExperimentRun = { id: '2026-10-07-example', createdAt: '2026-10-07T10:00:00Z', stage: 'failed', templateKey: 'template-b', original: { file: 'original.png', width: 512, height: 512 }, input: { file: 'input.png', width: 512, height: 512, orientationNormalized: false }, seedream: { endpoint: 'fake' }, timings: {}, warnings: [] };
describe('experiment workspace navigation', () => {
  it('exposes six named tabs with one keyboard stop and their panel relationships', () => {
    const html = renderToStaticMarkup(createElement(ExperimentTabs, { current: 'overview', runCount: 2, onChange: () => {} }));
    for (const name of ['Overview', 'Offer Templates', 'Template Studio', 'Decompose/Test', 'Protected Templates', 'Saved Runs']) expect(html).toContain(name);
    expect(html).not.toContain('Legacy Templates');
    expect(html.match(/role="tab"/g)).toHaveLength(6); expect(html.match(/tabindex="0"/g)).toHaveLength(1); expect(html).toContain('aria-controls="lab-panel-saved"'); expect(html).toContain('aria-controls="lab-panel-offer"'); expect(html).toContain('aria-controls="lab-panel-protected"');
  });
  it('shows the earlier template wizard as a seventh tab only with the legacy flag', () => {
    const html = renderToStaticMarkup(createElement(ExperimentTabs, { current: 'create', runCount: 0, onChange: () => {}, legacy: true }));
    expect(html.match(/role="tab"/g)).toHaveLength(7); expect(html).toContain('Legacy Templates'); expect(html).toContain('aria-controls="lab-panel-create"');
  });
  it('searches saved runs by ID, date or template and combines the status filter', () => {
    const runs = [run, { ...run, id: 'active', templateKey: 'template-c', stage: 'planning' }];
    expect(filterSavedRuns(runs, 'TEMPLATE-B', 'all')).toEqual([run]);
    expect(filterSavedRuns(runs, '2026-10-07', 'FAILED')).toEqual([run]);
    expect(filterSavedRuns(runs, 'example', 'RUNNING')).toEqual([]);
  });
  it('shows first-time guidance when saved history is empty', () => {
    const html = renderToStaticMarkup(createElement(SavedRunBrowser, { runs: [], loading: false, busy: false, onSelect: () => {} }));
    expect(html).toContain('Your results will appear here'); expect(html).toContain('Decompose/Test');
  });
  it('run cards expose a result action and a concise status without raw error text', () => {
    const html = renderToStaticMarkup(createElement(SavedRunBrowser, { runs: [{ ...run, error: { code: 'RAW_ERROR', message: 'Technical stack trace', stage: 'planning' } }], loading: false, busy: false, onSelect: () => {} }));
    expect(html).toContain('View run'); expect(html).toContain('Failed'); expect(html).not.toContain('Technical stack trace');
  });
});
