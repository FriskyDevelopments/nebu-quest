# Third-party code

| Package | Version | License | Where | Use |
|---|---|---|---|---|
| @tma.js/init-data-node | 2.0.8 | MIT | worker (bundled) | Checks Telegram Mini App `initData` (HMAC + expiry) in `live.js` |
| web-audio-beat-detector | 8.2.39 | MIT | `studio/vendor/beat-detector.js` (esbuild bundle) | BPM for the DJ decks |
| lottie-web (light canvas) | 5.13.0 | MIT | `studio/vendor/lottie_light_canvas.min.js` | Renders animated Telegram stickers (.tgs) |
| @mtcute/web, @mtcute/core | 0.29.7 | MIT | worker, prototype only (`tg-user-mtcute.js`, not routed) | Stage 2 "Your NEBU" userbot design |
| Telegram Web App script | hosted by Telegram | Telegram terms | `live/index.html` (loaded from telegram.org) | Mini App bridge |

Patterns, no code copied:
- Live chat Durable Object (hibernating WebSockets, per-socket attachments) follows Cloudflare's `workers-chat-demo` / PartyKit room pattern.
- Workers AI MeloTTS (`@cf/myshell-ai/melotts`) is called through the `AI` binding, so no model code ships in the repo.

Planned for stage 2 (not in this PR): grammY (MIT) for bot commands, obs-websocket-js (MIT), Kokoro-82M ONNX (Apache-2.0) as a self-hosted TTS, unitary/toxic-bert (Apache-2.0) or Llama Guard (Llama license) for moderation, BiRefNet (MIT) for cutouts, ntgcalls (LGPL-3.0) only as a separate container, never linked into the Worker.

Deliberately avoided (AGPL/GPL or non-commercial): vdo.ninja, essentia.js, Ultroid, GPL music bots, briaai/RMBG-1.4.
