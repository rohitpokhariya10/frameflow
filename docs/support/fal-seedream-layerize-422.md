# fal support package: `bytedance/seedream/v5/pro/layerize` HTTP 422 `invalid_request` on `body.image_url`

Sanitized: no credentials and no account data. Every request ID below is ours (one fal account). The full saved responses
and requests are local files (`artifacts/decomposition/layerize-experiment/<run>/provider-error.json`,
`seedream-request.json`).

## The request

- Endpoint `bytedance/seedream/v5/pro/layerize`, through the queue (`@fal-ai/client` 1.x). We call `queue.submit`, poll
  `queue.status` every 3 s, then `queue.result`.
- Input: `image_url` (a fal storage upload made by the same client seconds earlier, `v3b.fal.media/files/b/…`, 1-day
  lifecycle, public ACL), `prompt`, `image_size: "auto"`, `enhance_prompt_mode: "standard"`,
  `enable_safety_checker: true`, `sync_mode: false`.
- Images: PNG, 8-bit sRGB, no alpha, no ICC profile. Sizes are 1122×1402, 1216×1520 or 1186×1326 (1.6–1.9 MP), 1.5–2.1
  MB. All are within the documented limits: 512²–6000² pixels, aspect ratio 1/16–16, at most 30 MB.

## What fal returns

The result is HTTP 422, `x-fal-billable-units: 0`, with this body:

```json
{"detail":[{"loc":["body","image_url"],"msg":"The provided image could not be processed for layer decomposition. Try a different image.","type":"invalid_request","url":"https://docs.fal.ai/errors#invalid_request"}]}
```

`invalid_request` is not among the error types on fal's errors page. A download failure would be
`file_download_error`, and an unreadable image `image_load_error`.

## Verified on our side

1. **Each failing request is a new submission.** Each has a new request ID and a new upload; none is a cached or
   re-read result.
2. **The image URL serves exactly the bytes we sent.** For the four most recent rejections, an anonymous GET of the
   echoed `image_url` returned HTTP 200, `image/png`, the same length and the same sha256 as our file (checked
   2026-10-08 ≈08:40 UTC).
3. **Identical inputs produce different outcomes.** One pair had the same image bytes (sha256 `b79f1527bd8946b9…`) and a
   byte-identical prompt and parameters, differing only in the upload URL and time:
   - `01a11a24-e030-70e1-8a24-c42aa446d5ad` (06:13 UTC): 422.
   - `01a11a2a-75ea-7803-b88d-ef535e7a0825` (06:19 UTC): completed, layers usable.
   Two more requests with identical inputs were both rejected: `01a117fb-31fe-7e63-9f14-b70e13166ad5` and
   `01a117fd-49a7-7aa3-aec4-e11506c69975`.
4. **Rejected requests run before failing.** The queue reported each one `IN_PROGRESS` for 52–132 s before
   `COMPLETED`. Accepted requests took 55–174 s.
5. **The error's `Date` header is not the decision time.** It equals the submission second (within 2 s) in 13 of 14
   rejections, and was 213 s after submission in one.

## Rejected requests (all 422 `invalid_request` on `body.image_url`, 0 billable units)

| Submitted (UTC) | Request ID | Image sha256 (prefix) | Size | Prompt chars | IN_PROGRESS until result |
|---|---|---|---|---|---|
| 2026-10-07 20:08:20 | `01a117fb-31fe-7e63-9f14-b70e13166ad5` | `caff1ac5abc15fa6` | 1122×1402 | 1307 | 65 s |
| 2026-10-07 20:10:38 | `01a117fd-49a7-7aa3-aec4-e11506c69975` | `caff1ac5abc15fa6` | 1122×1402 | 1307 | 65 s |
| 2026-10-08 02:07:06 | `01a11943-a77e-7fb2-a64c-a70de9c655ba` | `eb1e0b92363a7cb2` | 1122×1402 | 559 | 74 s |
| 2026-10-08 05:07:14 | `01a119e8-93b7-7cb2-b7c9-462795933d79` | `cfcf506e3e482619` | 1216×1520 | 559 | 83 s |
| 2026-10-08 05:11:05 | `01a119ec-18c8-7cb1-bfdb-762bf6bf3a57` | `5b4d1c44c9a3c046` | 1216×1520 | 559 | 90 s |
| 2026-10-08 06:13:06 | `01a11a24-e030-70e1-8a24-c42aa446d5ad` | `b79f1527bd8946b9` | 1216×1520 | 576 | 52 s |
| 2026-10-08 08:14:37 | `01a11a94-216e-76f3-b37c-c1352d684440` | `caff1ac5abc15fa6` | 1122×1402 | 1353 | 68 s |
| 2026-10-08 08:28:57 | `01a11aa1-4058-78b3-aaa3-ad0ac0e3b43c` | `56d79119146b4335` | 1216×1520 | 704 | 104 s |

The same image `caff1ac5abc15fa6` was also accepted 4 times, with different prompts: `01a11744-…`, `01a11749-…`,
`01a1193f-…` and `01a11a99-63f4-7742-a85d-0de5e563d275`.

## Questions for fal

1. What does `invalid_request` on `body.image_url` mean for this endpoint? Does it come from the upstream model
   service, and at which stage: fetching the image, validating the prompt against the image, or validating the
   produced layers?
2. Why do identical inputs (point 3) both fail and succeed? Is there any server-side randomness or capacity condition
   behind this error?
3. Does the error's `Date` header reflect when the request was accepted rather than when it failed?
4. Are there image or prompt properties (layer count, prompt length, how many objects are described, depth ordering) that
   make this rejection more likely?

## One cause found on our side, fixed

For `01a11a94-216e-76f3-b37c-c1352d684440` our code had sent a self-contradictory prompt. It merged a product part (the
case lid, behind the earbud) into the part in front of the earbud (the case base). The planner had asked for 9
separate layers in a valid order. Since the fix this plan is sent as 8 layers in a valid order. Rejections also
happen without such a contradiction (`01a11aa1-…`, `01a11a24-…`), so this does not explain every case.
