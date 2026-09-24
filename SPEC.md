# NEBU.QUEST MVP -- Architectural Spec

Goal: an Awwwards-caliber marketing + live-proof landing experience for NEBU.QUEST.
Static bundle, no build step, no framework, no new dependencies. Marketing sections
sell the product; one honest live-proof widget demonstrates the real API state.

## Non-goals

- Do NOT touch the live `nebu.quest` site (currently serves the vc-node SPA).
- Do NOT deploy without explicit owner OK (see `DEPLOY.md`).
- Do NOT touch `vc.friskydev.com` or the vc-node repo.
- No faked functionality: the room widget shows the true gated state, never a
 fabricated success.

## File map

| File | Role |
| --- | --- |
| `index.html` | Document shell, head/meta/OG, header, hero, section mounts, footer. Loads `sections.html` partials or inlines them; single source of section order. |
| `styles.css` | All styling. Brand tokens as `:root` custom properties, display/body/mono stacks, buttons, stickers, reveal, responsive breakpoints, `prefers-reduced-motion`, print. |
| `scene.js` | Hero scene motion only: parallax (`--par-x/--par-y`), float loops, scroll reveal via `IntersectionObserver` adding `.is-visible`, marquee. No DOM content construction. |
| `app.js` | Site behavior only: tabs, FAQ (`details` native), mobile nav, footer year, smooth-scroll offset. No network calls. |
| `sections.html` | Section partials (features, use-cases, workflow, product-shot, FAQ, closing) fetched/inlined at build-authoring time so `index.html` stays readable. If inlined instead, this file is the canonical copy-paste source. |
| `room.js` | Live-proof widget. Exactly one network call: `POST https://vc.friskydev.com/v1/rooms`. Handles 401 by rendering the honest gated state. No token storage, no retry loop. |
| `assets/` | `nebu-icon.svg`, `nebu-mark-yellow.svg`, `nebu-wordmark-paper.svg`, `nebu-social.png` (OG), `studio-preview.webp` (product shot). All images carry explicit dimensions. |
| `verify.sh` | Verification runner: header check, content greps, headless-Chrome screenshots at final sizes. |

## Brand tokens

Source of truth: `/Users/friskypup/nebu-brand-kit` (`styles.css` `:root`).

| Token | Value | Use |
| --- | --- | --- |
| `--night` | `#0B001A` | Page background, dark sections |
| `--violet` | `#9D00FF` | Hero/preview scene fields, accent fills |
| `--cyan` | `#00E5FF` | Focus rings, scene disc, selection, links-on-dark |
| `--lime` | `#B7FF2A` | Live/status accents, people sticker |
| `--paper` | `#F7F5F2` | Light sections, text on night |
| `--yellow` | `#FFD100` | Primary buttons, signal strip, closing band |
| `--ink` | `#121212` | Borders, hard shadows, text on paper |
| `--panel` | `#191424` | Feature panel surface |
| `--muted` | `#BCB4C9` | Secondary copy on night |
| `--line` | `#4B4059` | Hairline dividers on night |
| `--display` | `"Bricolage Grotesque", sans-serif` | Headlines, weight 800, tight tracking |
| `--body` | `Manrope, sans-serif` | Body copy |
| `--mono` | `ui-monospace, SFMono-Regular, Consolas, monospace` | Eyebrow labels, captions, meta |

Signature moves (must all ship): mono uppercase eyebrow labels with wide tracking;
1px hairline dividers (`--line` on night, ink on paper); hard-shadow yellow buttons
(`border: 2px solid ink; border-radius: 999px; box-shadow: 0 5px 0 #000` with
lift on hover, press on active); rotated sticker cards with ink borders and offset
shadows; yellow signal-strip marquee; oversized Bricolage headlines.

## Motion language

From the brand kit: `sticker-float` / `e-float` ambient loops on hero stickers and
scene shapes; parallax via `--par-x`/`--par-y` custom properties; `[data-reveal]`
translateY-to-visible with staggered `--reveal-delay`; marquee track on the signal
strip; waveform/equalizer bar loops. All motion is transform/opacity only (no layout
thrashing). `prefers-reduced-motion: reduce` disables every loop and forces
`[data-reveal]` visible.

## API contract note

`POST https://vc.friskydev.com/v1/rooms` is operator-gated. Verified 2026-09-24:
anonymous POST with empty JSON body returns `401`. The `room.js` widget therefore
degrades honestly: on 401 it renders a gated state ("operator access required" +
request-access CTA) and never invents a room ID, session, or success message. Any
non-401 response is surfaced verbatim as "unexpected status" rather than rendered
as product UI. No credentials are collected or stored client-side.

## Accessibility budget

- Skip link, landmarks (`header/main/footer`), one `h1`, hierarchical headings.
- Visible focus: 3px cyan outline, 6px offset, on all interactive elements.
- FAQ uses native `details/summary` (keyboard free). Tabs use real buttons with
 `aria-selected`.
- Contrast: paper-on-night and ink-on-yellow pass; muted copy is decorative-large
 or secondary only, never sole carrier of meaning.
- Touch targets minimum 44px. Hero canvas is `aria-hidden` with a text equivalent.
- Full keyboard path with `prefers-reduced-motion` respected.

## Performance budget

- Zero frameworks, zero runtime dependencies; two scripts (`scene.js`, `app.js`)
 plus `room.js` on demand. Total render-blocking JS under 25 KB.
- Fonts: local variable fonts (`BricolageGrotesque-VF`, `Manrope-VF`) with
 `font-display: swap`. No third-party font requests.
- Images: explicit `width/height`, `loading="lazy"` below the fold, WebP/PNG sized
 for slot. LCP target under 2.5 s on cable; CLS 0 (reveal uses transform only).
- No render-blocking third-party requests of any kind.

## Verification (`verify.sh`)

1. `curl -sI https://nebu.quest` -- records current production headers as baseline;
  asserts the MVP bundle is NOT served yet.
2. Grep bundle: brand hex codes present, no `TODO`/`FIXME`/placeholder strings,
  no emoji codepoints in markup, no `fetch` outside `room.js`.
3. Screenshots with real headless Chrome at final sizes (1440x900 desktop,
  390x844 mobile): hero, features, closing. Human eyeball check against the
  Awwwards bar before any deploy conversation.
4. Anonymous `POST /v1/rooms` still 401 -> widget gated-state path re-confirmed.
