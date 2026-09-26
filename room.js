/*
 * NEBU — "Open a room" widget on the landing page.
 *
 * Mounts on #room-widget. Checks that the rooms signaling service is up
 * (GET <signal>/health), then creates a private room link on click. The link
 * opens the in-browser studio at /studio/?room=<id>; the room itself exists
 * as soon as someone joins it and disappears when the last person leaves.
 * The room id is random and generated in this browser. Nothing is faked: if
 * the service is unreachable the card says so and still offers the studio
 * (recording and scenes work without it).
 */
(function () {
  "use strict";

  var SIGNAL = "https://nebu-rooms.hrgrrtks2p.workers.dev";
  var STUDIO_PATH = "/studio/";
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
    "#room-widget .nebu-room__health{display:inline-flex;align-items:center;gap:8px;}",
    "#room-widget .nebu-room__dot{width:8px;height:8px;border-radius:50%;background:var(--nebu-muted);}",
    "#room-widget [data-health='ok'] .nebu-room__dot{background:var(--nebu-lime);box-shadow:0 0 0 4px rgba(183,255,42,.18);}",
    "#room-widget [data-health='down'] .nebu-room__dot{background:#FF5C8A;}",
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

  function ensureStyles() {
    if (document.querySelector("style[data-nebu-room]")) return;
    var el = document.createElement("style");
    el.setAttribute("data-nebu-room", "1");
    el.textContent = CSS;
    document.head.appendChild(el);
  }

  function roomId() {
    var a = "abcdefghjkmnpqrstuvwxyz23456789";
    var r = new Uint8Array(12);
    (window.crypto || window.msCrypto).getRandomValues(r);
    var s = "";
    for (var i = 0; i < r.length; i++) s += a[r[i] % a.length];
    return s.slice(0, 4) + "-" + s.slice(4, 8) + "-" + s.slice(8, 12);
  }

  function roomUrl(id) {
    return location.origin + STUDIO_PATH + "?room=" + id;
  }

  function healthLine() {
    return '<p class="nebu-room__status nebu-room__health" data-health="checking" data-nebu-health><i class="nebu-room__dot" aria-hidden="true"></i><span>Checking the room service…</span></p>';
  }

  function checkHealth(root) {
    var node = root.querySelector("[data-nebu-health]");
    if (!node || typeof window.fetch !== "function") return;
    var done = false;
    var set = function (state, text) {
      if (done) return;
      done = true;
      node.setAttribute("data-health", state);
      node.querySelector("span").textContent = text;
    };
    var timer = window.setTimeout(function () {
      set("down", "Room service did not answer. Scenes and recording still work in the studio.");
    }, TIMEOUT_MS);
    window
      .fetch(SIGNAL + "/health", { cache: "no-store", credentials: "omit" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        window.clearTimeout(timer);
        if (data && data.ok) {
          set("ok", "Room service online" + (data.turn ? " · relay ready for strict networks" : "") + ".");
        } else {
          set("down", "Room service is not answering right now. Scenes and recording still work in the studio.");
        }
      })
      .catch(function () {
        window.clearTimeout(timer);
        set("down", "Could not reach the room service. Scenes and recording still work in the studio.");
      });
  }

  function renderIdle(root) {
    root.innerHTML =
      '<div class="nebu-room" data-state="idle">' +
      '<p class="nebu-room__eyebrow">LIVE ROOMS / TRY IT NOW</p>' +
      '<p class="nebu-room__title">Open a room.</p>' +
      '<p class="nebu-room__sub">Get a private link, send it to up to three people and meet in the studio. ' +
      "No sign-up. Audio and video go browser to browser, and the room disappears when the last person leaves.</p>" +
      '<button type="button" class="nebu-room__btn" data-nebu-action="start">Open a room</button>' +
      healthLine() +
      "</div>";
    checkHealth(root);
  }

  function renderRoom(root, id) {
    var url = roomUrl(id);
    root.innerHTML =
      '<div class="nebu-room" data-state="ready">' +
      '<p class="nebu-room__eyebrow">LIVE ROOMS / YOUR LINK</p>' +
      '<p class="nebu-room__title">Your room link.</p>' +
      '<p class="nebu-room__sub">Send it to your people, then step in yourself. Whoever opens it joins the same room.</p>' +
      '<a class="nebu-room__invite" data-nebu-invite href="' + escapeHtml(url) + '">' + escapeHtml(url) + "</a>" +
      '<div class="nebu-room__row">' +
      '<a class="nebu-room__btn" href="' + escapeHtml(url) + '">Go to the room</a>' +
      '<button type="button" class="nebu-room__btn nebu-room__btn--ghost" data-nebu-action="copy" data-nebu-copy="' + escapeHtml(url) + '">Copy link</button>' +
      "</div>" +
      '<hr class="nebu-room__divider">' +
      healthLine() +
      "</div>";
    checkHealth(root);
  }

  function copyText(text, btn) {
    var original = btn.textContent;
    var done = function (label) {
      btn.textContent = label;
      window.setTimeout(function () { btn.textContent = original; }, 1600);
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
        var ok = document.execCommand("copy");
        document.body.removeChild(area);
        done(ok ? "Copied" : "Select the link to copy it");
      } catch (err) {
        done("Select the link to copy it");
      }
    };
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(text).then(function () { done("Copied"); }, legacyCopy);
    } else {
      legacyCopy();
    }
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
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
      if (kind === "start") renderRoom(root, roomId());
      else if (kind === "copy") copyText(action.getAttribute("data-nebu-copy") || "", action);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
