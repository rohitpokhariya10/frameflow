/** Deterministic product-ad evidence for local tests; never a live provider response. */
export const referenceCreativeFixture = {
  suggested_name: 'Premium headphones campaign',
  analysis: {
    sceneType: 'Minimal blue premium electronics advertisement',
    hero: { identity: 'AirPods Max headphones', appearance: 'Silver over-ear headphones with a mesh headband', color: 'silver', orientation: 'upright three-quarter', cameraAngle: 'front three-quarter', position: 'right center', relativeScale: 'large dominant product' },
    objects: [{ kind: 'headphones', count: 1, appearance: 'silver', position: 'right center', relativeScale: '60% height', relationshipToHero: 'main product' }],
    composition: { framing: 'wide rounded panels', crop: 'whole product', foreground: 'product', midground: 'rounded card', background: 'cool blue', negativeSpace: 'left copy zone', visualHierarchy: 'headline left, large product right, CTA below' },
    palette: ['blue', 'silver', 'white'], lighting: 'soft studio light from upper left', materials: ['metal', 'mesh'],
    backgroundTreatment: 'Soft blue gradient', visibleText: { present: true, description: 'headline left and lower CTA bar' }, preservationRules: ['Keep rounded panels and negative space'],
    design: { summary: 'Minimal blue premium electronics creative', subjectMode: 'single', panelGeometry: 'large rounded rectangular card on right', typographyMood: 'bold clean sans-serif',
      treatment: 'photographic', shadows: 'soft contact shadow', depth: 'product floats over card', focalPoint: 'large right product', theme: 'premium modern', decorations: 'minimal',
      zones: { headline: 'upper left', offer: 'middle left', cta: 'lower bar', logo: 'top left margin', product: 'right center' } },
  },
};
