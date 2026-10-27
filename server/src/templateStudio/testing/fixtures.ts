/**
 * Synthetic test material (no real brand, product or poster): a brand kit, logo, reference poster and product photos.
 * Used by the unit tests and by the offline browser fixture, where everything made from them is labelled as mock.
 */
import sharp from 'sharp';

/** A complete, valid brand-rules/1 document for a made-up brand. */
export const TEST_BRAND_RULES = {
  schema: 'brand-rules/1',
  palette: {
    core: [{ name: 'Studio Navy', hex: '#14325c', confirmed: true }, { name: 'White', hex: '#ffffff', confirmed: true }],
    accent: [{ name: 'Sun Yellow', hex: '#ffcc33', confirmed: true }],
    extended: [], neutrals: [],
    rules: ['Use Sun Yellow only for offers.'],
  },
  logo: {
    allowedCorners: ['top_left', 'top_right'],
    allowedColours: ['Studio Navy', 'White'],
    clearSpace: { unitDefinition: 'X = 25% of the logo height', multiple: 1, unitRatioOfLogoHeight: 0.25, unitRatioOfLogoWidth: 0.1, provenance: 'user', confirmed: true },
    partnerLockup: { gapUnits: 2, separator: '×', equalVisualWeight: true },
    subBrandLockup: null,
    minWidth: { digitalPx: 100, printMm: null },
    prohibited: ['shadow', 'stretch'],
    requireCleanBackground: true,
  },
  typography: { display: { family: 'Poppins', usage: 'Headlines and offers' }, text: { family: 'Poppins', usage: 'Body and footers' }, notes: [] },
  aesthetic: { summary: 'Clean, bright retail', principles: [{ name: 'Space', description: 'Leave room around products.' }], keywords: ['clean'], latitude: 'Moderate' },
  openQuestions: [],
} as const;

/** A two-tone wordmark-like logo with a transparent background, in one colour. */
export const logoPng = (hex: string) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="120"><rect x="10" y="20" width="80" height="80" rx="18" fill="${hex}"/><rect x="110" y="40" width="270" height="40" rx="10" fill="${hex}"/></svg>`)).png().toBuffer();

/** A reference poster: blue studio backdrop, white podiums of different heights, three appliances, an offer block. */
export const referencePosterPng = (width = 1080, height = 1350) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1080 1350"><defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b7be0"/><stop offset="1" stop-color="#1d4fa5"/></linearGradient></defs><rect width="1080" height="1350" fill="url(#bg)"/><rect x="0" y="1060" width="1080" height="290" fill="#2a5fba"/><rect x="170" y="860" width="220" height="200" fill="#f4f6fb"/><rect x="430" y="780" width="220" height="280" fill="#ffffff"/><rect x="690" y="900" width="220" height="160" fill="#eef1f8"/><rect x="200" y="640" width="160" height="220" rx="16" fill="#c7ccd4"/><rect x="460" y="520" width="160" height="260" rx="16" fill="#8b929c"/><rect x="720" y="700" width="160" height="200" rx="16" fill="#d9dde3"/><rect x="90" y="110" width="900" height="120" rx="20" fill="#ffcc33"/><rect x="90" y="260" width="600" height="50" rx="12" fill="#ffffff" opacity="0.8"/></svg>`)).png().toBuffer();

/** An opaque product photo: a grey appliance on white. */
export const productPhotoPng = (hex = '#8b929c') => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000"><rect width="800" height="1000" fill="#ffffff"/><rect x="220" y="160" width="360" height="680" rx="30" fill="${hex}"/><rect x="260" y="200" width="280" height="90" rx="12" fill="#1f2328"/><circle cx="400" cy="560" r="70" fill="#d8dce2"/></svg>`)).png().toBuffer();

/** A transparent product cutout (what a user exports from a photo editor). */
export const productCutoutPng = (hex = '#b5651d') => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect x="100" y="80" width="400" height="760" rx="40" fill="${hex}"/><rect x="150" y="140" width="300" height="100" rx="14" fill="#202020"/><circle cx="300" cy="520" r="90" fill="#f0e0c8"/></svg>`)).png().toBuffer();
