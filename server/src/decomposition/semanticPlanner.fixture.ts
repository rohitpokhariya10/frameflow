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

/** A product-shadow merge with an uneven description length, like the rejected charging-case run. */
export const productShadowFixture: SemanticAnalysis = {
  image_type: 'product creative', scene_summary: 'An open case and two earbuds above a pedestal.',
  relationships: [], ambiguities: [], recommended_layer_count: 8,
  decomposition_strategy: 'Separate the meaningful elements.', downstream_decomposition_prompt: 'Separate eight elements.',
  elements: [
    ['background', 'background'], ['disc', 'backdrop'], ['bars', 'decoration'], ['pedestal', 'prop'],
    ['product_shadow', 'cast shadow'], ['charging_case', 'main product'], ['left_earbud', 'product'], ['right_earbud', 'product'],
  ].map(([id, type], z_order) => ({ id, type,
    description: id === 'charging_case' ? 'Open charging case treated as one object, including front body, metallic rim, indicator slot, attached lid, hinge, interior wells, reflections, and the small surface emblem inside the lid. Do not split the attached lid or surface markings into separate layers.' : `${id.replaceAll('_', ' ')} as seen`,
    editable_independently: true, approximate_region: 'center', z_order, confidence: 'high',
    occlusion: { is_occluded: false, occluded_by: [], requires_reconstruction: false },
    attachment: { relation: 'none', parent_id: '', separation_risk: 'low', keep_with_parent: false } })),
};

/**
 * The planner's answer for the earbuds creative of live run 2026-10-08T08-13-23 (request 01a11a94-…, fal 422), verbatim:
 * the case lid is "part of" the case base with keep_with_parent, and the seated earbud lies between them in depth (in
 * front of the lid, behind the base rim). Merging the lid into the base turned the planner's coherent 9-layer prompt
 * into a 7-layer one asking for an impossible order.
 */
