/*
 * nebu-rooms (v2): signaling + accounts + packs for NEBU studio.
 *
 * Rooms: one Durable Object per room. Browsers relay SDP/ICE through it; media is peer to peer.
 * TURN (Cloudflare Realtime) credentials are NOT handed out over HTTP any more. They arrive over
 * the room WebSocket, only when a signed-in host (FRISKY ID session) is in the room (TURN_POLICY
 * = "host-present"), with a short TTL (TURN_TTL, default 30 min, refreshed by DO alarm) and per-IP
 * rate limits on joins and on credential issuance.
 *
 *   GET  /health, /config
 *   POST /auth/exchange {token}            FriskyDev handoff -> NEBU session
 *   GET  /auth/me                          (Bearer session)
 *   GET  /rooms/:room/ws?name&role&t=      WebSocket
 *   POST /connect/telegram                 Login Widget payload (Bearer)
 *   POST /telegram/import {set, cursor}    getStickerSet/getFile -> R2 (Bearer, rate limited)
 *   /packs..., /s/:share, /f/<key>         My packs (R2 + D1)
 *   /me/nebu...                            Your NEBU (tenant, bot, links, billing)
 *   /requests, /billing/*, /admin/requests/:id/deliver
 */
import { DurableObject } from "cloudflare:workers";
import { exchangeHandoff, sessionUser, bearer, reissueWithTelegram, randomId } from "./auth.js";
import { fileUrl, SCHEMA, ensureUser, handlePacks, handleShare, serveFile, packsEnabled, createPackFor } from "./packs.js";
import { verifyLoginWidget, parseSetName, importBatch } from "./telegram.js";
import { PLAN_SCHEMA, publicPlans, entitlements } from "./plans.js";
import { assist, usage, saveUserKey, setAutoTopup, AI_SCHEMA, topupCatalog } from "./ai.js";
import { BILLING_SCHEMA, catalog, createCheckout, handleWebhook, balance } from "./billing.js";
import { listRequests, createRequest, deliverRequest } from "./requests.js";
export { TgUser } from "./tg-user.js";
export { LiveHub } from "./live.js";
import { LIVE_SCHEMA, handleLive, liveConfig } from "./live.js";
import { ttsConfig, speak } from "./tts.js";
import { ACTIONS_SCHEMA, postJoinMessage, actionLog } from "./actions.js";
import { STITCH_SCHEMA, stitchConfig, listStitch, dispatchStitch, stitchCallback } from "./stitch.js";
import { TENANT_SCHEMA, yourNebu, createTenant, setTenantBot, checkTenantBot, deleteTenant, setLink, removeLink } from "./tenant.js";

const ROOM_RE = /^[a-z0-9][a-z0-9-]{3,39}$/;
const RELAY_TYPES = new Set(["offer", "answer", "ice", "meta", "bye"]);
const MAX_MSG = 64 * 1024;
const STUN = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];

function originAllowed(origin, env) {
  if (!origin) return false;
  const rules = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  let u;
  try { u = new URL(origin); } catch { return false; }
  return rules.some((rule) => {
    if (rule === "*") return true;
    if (rule.startsWith("*.")) return u.protocol === "https:" && u.hostname.endsWith(rule.slice(1));
    if (rule.endsWith(":*")) { const base = new URL(rule.slice(0, -2)); return u.protocol === base.protocol && u.hostname === base.hostname; }
    return origin === rule;
  });
}
function cors(req, env) {
  const origin = req.headers.get("Origin");
  const h = { "Vary": "Origin", "Cache-Control": "no-store" };
  if (origin && originAllowed(origin, env)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
    h["Access-Control-Max-Age"] = "600";
  }
  return h;
}
const ipOf = (req) => req.headers.get("CF-Connecting-IP") || "0.0.0.0";

async function limited(binding, key) {
  if (!binding) return false;
  try { const { success } = await binding.limit({ key }); return !success; } catch { return false; }
}

