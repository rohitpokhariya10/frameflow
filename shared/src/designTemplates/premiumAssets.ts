/** Fixed same-origin assets only. Neither users nor planners can supply an address here. */
const files: Record<string, string> = {
  'premium-photo-lanterns': 'lanterns.webp', 'premium-photo-night': 'night.webp',
  'premium-photo-city': 'city.webp', 'premium-photo-lamps': 'lamps.webp',
  'premium-photo-city-left': 'city-left.webp', 'premium-photo-city-right': 'city-right.webp',
  'premium-photo-hanging-lantern': 'hanging-lantern.webp',
  'premium-sparks': 'sparks.svg',
  'premium-night-veil': 'night-veil.svg',
  'premium-photo-celebration': 'greeting.webp', 'premium-photo-greeting': 'greeting.webp',
  'premium-photo-lantern-people': 'lantern-people.webp', 'premium-photo-gifts': 'gift-stage.webp',
  'premium-photo-floral': 'floral.webp', 'premium-photo-product': 'product.webp', 'premium-photo-products': 'products.webp', 'premium-photo-gift-stage': 'gift-stage.webp', 'premium-atmosphere': 'atmosphere.svg',
};
export const premiumAssetPath = (id: string): string | undefined => Object.hasOwn(files, id) ? `/assets/diwali-premium/${files[id]}` : undefined;
export const PREMIUM_ASSET_IDS = Object.keys(files);
