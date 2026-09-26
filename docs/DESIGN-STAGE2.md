# Stage 2: designed, not shipped

Everything here is off (`/config` → `stage2.*: false`). The interfaces are stubbed in the Worker so the next PR can wire them up without reshaping anything.

| Feature | Stub | Shape |
|---|---|---|
| Your NEBU userbot (tenant's own Telegram account) | `tenant.js` (`setTenantTgApi`, sealed `tenant_secrets`), `tg-user.js` / `tg-user-mtcute.js` (TgUser DO) | The tenant brings their **own** api_id/api_hash from my.telegram.org. It gets sealed with `TENANT_KEY` (AES-GCM), shown masked, and one tap deletes it. Login by code in a DO; the session never leaves the DO. |
| Discord (bring your own bot) | `discord.js` | Application ID + Public Key + Bot token, verified against `/applications/@me`. Ed25519 interactions, owner-only slash commands (`design`, `packs`, `status`, `announce`, `help`). Invite permissions are 0 (commands) or 51200 (post). |
| Joining Telegram video chats live + admin controls | none (design) | ntgcalls (LGPL) in a **separate container** (Cloudflare Containers), driven by the tenant userbot. Admin uses `phone.editGroupCallParticipant` (mute, volume) and needs the "Manage video chats" right. |
| RTMP / Stream Live | none (design) | `phone.createGroupCall(rtmp_stream)` + `getGroupCallStreamRtmpUrl` (revoke = rotate). The stream key is sealed, masked in the UI, with a rotate button. Studio → Cloudflare Stream Live (WHIP in, RTMP out to Telegram). Pricing is deferred until it's enabled. |
| Own phone numbers | `numbers.js` (Twilio + Telnyx adapters, webhook signature checks, mock) | Only needed for a second Telegram account. Buying is gated by `NUMBERS_BUY_ENABLED`. Inbound SMS keeps only a sealed Telegram code for 10 minutes. See the table below. |
| Assistant add-on: Vellum | `ASSISTANT_TRIAL_ENABLED` flag | Hosted personal assistant: one Cloudflare Container per FRISKY ID that sleeps when idle. Only talks to the host. Included in ALL-IN. |
| Add-on: FR!sky Paperclip (my Agent Ops desk, clip.friskydev.com) | `/config` `paperclipLink.enabled: false`, `plans.js` provider `paperclip-frisky` | Link your Paperclip seat (Whop seat key `FRSKY-PC-…`) to your FRISKY ID and open the desk from NEBU. NEBU only stores the link (seat id plus a masked key suffix) and opens `clip.friskydev.com` or the Paperclip extension/app. Budgets and hard-stops stay in Paperclip. |
| Prepaid credits + billing | `billing.js` (Whop test mode only), `plans.js` | **ALL-IN is $99.99 USD / month** (studio, Your NEBU, a Paperclip seat link, the hosted Vellum assistant, included AI credits). Set `WHOP_PLAN_ALL_IN` to a **sandbox** plan id. No live Whop products. Every other tier is TBD. The monthly design is free (see `stitch-hermes.md`). |
| Drive + Spotify linking | none | Drive: export takes and packs. Spotify: now-playing metadata **only**. Their terms don't allow capturing or restreaming audio, so the DJ decks take local files. |
| Virtual cam | none | Desktop helper that exposes the program output as a camera. Out of scope for the browser. |
| Chrome extension | none | At most a guide overlay that points at buttons inside Telegram Web. It never automates the account. |

## Phone numbers for a second Telegram account (researched Sep 2026)
| Provider | US local / mo | MX | Inbound SMS | Notes |
|---|---|---|---|---|
| Twilio (real Pricing API) | $1.15 | local $6.25 · mobile $15.00 | US $0.0083 | CA $1.15, GB local $1.15 / mobile $2.50 |
| Telnyx | $1.00 (+$0.10 SMS) | from $5 | $0.004 + carrier fee | cheapest API option |
| Plivo | $0.50 | no MX inbound SMS | $0.0077 + carrier fee | |
| Bandwidth / Sinch | quote | quote | quote | |

**Caveat:** Telegram only connects accounts to mobile numbers, and it tends to reject VoIP/CPaaS ranges at signup. That second part is community evidence, not official. **Recommendation:** use a real mobile SIM or eSIM. If it has to be an API, Telnyx is the cheapest.
