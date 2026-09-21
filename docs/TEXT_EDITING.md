# Milestone 2 implementation notes

## Document, UI, and interaction

The project/variant contains serializable text data in logical canvas pixels.
`editorSlice` implements add, update, move, width resize, duplicate, and delete.
`uiSlice` owns the selected ID. UI commands compose these actions without putting
selection, refs, resources, or DOM state into document reducers. Each meaningful
document change increments the variant revision; selecting or zooming does not.

New text scales from the logical canvas's shorter side. Headings use Lora 600,
subheadings Inter 600, body Inter 400. Defaults use 70% frame width and different
vertical regions, with a small stagger for repeated insertions. IDs come from
`crypto.randomUUID()` in the supported secure-context/local-development browsers.

## Coordinates and transforms

The stage is scaled for display. A Text node's `x()`/`y()` already belong to its
logical parent coordinates, so drag-end values must **not** be multiplied or
divided by the viewport scale again. Browser tests compare a real 40×25 screen-px
drag against the expected logical delta at two zoom levels on both screen sizes.

Side handles are the only resize handles. During a transform, compute
`node.width() * node.scaleX()`, assign that width, and reset node scale to 1.
Reflow therefore happens live without stretching glyphs. On release commit
`x/y/width` as one action, preserving font size and exact text. Selection uses
Konva Transformer, with a green one-pixel border and white 8px handles.

This follows the public Konva [text resizing pattern](https://konvajs.org/docs/select_and_transform/Resize_Text.html)
and [React Transformer attachment](https://konvajs.org/docs/react/Transformer.html).
The only synchronization effect attaches the selected node and refreshes its
bounds when text metrics change. No document updates are dispatched on pointer move.

## Recoverability and typography

Dragging retains a 24-logical-pixel strip of the text box in the frame (or the full
height when it is smaller). Numeric position/width controls use the same bound
policy, measuring natural height with a temporary Konva Text configured identically
to rendering. It is destroyed immediately; measurements never enter Redux.
This is position bounding, **not Auto Layout**: no fitting, font reduction, content
rewriting, or inter-element layout occurs.

Preset changes intentionally do not reposition text. The DOM element list and
numeric controls let users select/recover text even when its entire box is outside
the new frame. Empty content remains a selectable list row labelled “Empty text”.

Inter and Lora are bundled locally with real 400/600/700 weights and their OFL
licenses. `loadEditorFonts()` loads all six faces before the editor renders.
The canvas gets an explicit numeric font weight, and measurement uses the same
font family, weight, size, width, line height, letter spacing, and wrapping policy.

## Keyboard and input policy

Content updates immediately and retains whitespace/newlines. Numerical fields
keep their draft locally until Enter or blur; invalid drafts never reach Redux.
Font size/width clamp to the documented bounds. X/Y clamp to recoverable positions.
Escape reverts an in-progress numeric draft without deselecting the element.

The editor handles Delete/Backspace only when the canvas or element list owns
focus, and never from input/textarea/select/contenteditable, modifier shortcuts,
or IME composition. The inspector Delete button is explicit. Escape deselects
outside form fields. Duplicate copies content/style and offsets the new object;
at a boundary it tries the opposite offset to avoid an invisible coincident copy.

## Scope

No Auto Layout, undo/redo, persistence, AI, adaptation, PNG export, or inline editor.
History can later wrap the already discrete drag/resize actions. Content-edit
session grouping belongs to that history milestone; current text edits update
live without pretending to provide undo.
