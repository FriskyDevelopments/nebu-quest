# Migration: Cloudflare Pages / Framer to the app Worker

## Scope and evidence boundary

Owner-list item 8: **documentation only**. This document proposes a future
cutover; it does not authorize or perform one. Do not deploy, publish site
content, merge this PR, change DNS/Cloudflare/Zeabur, or touch any Vellum or
Fenrir repository or service. A GitHub PR containing only this file is the
requested deliverable. Login must always use **Better Auth**.

The owner reports that `nebu.quest` serves static content from Cloudflare
Pages / Framer, while the app (`/login`, `/units/ashy`, `/healthz`) lives on
`nebu-app.workers.dev`. The Framer deployment, app hostname, app deployment,
those three routes, and its Better Auth implementation are **unverified**
from this repository. Do not substitute the repository's rooms Worker for
the reported app Worker.

Evidence below describes the checked-in configuration, not live infrastructure.
Live DNS, certificates, Cloudflare account settings, deployment versions,
secret availability, CI success, and production responses are **unverified**.

## Current state evidenced by the repository

| Evidence | What it establishes | What remains unverified |
| --- | --- | --- |
| [README.md](../README.md), [DEPLOY.md](../DEPLOY.md) | Document a static Pages project named `nebu-quest`, production branch `main`, custom domains `nebu.quest` and `www.nebu.quest`, plus a separate rooms Worker. | Whether these documents match the current live Pages/Framer setup. |
| [scripts/stage.sh](../scripts/stage.sh) | No compilation/bundling: recreates `dist/`, copies root HTML/CSS/JS, `_headers`, `_redirects`, `robots.txt`, `sitemap.xml`, and `assets/`, `brand/`, `studio/`, `live/`, `viewer/`. Excludes Worker source, tests, and docs from that upload. | Whether Framer exports or app assets are supplied elsewhere. Neither is wired into this script. |
| [.github/workflows/deploy.yml](../.github/workflows/deploy.yml) | Pushes to `main` run staging and `cloudflare/wrangler-action@v3` with `pages deploy dist --project-name nebu-quest --branch main`. Uses environment/secret names `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. No PR trigger is declared here. | Credentials and successful execution. A future merge can trigger this existing deployment workflow; this PR must not be merged by the agent. |
| [worker/wrangler.toml](../worker/wrangler.toml) | Worker name `nebu-rooms`, entry `src/index.js`, compatibility date `2026-09-01`, `workers_dev = true`, `preview_urls = false`, `ROOMS` Durable Object binding and `v1` SQLite migration. `ALLOWED_ORIGINS` includes apex, `www`, Pages and local origins. | Live bindings and deploy state. There is no app Worker declaration, custom-domain/route declaration, or static assets binding here. |
| [worker/wrangler.preview.toml](../worker/wrangler.preview.toml) | Separately named `nebu-rooms-preview`; declares `ROOMS`, `TG_USERS`, `LIVE`, `PACKS`, `DB`, rate-limit bindings and `AI`. This is explicitly preview-only. | Live provisioning. These bindings must not be assumed to exist in production or copied into an app migration. |
| [worker/package.json](../worker/package.json) | Only `dev: wrangler dev` and `deploy: wrangler deploy` scripts; Wrangler `^4.141.0`. Declared runtime dependencies are `@mtcute/web` and `@tma.js/init-data-node`. | The reported app's package versions, build command, and deployment configuration. Better Auth is not declared in this manifest. |
| [worker/src/index.js](../worker/src/index.js) | `/` and `/health` return rooms-service JSON. Implements `/config`, room WebSockets at `/rooms/:room/ws`, `/auth/exchange`, `/auth/me`, and other APIs. `/ice` returns 410. No handlers for `/login`, `/units/ashy`, or `/healthz` are present. | The reported app's route contracts. Rooms `/health` is not evidence for app `/healthz`; rooms `/` is not a landing-page handler. |
| [worker/src/auth.js](../worker/src/auth.js) | Custom HMAC handoff/session tokens and Bearer authentication using names `FD_HANDOFF_SECRET` and `NEBU_SESSION_SECRET`, not a Better Auth implementation. | Better Auth configuration in the separate app. Existing custom auth must not become the replacement login. |
| [_redirects](../_redirects), [_headers](../_headers) | `/live/* /live/ 200` is a rewrite, not a redirect. Static security, permissions and cache headers are defined. | Whether the target app's asset pipeline preserves these behaviors. |
| [room.js](../room.js), [studio/studio.js](../studio/studio.js) | Static clients use a rooms signaling service; `room.js` checks its `/health`. | Live availability and compatibility with the proposed app origin. |

No checked-in app build/configuration or Framer integration establishes the
reported app as a cutover-ready destination. This is a blocking evidence gap,
not permission to deploy the rooms Worker at the apex.

## Pre-flight checklist (all required before execution)

- [ ] Obtain all written approvals in **OWNER DECISIONS** below, including the
  operator, maintenance window, precise change set, and rollback authority.
- [ ] Identify the actual app repository/revision, full Worker hostname,
  Cloudflare account/zone, build and asset output, Wrangler configuration,
  deployment version, and binding inventory. All are currently **unverified**.
  Do not access excluded repositories or services to fill these gaps.
- [ ] Verify the app implements `/login`, `/units/ashy`, `/healthz` and Better
  Auth. Record expected response codes, health JSON schema, access policy for
  Ashy, auth API/callback paths, and logout behavior; currently **unverified**.
- [ ] Inventory the existing apex and `www` DNS records, Pages custom-domain
  associations, Worker routes/custom domains, Framer ownership/export,
  redirects, certificates, cache rules, and relevant deployment automation.
  Capture recoverable settings and deployment IDs in approved private storage.
  Current values and Framer rollback mechanics are **unverified**.
- [ ] Inventory all public paths, static files, app APIs, auth callbacks,
  WebSockets, webhooks, and external links. Resolve `/live/` static versus API
  collisions before choosing asset fallbacks; never serve HTML for API errors.
- [ ] Confirm Better Auth's canonical base URL, trusted origins, provider
  callback allowlists, cookie scope/Secure/SameSite behavior, session storage,
  CSRF protection, and allowed return URLs for the destination. Exact app
  environment variable names are **unverified**: obtain them from its source,
  do not invent them or disclose values. Plan for re-login across hostnames.
- [ ] Confirm required secrets/bindings by **name and presence only** through
  authorized operators. Preserve existing rooms storage and isolation; do not
  migrate data or reuse preview resources as part of a hostname cutover.
- [ ] Verify a non-production candidate, with separate approved resources,
  serves the selected static content and app routes together, preserves
  security headers, and passes the tests below. Publication of that candidate
  requires separate written approval; none is performed by this task.
- [ ] Save the last known-good Pages/Framer release and app Worker version,
  confirm restoration access and TLS readiness, agree monitoring duration and
  rollback thresholds, and ensure the old origin remains recoverable.
- [ ] Resolve the existing `main` Pages deployment workflow's future role.
  Any workflow/config changes require a separate approved implementation PR.

## Proposed route / redirect table

These are proposals, not verified destination behavior or approved changes.
The default proposal keeps apex as canonical; the owner must ratify it.

| Host/path | Repository evidence / current state | Proposed post-cutover handling |
| --- | --- | --- |
| `nebu.quest/` | Static `index.html` is staged for Pages; live Pages/Framer selection **unverified**. | App Worker serves the owner-selected landing content, 200. Do not deploy rooms `/` here. |
| `nebu.quest/login` | App route reported by owner; **unverified** in repo. | Better Auth login page, normally 200 when signed out; signed-in behavior must be verified. No static catch-all or custom-auth substitute. |
| `nebu.quest/units/ashy` | App route/access policy **unverified**. | Serve app route; authorized user gets 200. Signed-out redirect to Better Auth login or approved denial, and unauthorized-user denial, require an agreed contract. Preserve a validated same-origin return path. |
| `nebu.quest/healthz` | App route/response contract **unverified**; repo only has rooms `/health`. | Direct app health response, expected 200 JSON per verified contract; no redirect, login challenge, cache, or HTML fallback. |
| `nebu.quest/studio/`, `/viewer/`, static files, `/robots.txt`, `/sitemap.xml` | Included by staging script. | Preserve content/paths and applicable headers on Worker assets unless owner explicitly approves retirement/replacement. Test direct navigation and trailing slashes. |
| `nebu.quest/live/*` | Pages 200 rewrite to `/live/`. | Preserve viewer deep links as a 200 rewrite; explicitly separate live API handling to prevent collisions. Target implementation **unverified**. |
| App auth API/provider callbacks | Exact paths **unverified**. | Route directly to Better Auth; verify methods, cookies and provider allowlists. Never blanket-redirect POST callbacks or auth APIs. |
| `www.nebu.quest/*` | Documented Pages custom domain; live behavior **unverified**. | If apex is approved canonical, temporary 302 for safe GET/HEAD navigation to the same apex path/query. Define non-GET/auth/API handling explicitly; no blanket method-changing redirect. Permanent 308 only after owner approval and stabilization. |
| Reported `nebu-app.workers.dev` navigation paths | Hostname/deployment **unverified**; exact full hostname must be confirmed. | Keep available during validation/rollback. Optional temporary 302 for safe navigation to matching apex paths only after cookie/callback review. Do not redirect health, APIs, WebSockets or POSTs indiscriminately. |
| Existing rooms Worker `/health`, `/config`, `/rooms/:room/ws`, other APIs | Separate rooms Worker routes are present in source. | Leave signaling endpoints and bindings unchanged. Do not redirect WebSocket handshakes or conflate `/health` with `/healthz`. |
| Unknown paths | App behavior **unverified**. | Explicit 404 (or approved app routing behavior), not an unconditional landing-page 200. |

Redirect rules must preserve intended paths/queries without leaking tokens,
accepting external return URLs, or producing loops. URL fragments are not
sent to the server; inventory fragment-dependent links separately.

## Step-by-step cutover plan (future authorized operator only)

1. **Stop/go gate:** complete the checklist and attach written approvals.
   If app identity, Better Auth, target routes, TLS, or rollback remains
   **unverified**, stop. This documentation PR is not deployment permission.
2. **Prepare a separate implementation PR:** use the verified app's own
   build/Worker configuration to implement the approved asset strategy,
   route precedence, headers and redirects. Do not repurpose `nebu-rooms`.
   Review environment variable names and auth host changes without values.
3. **Rehearse with approval:** an authorized operator prepares the approved
   isolated candidate, runs the complete route/auth checks, and rehearses
   restoring the previous configuration. Record revision, results and timing.
4. **Freeze and snapshot:** during the approved window, prevent competing
   Pages/Framer publication and automation changes using the approved method.
   Save recoverable domain associations, DNS/route settings, content releases
   and Worker version IDs. Do not delete Pages/Framer or any backing storage.
5. **Ready the destination:** the authorized operator makes the tested app
   release available and verifies the actual Worker hostname, required
   bindings, auth provider settings, and certificate readiness. No schema or
   data migration is implicitly authorized by this plan.
6. **Move domain ownership/routing:** apply only the approved Cloudflare
   custom-domain or Worker-route strategy. If Pages domain detachment or DNS
   edits are required, follow the captured zone-specific sequence with
   separately approved changes; exact records and order are **unverified**.
   Do not guess a DNS target from the reported workers.dev label. Establish
   apex/`www` TLS and routing without conflicting Pages associations.
7. **Validate immediately:** run the post-cutover checks below from clean
   browsers and external networks. Confirm the expected app revision, not
   merely a 200 from cached static content. Keep old origins recoverable and
   retain temporary redirects while observing approved monitoring thresholds.
8. **Stabilize only with sign-off:** after the agreed observation period,
   obtain written acceptance. Permanent redirects, retiring Pages/Framer,
   changing publication automation, and disabling old hostnames are separate
   approvals; none is automatic. Retain rollback snapshots for the approved
   retention period.

## Tests to run after cutover

These are planned checks, **not executed results**. Current production
responses and Better Auth behavior are **unverified**. Repeat critical tests
before cutover on the approved candidate and after any rollback.

Unauthenticated GET probes (no cookie/token/header dumps):

```bash
for path in /login /units/ashy /healthz; do
  curl --silent --show-error --output /dev/null --max-time 20 \
    --write-out "${path}: %{http_code}\n" "https://nebu.quest${path}"
done
```

Do not use `curl -L` to mask an unexpected redirect. Check redirect locations
privately and sanitize query strings before recording evidence. A status-only
probe does not prove login, authorization, or health readiness.

| Test | Required acceptance evidence |
| --- | --- |
| `/login` | Clean signed-out browser loads Better Auth login with working assets and no loop. With an authorized test account, complete the approved login/provider flow, return to the intended app path, reload to confirm session, then log out and confirm session rejection. Confirm secure cookie/CSRF/trusted-origin behavior privately; do not publish credentials, cookie values or auth tokens. |
| `/units/ashy` | Direct navigation and reload work. Signed-out behavior matches the approved login/denial contract; an authorized account sees the expected unit; an unauthorized account cannot access it. Confirm return-to after Better Auth login. Do not record private unit data. |
| `/healthz` | Direct 200, JSON matching the verified app contract and readiness criteria, no HTML/static fallback, login requirement, redirect, secret disclosure, or caching. Failure behavior matches the agreed contract. Do not treat rooms `/health` as a substitute. |
| Hostnames/redirects | Apex and `www` have valid HTTPS, agreed canonical behavior and preserved non-sensitive path/query. Verify old app-host handling, no loops, and correct auth callbacks. Actual workers.dev URL remains **unverified** until supplied. |
| Static/API regression | Landing, `/studio/`, `/viewer/`, `/live/<approved-test-id>`, assets, robots and sitemap behave as approved; verify security/permissions/cache headers. Check unknown-path behavior, API content types and room WebSocket connectivity without changing the rooms service. |

Repository regression tooling is supplementary, not app-route coverage:

- `./scripts/stage.sh` verifies the existing static packaging only; it does
  not deploy. `./verify.sh` runs a local static server and Chrome checks.
- `tests/e2e.mjs` uses Playwright and accepts `BASE` and `SIGNAL`; fixtures,
  Chrome, and an isolated rooms target are prerequisites. Do not default
  tests to production or assume their old fixture paths exist.
- `tests/v2.mjs` defaults to a remote preview and performs interactive work.
  Run only with an explicitly approved isolated target/fixtures, not as a
  production smoke check. No checked-in test establishes the three app routes.

## Rollback

Rollback immediately for broken Better Auth, failed `/healthz`, Ashy access
regressions, TLS failures, redirect loops, or asset/API collisions. Numeric
error thresholds, observation duration and recovery-time target are
**unverified** and must be approved before cutover.

1. The approved operator records the failing checks and invokes the written
   rollback authorization. Stop further promotions and permanent redirects.
2. Restore the exact captured DNS/Cloudflare route/custom-domain associations
   in the approved reverse sequence, returning static traffic to the
   last known-good Pages/Framer origin. Domain attachment and TLS restoration
   steps depend on the recorded configuration and are currently **unverified**.
3. If content changed, restore the saved Pages production deployment using
   the Pages rollback facility documented in [DEPLOY.md](../DEPLOY.md).
   Framer restoration steps are **unverified** and must be rehearsed separately.
   Do not redeploy or publish anything without the rollback approval.
4. Restore the prior app Worker version and its host-related Better Auth
   settings only if they changed and their restoration is approved. Preserve
   session storage and data; invalidate/re-login only per the approved auth
   recovery plan. Never fall back to custom HMAC login or another auth system.
5. Remove only cutover-specific redirects/cache rules as approved, and verify
   DNS/TLS and content from external networks. Do not alter the rooms Worker.
6. Re-run landing/static checks on restored apex/`www`, and `/login`,
   `/units/ashy`, `/healthz` on the restored, verified app hostname. If apex
   was static before cutover, do not falsely claim those app paths work there
   after rollback. Record the restored topology and sanitized test results.
7. Retain old origins and snapshots, document the incident, and require a new
   written go/no-go before retrying. Do not delete resources or reverse data
   migrations under this plan.

## OWNER DECISIONS and written approvals required

All decisions below are **unverified / pending written approval**. Record
approver, date, exact scope, operator, release/configuration references,
execution window, and rollback authorization in an approved review record.
Approval of this documentation alone authorizes none of the operational work.

| OWNER DECISION | Required written approval |
| --- | --- |
| Which app Worker/repository/revision is authoritative? | Confirm full hostname, ownership, build/configuration and route contracts; explicitly distinguish it from `nebu-rooms`. |
| What serves the landing page after migration? | Approve preserving current static files, a Framer export, or replacement app content; approve content rights and any retired URLs. Framer details are **unverified**. |
| Is apex or `www` canonical, and how is traffic moved? | Approve specific Cloudflare strategy, domain detach/attach sequence, exact DNS changes if any, TLS plan, downtime tolerance and route precedence. No Zeabur change is implied. |
| How is Better Auth configured across hostnames? | Approve verified base URL/origins, provider callback changes, cookie/session strategy, re-login impact, auth API paths and Ashy authorization rules. Better Auth is mandatory, not an optional provider choice. |
| Which redirects/legacy paths remain? | Approve the final route table, safe method handling, old app-host policy, temporary/permanent status codes and timing. |
| Who may prepare, deploy and cut over? | Separate written authorization for the implementation PR, any merge, candidate publication, production deployment, DNS/Cloudflare changes, and operational execution. Do not merge this documentation PR in this task. |
| How are automation and existing resources protected? | Approve Pages/Framer publication freeze/resumption and workflow changes in a separate PR; confirm no rooms binding/data migration and no Vellum/Fenrir work. |
| What proves success, and who can roll back? | Approve test accounts, health schema, acceptance tests, monitoring thresholds/window, recovery target, rollback operator and pre-authorized restoration scope. |
| When may old origins be retired? | Explicit later approval for permanent redirects, origin/domain retirement and snapshot retention. Keep rollback possible until then. |

**Go/no-go:** do not execute while any required approval or blocking technical
fact remains **unverified**. This PR changes only this document.
