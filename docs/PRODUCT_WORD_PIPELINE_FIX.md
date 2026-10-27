# Product with Text verification — 22 October 2026

The editable pipeline is verified offline against the actual cropped LG reference. **Full acceptance is not yet met:** real AI detection accuracy is unverified, and the local background/cutout estimate is not suitable for unrestricted object movement. No paid provider was called ($0).

## Defects and fixes

- **Zero characters/products:** the upload defaulted to local OCR, which cannot detect these objects. The service previously marked that scan done. A Product-only word/object vision schema now requests separate objects and measured words. Skipped/failed AI is explicitly incomplete and blocks preparation. Offline detections are labelled as fixtures. No Ganesh coordinates occur in the production analyzer.
- **Text blocks instead of editable words:** the editor import discarded word metadata. Product runs now retain word/group/line identities and original crop/box evidence. Each word imports as native text; the Text panel groups words under collapsible headlines, with an individual-word mode. Group drag is Product-only. The original Text workflow retains its existing import behavior.
- **Bad word rendering:** font matching used loose rectangles, and the browser measured fonts before loading them. Matching now uses tight ink bounds while retaining original source boxes, waits for fonts before Product import, and expands a changed word's width without reflowing its neighbors. Fonts remain estimates.
- **Green fragments classified as logos:** local color-tile guesses were treated as bank logos. Successful vision analysis now supplies authoritative logo identities/boxes; unknown logos need review. Each saved logo is a lossless source crop, separate from text and objects. Brand logos are overlays; old brand objects migrate through review.
- **Overbroad decomposition:** preparation included brand logos, podiums and decorations and passed a complete clean poster. The server now limits targets to accepted characters/products. Every actual provider PNG is a separate masked crop; all detected text/logo exclusions (including physical brand marks and rotated boxes) have zero RGB and alpha. Invalid/empty/heavily obscured crops fail before the batch's first request. Returned masks are dimension-checked, mapped into source coordinates, and constrained to the seed/exclusion masks. Input hashes and boxes are recorded. No whole-poster segmentation request remains in this path.
- **Overlay artifacts and broad smearing:** original word/logo source assets are stored before removal. AI manifests use narrow masked overlay fills; uncertain patches are listed for review. The local AI-manifest background path no longer blurs broad holes. Local cutout rims preserve visible source colors instead of inferring alpha against an uncertain background. Missing hidden artwork is not claimed recovered.
- **Run/editor handoff:** saved Product creatives now have Send to Decomposition and reuse the existing run dashboard, Saved Runs, native editor and PNG export. Saved layers are reused without another AI/segmentation call. Preparation reuse checks the preparation version and both analysis/object revisions.

## Actual reference evidence

The input was the first creative cropped from the real `Ganesh-Chaturthi.png`, 607 × 606 px. **The detector response was a handmade test manifest, not a recorded or live AI response.** The fixture includes 42 words in 5 groups, 18 logos (LG, Pine Labs and 16 bank/payment tiles), 1 Ganesha character, 8 separate product targets, and a background structure. These counts prove data handling, not detection recall.

The browser walked Upload → Review → Prepare → Save Template → New Creative → Send to Decomposition → run dashboard → Open Editor → edit → reload/Saved Runs → reopen → PNG export. It also checked the review at 390 px without horizontal overflow.

- All 42 words imported as native text with individual word metadata.
- `grand` became `amazing`; X moved from 278.9 to 308.9, Y stayed 68.85. Every neighboring word object compared equal before/after. The word remained selectable and editable after reopening. Width grew to accommodate the new text.
- The LG image overlay moved 12 px left. Its independent layer and changed position survived reopening.
- 9 separate object layers plus background and 18 logo images imported (28 image layers). Text remained native text.
- PNG export is 607 × 606 and was opened for visual inspection.
- Browser assertions compare the clean prepared picture with background + local cutouts; visible pixel difference is below 0.01%, guarding against new edge damage at the original placements.

Screenshots and images are in [the evidence gallery](../test-results/product-v2/report.html). Machine-readable edit evidence: [browser-evidence.json](../test-results/product-v2/browser-evidence.json).

## Limits that remain

