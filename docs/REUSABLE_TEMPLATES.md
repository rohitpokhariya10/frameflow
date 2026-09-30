# Reusable templates ("Create Own Template")

A **template** is a fixed, reusable design structure. A **creative** is one content-filled instance of it. One template
gives many creatives (Diwali, Holi, Christmas) with the same geometry in every supported aspect ratio; only the content
the template author marked editable changes.

The whole feature is local and deterministic. It makes no OpenAI, fal or Seedream call and no request of any kind:
templates and creatives are JSON in this browser's `localStorage`, pictures are in its IndexedDB asset store. It works
with no API keys, no server and no network. It is unrelated to the layerize Templates A/B/C, which are decomposition
recipes.

Open it with the **Create Own Template** button (bottom right, next to the two AI test buttons).

## Where the code is

| Part | Location |
|---|---|
| The element model shared with the editor | `shared/src/canvasElement.ts` |
| Lossless conversion to and from the editor's format | `shared/src/canvasEditorAdapter.ts` |
| Template schema, validation | `shared/src/designTemplates/schema.ts` |
| Normalized ↔ pixel math, canvas sizes, image fit | `shared/src/designTemplates/geometry.ts` |
| Authoring operations (add, move, resize, reorder) | `shared/src/designTemplates/editing.ts` |
| Creatives and content overrides | `shared/src/designTemplates/creative.ts` |
| Template → pixel boxes for one canvas | `shared/src/designTemplates/resolve.ts` |
| Text overflow policy | `shared/src/designTemplates/textFit.ts` |
| Library: save, versions, rename, duplicate, load | `shared/src/designTemplates/library.ts` |
| Studio, author editor, creative editor, Konva canvas | `client/src/features/templates/` |

Everything under `shared/` is pure functions with no React or Konva. The Konva canvas only draws the pixel boxes it is
given and reports pixels back; the conversion is one shared function.

## Normalized layout

Geometry is stored as fractions of the canvas, never as pixels:

```
layout: { x, y, width, height, rotation }      x, y, width, height in 0..1; rotation in degrees

toPixels      pixelX = x × canvasWidth          pixelY = y × canvasHeight
              pixelWidth = width × canvasWidth  pixelHeight = height × canvasHeight
toNormalized  x = pixelX / canvasWidth          y = pixelY / canvasHeight   (same for width and height)
```

- The box is the unrotated box; `x`, `y` is its top-left corner. Rotation turns it about its centre and is the same
  number of degrees in every ratio.
- Stored values are rounded to 6 decimals and clamped: `width`, `height` in `0.005..1`, `x` in `0..1 − width`, `y` in
  `0..1 − height`. An element cannot leave the canvas, have a negative position or collapse to nothing. Values that
  are not finite numbers are refused.
- Pixels are converted back only when the author drops or resizes an element, once, and only for the values that
  gesture changed (a drag writes `x` and `y`; `width`, `height` and `rotation` keep their stored values). Together with
  the rounding this makes the round trip exact: there is no drift, however often the ratio is switched.
- There are no per-ratio layouts, overrides or automatic rearrangement. Switching the ratio changes the canvas the one
  layout is resolved against, and nothing else.

Supported ratios and their canvases (short edge 1080 px): `1:1` 1080×1080, `4:5` 1080×1350, `3:4` 1080×1440,
`9:16` 1080×1920, `16:9` 1920×1080. A heading at `x 0.05, y 0.05, width 0.6, height 0.1` is at 54, 54, 648×108 px on
1:1 and 54, 67.5, 648×135 px on 4:5: 5% from the top in both.

### Sizes that are not boxes

| Value | Stored as | Pixels |
|---|---|---|
| Font size, smallest font size | fraction of the canvas **short edge** | `fontSize × min(canvasWidth, canvasHeight)` |
| Letter spacing | em | `letterSpacing × fontPx` |
| Line height | multiple of the font size | `lineHeight × fontPx` |
| Corner radius | 0..1 of half the box's shorter side (1 = pill) | `cornerRadius × min(boxWidth, boxHeight) / 2` |
| Outline width | fraction of the canvas short edge | `strokeWidth × min(canvasWidth, canvasHeight)` |