async function mintTurn(env) {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return null;
  const ttl = Math.max(300, Math.min(3600 * 6, Number(env.TURN_TTL || 1800)));
  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const list = Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];
    return { iceServers: list.map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)) })), ttl };
  } catch { return null; }
}

let schemaOk = false;
async function schema(env) {
  if (schemaOk || !env.DB) return;
  await env.DB.batch([...SCHEMA, ...BILLING_SCHEMA, ...TENANT_SCHEMA, ...PLAN_SCHEMA, ...AI_SCHEMA, ...LIVE_SCHEMA, ...ACTIONS_SCHEMA, ...STITCH_SCHEMA].map((s) => env.DB.prepare(s)));
  schemaOk = true;
}

function publicConfig(env) {
  const handoff = Boolean(env.FD_HANDOFF_SECRET && env.NEBU_SESSION_SECRET && env.FD_HANDOFF_URL);
  return {
    version: 2,
    turnPolicy: env.TURN_POLICY || "host-present",
    turnTtl: Number(env.TURN_TTL || 1800),
    requireHostLogin: env.REQUIRE_HOST_LOGIN === "true",
    // FRISKY ID providers (exactly these four). Each is enabled only when listed in FD_PROVIDERS after
    // the matching app exists on forge.friskydev.com (see docs/SETUP-KEYS.md).
    friskyId: { enabled: handoff, start: handoff ? env.FD_HANDOFF_URL : null, missing: handoff ? [] : ["FD_HANDOFF_URL", "FD_HANDOFF_SECRET", "NEBU_SESSION_SECRET"].filter((k) => !env[k]),
      providers: ["apple", "google", "microsoft", "xai"].map((id) => ({ id, label: { apple: "Apple", google: "Google", microsoft: "Microsoft", xai: "Grok (xAI)" }[id], enabled: handoff && String(env.FD_PROVIDERS || "").split(",").map((s) => s.trim()).includes(id) })) },
    telegram: { login: Boolean(env.TELEGRAM_BOT_USERNAME && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_LOGIN_DOMAIN_OK === "true"), bot: env.TELEGRAM_BOT_USERNAME || null, import: Boolean(env.TELEGRAM_BOT_TOKEN && env.PACKS), submitMode: env.TELEGRAM_SUBMIT_MODE || "mock" },
    spotify: { clientId: env.SPOTIFY_CLIENT_ID || null },
    google: { clientId: env.GOOGLE_CLIENT_ID || null },
    relay: { url: env.RELAY_URL || null },
    packs: { enabled: packsEnabled(env) },
    billing: { mode: "test", configured: Boolean(env.WHOP_API_KEY) },
    maxNebuPerId: Number(env.MAX_NEBU_PER_ID || 1),
    live: liveConfig(env),
    tts: ttsConfig(env),
    importAnon: env.IMPORT_ANON === "true",
    stitch: stitchConfig(env),
    // Designed, not enabled in this PR (see docs/DESIGN-STAGE2.md).
    stage2: { tenantUserbot: false, discord: false, videoChatJoin: false, rtmpOut: false, ownNumbers: false, assistant: false, credits: false, drive: false, spotify: false, virtualCam: false, extension: false },
    // Stage 2 (not built): Vellum assistant trial. Disabled unless VELLUM_TRIAL_ENABLED=true.
    paperclipLink: { enabled: false, desk: "https://clip.friskydev.com" }, // design-only: link a FR!sky Paperclip seat to FRISKY ID
    assistantTrial: { enabled: env.ASSISTANT_TRIAL_ENABLED === "true", providers: ["vellum", "paperclip-frisky"], days: Number(env.ASSISTANT_TRIAL_DAYS || 0) || null },
  };
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = url.origin;
    const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors(req, env), ...extra } });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req, env) });
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const parts = path.split("/").filter(Boolean);

    if (path === "/" || path === "/health") {
      return json({ ok: true, service: "nebu-rooms", version: 2, turn: Boolean(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN), turnPolicy: env.TURN_POLICY || "host-present", maxPeers: Number(env.MAX_PEERS || 6) });
    }
    if (path === "/config") return json(publicConfig(env));
    if (path === "/ice") return json({ error: "moved", hint: "ICE servers arrive over the room WebSocket now." }, 410);
    if (path === "/api/stitch/callback" && req.method === "POST") {
      if (!env.DB || !env.PACKS) return json({ error: "not_configured" }, 503);
      await schema(env); const r = await stitchCallback(env, req); return json(r.body, r.status);
    }

    // Rooms
    const m = path.match(/^\/rooms\/([^/]+)\/ws$/);
    if (m) {
      const room = decodeURIComponent(m[1]).toLowerCase();
      if (!ROOM_RE.test(room)) return json({ error: "bad room name" }, 400);
      if (req.headers.get("Upgrade") !== "websocket") return json({ error: "expected websocket" }, 426);
      if (!originAllowed(req.headers.get("Origin"), env)) return json({ error: "origin not allowed" }, 403);
      if (await limited(env.JOIN_LIMIT, ipOf(req))) return json({ error: "slow down" }, 429);
      const user = await sessionUser(env, url.searchParams.get("t") || "");
      const headers = new Headers(req.headers);
      headers.delete("X-Nebu-User");
      headers.set("X-Nebu-IP", ipOf(req));
      if (user) headers.set("X-Nebu-User", JSON.stringify({ id: user.id, name: user.name }));
      const clean = new URL(req.url); clean.searchParams.delete("t");
      const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
      return stub.fetch(new Request(clean.toString(), { headers, method: "GET" }));
    }

    // Public reads
    if (parts[0] === "f" && env.PACKS) return serveFile(env, req, decodeURI(path.slice(3)));
    if (parts[0] === "s" && parts[1] && env.DB) { await schema(env); return handleShare(env, parts[1], origin, json); }
    if (path === "/billing/catalog") return json(catalog(env));
    if (path === "/plans") return json({ ...publicPlans(env), aiTopups: topupCatalog(env) });
    if (path === "/billing/webhook" && req.method === "POST") { await schema(env); const r = await handleWebhook(env, req); return json(r.body, r.status); }

    // Live chat (viewers need no FRISKY ID) and TTS
    const earlyUser = await sessionUser(env, bearer(req));
    if (parts[0] === "live") { if (env.DB) await schema(env); if (!env.DB) return json({ error: "storage_not_configured" }, 503); return handleLive(env, req, parts, url, earlyUser, json, ipOf(req), limited); }
    if (path === "/tts" && req.method === "POST") {
      const cfg = ttsConfig(env);
      if (!cfg.enabled) return json({ error: "tts_not_enabled" }, 503);
      if (!earlyUser && !cfg.anon) return json({ error: "sign_in_required" }, 401);
      if (await limited(env.IMPORT_LIMIT, earlyUser ? earlyUser.id : `tts:${ipOf(req)}`)) return json({ error: "slow down" }, 429);
      const tb = await req.json().catch(() => ({}));
      let r = await speak(env, tb); if (!r.audio && r.status >= 500) r = await speak(env, tb); // Workers AI blips: one retry
      if (r.audio) return new Response(r.audio.bytes, { headers: { "Content-Type": r.audio.mime, ...cors(req, env) } });
      return json(r.body, r.status);
    }
    if (path === "/telegram/import" && req.method === "POST" && !earlyUser && env.IMPORT_ANON === "true") {
      // Preview: import without an account (files cached in R2, no pack saved). Rate-limited per IP.
      if (!env.TELEGRAM_BOT_TOKEN || !env.PACKS) return json({ error: "telegram_import_not_connected" }, 503);
      if (await limited(env.IMPORT_LIMIT, `imp:${ipOf(req)}`)) return json({ error: "slow down" }, 429);
      const body = await req.json().catch(() => ({}));
      const name = parseSetName(body.set);
      if (!name) return json({ error: "bad_set_link", hint: "Paste a t.me/addstickers/<name> link." }, 400);
      try { const b = await importBatch(env, name, Math.max(0, Number(body.cursor) || 0)); return json({ pack: null, set: b.set, items: await withUrls(env, origin, b.items), added: b.items.length, next: b.next }); }
      catch (e) { return json({ error: e.code === 400 ? "set_not_found" : "telegram_error" }, e.code === 400 ? 404 : 502); }
    }

    // Auth
    if (path === "/auth/exchange" && req.method === "POST") {
      if (await limited(env.AUTH_LIMIT, ipOf(req))) return json({ error: "slow down" }, 429);
      if (!env.FD_HANDOFF_SECRET || !env.NEBU_SESSION_SECRET) return json({ error: "friskyid_not_connected" }, 503);
      const body = await req.json().catch(() => ({}));
      const out = await exchangeHandoff(env, body.token);
      if (!out) return json({ error: "invalid_handoff" }, 401);
      if (env.DB) { await schema(env); await ensureUser(env, out.user); }
      return json(out);
    }
    const user = await sessionUser(env, bearer(req));
    if (path === "/auth/me") return user ? json({ user }) : json({ error: "signed_out" }, 401);

    // Admin delivery (bot/tool), separate secret
    if (parts[0] === "admin" && parts[1] === "requests" && parts[3] === "deliver" && req.method === "POST") {
      if (!env.ADMIN_TOKEN || bearer(req) !== env.ADMIN_TOKEN) return json({ error: "forbidden" }, 403);
      await schema(env);
      const r = await deliverRequest(env, parts[2], await req.json().catch(() => ({})));
      return json(r.body, r.status);
    }

    // Everything below needs a FRISKY ID session; every query is scoped to user.id.
    const needs = ["packs", "me", "requests", "stitch", "billing", "connect", "telegram", "ai", "actions"];
    if (needs.includes(parts[0])) {
      if (!user) return json({ error: "sign_in_required" }, 401);
      if (!env.DB) return json({ error: "storage_not_configured" }, 503);
      await schema(env);
      await ensureUser(env, user);
    }
    if (parts[0] === "packs") {
      if (!env.PACKS) return json({ error: "storage_not_configured" }, 503);
      if (req.method !== "GET" && await limited(env.WRITE_LIMIT, user.id)) return json({ error: "slow down" }, 429);
      return handlePacks(env, req, user, parts, origin, json);
    }
    if (path === "/connect/telegram" && req.method === "POST") {
      if (await limited(env.WRITE_LIMIT, user.id)) return json({ error: "slow down" }, 429);
      const as = url.searchParams.get("as") === "nebu" ? "telegram_nebu" : "telegram";
      const tg = await verifyLoginWidget(env, await req.json().catch(() => null));
      if (!tg) return json({ error: "telegram_verify_failed" }, 401);
      try { await setLink(env, user.id, as, tg); } catch (e) { return json({ error: e.message, friendly: e.friendly || "" }, 409); }
      return json({ telegram: tg, as, session: as === "telegram" ? await reissueWithTelegram(env, user, tg) : null });
    }
    if (parts[0] === "connect" && parts[1] && req.method === "PUT") {
      if (parts[1].startsWith("telegram")) return json({ error: "use_login_widget" }, 400); // Telegram links must be verified
      try { await setLink(env, user.id, parts[1], await req.json().catch(() => ({}))); } catch (e) { return json({ error: e.message }, 400); }
      return json({ ok: true });
    }
    if (parts[0] === "connect" && parts[1] && req.method === "DELETE") { await removeLink(env, user.id, parts[1]); return json({ ok: true }); }
    if (path === "/telegram/import" && req.method === "POST") {
      if (!env.TELEGRAM_BOT_TOKEN || !env.PACKS) return json({ error: "telegram_import_not_connected", missing: ["TELEGRAM_BOT_TOKEN"].filter((k) => !env[k]) }, 503);
      if (await limited(env.IMPORT_LIMIT, user.id) || await limited(env.IMPORT_LIMIT, ipOf(req))) return json({ error: "slow down" }, 429);
      const body = await req.json().catch(() => ({}));
      const name = parseSetName(body.set);
      if (!name) return json({ error: "bad_set_link", hint: "Paste a t.me/addstickers/<name> link." }, 400);
      let batch;
      try { batch = await importBatch(env, name, Math.max(0, Number(body.cursor) || 0)); }
      catch (e) { return json({ error: e.code === 400 ? "set_not_found" : "telegram_error", detail: String(e.message).slice(0, 120) }, e.code === 400 ? 404 : 502); }
      // Keep a pack per (user, set) in My packs, appending items batch by batch.
      const packName = `Telegram · ${batch.set.title}`.slice(0, 60);
      let row = await env.DB.prepare(`SELECT id, manifest FROM packs WHERE owner = ?1 AND source = ?2`).bind(user.id, `telegram:${name}`).first();
      if (!row) { const id = await createPackFor(env, user.id, packName, "telegram", { version: 1, telegram: name, items: [] }, `telegram:${name}`); row = { id, manifest: JSON.stringify({ version: 1, telegram: name, items: [] }) }; }
      const man = JSON.parse(row.manifest); const have = new Set(man.items.map((i) => i.id));
      for (const it of batch.items) if (!have.has(it.id)) man.items.push({ ...it, kind: "sticker" });
      await env.DB.prepare(`UPDATE packs SET manifest = ?2, updated = ?3 WHERE id = ?1 AND owner = ?4`).bind(row.id, JSON.stringify(man), Date.now(), user.id).run();
      return json({ pack: row.id, set: batch.set, items: await withUrls(env, origin, batch.items), added: batch.items.length, next: batch.next });
    }
    if (parts[0] === "me" && parts[1] === "nebu") {
      if (parts.length === 2 && req.method === "GET") return json(await yourNebu(env, user));
      if (parts.length === 2 && req.method === "POST") { const r = await createTenant(env, user, await req.json().catch(() => ({}))); return json(r.body, r.status); }
      const id = parts[2];
      if (parts[3] === "bot" && req.method === "PUT") { if (await limited(env.WRITE_LIMIT, user.id)) return json({ error: "slow down" }, 429); const b = await req.json().catch(() => ({})); const r = await setTenantBot(env, user, id, b.token); return json(r.body, r.status); }
      if (parts[3] === "bot" && req.method === "GET") { const r = await checkTenantBot(env, user, id); return json(r.body, r.status); }
      if (parts[3] === "tg" && parts[4]) {
        // NEBU user account (MTProto) ops, proxied to the tenant's TgUser Durable Object. Owner-checked.
        const t = await env.DB.prepare(`SELECT id FROM tenants WHERE id = ?1 AND owner = ?2`).bind(id, user.id).first();
        if (!t) return json({ error: "not_found" }, 404);
        if (await limited(env.AUTH_LIMIT, `tg:${user.id}`)) return json({ error: "slow down" }, 429);
        const personal = await env.DB.prepare(`SELECT tg_id FROM users WHERE id = ?1`).bind(user.id).first();
        const stub = env.TG_USERS.get(env.TG_USERS.idFromName(id));
        const r = await stub.fetch(new Request(`https://tg/${parts[4]}`, { method: req.method, body: req.method === "POST" ? await req.text() : undefined, headers: { "X-Nebu-Tenant": JSON.stringify({ tenant: id, owner: user.id, personalTgId: personal && personal.tg_id }) } }));
        return json(await r.json(), r.status);
      }
      if (parts.length === 3 && req.method === "DELETE") {
        // Deleting a NEBU revokes its Telegram user session first.
        const stub = env.TG_USERS.get(env.TG_USERS.idFromName(id));
        await stub.fetch(new Request("https://tg/logout", { method: "POST", body: "{}", headers: { "X-Nebu-Tenant": JSON.stringify({ tenant: id, owner: user.id }) } })).catch(() => {});
        const r = await deleteTenant(env, user, id); return json(r.body, r.status);
      }
    }
    if (path === "/actions/join-message" && req.method === "POST") { const r = await postJoinMessage(env, user.id, await req.json().catch(() => ({}))); return json(r.body, r.status); }
    if (path === "/actions/log") return json({ log: await actionLog(env, user.id) });
    if (path === "/stitch" && req.method === "GET") return json(await listStitch(env, user));
    if (path === "/stitch" && req.method === "POST") { if (await limited(env.WRITE_LIMIT, user.id)) return json({ error: "slow down" }, 429); const r = await dispatchStitch(env, ctx, user, await req.json().catch(() => ({})), origin); return json(r.body, r.status); }
    if (path === "/requests" && req.method === "GET") return json(await listRequests(env, user));
    if (path === "/requests" && req.method === "POST") { if (await limited(env.WRITE_LIMIT, user.id)) return json({ error: "slow down" }, 429); const r = await createRequest(env, user, await req.json().catch(() => ({}))); return json(r.body, r.status); }
    if (path === "/billing/checkout" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const ret = typeof b.returnUrl === "string" && originAllowed(new URL(b.returnUrl).origin, env) ? b.returnUrl : "https://nebu.quest/studio/";
      const r = await createCheckout(env, user, b.tier, ret); return json(r.body, r.status);
    }
    if (path === "/me/entitlements") return json(await entitlements(env, user.id));
    if (path === "/ai/usage") return json(await usage(env, user.id));
    if (path === "/ai/assist" && req.method === "POST") { if (await limited(env.WRITE_LIMIT, user.id)) return json({ error: "slow down" }, 429); const b = await req.json().catch(() => ({})); const r = await assist(env, user.id, b.task, b.input); return json(r.body, r.status); }
    if (path === "/ai/key" && req.method === "PUT") { const b = await req.json().catch(() => ({})); return (await saveUserKey(env, user.id, b.provider, b.key)) ? json({ ok: true }) : json({ error: "bad_key" }, 400); }
    if (path === "/ai/auto-topup" && req.method === "PUT") { const b = await req.json().catch(() => ({})); await setAutoTopup(env, user.id, b.on === true); return json({ ok: true, autoTopup: b.on === true }); }
    if (path === "/ai/key" && req.method === "DELETE") { await env.DB.prepare(`DELETE FROM ai_keys WHERE owner = ?1`).bind(user.id).run(); return json({ ok: true }); }
    if (path === "/billing/balance") return json({ credits: await balance(env, user.id), catalog: catalog(env) });

    return json({ error: "not found" }, 404);
  },
};

