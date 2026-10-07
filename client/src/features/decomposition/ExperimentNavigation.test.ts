import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ExperimentTabs, filterSavedRuns, SavedRunBrowser } from './ExperimentNavigation';
import type { ExperimentRun } from './layerizeExperiment';
const run: ExperimentRun = { id: '2026-10-07-example', createdAt: '2026-10-07T10:00:00Z', stage: 'failed', templateKey: 'template-b', original: { file: 'original.png', width: 512, height: 512 }, input: { file: 'input.png', width: 512, height: 512, orientationNormalized: false }, seedream: { endpoint: 'fake' }, timings: {}, warnings: [] };
describe('experiment workspace navigation', () => {
  it('exposes four named tabs with one keyboard stop and their panel relationships', () => {
    const html = renderToStaticMarkup(createElement(ExperimentTabs, { current: 'overview', runCount: 2, onChange: () => {} }));
    for (const name of ['Overview', 'Create Template', 'Decompose/Test', 'Saved Runs']) expect(html).toContain(name);
    expect(html.match(/role="tab"/g)).toHaveLength(4); expect(html.match(/tabindex="0"/g)).toHaveLength(1); expect(html).toContain('aria-controls="lab-panel-saved"');
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
