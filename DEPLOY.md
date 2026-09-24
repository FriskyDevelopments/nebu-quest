# NEBU.QUEST -- Deploy

Status: NOT DEPLOYED. The live `nebu.quest` currently serves the vc-node SPA.
This bundle must not replace it without explicit owner OK.

## How nebu.quest serves the static bundle

`nebu.quest` is fronted by Cloudflare (`server: cloudflare`, NEL reporting,
`cache-control: public, max-age=0, must-revalidate` -- verified 2026-09-24 via
`curl -sI https://nebu.quest`). Publishing means uploading the contents of
`~/nebu-quest` (the static bundle: `index.html`, `styles.css`, `scene.js`,
`app.js`, `sections.html`, `room.js`, `assets/`) to the Pages/Cloudflare project
that currently serves `nebu.quest` -- the same project, same custom domain, new
file set. No server, no build command, no environment variables.

Identify the project first (dashboard or API): the Pages project with custom
domain `nebu.quest`. Confirm with headers after publish.

## Pre-deploy checklist

1. Owner says go -- in writing, naming this exact bundle.
2. `verify.sh` green: screenshots eyeballed at final size, no TODOs, no emojis,
  `POST /v1/rooms` still anonymously 401.
3. Back up the current production bundle (the vc-node SPA output) to a dated
  directory so rollback is a republish, not a rebuild.
4. Freeze vc-node work for the cutover window so the backup matches production.

## Publish

1. Upload `~/nebu-quest` contents to the `nebu.quest` Pages/Cloudflare project
  production environment (direct upload or the project's existing publish path).
2. Confirm: `curl -sI https://nebu.quest` shows the new bundle (content changes,
  Cloudflare headers intact); load `/` in a clean profile and check hero,
  sections, and the room widget's honest gated state.
3. Purge/verify CDN freshness if a stale copy persists (`max-age=0,
  must-revalidate` should revalidate, but confirm visually).

## Do NOT

- Do NOT deploy without owner OK.
- Do NOT touch `vc.friskydev.com` or the vc-node repo in any step.
- Do NOT add redirects, workers, or env vars as part of this cutover.

## Rollback

Rollback = republish the previous bundle: upload the dated backup from step 3
of the checklist to the same project and re-verify with `curl -sI` plus a visual
check. No DNS changes involved in either direction.
