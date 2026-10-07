import type { RunRecord } from './layerizeExperiment.js';

/** The semantic plan a run decomposed with: the planner's, or a template family's compiled one (no planner call). */
export const semanticAnalysisOf = (run: RunRecord) => run.planner?.semantic_analysis ?? (run.promptSource?.mode === 'blueprint' ? run.promptSource.semantic_analysis : undefined);
export const semanticProtectionOf = (run: RunRecord) => run.planner?.semantic_protection ?? (run.promptSource?.mode === 'blueprint' ? run.promptSource.semantic_protection : undefined);