The short edge is used for text because it is what a portrait and a landscape canvas of the same family share: a
heading keeps its visual weight when the ratio changes, and doubles when the canvas doubles.

## Elements

| Type | Roles | Notes |
|---|---|---|
| `text` | heading, subheading, paragraph, offer, cta, generic-text | A CTA is a text with a filled box behind it. |
| `image` | hero, logo, product, generic-image | A fixed slot: `cover` or `contain`, with a focal point (0..1). Replacing the picture never changes the box. |
| `shape` | rectangle, rounded-rectangle, circle, ellipse, decorative | A circle is the largest circle centred in its box, so it stays round in every ratio; an ellipse fills its box. |
| `background` | background | At most one; always the full canvas and the lowest layer. A colour, optionally an image. |

Roles are generic; nothing is specific to one company or campaign. Layer order is an explicit `zIndex`, numbered
0, 1, 2 … with the background at 0, and is identical in every ratio.

Fonts are the editor's bundled fonts (Inter, Lora). A template naming another font still loads, with a warning, and
is drawn in Inter. An empty image slot, or a picture missing from this browser, is drawn as a placeholder in its box.

## Text overflow

Longer wording never moves or resizes anything. Per text element (`behavior`):

1. wrap inside the box width at the design font size;
2. it fits when it needs no more lines than `maxLines` and the box height allow;
3. otherwise, with `overflow: "shrink"`, use the largest of 32 evenly spaced sizes between the design size and
   `minFontSize` that fits;
4. if nothing fits, or with `overflow: "ellipsis"`, keep the lines that fit and end them with an ellipsis, and show a
   warning.

## Editable and locked properties

Each element says what a creative may change: `content`, `color`, `backgroundColor`, `image`, `fontFamily`,
`position`, `size`, `rotation`. Anything not set to `true` is locked.

- **Template author** mode: geometry, order, style and these flags are all editable.
- **Creative** mode: only the flagged properties. Geometry is locked, and the canvas ignores drags, unless the author
  ticked `position`, `size` or `rotation` for that element; then the change is stored as a normalized override on the
  creative, still clamped to the canvas.

A creative stores a reference and its differences only:

```
Creative { id, name, templateId, templateVersion, aspectRatio, contentOverrides: { [elementId]: { text?, color?, … } } }
```

An override the template does not allow is refused when it is made, refused again when the creative is saved, and
ignored (with a warning) if it is found in stored data.

## Versions

A saved template version is immutable.

- Saving an edited template whose **structure** changed adds version n+1; earlier versions are left as they were.
- A creative records the version it was made with and is always rendered with exactly that version, so editing a
  template cannot change or break existing creatives.
- Moving a creative to the newest version is an explicit button. Overrides the new version no longer allows are
  dropped and listed.
- The name is a label: renaming creates no version.
- Old versions are kept. No version is removed automatically, whether or not a creative uses it; versions go only
  when their whole template is deleted.
- A template with creatives cannot be deleted until its creatives are.

## Storage

`localStorage["frameflow:design-templates:v1"]` holds `{ schemaVersion, templates, creatives }`. Every entry is
validated on load. A malformed entry is set aside with its problems, shown as a warning, and written back untouched;
it is never repaired by guessing and never takes the valid entries down with it. Text that cannot be read at all is
moved to `…:unreadable` before an empty library is started.

Pictures are stored once in the asset store and referenced by id. They are not removed when an element is deleted,
because an older template version or a creative may still use them.

## Open in editor: one shared element model

Template Studio, Creative mode and the existing editor understand the same element properties, so opening a creative
in the editor loses nothing.

- **`CanvasElement`** (`shared/src/canvasElement.ts`) is the one element model: id, type, role, normalized `x`, `y`,
  `width`, `height`, rotation, `zIndex`, visibility, and per type the text, image, shape and background properties
  described above. Template Studio authors it; a creative is a template's `CanvasElement[]` plus content overrides.
