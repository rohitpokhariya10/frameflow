> **22 October 2026 update:** The word-level/selective-decomposition fix and current verified limitations are documented in [PRODUCT_WORD_PIPELINE_FIX.md](PRODUCT_WORD_PIPELINE_FIX.md). Earlier descriptions below of brand/decorative cutouts and full-picture provider input describe the prior implementation and are superseded.

# Offer templates: Product with Text

Upload an offer creative with products, characters, text and logos once; FrameFlow separates it into a reusable layered
template; then reuse it: replace products and characters in their slots, change the headline, offer and logos, make
variations, and open any creative in the editor with every element its own layer.

Workspace: **OpenAI + Seedream test → Offer Templates → New product template** (or *Create template → Product + Text*).
Template Studio's generated posters stay on their own tab. Text & Graphics masters are unchanged (they never read the
`product` field these templates add).

```
Create   Upload ─► Review ─► Prepare ─► Save
         (a sheet: choose one creative; cropped exactly, the upload kept)
         (local OCR; optional AI vision, one request, opt-in) (local; optional SAM-3, priced and confirmed) (version N)
Reuse    Use template ─► New creative ─► Replace / edit / move ─► Save (a new creative version) ─► Open in editor
Vary     Generate variations (3–5) ─► Save / Regenerate / Remove ─► Open & edit
```

## The two groups

| Group | What | Handling |
| --- | --- | --- |
| A · preserved overlays | text (word level, grouped into blocks with roles), bank and payment logos, QR codes, offer badges | stay editable; removed from the picture before anything else; **never** sent to any provider |
| B · visual objects | characters (each), products (each), the brand logo, podiums, frames, decorations | each its own cut-out layer; characters and products get a slot (box, contact line, target height, order) |

The server enforces A: `prepare.ts` removes every overlay, then `assertOverlaysGone` checks the clean picture (each
overlay's own pixels must have changed) before the cut-out service may see it; the service is given only that picture
(tested: `prepare.test.ts`, `prepareGate.test.ts`).

## What runs where

| Step | What runs | Cost |
| --- | --- | --- |
| Sheet detection, crop | local pixels (`sheet.ts`): artboards on a plain gutter, cropped without resampling | free |
| Detection | tesseract.js (local) for words, lines, plates, logo cards, QR codes, brand marks; optional **one** OpenAI vision request (the scene analysis, strict schema) for characters, products, logo kinds and text roles | free; AI an estimate of $0.05–0.25 (about 3–5k tokens in, 3–10k out with reasoning, at $4 / $20 per million), only when ticked |
| Review | the browser; one PUT of the whole state (revision-checked) | free |
| Prepare | local: overlays out (pattern-aware fill), gate, each object's mask from the background's colours (overlaps split by each object's own colours), soft rims unmixed, the base rebuilt behind the objects, two comparisons and per-object checks | free |
| Sharper cut-outs (optional) | SAM-3 on fal.ai, one request per object, the gated clean picture only | $0.01 per object, priced and confirmed in the page |
| Save | `product-r<n>.json`, a new file per version (never overwritten) | free |
| Creatives | stored files; replacement pictures cut out locally (own transparency kept; a plain backdrop removed; a scene kept and said so) | free |
| Open in editor | a run built locally from the creative's layers (`creativeRun.ts`), opened by the existing creative-run import | free |
| Variations | offline planner (fixed styles, free) or, when configured and confirmed, one OpenAI planning request; every plan is checked on the server (allowed colours, readable contrast, products only from the choices, mascot/frame/podium/brand logo kept, offer and legal text never rewritten, no new figures or offer words) | free / an estimated $0.08 |

## Storage

All in the protected template's folder (`artifacts/decomposition/protected-templates/pt-…`), next to its unchanged
original: `pclean-*`, `pbase-*`, `pcut-<object>-*`, `poverlays-*`, `precombined-*` (prepare, by content hash),
`product-r<n>.json` (versions), `pcr-<creative>-r<n>.json` (creative versions), `pca-*` (a creative's pictures),
`pvl-*` (the variation product library), `pvar-*` (variation jobs and previews). The record's `product` field
(`ProductInfo`, `PRODUCT_SCHEMA_VERSION` 1) holds detection, the reviewed objects, the preparation, approval and history.

## Limits (honest)

- Behind objects and removed text the background is an **estimate**: exact on plain fields and repeating patterns, a
  smooth blend on gradients, sunbursts and photos. It shows only when an object is moved or hidden; the share is reported.
- Local cut-outs follow colour differences; touching or overlapping objects of similar colours, and objects on busy
  artwork, need the cut-out service or a hand-drawn box.
- Small creatives (a 600 px sheet artboard) give small, soft cut-outs.
- Variations without the AI planner are deliberately conservative (product swaps, text colours, draft headlines).
