# NEBU.QUEST v1 — Go-live pack (2026-09-24)

Living landing for NEBU: the page IS the demo. Static, no build, served from
Cloudflare Pages project `nebu-quest` (nebu.quest + www.nebu.quest).

## What's live

- Animated nebula hero (drag-to-orbit canvas, reduced-motion safe)
- Brand story: marquee, Studio/Sound/Rooms/Record tabs + preview, use-cases,
  Prepare/Preview/Share workflow, product shot, FAQ, closing CTA
- Honest live-room widget (operator-gated API degrades to a truthful card)
- On Air band: 1-click Add-to-OBS config, Boom support card, Continuity
  Camera card — each with copy-checklist buttons
- SEO: OG/Twitter tags, JSON-LD, sitemap.xml, robots.txt
- Caching: immutable assets, short TTL on HTML/fragments/JS/CSS

## Verify

- `./verify.sh` → 12/12 (local HTTP + mounts + screenshots)
- Production DOM: footer, closing, all 3 On Air cards, all 3 copy buttons
  wired, zero false errors
- `curl` all routes → 200 (sections.html 308→/sections, same content)

## Rollback

`npx wrangler pages deployment list --project-name nebu-quest`, then promote
the previous deployment. Or republish any git tag's tree.

## Open items (owner)

- CI autodeploy needs `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` secrets
- `POST vc.friskydev.com/v1/rooms` stays operator-gated (widget is honest)
