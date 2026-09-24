/*
 * NEBU — "Start a scene" room widget (Track 5).
 *
 * Mounts on #room-widget. Attempts one anonymous POST to the live studio API
 * (https://vc.friskydev.com/v1/rooms) with a 6s timeout via AbortController.
 *
 * - Success (2xx): renders the server-issued invite link + copy button.
 * - ANY failure (including the expected 401 — the API is operator-gated):
 *   renders an honest fallback card pointing at the live studio. Never
 *   fabricates a room code: only values returned by the API are shown.
 *
 * Vanilla JS, no dependencies. Brand: night #0B001A, violet #9D00FF,
 * cyan #00E5FF, lime #B7FF2A, paper #F7F5F2, yellow #FFD100;
 * Bricolage Grotesque display + Manrope body, mono eyebrow labels,
 * hairline dividers, hard-shadow yellow buttons.
 */
(function () {
  "use strict";

  var API_URL = "https://vc.friskydev.com/v1/rooms";
  var STUDIO_URL = "https://vc.friskydev.com/";
  var TIMEOUT_MS = 6000;

  var CSS = [
    "#room-widget .nebu-room{",
    "  --nebu-night:#0B001A;--nebu-panel:#191424;--nebu-paper:#F7F5F2;",
    "  --nebu-yellow:#FFD100;--nebu-cyan:#00E5FF;--nebu-violet:#9D00FF;",
    "  --nebu-lime:#B7FF2A;--nebu-ink:#121212;--nebu-line:#4B4059;--nebu-muted:#BCB4C9;",
    "  background:var(--nebu-panel);color:var(--nebu-paper);",
    "  border:1px solid var(--nebu-line);border-radius:18px;",
    "  border-top:4px solid var(--nebu-violet);",
    "  padding:32px 30px;max-width:560px;",
    "  font-family:Manrope,system-ui,-apple-system,'Segoe UI',sans-serif;",
    "}",
    "#room-widget .nebu-room__eyebrow{",
    "  font-family:ui-monospace,SFMono-Regular,Consolas,monospace;",
    "  font-size:11px;font-weight:500;letter-spacing:.1em;line-height:1.5;",
    "  color:var(--nebu-lime);margin:0 0 14px;",
    "}",
    "#room-widget .nebu-room__title{",
    "  font-family:'Bricolage Grotesque',Manrope,system-ui,sans-serif;",
    "  font-weight:800;font-size:32px;letter-spacing:-.04em;line-height:1.02;",
    "  margin:0 0 12px;",
    "}",
    "#room-widget .nebu-room__sub{font-size:13px;line-height:1.75;color:var(--nebu-muted);margin:0 0 22px;max-width:44ch;}",
    "#room-widget .nebu-room__divider{border:0;border-top:1px solid var(--nebu-line);margin:22px 0;}",
    "#room-widget .nebu-room__btn{",
    "  display:inline-flex;align-items:center;justify-content:center;gap:12px;",
    "  min-height:56px;padding:15px 25px;border-radius:999px;",
    "  border:2px solid var(--nebu-ink);background:var(--nebu-yellow);color:var(--nebu-ink);",
    "  font-size:14px;font-weight:800;line-height:1.3;white-space:nowrap;cursor:pointer;",
    "  box-shadow:0 5px 0 #000;transition:transform .18s,box-shadow .18s;",
    "}",
    "#room-widget .nebu-room__btn:hover{transform:translateY(-3px);box-shadow:0 8px 0 #000;}",
    "#room-widget .nebu-room__btn:active{transform:translateY(2px);box-shadow:0 2px 0 #000;}",
    "#room-widget .nebu-room__btn:disabled{opacity:.65;cursor:wait;transform:none;}",
    "#room-widget .nebu-room__btn--ghost{background:transparent;color:var(--nebu-paper);border-color:var(--nebu-paper);}",
    "#room-widget .nebu-room__row{display:flex;flex-wrap:wrap;gap:14px;align-items:center;}",
    "#room-widget .nebu-room__invite{",
    "  display:block;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;",
    "  font-size:12px;color:var(--nebu-cyan);margin:0 0 16px;",
    "}",
    "#room-widget a.nebu-room__invite:hover{color:var(--nebu-yellow);}",
    "#room-widget .nebu-room__code{",
    "  display:inline-block;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;",
    "  font-size:15px;color:var(--nebu-ink);background:var(--nebu-lime);",
    "  border:2px solid var(--nebu-ink);border-radius:10px;padding:10px 16px;margin:0 0 16px;",
    "}",
    "#room-widget .nebu-room__status{",
    "  font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;",
    "  letter-spacing:.06em;color:var(--nebu-muted);margin:18px 0 0;",
    "}",
    "#room-widget .nebu-room__btn:focus-visible,#room-widget a:focus-visible{outline:3px solid var(--nebu-cyan);outline-offset:4px;}",
    "@media (prefers-reduced-motion:reduce){#room-widget .nebu-room__btn{transition:none;}}"
  ].join("\n");

  function ensureStyles() {
    if (document.querySelector("style[data-nebu-room]")) return;
    var el = document.createElement("style");
    el.setAttribute("data-nebu-room", "1");
    el.textContent = CSS;
    document.head.appendChild(el);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[ch];
    });
  }

  function setStatus(root, text) {
    var node = root.querySelector("[data-nebu-status]");
    if (node) node.textContent = text;
  }

  function renderIdle(root) {
    root.innerHTML =
      '<div class="nebu-room" data-state="idle">' +
      '<p class="nebu-room__eyebrow">LIVE ROOMS / TRY THE API</p>' +
      '<p class="nebu-room__title">Start a scene.</p>' +
      '<p class="nebu-room__sub">This button asks the live studio API for a room. ' +
      "If the studio answers, you get an invite link. If not, we say so.</p>" +
      '<button type="button" class="nebu-room__btn" data-nebu-action="start">Start a scene</button>' +
      '<p class="nebu-room__status" role="status" aria-live="polite" data-nebu-status></p>' +
      "</div>";
  }

  function renderPending(root) {
    var btn = root.querySelector('[data-nebu-action="start"]');
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Asking the studio…";
    }
    setStatus(root, "POST " + API_URL + " — waiting up to 6s.");
  }

  function renderFallback(root, detail) {
    root.innerHTML =
      '<div class="nebu-room" data-state="fallback">' +
      '<p class="nebu-room__eyebrow">LIVE ROOMS / STUDIO ACCESS</p>' +
      '<p class="nebu-room__title">Rooms live in the studio.</p>' +
      '<p class="nebu-room__sub">The live studio opens at vc.friskydev.com with ' +
      "FriskyDev sign-in — rooms are operator-issued.</p>" +
      '<div class="nebu-room__row">' +
      '<a class="nebu-room__btn" href="' + STUDIO_URL + '">Open the live studio</a>' +
      '<button type="button" class="nebu-room__btn nebu-room__btn--ghost" data-nebu-action="retry">Try again</button>' +
      "</div>" +
      '<hr class="nebu-room__divider">' +
      '<p class="nebu-room__status" role="status" aria-live="polite" data-nebu-status>' +
      escapeHtml(detail) +
      "</p>" +
      "</div>";
  }

  function renderSuccess(root, invite) {
    var linkPart;
    var copyValue;
    if (invite.url) {
      linkPart =
        '<a class="nebu-room__invite" data-nebu-invite href="' +
        escapeHtml(invite.url) +
        '" target="_blank" rel="noopener">' +
        escapeHtml(invite.url) +
        "</a>";
      copyValue = invite.url;
    } else {
      linkPart =
        '<p class="nebu-room__code">Room issued: ' +
        escapeHtml(invite.code) +
        "</p>";
      copyValue = invite.code;
    }
    root.innerHTML =
      '<div class="nebu-room" data-state="success">' +
      '<p class="nebu-room__eyebrow">LIVE ROOMS / ROOM ISSUED</p>' +
      '<p class="nebu-room__title">Your room is ready.</p>' +
      '<p class="nebu-room__sub">Issued by the live studio API. Share the invite to bring people in.</p>' +
      linkPart +
      '<div class="nebu-room__row">' +
      '<button type="button" class="nebu-room__btn" data-nebu-action="copy" data-nebu-copy="' +
      escapeHtml(copyValue) +
      '">Copy invite</button>' +
      '<a class="nebu-room__btn nebu-room__btn--ghost" href="' + STUDIO_URL + '">Open the live studio</a>' +
      "</div>" +
      '<p class="nebu-room__status" role="status" aria-live="polite" data-nebu-status>API response 200 — room issued.</p>' +
      "</div>";
  }

  function pickInvite(data) {
    if (!data || typeof data !== "object") return null;
    var url = firstString(data, [
      "inviteUrl",
      "invite_url",
      "joinUrl",
      "join_url",
      "roomUrl",
      "room_url",
      "url"
    ]);
    if (url && !/^https?:\/\//i.test(url)) url = null;
    var code = firstString(data, ["code", "id", "roomId", "room_id", "slug"]);
    if (url) return { url: url };
    if (code) return { code: code };
    return {};
  }

  function firstString(data, keys) {
    for (var i = 0; i < keys.length; i++) {
      var value = data[keys[i]];
      if (typeof value === "string" && value.length > 0) return value;
    }
    return null;
  }

  function fallbackDetailForStatus(status, statusText) {
    var base = "Live check: API response " + status;
    if (statusText) base += " — " + statusText;
    base += ".";
    if (status === 401) {
      base += " The rooms endpoint is operator-gated (expected without sign-in).";
    }
    return base;
  }

  function copyText(text, btn) {
    var original = btn.textContent;
    var done = function (label) {
      btn.textContent = label;
      window.setTimeout(function () {
        btn.textContent = original;
      }, 1600);
    };
    var legacyCopy = function () {
      try {
        var area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
        done("Copied");
      } catch (err) {
        done("Copy failed — select it manually");
      }
    };
    if (
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      navigator.clipboard.writeText(text).then(
        function () {
          done("Copied");
        },
        legacyCopy
      );
    } else {
      legacyCopy();
    }
  }

  function startRoom(root) {
    if (root.__nebuBusy) return;
    if (typeof window.fetch !== "function") {
      renderFallback(
        root,
        "Live check: this browser could not reach the rooms API."
      );
      return;
    }
    root.__nebuBusy = true;
    renderPending(root);

    var controller = null;
    if (typeof AbortController !== "undefined") {
      try {
        controller = new AbortController();
      } catch (err) {
        controller = null;
      }
    }
    var settled = false;
    var finish = function () {
      settled = true;
      root.__nebuBusy = false;
    };
    var timer = window.setTimeout(function () {
      if (settled) return;
      if (controller) {
        try {
          controller.abort();
        } catch (err) {
          /* noop */
        }
      } else {
        finish();
        renderFallback(
          root,
          "Live check: request timed out after 6 seconds."
        );
      }
    }, TIMEOUT_MS);

    var options = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      credentials: "omit"
    };
    if (controller) options.signal = controller.signal;

    window
      .fetch(API_URL, options)
      .then(function (res) {
        window.clearTimeout(timer);
        if (settled) return null;
        if (!res.ok) {
          finish();
          renderFallback(root, fallbackDetailForStatus(res.status, res.statusText));
          return null;
        }
        return res.text().then(function (text) {
          if (settled) return;
          finish();
          var data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch (err) {
            data = null;
          }
          var invite = pickInvite(data);
          if (invite && (invite.url || invite.code)) {
            renderSuccess(root, invite);
          } else {
            // 2xx but no displayable invite in the payload: stay honest,
            // never claim a room was issued.
            renderFallback(
              root,
              "Live check: the studio answered but returned no invite to display."
            );
          }
        });
      })
      .catch(function (err) {
        window.clearTimeout(timer);
        if (settled) return;
        finish();
        if (err && err.name === "AbortError") {
          renderFallback(
            root,
            "Live check: request timed out after 6 seconds."
          );
        } else {
          renderFallback(root, "Live check: network request failed.");
        }
      });
  }

  function mount() {
    var root = document.getElementById("room-widget");
    if (!root || root.__nebuMounted) return;
    root.__nebuMounted = true;
    ensureStyles();
    renderIdle(root);
    root.addEventListener("click", function (event) {
      var target = event.target;
      if (!(target instanceof window.Element)) return;
      var action = target.closest("[data-nebu-action]");
      if (!action || !root.contains(action)) return;
      var kind = action.getAttribute("data-nebu-action");
      if (kind === "start" || kind === "retry") {
        if (kind === "retry") renderIdle(root);
        startRoom(root);
      } else if (kind === "copy") {
        copyText(action.getAttribute("data-nebu-copy") || "", action);
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
