import type { RunRecord } from './layerizeExperiment.js';

/** The plan a run reused instead of calling the planner: a creative template's, or a rejected run's (explicit retry). */
const reusedPlan = (run: RunRecord) => run.promptSource?.mode === 'template-plan' || run.promptSource?.mode === 'retry' ? run.promptSource : undefined;
/** The semantic plan a run decomposed with: the planner's, or the reused one's. */
export const semanticAnalysisOf = (run: RunRecord) => run.planner?.semantic_analysis ?? reusedPlan(run)?.semantic_analysis;
export const semanticProtectionOf = (run: RunRecord) => run.planner?.semantic_protection ?? reusedPlan(run)?.semantic_protection;
