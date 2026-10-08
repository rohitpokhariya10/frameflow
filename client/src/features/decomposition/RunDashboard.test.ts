import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AI_PRICING, calculateStageCost, sumCosts, type RunDiagnostics, type DiagnosticStage } from '@frameflow/shared';
import { RunDashboard, dashboardStatus, displayLayer } from './RunDashboard';
import type { ExperimentRun, ExperimentLayer } from './layerizeExperiment';
const layer: ExperimentLayer = { file: 'phone.png', name: 'Oversized phone', index: 1, zIndex: 1, pixelWidth: 1000, pixelHeight: 1000, opaquePercent: 30, placement: { kind: 'full-canvas', x: 0, y: 0, width: 1000, height: 1000 } };
const run: ExperimentRun = { id: 'saved-run', createdAt: '2026-10-07T00:00:00Z', stage: 'done', original: { file: 'original.png', width: 1000, height: 1000 }, input: { file: 'input.png', width: 1000, height: 1000, orientationNormalized: false }, seedream: { endpoint: AI_PRICING.seedream.model }, timings: {}, warnings: [], outputLayers: [layer], editorLayerFiles: [layer.file] };
const stages: DiagnosticStage[] = [
  { id: 'seedream', label: 'Generate raw layers', status: 'Complete', result: '13 billable raw layers', callsMeasured: true, calls: [{ kind: 'seedream', model: AI_PRICING.seedream.model, rawLayers: 13, baseWidth: 1000, baseHeight: 1000, requestId: 'secret-request-id' }], cost: calculateStageCost([{ kind: 'seedream', model: AI_PRICING.seedream.model, rawLayers: 13, baseWidth: 1000, baseHeight: 1000 }], 90) },
  ...(['residual', 'background', 'curation'] as const).map(id => ({ id, label: id, status: 'Skipped' as const, result: 'No call', callsMeasured: true, calls: [], cost: calculateStageCost([], 90) })),
];
const diagnostics: RunDiagnostics = { runId: run.id, updatedAt: run.createdAt, fx: 90, pricingVersion: AI_PRICING.version, sources: AI_PRICING.sources, stages, total: sumCosts(stages.map(s => s.cost), 90), calls: 1, callsMeasured: true, rawLayers: 13, editorLayers: 1, elapsedMs: 151000,
  prompts: [{ label: 'Planner instructions', model: 'gpt-5.6-sol', text: 'Huge private prompt' }], raw: [{ file: 'raw-shadow.png', name: 'Translucent shadow', disposition: 'internal', reasons: ['Low value'], pass: 0 }], notes: [] };
const html = (r = run, d: RunDiagnostics | undefined = diagnostics) => renderToStaticMarkup(createElement(RunDashboard, { run: r, diagnostics: d }));
describe('run dashboard default view', () => {
  it('shows calculated total and stage costs', () => { expect(html()).toContain('Calculated ₹39.49'); expect(html()).toContain('data-testid="cost-seedream"'); });
  it('shows raw to editor and target difference', () => { expect(html()).toContain('13 → 1'); expect(html()).toContain('₹30–₹33'); expect(html()).toContain('Above ₹33 target by ₹6.49'); });
  it('shows actual models and raw billable count', () => { expect(html()).toContain(AI_PRICING.seedream.model); expect(html()).toContain('13 billable raw layers'); });
  it('skipped stages show zero', () => { expect(html()).toContain('₹0.00'); expect(html()).toContain('Skipped'); });
  it('mounts only curated thumbnails by default', () => { expect(html()).toContain('/files/phone.png'); expect(html()).not.toContain('/files/raw-shadow.png'); });
  it('keeps raw layers collapsed and unmounted', () => { expect(html()).toContain('Raw / internal layers (13)'); expect(html()).not.toContain('Translucent shadow'); expect(html()).not.toContain('<details open'); });
  it('keeps prompts and request IDs out of the default tree', () => { expect(html()).toContain('Planner instructions'); expect(html()).not.toContain('Huge private prompt'); expect(html()).not.toContain('secret-request-id'); });
  it('shows recorded runtime and fixed budget FX', () => { expect(html()).toContain('2m 31s'); expect(html()).toContain('project budget rate: ₹90 / $'); });
  it('failure is understandable without a raw trace', () => {
    const text = html({ ...run, stage: 'failed', error: { stage: 'queued', code: 'PROVIDER_DECOMPOSITION_REJECTED', message: 'RAW STACK', provider: { code: 'PROVIDER_REJECTED', status: 422, messages: [{ msg: 'The provided image could not be processed for layer decomposition.' }] } } });
    expect(text).toContain('FAILED'); expect(text).toContain('could not produce a valid decomposition'); expect(text).not.toContain('RAW STACK'); expect(text).not.toContain('/files/phone.png');
    expect(text).toContain('Provider response (HTTP 422)'); expect(text).toContain('The provided image could not be processed');
    expect(text).toContain('Resume cannot recover it'); expect(text).toContain('new paid Seedream request');
  });
  it('never claims readiness for an invalid saved editor selection', () => expect(html({ ...run, editorLayerFiles: ['absent.png'] })).toContain('PARTIAL'));
  it('unknown total shows known subtotal and defers comparison', () => {
    const text = html(run, { ...diagnostics, total: { ...diagnostics.total, inr: null, usd: null, confidence: 'Unknown', knownInr: 10 } }); expect(text).toContain('₹10.00 known + unknown'); expect(text).toContain('Comparison pending');
  });
  it('has separate background and recursion cards', () => { expect(html()).toContain('aria-label="Background"'); expect(html()).toContain('aria-label="Recursive cleanup"'); });
  it('shows running status', () => expect(dashboardStatus({ ...run, stage: 'planning' }, 0)).toBe('RUNNING'));
  it('cleans technical base labels without changing imported layer data', () => { expect(displayLayer({ ...layer, name: 'Layer 0', placement: { ...layer.placement, kind: 'base' } }, run)).toEqual({ name: 'Background', role: 'Background' }); expect(layer.name).toBe('Oversized phone'); });
});