export const interleavedPartFixture: SemanticAnalysis = {
  "image_type": "Stylized 3D product render with glossy materials, gradient lighting and floating presentation elements.",
  "scene_summary": "A coordinated wireless audio set floats above a cylindrical pedestal. An open charging case dominates the foreground, one earbud is seated near the open lid, and another floats at upper left. A large circular gradient backdrop and grouped circuit-like lines with three glowing capsules frame the products against a pale luminous background.",
  "elements": [
    {
      "id": "background_gradient",
      "type": "background plate",
      "description": "Full-canvas near-white background with subtle lavender and pink illumination, especially around the edges and lower corners.",
      "editable_independently": true,
      "approximate_region": "Full canvas, normalized x 0–1 and y 0–1.",
      "z_order": 0,
      "confidence": "high",
      "occlusion": {
        "is_occluded": true,
        "occluded_by": [
          "circular_backdrop",
          "circuit_decorations",
          "pedestal",
          "case_shadow",
          "case_lid",
          "seated_earbud",
          "case_base",
          "floating_earbud"
        ],
        "requires_reconstruction": true
      },
      "attachment": {
        "relation": "none",
        "parent_id": "",
        "separation_risk": "low",
        "keep_with_parent": false
      }
    },
    {
      "id": "circular_backdrop",
      "type": "gradient shape",
      "description": "Large circular purple-to-pink luminous disc centered behind the product group, with soft internal lighting and clean circular edges.",
      "editable_independently": true,
      "approximate_region": "Central upper-middle area, approximately x 0.12–0.70 and y 0.23–0.69.",
      "z_order": 1,
      "confidence": "high",
      "occlusion": {
        "is_occluded": true,
        "occluded_by": [
          "circuit_decorations",
          "case_lid",
          "seated_earbud",
          "case_base",
          "floating_earbud"
        ],
        "requires_reconstruction": true
      },
      "attachment": {
        "relation": "none",
        "parent_id": "",
        "separation_risk": "low",
        "keep_with_parent": false
      }
    },
    {
      "id": "circuit_decorations",
      "type": "grouped decorative graphics",
      "description": "Three horizontal rounded gradient capsules with soft glow, connected by thin curved magenta circuit-like lines. The group includes one capsule at left and two at right; no text is visible inside them.",
      "editable_independently": true,
      "approximate_region": "Distributed around the product: left capsule x 0.06–0.24, y 0.58–0.63; upper-right capsule x 0.62–0.79, y 0.41–0.46; lower-right capsule x 0.61–0.78, y 0.74–0.79, with connecting lines across x 0.15–0.71 and y 0.45–0.77.",
      "z_order": 2,
      "confidence": "high",
      "occlusion": {
        "is_occluded": true,
        "occluded_by": [
          "case_lid",
          "seated_earbud",
          "case_base",
          "floating_earbud"
        ],
        "requires_reconstruction": true
      },
      "attachment": {
        "relation": "none",
        "parent_id": "",
        "separation_risk": "low",
        "keep_with_parent": false
      }
    },
    {
      "id": "pedestal",
      "type": "3D display surface",
      "description": "Large cylindrical presentation plinth with a pale pink elliptical top and softly shaded vertical front wall, cropped by the bottom edge.",
      "editable_independently": true,
      "approximate_region": "Bottom center, approximately x 0.12–0.68 and y 0.81–1.00.",
      "z_order": 3,
      "confidence": "high",
      "occlusion": {
        "is_occluded": true,
        "occluded_by": [
          "case_shadow",
          "case_base"
        ],
        "requires_reconstruction": true
      },
      "attachment": {
        "relation": "none",
        "parent_id": "",
        "separation_risk": "low",
        "keep_with_parent": false
      }
    },
    {
      "id": "case_shadow",
      "type": "contact shadow effect",
      "description": "Soft dark purple elliptical shadow cast beneath the floating charging case onto the pedestal top.",
      "editable_independently": true,
      "approximate_region": "On the pedestal top beneath the case, approximately x 0.27–0.63 and y 0.82–0.87.",
      "z_order": 4,
      "confidence": "high",
      "occlusion": {
        "is_occluded": true,
        "occluded_by": [
          "case_base"
        ],
        "requires_reconstruction": false
      },
      "attachment": {
        "relation": "part_of_object",
        "parent_id": "case_base",
        "separation_risk": "low",
        "keep_with_parent": true
      }
    },
    {
      "id": "case_lid",
      "type": "attached product component",
      "description": "Open rear lid and hinge assembly of the charging case, including the glossy inner cavity, rim highlights and the visible pale fruit-shaped surface emblem. It is separated to preserve the depth interleaving around the seated earbud.",
      "editable_independently": true,
      "approximate_region": "Central area behind the case base, approximately x 0.27–0.63 and y 0.40–0.64.",
      "z_order": 5,
      "confidence": "high",
      "occlusion": {
        "is_occluded": true,
        "occluded_by": [
          "seated_earbud",
          "case_base"
        ],
        "requires_reconstruction": true
      },
      "attachment": {
        "relation": "part_of_object",
        "parent_id": "case_base",
        "separation_risk": "medium",
        "keep_with_parent": true
      }
    },
    {
      "id": "seated_earbud",
      "type": "standalone product",
      "description": "Right-side earbud positioned over the open case, including its rounded housing, silicone tip, stem and small visible 'R' surface marking. The lower stem disappears behind the case front rim.",
      "editable_independently": true,
      "approximate_region": "Upper central-right area, approximately x 0.36–0.56 and y 0.32–0.56.",
      "z_order": 6,
      "confidence": "high",
      "occlusion": {
        "is_occluded": true,
        "occluded_by": [
          "case_base"
        ],
        "requires_reconstruction": true
      },
      "attachment": {
        "relation": "none",
        "parent_id": "",
        "separation_risk": "medium",
        "keep_with_parent": false
      }
    },
    {
      "id": "case_base",
      "type": "main product assembly",
      "description": "Large foreground charging-case base with glossy purple body, bright metallic rim, dark open interior and small front indicator. The base forms the foremost occluding edge across the lid and seated earbud stem.",
      "editable_independently": true,
      "approximate_region": "Dominant lower-middle foreground, approximately x 0.21–0.64 and y 0.52–0.84.",
      "z_order": 7,
      "confidence": "high",
      "occlusion": {
        "is_occluded": false,
        "occluded_by": [],
        "requires_reconstruction": false
      },
      "attachment": {
        "relation": "none",
        "parent_id": "",
        "separation_risk": "low",
        "keep_with_parent": false
      }
    },
    {
      "id": "floating_earbud",
      "type": "standalone product",
      "description": "Detached earbud floating at upper left, including its rounded body, textured stem, silicone tip, circular end cap, triangular surface symbol and small highlights.",
      "editable_independently": true,
      "approximate_region": "Upper-left of the product group, approximately x 0.18–0.35 and y 0.30–0.49.",
      "z_order": 8,
      "confidence": "high",
      "occlusion": {
        "is_occluded": false,
        "occluded_by": [],
        "requires_reconstruction": false
      },
      "attachment": {
        "relation": "none",
        "parent_id": "",
        "separation_risk": "low",
        "keep_with_parent": false
      }
    }
  ],
  "relationships": [
    {
      "source": "circular_backdrop",
      "relationship": "behind",
      "target": "circuit_decorations"
    },
    {
      "source": "circular_backdrop",
      "relationship": "behind",
      "target": "case_lid"
    },
    {
      "source": "circular_backdrop",
      "relationship": "behind",
      "target": "seated_earbud"
    },
    {
      "source": "circular_backdrop",
      "relationship": "behind",
      "target": "case_base"
    },
    {
      "source": "circular_backdrop",
      "relationship": "behind",
      "target": "floating_earbud"
    },
    {
      "source": "circuit_decorations",
      "relationship": "behind",
      "target": "case_lid"
    },
    {
      "source": "circuit_decorations",
      "relationship": "behind",
      "target": "seated_earbud"
    },
    {
      "source": "circuit_decorations",
      "relationship": "behind",
      "target": "case_base"
    },
    {
      "source": "case_shadow",
      "relationship": "belongs_to",
      "target": "case_base"
    },
    {
      "source": "case_shadow",
      "relationship": "rests_on",
      "target": "pedestal"
    },
    {
      "source": "case_lid",
      "relationship": "part_of",
      "target": "case_base"
    },
    {
      "source": "seated_earbud",
      "relationship": "in_front_of",
      "target": "case_lid"
    },
    {
      "source": "seated_earbud",
      "relationship": "partially_behind",
      "target": "case_base"
    },
    {
      "source": "case_base",
      "relationship": "floats_above",
      "target": "pedestal"
    },
    {
      "source": "floating_earbud",
      "relationship": "floats_beside",
      "target": "seated_earbud"
    }
  ],
  "ambiguities": [
    "The pale fruit-shaped emblem on the lid, triangular cap symbol on the floating earbud and small 'R' marking are retained with their product surfaces because they are perspective-bound details rather than reliable standalone graphics.",
    "The case lid is physically attached to the base but should be generated as a separate coordinated layer to reproduce the seated earbud's interleaved depth; moving it independently may require hinge-area repair.",
    "The seated earbud's hidden lower stem must be conservatively reconstructed from its visible taper and alignment; its exact concealed length is uncertain.",
    "Curved decorative lines hidden behind the products should be continued smoothly from their visible trajectories without inventing additional branches.",
    "The three capsules, their glows and connecting lines are grouped as one decoration layer to avoid unreliable fragmentation while preserving useful repositioning."
  ],
  "recommended_layer_count": 9,
  "decomposition_strategy": "Create nine meaningful layers in strict back-to-front order. Keep the smooth background, circular backdrop and grouped circuit graphics independent. Separate the pedestal and the case-associated shadow. Split the open case into rear lid and foreground base so the seated earbud can pass in front of the lid but behind the base rim. Preserve both earbuds as complete standalone product silhouettes, reconstructing only the seated earbud's concealed lower stem. Keep small perspective-bound surface markings baked into their corresponding product layers.",
  "downstream_decomposition_prompt": "Decompose into exactly 9 transparent layers, back to front: (1) full pale lavender/pink gradient background; (2) large central purple-pink circular gradient backdrop; (3) one grouped decoration layer containing all three glowing rounded capsules and their thin curved connecting lines; (4) cylindrical pink pedestal; (5) soft purple case shadow on the pedestal; (6) open rear case lid/hinge with inner cavity and surface emblem; (7) seated right earbud with housing, tip, stem and R mark; (8) foreground charging-case base with rim, interior and front indicator; (9) floating upper-left earbud with tip, cap symbol and textured stem. Preserve original geometry, gloss, lighting, antialiased edges and positions. The seated earbud must appear in front of the lid but its lower stem must pass behind the case base rim; reconstruct that hidden stem conservatively. Reconstruct the lid area hidden by the earbud/base, the pedestal top beneath the product, the circular gradient behind products, and obscured decoration-line paths using smooth visible continuations. Keep the lid aligned to the base and the shadow associated with the base. Do not extract tiny surface markings as separate layers or duplicate visible pixels."
};
