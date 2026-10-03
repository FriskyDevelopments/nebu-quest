/* Worker base URL for studio and live chat.
 * Production hosts use the prod meta tag. Branch previews and loopback use the preview tag.
 * ?signal= is only honored on those hosts, and only for an origin already named in the meta tags
 * (https), or a loopback origin when the page itself is loopback. Anything else is ignored,
 * so a crafted preview link cannot point session or Telegram initData fetches at another host.
 */
(function (root) {
  "use strict";

  function originOf(value) {
    try {
      var u = new URL(String(value || "").trim());
      return u.protocol === "https:" && !u.username && !u.password ? u.origin : "";
    } catch (e) {
      return "";
    }
  }

  function overrideAllowed(raw, hostname, metas) {
    var u;
    try { u = new URL(raw); } catch (e) { return false; }
    if (u.username || u.password || u.search || u.hash) return false;
    if (u.pathname !== "/" && u.pathname !== "") return false;
    var trusted = [originOf(metas.prod), originOf(metas.preview)].filter(Boolean);
    if (u.protocol === "https:" && trusted.indexOf(u.origin) !== -1) return true;
    var loopbackPage = hostname === "localhost" || hostname === "127.0.0.1";
    var loopbackTarget = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    return loopbackPage && loopbackTarget && (u.protocol === "http:" || u.protocol === "https:");
  }

  function nebuSignalBase(opts) {
    var hostname = opts.hostname || "";
    var metas = opts.metas || {};
    var previewHost = /(^|\.)nebu-quest\.pages\.dev$|^localhost$|^127\.0\.0\.1$/.test(hostname) && hostname !== "nebu-quest.pages.dev";
    var fallback = String((previewHost ? metas.preview : metas.prod) || metas.prod || "").trim();
    var raw = "";
    if (previewHost) raw = new URLSearchParams(opts.search || "").get("signal") || "";
    var chosen = raw && overrideAllowed(raw, hostname, metas) ? raw : fallback;
    return chosen.replace(/\/$/, "");
  }

  root.nebuSignalBase = nebuSignalBase;
})(typeof globalThis !== "undefined" ? globalThis : this);
