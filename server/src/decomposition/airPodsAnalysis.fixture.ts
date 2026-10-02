/** Analysis content captured from the failed AirPods manual test (2026-10-02).
 * Exact evidence retained; request IDs, reasoning, usage and user/image metadata omitted.
 * Replayed only through injected fake providers. No network or reference-image asset required.
 */
export const airPodsAnalysisFixture = {
  "analysis": {
    "sceneType": "studio product layout / promotional graphic",
    "hero": {
      "identity": "AirPods Max (over-ear headphone)",
      "appearance": "modern over-ear headphones with mesh-knit ear cushions and padded mesh headband; visible metal hinge details and digital crown",
      "color": "blue / sky-blue gradient (cool blue tones)",
      "orientation": "angled three-quarter view, right earcup forward, left earcup visible behind",
      "cameraAngle": "slightly elevated frontal angle (camera above center, looking down slightly)",
      "position": "center-right",
      "relativeScale": "dominant (~55-65% of image width vertically; largest object)"
    },
    "objects": [
      {
        "kind": "secondary headphone view (single earcup and headband)",
        "appearance": "isolated rear/vertical view of one earcup hung from top shape",
        "position": "left column, top center (~13% x, 18% y)",
        "relativeScale": "small (about 12% of image width)",
        "relationshipToHero": "supporting visual / alternate view of same product",
        "count": 1
      },
      {
        "kind": "rounded rectangular panel (background cards)",
        "appearance": "three rounded panels/cards with gradient blue to gray fills; one large central card behind hero, one left tall card, one",
        "position": "spanning left-to-center and center-right; centers approx 30% x, 40% y and 56% x, 36% y",
        "relativeScale": "large (background framing elements)",
        "relationshipToHero": "background framing and contrast for hero",
        "count": 3
      },
      {
        "kind": "headline text",
        "appearance": "large white bold text, stacked lines",
        "position": "top-center / overlapping central card (~50% x, 18% y)",
        "relativeScale": "medium",
        "relationshipToHero": "visually associated, placed behind top of hero",
        "count": 1
      },
      {
        "kind": "product name and CTA panel",
        "appearance": "light rounded rectangle lower-left with bold black product name and small white pill 'ORDER NOW'",
        "position": "lower-left quadrant (~30% x, 78% y)",
        "relativeScale": "medium",
        "relationshipToHero": "informational overlay; anchors composition bottom-left",
        "count": 1
      },
      {
        "kind": "Apple logo",
        "appearance": "solid black apple silhouette",
        "position": "lower-right on central card (~78% x, 82% y)",
        "relativeScale": "small",
        "relationshipToHero": "brand mark near hero",
        "count": 1
      },
      {
        "kind": "website text",
        "appearance": "small dark gray URL text",
        "position": "very bottom center (~50% x, 96% y)",
        "relativeScale": "very small",
        "relationshipToHero": "caption / footer",
        "count": 1
      }
    ],
    "composition": {
      "framing": "tight square crop; hero slightly overlapping foreground panels",
      "crop": "full product mostly within frame; left column shows alternate view cropped with rounded card edges",
      "foreground": "large angled headphone occupying right foreground",
      "midground": "rounded card with headline and left alternate earcup",
      "background": "soft blue-gray gradient fill across full canvas",
      "negativeSpace": "soft gradient space around left and top edges, balanced bottom area under product",
      "visualHierarchy": "hero headphone (dominant) > headline text > lower product-name panel/CTA > brand mark"
    },
    "palette": [
      "cool blue",
      "sky blue",
      "desaturated steel blue",
      "soft gray",
      "white",
      "black (logo/text)"
    ],
    "lighting": "soft, even studio lighting from upper-left; subtle highlights on metal and matte casings; gentle diffuse shadows",
    "materials": [
      "matte anodized metal (earcup exterior)",
      "knit mesh fabric (ear cushions and headband)",
      "polished metal accents (hinges, crown)",
      "soft rubberized padding (headband underside)"
    ],
    "backgroundTreatment": "layered rounded gradient cards over a full-bleed blue-gray gradient; subtle vignette left edge",
    "visibleText": {
      "present": true,
      "description": "Top/center: 'Air Pod Max' (large white stacked); Lower-left card: 'Air Pod Max' (black) and small pill 'ORDER NOW'; Bottom center: 'www.apple.com'"
    },
    "preservationRules": [
      "do not remove or reposition the hero headphone",
      "do not change or remove visible text or logo",
      "do not alter number, placement, or shape of background rounded cards",
      "do not modify product color, surface finish or visible hardware details"
    ],
    "design": {
      "summary": "clean editorial product hero with layered rounded panels, bold stacked headline and a small rounded CTA pill; cool blue monochrome theme",
      "panelGeometry": "rounded rectangles/cards with consistent large corner radius",
      "typographyMood": "bold, geometric sans-serif; heavy weight for headline, medium for product name, small condensed for URL and CTA",
      "treatment": "photorealistic product render composited over graphic panels; subtle gradients and soft shadows",
      "shadows": "soft drop shadows beneath hero and panels, low contrast",
      "depth": "shallow-to-moderate depth created by overlapping panels and shadowing",
      "focalPoint": "right-side angled headphone earcup and cushion interior",
      "theme": "product launch / promotional tech",
      "decorations": "none beyond gradient cards and subtle highlights",
      "subjectMode": "single",
      "zones": {
        "headline": "top-center / on central card",
        "offer": "lower-left rounded rectangle",
        "cta": "small white pill inside lower-left panel, right of product name",
        "logo": "lower-right of central card",
        "product": "center-right dominant area"
      }
    }
  },
  "suggested_name": "Blue AirPods Max",
  "decomposition_template": "template-b",
  "reason": "Single dominant product rendered in a designed scene with supporting panels and CTA"
};

/** Retain both actual response text locations; omit private provider envelope metadata. */
export const airPodsAnalysisResponseFixture = {
  status: 'completed',
  output_text: JSON.stringify(airPodsAnalysisFixture),
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(airPodsAnalysisFixture) }] }],
};
