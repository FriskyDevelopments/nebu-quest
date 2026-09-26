# Monthly design: Code Pup Design (Stitch through Hermes)

The monthly design is made by **Code Pup Design**, the design side of Code Pup (same brand as the code review). Code Pup Design uses Stitch through Hermes. NEBU doesn't call Stitch itself. It hands the job to Frisky's Hermes Stitch dispatcher (`stitch.sh`, which round-robins 4 keys and runs detached). Hermes then calls NEBU back. Code: `worker/src/stitch.js`.

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
- Optional pipeline fields (NEBU always sends them; Hermes should treat missing ones as these defaults):
  - `brief_mode: "auto" | "provided"`. `auto` (default): the user gave an idea, and if it's vague a stronger reasoning model first writes a concrete design brief, which then goes to Stitch. `provided`: the user wrote the brief themselves, so it goes straight to Stitch. The studio sets this from the "This is already a full brief" checkbox.
  - `rounds: 3`. Stitch runs 3 rounds. Between rounds, a vision-capable model reviews the screenshot against the brief and writes the refinement prompt for the next round.
  - `nice_touch: true`. Every design gets one "nice touch": a tasteful extra detail the user didn't ask for, in line with the brief and the FR!SKY/NEBU style.

## 2. Callback (Hermes → NEBU)
`POST {callback_url}` with the same signature header, computed over this body:

```json
{ "job_id": "sj_…", "status": "designing" | "ready" | "failed", "round": 1, "screens": [{ "htmlCode": "<div>…</div>", "screenshotUrl": "https://…png" }], "nice_touch": "optional, one line", "error": "optional" }
```
- `round` (optional, 1–3) on `designing` callbacks reports which Stitch round is running. The studio shows **Designing · round 2/3**. Rounds only move forward, so a late or duplicate callback for an earlier round is ignored.
- `nice_touch` (optional) on `ready` is a one-line description of the extra detail. It gets stored with the pack and shown as a **✦ Nice touch** flag on the result.
- Screens in `ready` come from the final (third) round only.
- The signature is checked in constant time. A bad signature gets `401`. An unknown job gets `404`.
- **Idempotent per `job_id`.** Once a job is `ready` or `failed`, repeats get `200 {"already": …}`. A `ready` claims the job first (`saving`), so two `ready` callbacks racing each other can't save twice. `designing` can repeat freely.
- On `ready`, every `screenshotUrl` is downloaded **right away** into R2 (`nebu-packs-preview`, key `packs/stitch/<frisky_id>/<job_id>/<n>.<ext>`) because those URLs can expire. Rules: https only, `image/png|jpeg|webp|svg+xml`, 6 MB max each. `htmlCode` (512 KB max) is stored next to it as `<n>.html`: that's the layered, editable source.
- A pack called `Monthly design · YYYY-MM` shows up in My packs. Each screen is one `design` layer (`src` = image, `source` = HTML). Files are served signed, with `CSP: sandbox` and `nosniff`.
- If a download fails, the job fails and the quota is refunded.

## 3. Model costs
The brief model (reasoning) and the review model (vision) are FR!SKY's cost, paid inside the plan. They are **not** deducted from the user's AI credits. Hermes caps that spend per design; when the cap is hit, it finishes with the rounds done so far instead of calling more models.

## 4. Capacity and terms risk
Stitch currently runs on a small pool of personal Google AI Pro accounts through the Hermes dispatcher (`stitch.sh`, round-robin, detached). So:
- Hermes must queue and throttle jobs. NEBU treats `202` as "accepted into the queue", not "started", and the studio shows **Queued** until the first `designing` callback.
- Before selling this at scale, check Stitch's terms and usage limits for this kind of use, and move to an official or business plan if one exists.
- If capacity runs out or the terms don't allow it, jobs fail and get refunded (see Quota). Nothing is charged for a design that wasn't delivered.

## 5. Quota
One job per calendar month (UTC) per FRISKY ID. The slot is reserved at dispatch (`stitch_quota` with primary key owner+month, so it's atomic). If the job fails at any point (dispatch, `failed` callback, save error), the slot is deleted, which is the refund.

## 6. Status in the studio
Show panel → My packs → "Your monthly design · by Code Pup Design". The status reads **Queued → Designing · round 1/3 → 2/3 → 3/3 → Ready** (or **Failed · refunded**) and refreshes every 2.5 s while a job is running. When the result is ready, its nice touch shows underneath. "Open" drops the screens onto the program as movable layers.

## 7. Mock (no `HERMES_STITCH_URL`)
The same contract runs end to end: `designing` with `round` 1, 2 and 3 about 2 s apart, then `ready` with sample SVG screens, HTML and a sample `nice_touch`. Both callbacks are HMAC-signed and go through the real callback handler, including the R2 download. Put the word "fail" in the prompt to exercise the refund path. The mock signing key is derived from `NEBU_SESSION_SECRET`, so nobody outside can forge callbacks.

## Worker routes
- `GET /stitch` (session): `{month, available, mode, jobs[]}` (each job has `round`, `rounds`, `brief_mode`, `nice_touch`)
- `POST /stitch` (session) `{prompt, kind, count, brief_mode?}`: `202 {job_id, status:"queued", mode}` · `409 monthly_used` · `400 prompt_too_short` · `502` (Hermes down, refunded)
- `POST /api/stitch/callback` (signed)

This replaces the old free monthly path in `/requests`. `/requests` is only kept for paid extras, which are design-only in this PR.