async function withUrls(env, origin, items) {
  return Promise.all(items.map(async (it) => ({ ...it, url: String(it.src || "").startsWith("r2:") ? await fileUrl(env, origin, it.src.slice(3)) : it.src })));
}
function clean(value, max) { return String(value || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max); }

export class Room extends DurableObject {
  async fetch(req) {
    const url = new URL(req.url);
    const max = Number(this.env.MAX_PEERS || 6);
    const current = this.ctx.getWebSockets().filter((ws) => ws.deserializeAttachment());
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    if (current.length >= max) {
      server.send(JSON.stringify({ type: "full", max }));
      server.close(4001, "room full");
      return new Response(null, { status: 101, webSocket: client });
    }
    let verified = null;
    try { verified = JSON.parse(req.headers.get("X-Nebu-User") || "null"); } catch { verified = null; }
    const me = {
      id: crypto.randomUUID().replace(/-/g, "").slice(0, 10),
      name: clean(url.searchParams.get("name"), 32) || (verified && verified.name) || "Guest",
      role: url.searchParams.get("role") === "viewer" ? "viewer" : "guest",
      host: Boolean(verified),
      uid: verified ? verified.id : null,
      ip: req.headers.get("X-Nebu-IP") || "",
      joined: Date.now(), ice: 0, chatAt: 0,
    };
    server.serializeAttachment(me);
    const pub = (a) => ({ id: a.id, name: a.name, role: a.role, host: a.host, joined: a.joined });
    const peers = current.map((ws) => ws.deserializeAttachment()).filter(Boolean).map(pub);
    const hostPresent = me.host || peers.some((p) => p.host);
    const policy = this.env.TURN_POLICY || "host-present";
    const turnConfigured = Boolean(this.env.TURN_KEY_ID && this.env.TURN_KEY_API_TOKEN);
    const eligible = turnConfigured && (policy === "any" || (policy === "host-present" && hostPresent));
    const ice = eligible ? await this.issue(server, me) : null;
    server.send(JSON.stringify({
      type: "welcome", you: pub(me), peers, max,
      iceServers: ice ? ice.iceServers : STUN, turn: Boolean(ice),
      relay: ice ? "ready" : turnConfigured ? (policy === "host-present" ? "waiting-for-host" : "limited") : "off",
    }));
    this.broadcast({ type: "peer-joined", peer: pub(me) }, server);
    // A signed-in host arriving arms TURN for everyone already waiting.
    if (me.host && eligible) {
      for (const ws of this.ctx.getWebSockets()) {
        if (ws === server) continue;
        const a = ws.deserializeAttachment();
        if (a && !a.ice) await this.issue(ws, a, true);
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async issue(ws, att, push) {
    if (this.env.TURN_LIMIT) {
      try { const { success } = await this.env.TURN_LIMIT.limit({ key: att.ip || att.id }); if (!success) return null; } catch { /* limiter unavailable */ }
    }
    const ice = await mintTurn(this.env);
    if (!ice) return null;
    att.ice = Date.now();
    ws.serializeAttachment(att);
    if (push) { try { ws.send(JSON.stringify({ type: "ice-servers", iceServers: ice.iceServers, turn: true })); } catch { /* gone */ } }
    const next = Date.now() + Math.max(120, ice.ttl - 300) * 1000;
    const cur = await this.ctx.storage.getAlarm();
    if (!cur || cur > next) await this.ctx.storage.setAlarm(next);
    return ice;
  }

  async alarm() {
    const sockets = this.ctx.getWebSockets().filter((ws) => { const a = ws.deserializeAttachment(); return a && a.ice; });
    const hostPresent = this.ctx.getWebSockets().some((ws) => { const a = ws.deserializeAttachment(); return a && a.host; });
    if ((this.env.TURN_POLICY || "host-present") === "host-present" && !hostPresent) return; // host left: stop renewing
    for (const ws of sockets) await this.issue(ws, ws.deserializeAttachment(), true);
  }

  broadcast(msg, except) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(data); } catch { /* socket already gone */ }
    }
  }

  webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > MAX_MSG) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const me = ws.deserializeAttachment();
    if (!me || !msg || typeof msg !== "object") return;
    if (msg.type === "ping") { ws.send('{"type":"pong"}'); return; }
    if (msg.type === "chat") {
      const now = Date.now();
      if (now - (me.chatAt || 0) < 600) return;
      const text = clean(msg.text, 280);
      if (!text) return;
      me.chatAt = now; ws.serializeAttachment(me);
      this.broadcast({ type: "chat", from: me.id, name: me.name, text, at: now });
      return;
    }
    if (msg.type === "pack-share") {
      // Hosts only: point guests at a read-only share link of a pack.
      if (!me.host || typeof msg.url !== "string" || !/^https:\/\/[^\s]{8,300}\/s\/[A-Za-z0-9_-]{8,40}$/.test(msg.url)) return;
      this.broadcast({ type: "pack-share", from: me.id, name: me.name, url: msg.url, title: clean(msg.title, 60) }, ws);
      return;
    }
    if (!RELAY_TYPES.has(msg.type) || typeof msg.to !== "string") return;
    for (const other of this.ctx.getWebSockets()) {
      const att = other.deserializeAttachment();
      if (att && att.id === msg.to) {
        try { other.send(JSON.stringify({ type: msg.type, from: me.id, data: msg.data })); } catch { /* gone */ }
        break;
      }
    }
  }
  leave(ws) {
    const me = ws.deserializeAttachment();
    if (me) this.broadcast({ type: "peer-left", id: me.id }, ws);
    ws.serializeAttachment(null);
  }
  webSocketClose(ws, code) { this.leave(ws); try { ws.close(code === 1005 ? 1000 : code, "bye"); } catch { /* closed */ } }
  webSocketError(ws) { this.leave(ws); }
}
