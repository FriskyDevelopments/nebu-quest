# Monthly design via Hermes Stitch

NEBU doesn't call Stitch itself. It hands the job to Frisky's Hermes Stitch dispatcher (`stitch.sh`, which round-robins 4 keys and runs detached). Hermes then calls NEBU back. Code: `worker/src/stitch.js`.

## Keys (Worker secrets)
| Name | What |
|---|---|
| `HERMES_STITCH_URL` | Base URL of the Hermes dispatcher, e.g. `https://hermes.example/`. When unset, NEBU uses the built-in mock. |
| `HERMES_STITCH_SECRET` | Shared HMAC secret, used in both directions. |
| `STITCH_SAMPLE_BASE` (var, optional) | Where the mock gets its sample screens. Defaults to the preview `/studio/stitch-samples/`. |

## 1. Dispatch (NEBU → Hermes)
`POST {HERMES_STITCH_URL}/stitch/jobs`

```json
{ "job_id": "sj_…", "frisky_id": "fd_…", "prompt": "…", "kind": "element" | "set", "count": 1-5, "callback_url": "https://<worker>/api/stitch/callback" }
```
- Header `X-Nebu-Signature`: lowercase hex HMAC-SHA256 of the exact raw body, keyed with `HERMES_STITCH_SECRET`. A `sha256=` prefix is also accepted.
- Hermes answers `202 {"job_id": "…"}`. Any other answer, or no answer within 10 s, fails the job and refunds the quota right away.
- `kind: "element"` means count = 1; `kind: "set"` allows 2–5.

## 2. Callback (Hermes → NEBU)
`POST {callback_url}` with the same signature header, computed over this body:

```json
{ "job_id": "sj_…", "status": "designing" | "ready" | "failed", "screens": [{ "htmlCode": "<div>…</div>", "screenshotUrl": "https://…png" }], "error": "optional" }
```
- The signature is checked in constant time. A bad signature gets `401`. An unknown job gets `404`.
- **Idempotent per `job_id`.** Once a job is `ready` or `failed`, repeats get `200 {"already": …}`. A `ready` claims the job first (`saving`), so two `ready` callbacks racing each other can't save twice. `designing` can repeat freely.
- On `ready`, every `screenshotUrl` is downloaded **right away** into R2 (`nebu-packs-preview`, key `packs/stitch/<frisky_id>/<job_id>/<n>.<ext>`) because those URLs can expire. Rules: https only, `image/png|jpeg|webp|svg+xml`, 6 MB max each. `htmlCode` (512 KB max) is stored next to it as `<n>.html`: that's the layered, editable source.
- A pack called `Monthly design · YYYY-MM` shows up in My packs. Each screen is one `design` layer (`src` = image, `source` = HTML). Files are served signed, with `CSP: sandbox` and `nosniff`.
- If a download fails, the job fails and the quota is refunded.

## 3. Quota
One job per calendar month (UTC) per FRISKY ID. The slot is reserved at dispatch (`stitch_quota` with primary key owner+month, so it's atomic). If the job fails at any point (dispatch, `failed` callback, save error), the slot is deleted, which is the refund.

## 4. Status in the studio
Show panel → My packs → "Your monthly design". The status reads **Queued → Designing → Ready** (or **Failed · refunded**) and refreshes every 2.5 s while a job is running. "Open" drops the screens onto the program as movable layers.

## 5. Mock (no `HERMES_STITCH_URL`)
The same contract runs end to end: about 1.5 s later it sends `designing`, about 4.5 s after that `ready` with sample SVG screens and HTML. Both callbacks are HMAC-signed and go through the real callback handler, including the R2 download. Put the word "fail" in the prompt to exercise the refund path. The mock signing key is derived from `NEBU_SESSION_SECRET`, so nobody outside can forge callbacks.

## Worker routes
- `GET /stitch` (session): `{month, available, mode, jobs[]}`
- `POST /stitch` (session) `{prompt, kind, count}`: `202 {job_id, status:"queued", mode}` · `409 monthly_used` · `400 prompt_too_short` · `502` (Hermes down, refunded)
- `POST /api/stitch/callback` (signed)

This replaces the old free monthly path in `/requests`. `/requests` is only kept for paid extras, which are design-only in this PR.