1. **Real AI quality is unverified.** No evidence yet establishes recall, transcription accuracy, logo identity, individual-object precision or coordinate accuracy of a live response. The configured scene model is used (code default `gpt-5.6-sol`, overridable with `OPENAI_SCENE_MODEL`). A future live validation would require explicit authorization for one analysis request and a fresh price estimate. This task made zero such requests.
2. **Background-only preview still has object remnants and hard estimated bands.** Local color masks miss some pale product surfaces. The masked background cannot reveal the original artwork hidden by a flattened foreground. The UI flags this. Moving/hiding these local cutouts is not visually accepted; clean source artwork or corrected cutouts are needed for reliable results. Removing blur does not make the hidden artwork accurate.
3. **Small badge/legal typography is approximate.** The font/spacing reconstruction is editable but not pixel-identical. The narrow offer/badge repairs also interrupt some underlying design. These uncertainties must be reviewed.
4. **Isolation is conditional on detection and the mask.** Tests establish zero bytes at every known text/logo exclusion and outside each seed mask, plus separate request images. They do not prove an imperfect detector/mask finds every printed pixel or removes every background fragment. The product preview flags local masks as estimates. No live SAM-3 quality claim is made.
5. Product packaging/TV-screen lettering remains part of visible product appearance in local previews. Known physical brand marks are excluded from provider requests; they are not all converted to editable advertising overlays.

The clean preview removes the detected advertising headline, top LG/Pine logos, offer words, badge lettering, bank tiles and footer text. The green banner is clear. This does **not** justify claiming that all hidden background, every product edge after movement, or live AI accuracy is solved.

## Verification

- `npm run typecheck`: passed across client, server, shared and tests.
- `npm run build`: passed. Vite reports its existing large-bundle advisory.
- Focused Product/import suite: **6 files, 17 tests passed**, including schema validation, immutable logo pixels, narrow-mask repair, rotated exclusions, actual fake-provider request bytes, rejected categories, preparation, routes, saved creatives and editor import. See `test-results/product-v2/final-unit.log`.
- Existing Text master/server/import regression suite: **3 files, 10 tests passed** (`regression.log`). The moved cross-workspace safety test was initially excluded by Vitest's glob; `vitest.config.ts` now includes `tests/unit`, and all three safety tests are included in the 17-test result.
- Existing Text browser scenario “a different poster becomes a master…”: **passed**, including native word/logo editing, reuse and reopen (`browser-final.log`). The following Product scenario in that invocation was interrupted after a concurrent build removed `client/dist/index.html`; it was rerun separately after the build, not counted as passed.
- Final actual-reference Product browser scenario: **1 passed** (`browser-verified.log`), including mobile review, word/neighbor assertions, moved logo, save/reopen, image-layer count and exported PNG.
- Focused ESLint for Product server/UI and new tests: passed (`lint.log`). No claim that the whole previously dirty repository's lint suite passes.
- Earlier focused failures were stale assumptions about brand/podium decomposition, full-poster provider input, six object layers and source-raster text previews. Their assertions now match the required semantics. A temporary TypeScript error from importing a test fixture outside server rootDir was resolved by locating that test under `tests/unit`; a rotated-box union type error was also fixed.

## Files and preservation

[task-files.txt](../test-results/product-v2/task-files.txt) lists the exact source/test/config files changed for this resumed fix. `docs/PRODUCT_WORD_PIPELINE_FIX.md`, the updated Product documentation notice, and the evidence/report files were also written. This inventory covers the task changes carried forward and completed in this conversation; it does not attribute every pre-existing uncommitted change to this fix. Many Product/Protected modules were already untracked at entry, so Git alone cannot reconstruct an exact edit history for earlier stopped sessions. The entry and final working-tree inventories are retained in `git-before.txt` and `git-current.txt`.

No reset, stash, clean, commit or push was performed. The original two source images and all 745 previously recorded artifact files have unchanged SHA-256 hashes: **747 checked, 0 changed, 0 missing** ([safety verification](../test-results/product-v2/safety-verification.json)). Browser/API tests used temporary stores and isolated loopback port 3349. No existing development server was stopped and no original template/run was overwritten. All provider tests injected fakes; browser external requests were blocked and provider keys blanked.

## Manual check

1. For the paid-free reproducible demonstration, build the app and run the `product-words.spec.ts` command recorded in `browser-verified.log`/the test source with `FRAMEFLOW_PRODUCT_REFERENCE=1` and `FRAMEFLOW_OFFLINE_E2E_PORT=3349`. This flag is an explicit handmade fixture mode.
2. In Offer Templates, choose Product with Text, upload Ganesh, and choose its first creative. Read the fixture/incomplete-analysis status. A normal upload without AI approval must remain incomplete rather than show successful object detection.
3. Review each word group, character, product and logo. Prepare locally, then inspect Without text and logos, Background only and every cutout. Do not treat acknowledging an estimate as proof that its artwork is accurate.
4. Save a template, create a creative and choose Send to Decomposition. Open the run in the existing editor. Expand a headline and select a single word. Change its text/X position; verify neighbors stay put. Select and move the LG logo.
5. Wait for “Saved on this device”, reload, open the same Saved Run, and open it in the editor. Verify the word is still editable and the logo is still separate. Export PNG and inspect at full resolution.
6. For quality beyond the local estimate, supply clean original artwork/corrected cutouts or separately authorize provider validation. No paid validation is triggered by these offline instructions.
