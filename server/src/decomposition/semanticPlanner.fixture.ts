import type { SemanticAnalysis } from './semanticPlanner.js';
export const semanticFixture: SemanticAnalysis = {
  image_type: 'photo', scene_summary: 'Person holding a phone.',
  elements: [
    { id: 'person', type: 'person', description: 'Person including gripping hand', editable_independently: true, approximate_region: 'right half', z_order: 2, confidence: 'high', occlusion: { is_occluded: false, occluded_by: [], requires_reconstruction: false },
      attachment: { relation: 'none', parent_id: '', separation_risk: 'low', keep_with_parent: false } },
    { id: 'phone', type: 'product', description: 'Phone held by the person', editable_independently: true, approximate_region: 'center', z_order: 1, confidence: 'high', occlusion: { is_occluded: true, occluded_by: ['person'], requires_reconstruction: true },
      // The model judged this grip clean (no fingers across the phone): a held object it may separate.
      attachment: { relation: 'held_in_hand', parent_id: 'person', separation_risk: 'low', keep_with_parent: false } },
  ],
  relationships: [{ source: 'person', relationship: 'holding', target: 'phone' }],
  ambiguities: ['Hidden phone edge needs reconstruction.'], recommended_layer_count: 2,
  decomposition_strategy: 'Separate phone and person, preserve grip.',
  downstream_decomposition_prompt: 'Separate the phone and person. Preserve the hand in front of the phone and reconstruct its hidden edge conservatively.',
};