- **The editor keeps its own pixel document format**, extended with optional fields so it can hold every one of those
  properties. Nothing in an older document changes: the new fields are absent there, and absent means "as before".
- **Two pure adapters** (`shared/src/canvasEditorAdapter.ts`) connect them: `canvasElementsToVariant()` and
  `variantToCanvasElements()`. Going to the editor and back returns the same `CanvasElement[]`.

```
template CanvasElement[]  +  creative overrides  →  complete CanvasElement[]  (normalized)
                                                 →  canvasElementsToVariant(canvas)  →  editor design (pixels)
                                                 ←  variantToCanvasElements          ←
```

| Property | In the editor's element | How the editor uses it |
|---|---|---|
| Layer order | `zIndex` on text and on layers | Draws text and layers interleaved in that one order. A text below an image stays below it. |
| Rotation | `rotation` on text (layers already had it) | Draws the text rotated. |
| Overflow rules | `height`, `maxLines`, `overflow`, `minFontSize`, `verticalAlign` on text | Draws the text box with the same function Template Studio uses. |
| Raw text | `text`, unchanged | Shrinking and the ellipsis happen only when drawing. The stored text and font size are never altered. |
| Image slot | `fit`, `focalPoint`, `radius`, the original `assetId` (a copy) | Crops or letterboxes when drawing; the picture is not flattened. An empty slot stays an element. |
| Shapes | `shapeType` (now also `circle`), `role`, fill, stroke, radius, gradient | A circle keeps its box and stays round. |
| CTA | one text with `box` (fill and radius) | One element, not a text plus a separate shape. |
| Background | canvas colour, background artwork, and the element's id and name under `template.background` | Unchanged editor features. |
| Editable flags | `editable` | Kept as metadata; the editor itself edits freely. |

Geometry: the editor stores pixels, computed as `normalized × canvas size` with no rounding. Converting back divides
by the canvas size and rounds to 6 decimals, which returns the stored template value exactly. A text box or layer in
the editor turns about its own top-left corner while a template box turns about its centre; the adapters convert
between the two, exactly for unrotated elements and to within rounding otherwise.

### What belongs to whom

Opening a creative creates an **independent design version** in the editor's own document, recorded as
`template: { templateId, templateVersion, creativeId }`. It gets its own copy of every picture and shares no data with
the template or the creative.

- Edits in the editor belong to that design and are saved with it. They never change the template or the creative.
- The template's geometry can only be changed in Template Studio, with Edit Template, which saves a new version.
- There is no "save back" from the editor into a template or creative. `variantToCanvasElements()` exists so that an
  editor design can be read as the shared model, and is what the round-trip tests use.

### Backward compatibility

- Every new field is optional, so documents saved before this change load unchanged and are rewritten unchanged.
- A design with no `zIndex` anywhere is drawn exactly as before: its layers, then all its text. The reducers leave
  such a design in the old format; they only maintain `zIndex` in a design that already has one.
- A design saved with the new fields cannot be opened by an older build, whose schema rejects unknown fields.

### Limits that remain

These are not losses, but are worth knowing:

- **Refused, not altered:** a text the editor's limits do not allow is refused with the reason instead of being
  changed: a font size under 8 px or over 512 px on the chosen canvas, a text box narrower than 32 px, or a font the
  editor does not have.
- **A missing picture** stops the hand-off with a message; nothing is dropped.
- **No editor controls yet** for a text's rotation, its overflow rules or its place among the layers. The editor
  keeps, draws and saves them, and the Text panel states the rules of a fixed text box, but they can only be changed
  in Template Studio. Layers can be reordered among the layers as before.
- **Auto Layout** treats a fixed text box as free text: it may change its position, width and font size.

## Not in this version

Per-ratio layout overrides, automatic rearrangement, undo in the template editor, export straight from the template
canvas (open in the editor and export there), sharing templates between browsers, removing old template versions,
and cleaning up unused pictures.
