# Template and creative undo/redo

Create Own Template and Use Template expose Undo and Redo beside the name and ratio controls. Disabled buttons indicate an empty stack. Shortcuts are Cmd+Z / Cmd+Shift+Z on macOS and Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y on Windows/Linux. The existing keyboard helper leaves inputs, textareas, selects, contenteditable descendants and IME composition to the browser; handled canvas shortcuts stop propagation to the main design editor.

## State and scope

`TemplateStudio` owns one `useTemplateHistory` manager around its canonical author draft or derived creative. `templateHistoryReducer` holds `past`, `present` and `future`, capped at **50 actions**. Incoming documents are cloned to detach caller-owned objects. Editing uses immutable shared model functions. New edits clear the redo branch; unchanged documents do not add entries. History stores asset IDs, not image blobs/base64 or decoded images. Binary assets remain in the existing IndexedDB repository so earlier replacements can be restored.

Saved baselines and library versions remain outside history. Save retains the editing history and updates the baseline; undoing a saved change makes the draft dirty without rewriting the saved library. Opening/reopening another template or creative, starting a new template, closing the studio or reloading starts fresh history. Sidebar library rename also resets the active session. Library deletion/duplication, saved version records and the separate editor handoff are not canvas-history actions.

Each session has a generation counter. An asynchronous edit callback belonging to a previous session is ignored. Hover, selection, dropdowns, font searches, font-loading status and AI drafts are not stored.

## Meaningful actions

- Add, duplicate, delete and reorder elements; content, role, styling, permissions, image fitting and other inspector edits all pass through the same history boundary.
- The existing canvas commits only at drag-end/transform-end. Intermediate pointer moves update Konva geometry without creating or cloning snapshots. Resize and rotation each become one action.
- Disabled history buttons retain native disabled semantics but use `pointer-events: none`, so releasing a canvas drag over them reaches their wrapper and Konva's drag-end listener. This fixes the laptop edge-drag regression reproduced during verification.
- Continuous text and numeric input changes share the focused field's transaction. Blur ends the transaction. Discrete controls, theme applications and completed image replacements create separate actions.
- Curated replacement, legacy theme styling/font pairing and explicit AI Apply each restore the entire prior canvas with one Undo. Creating/discarding an AI draft has no history effect. Undo and Redo never invoke a provider or regenerate a theme.
- Template ratio browsing is local view state. Creative ratio selection is saved with the creative but does not add an action or discard redo. Undo/Redo retains the current viewed ratio when supported by the restored template version. Author geometry snapshots include all ratio layouts, so undoing a 16:9 edit leaves the other layouts unchanged. Existing creative permissions and override semantics are retained.
- Product and logo replacement restores the previous asset ID. Restored font families use the normal font loader/fallback path. No asset duplication or provider call is needed.
- Selection stays when its ID exists. A missing selected ID is cleared before rendering the inspector. Undoing deletion restores the complete element; it does not automatically select it.

## Verification and limits

Unit coverage exercises actions on real template/creative models: element add/delete/duplicate, geometry, text grouping, typography/color, image replacement/fit, order, all five curated applications, AI Apply, theme styling, immutable snapshots, redo invalidation, capacity, session isolation and stale callbacks. Browser coverage uses real typing, canvas drag/resize/rotation, both image slots, keyboard modifiers, focus safety, independent creative editing, save/reload and mocked AI request counts.

History is intentionally not persisted. Native text-field undo remains browser-owned and can have different grouping from canvas-history buttons. Asset lifetime follows the existing browser-local asset store; this change does not add asset garbage collection. No live OpenAI, fal or Seedream requests are used in development verification.

A local timing sample on an approximately 18 KB Mega Sale document took 76 ms for 500 edit commits and 1 ms for 500 Undo/Redo pairs, retaining exactly 50 actions. These are reducer timings on the development machine, not browser rendering or a device-independent latency guarantee.

## Final verification

- Focused template/history/theme/font/planner units: **140 passed**, including 29 history cases.
- Corrected full offline browser suite: **257 passed / 0 failed**, across 1366, 1440 and 1920 widths. The subsequently added disabled Undo/Redo drag test passed at all three widths (**3 passed / 0 failed**), with no application source changes after the full run. It checks canonical and saved geometry, one-step Undo and one-step Redo for each disabled control. Toolbar screenshots were reviewed at all three widths.
- Full units: **1,034 passed / 3 failed**. All three failures match the already reproduced unchanged-main baseline (`3853b7195d7e57c5c174a2136e484bc36d33b6d8`, 932 passed / 3 failed): `decomposition/repository.test.ts` worker lease, `decomposition/reviewFlow.test.ts` phase 4 versus 5, and `decomposition/router.test.ts` HTTP 503 versus 202. No decomposition implementation was changed.
- Final typecheck, lint, production build and diff checks passed. The build retains its pre-existing large-chunk warning. OpenAI/fal/Seedream development calls: **0**.

Browser artifacts and logs stay outside the commit. Existing Diwali (including Luxury Gold), Dhanteras/Holi, Custom, saved-template, font, image, editor, Template A/B/C and Create Template from Image journeys pass. The separate proposed set of five premium reference-inspired templates is not part of this Undo/Redo change.
