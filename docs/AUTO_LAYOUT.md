# Deterministic text Auto Layout

Auto Layout fits one selected element into a safe rectangle. It is a local,
repeatable geometry operation with no AI request. The pure algorithm accepts a
measurement function; React only confirms fonts, invokes it, and applies the result.

## Measurement and content safety

The offscreen Konva Text uses the renderer's shared `textNodeStyle`: family,
weight, size, width, line height, letter spacing, alignment, and word wrapping.
Public `height()` and `getTextWidth()` measure natural line boxes, without a fixed
height or ellipsis. Nodes are destroyed after measurement. The selected bundled
font is confirmed with `document.fonts.load/check` before a user-triggered fit.

Konva can stop rendering a paragraph when even one grapheme cannot fit its width.
A short or zero measured height therefore does not prove that all text fits.
The adapter uses `Intl.Segmenter` and public `measureSize()` to verify every unique
grapheme fits. An incomplete candidate is rejected, even if its box appears small.
No private Konva arrays are used. Segmentation only validates metrics; it never
rewrites, splits, or replaces the authoritative `element.text` string.

## Fitting policy

1. Validate finite coordinates and positive dimensions. Empty text safely no-ops.
2. Measure the current element. Return `unchanged` if all four edges fit.
3. Try the original font at two widths: preferred width bounded between 35% and
   100% of the target width, then the full target width. This repairs very narrow
   columns. Clamp position only as far as necessary to fit.
4. Only if these candidates fail, use full width and a 16-step binary search for
   the largest fitting font above the effective floor. Retain a known-fitting
   lower bound. For supported 8–512 px fonts, the search interval ends below
   0.008 px; committed values retain their precision.
5. Re-measure the final candidate and verify all edges before returning `fitted`.
   If no readable candidate fits, return `unresolved` with the original object.

Safe margin is `clamp(round(min(canvas width, height) × 0.04), 12, 96)`.
The automatic font floor is `clamp(round(min(canvas width, height) × 18 / 1080), 10, 32)`.
The effective floor is the smaller of that value and the original font size,
so intentionally small text never enlarges. Bounds allow one logical pixel of
tolerance. Zoom never participates in fitting.

The changes list reports actual movement, widening, and font reduction. “Wrapped”
is reported only when the measured line count increases beyond both the original
count and explicit paragraph count. Width changes alone do not imply wrapping.

## UI and document boundary

Overflow is derived from current measured width, wrapped height, and completeness;
it is memoized for the selected element/canvas, not saved in document state.
The fitting search runs only on click, never during pointer movement. A restrained
amber warning becomes actionable unresolved feedback when fitting fails. Success
and unchanged feedback describe the actual outcome. Editing invalidates old feedback.

One `textAutoLayoutApplied` action updates x/y/width/font size and increments the
variant revision once. It cannot overwrite text or unrelated styling. Revision
and selection checks reject results made stale during font loading. History can
later wrap this action; history and persistence are not implemented here.

A fitted result has already passed the same check used at the algorithm's entry.
A second call therefore returns `unchanged`, and the UI dispatches no document
operation. This is the basis of idempotence, tested with both policy fixtures and
real Inter/Lora browser rendering.

## Boundaries and verification

This fits one text box; it does not resolve collisions with other elements or
invent a new composition. Metrics represent Konva's natural line boxes, not a
pixel-by-pixel glyph-ink contour. Emoji and scripts outside bundled Latin fonts
use platform fallback fonts and may differ across operating systems. The editor
requires a modern browser with Font Loading API and `Intl.Segmenter` support.

Unit tests isolate policy with an injected measurement double. Chrome tests use
actual loaded Inter/Lora, real canvas nodes, UI changes, narrow emoji/token text,
font reduction, preserved paragraphs, impossible fits, and repeated fitting.
Screenshots at 1440×900 and 1366×768 verify warning/result visibility and controls.
