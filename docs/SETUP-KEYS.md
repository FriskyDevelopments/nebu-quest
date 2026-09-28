# Keys and setup (preview → production)

Secrets go in with `wrangler secret put <NAME> -c worker/wrangler.preview.toml` (preview) and never in git.

| Key | Status on preview | For |
|---|---|---|
| `FD_HANDOFF_SECRET`, `NEBU_SESSION_SECRET`, `TENANT_KEY`, `ADMIN_TOKEN` | set | FRISKY ID handoff, sessions, sealing |
| `TURN_KEY_ID`, `TURN_KEY_API_TOKEN` | set | Room TURN relay (ICE comes over the room WebSocket; `/ice` returns 410) |
| `TELEGRAM_BOT_TOKEN` | set (Fenrir bot, used only for sticker import + initData checks) | Import, Mini App auth |
| `TELEGRAM_BOT_USERNAME` (var) | **missing** | Mini App deep link `t.me/<bot>/live?startapp=<sid>`. Until it's set, the web link works and the Telegram link is hidden. |
| `HERMES_STITCH_URL`, `HERMES_STITCH_SECRET` | **missing** (mock runs) | Monthly design, see `stitch-hermes.md` |
| FRISKY ID provider apps (Apple Services ID + key, Google, Microsoft Entra, xAI) | configured on the FriskyDev side | Sign-in buttons |

## FRISKY ID handoff contract
`https://forge.friskydev.com/auth/nebu/start?return_to=<studio url>&provider=<id>` redirects back to `<return_to>#nebu_handoff=<token>`. The studio POSTs the token to `/auth/exchange` (HMAC with `FD_HANDOFF_SECRET`, `aud=nebu.quest`, `iss=forge.friskydev.com`, at most 10 min). It gets back a 12 h NEBU session.
Redirect URLs to allow: `https://nebu.quest/studio/` and `https://feat-studio-v2.nebu-quest.pages.dev/studio/`.

## Telegram Mini App
1. In @BotFather, send `/newapp`, pick the NEBU bot, and set the URL to `https://nebu.quest/live/` with short name `live`.
2. Set `TELEGRAM_BOT_USERNAME` (and `TELEGRAM_MINIAPP_NAME` if the short name isn't `live`).
3. To let NEBU post and pin the join message, add the bot to the group as admin with "Pin messages". Posting is `TELEGRAM_ACTIONS_MODE=mock` on preview.
4. `/setdomain` is only needed for the Telegram Login Widget, which isn't used here.

Before merge, the production Worker `nebu-rooms` needs this code plus migration v3 (the `LiveHub` DO). Until then, prod keeps using the prod Worker, because the studio picks the preview Worker only on `*.nebu-quest.pages.dev` preview hosts (meta `nebu-signal-preview`).
