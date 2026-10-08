/** Synthetic structured equivalents of the reported live failures; no customer image or provider data. */
export function verboseImageAnalysis(characters: number) {
  const response = {
    analysis: {
      sceneType: '3D product creative',
      hero: { identity: 'one lavender smartphone', appearance: 'slender rounded body, three lenses in a triangular camera module', color: 'lavender',
        orientation: 'tilted clockwise', cameraAngle: 'rear three-quarter view', position: 'center-left', relativeScale: 'half the canvas height' },
      objects: [{ kind: 'lavender/white spheres', count: 4, appearance: 'smooth matte surfaces', position: 'large behind left, large foreground right, small upper-right, small lower-left', relativeScale: 'two large and two small', relationshipToHero: 'surround the phone without covering its camera module' }],
      composition: { framing: 'whole product visible', crop: 'uncropped phone', foreground: 'large right sphere', midground: 'phone', background: 'left sphere', negativeSpace: 'above right', visualHierarchy: 'phone first, spheres second' },
      palette: ['lavender', 'white', 'neutral gray'], lighting: 'soft upper-left studio light', materials: ['matte metal', 'glass lenses'], backgroundTreatment: 'neutral gray studio background',
      visibleText: { present: false, description: '' }, preservationRules: ['Preserve the three-lens triangular camera module'],
    },
    suggested_name: 'Lavender phone studio',
  };
  const extra = Math.max(0, characters - JSON.stringify(response).length);
  response.analysis.hero.appearance += ' polished'.repeat(Math.floor(extra / 9)) + ' '.repeat(extra % 9);
  return response;
}
