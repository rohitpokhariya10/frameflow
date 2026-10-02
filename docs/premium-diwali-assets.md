# Premium Diwali asset source record

Reviewed 2026-10-02. The six supplied campaign references are **comparison material only**. None of their pixels, logos, branding, or crops is included in the production assets.

All external images below were downloaded from the named **free Unsplash photo pages**, whose pages explicitly identify the Unsplash License. No Unsplash+ purchase, paid provider, generated image API, or runtime hotlink is used. The local versions are cropped, masked, compressed components of original editable layouts, not a stock-photo collection or resale of the source photographs.

The [Unsplash copyright license](https://unsplash.com/license) permits copying, modification, distribution and commercial use; it excludes unmodified resale and a competing image service. This is a copyright license, not a guarantee of releases for all depicted subjects: see [Unsplash's releases and trademarks guidance](https://help.unsplash.com/en/articles/2612329-releases-and-trademarks). These files were chosen/cropped to avoid visible identifying faces, branded clothing, merchant signs and reference-campaign trademarks. We do not claim independently obtained model/property releases. Do not reuse these as standalone stock downloads, prints or implied endorsements.

| Local production files | Photographer / exact source | Local treatment and subject review |
| --- | --- | --- |
| `lanterns.webp` | [Moulendu Sarka — wHSSyIIqrLs](https://unsplash.com/photos/ornate-lanterns-glow-with-warm-light-and-intricate-patterns-wHSSyIIqrLs) | Lantern market texture; feathered edges and low-opacity scene use. No brand or business copy. |
| `night.webp`, `hanging-lantern.webp` | [Prakash Rao — _FDJrQrg9QI](https://unsplash.com/photos/colorful-lanterns-illuminate-a-dark-night-sky-_FDJrQrg9QI) | Night texture plus a masked physical paper-lantern detail; brightness adjusted. Not a crop of a supplied reference poster. |
| `city.webp`, `city-left.webp`, `city-right.webp` | [Martijn Vonk — qW-EvMhN6d4](https://unsplash.com/photos/a-large-building-with-many-windows-lit-up-at-night-qW-EvMhN6d4) | Hawa Mahal exterior. Cropped above street-level people and commercial signage. Separate feathered architectural sides, dark-sky alpha blending. Decorative setting, not a claim about an event venue. |
| `lamps.webp` | [Aveedibya Dey — BPNVa9KDGhg](https://unsplash.com/photos/a-group-of-lit-candles-sitting-on-top-of-a-table-BPNVa9KDGhg) | Diya/rangoli surface; edge feathering and low-opacity atmosphere. |
| `greeting.webp` | [Shabeeba Ameen — 0gPVirdNzw8](https://unsplash.com/photos/a-woman-holding-a-lit-candle-in-her-hands-0gPVirdNzw8) | Hands and diya; original source excludes face. Local foreground mask, bounded crop, lower-edge fade. Shared by the jewellery and greeting families. |
| `lantern-people.webp` | [Jenny Le — aNoW1UZnXEo](https://unsplash.com/photos/group-of-people-gathering-for-a-paper-lantern-festival-aNoW1UZnXEo) | Left crop excludes the central branded T-shirt. Back-view/silhouette crowd; no identifying face in the retained crop. Feathered top/sides, independent night-colour veil. The photograph depicts a lantern festival in the US; used for celebration atmosphere, not described as a photograph of an Indian Diwali event. |
| `gift-stage.webp` | [David Trinks — ZA5EpwKOTeA](https://unsplash.com/photos/two-stacks-of-ornate-gift-boxes-with-gold-ribbon-ZA5EpwKOTeA) | Right gift-box stack; crop excludes the source's left price tag. Soft edges, no business text. |
| `floral.webp` | [Sonika Agarwal — 8ENrIOM3pdQ](https://unsplash.com/photos/a-candle-is-lit-next-to-a-flower-arrangement-8ENrIOM3pdQ) | Local foreground mask of flowers/clay lamp. The small decorative cutout is not represented as a separately animated flame. |
| `product.webp`, `products.webp` | [pmv chamara — kYH0tVbhaPw](https://unsplash.com/photos/a-group-of-bottles-of-skin-care-products-kYH0tVbhaPw) | Generic cosmetic mockup photograph, with “Cosmetic / bottle mockup” sample packaging. Locally masked group and isolated single bottle, rotated upright. No neighbouring product fragment in the single-bottle asset. No reference brand. The cosmetic package artwork is raster sample content; replace the whole product slot to change packaging. |
| `atmosphere.svg`, `sparks.svg`, `night-veil.svg` | Original FrameFlow code | Lighting, grain, soft fireworks and transparent colour veil; no business text, remote references or imported illustration. Independently manageable layers. |
| `previews/premium-*.webp` | Derived from the actual FrameFlow canvas | Six 420×420 reviewed default renders. These are gallery thumbnails only, never the editable document or its background. Inherit the component source records above. |

## Rejected / excluded

A watermarked portrait, an identifiable portrait without verified release, a branded perfume sample, gift-tag source and unused duplicate output files were rejected or removed. Original downloaded photographs remain outside the repository. No source image with a watermark was retouched to remove that watermark and shipped.

## Size and integrity

`client/public/assets/diwali-premium/manifest.json` lists every production image's dimensions, byte count and SHA-256. Scene assets are bounded WebP files, not full camera originals. Assets are fetched only through the fixed `premiumAssetPath` allowlist, with MIME/size checks, a ten-second timeout and shared in-memory loads. Editor handoff copies bytes into the existing IndexedDB asset store; ordinary project reload then uses the persisted copies.

To rebuild gallery thumbnails after a deliberate design change, first capture the premium browser suite with public fonts enabled, then run `node scripts/build-premium-previews.mjs test-results/premium-final`. The script accepts actual `*-1x1-render.png` canvas renders, not the visual references. Review generated thumbnails before updating this manifest. QA comparison sheets and source posters must never be put in `client/public`.
