// Live chat for viewers: one LiveHub Durable Object per live session (hibernating WebSockets; pattern
// after cloudflare/workers-chat-demo, no code copied). Viewers join from the Telegram Mini App
// (t.me/<bot>/live?startapp=<sid>, initData validated with @tma.js/init-data-node against the bot token)
// or from the web fallback (nebu.quest/live/<sid>, guest name + per-IP rate limit, no captcha).
// The host (studio) holds a host token. Sessions expire when ended; the host can rotate the link.
//
//   POST /live                      -> { sid, hostToken, webUrl, tgUrl }     (host; FRISKY ID or LIVE_ANON_HOSTS)
//   POST /live/:sid/auth            {initData} | {guest}  -> { token, me }    (viewer)
//   GET  /live/:sid/ws?t=token      WebSocket (viewer or host)
//   POST /live/:sid/end | /rotate   (host token)
import { DurableObject } from "cloudflare:workers";
import { validate, parse } from "@tma.js/init-data-node/web";
import { sign, verify, randomId } from "./auth.js";

export const LIVE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS live_sessions (sid TEXT PRIMARY KEY, owner TEXT, owner_tg TEXT, status TEXT NOT NULL, created INTEGER, ended INTEGER)`,
];
const SID_RE = /^[A-Za-z0-9_-]{10,40}$/;
const REACTIONS = ["🔥", "💜", "👏", "😂", "🎉", "⚡", "🐺", "✨"];
const clean = (v, n) => String(v || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);
const secret = (env) => env.LIVE_SECRET || env.NEBU_SESSION_SECRET;

export function liveConfig(env) {
  return { enabled: Boolean(secret(env) && env.LIVE), bot: env.TELEGRAM_BOT_USERNAME || null, app: env.TELEGRAM_MINIAPP_NAME || "live", web: env.LIVE_WEB_BASE || "https://nebu.quest/live/", anonHosts: env.LIVE_ANON_HOSTS === "true" };
}
function links(env, sid) {
  const c = liveConfig(env);
  return { webUrl: c.web + sid, tgUrl: c.bot ? `https://t.me/${c.bot}/${c.app}?startapp=${sid}` : null };
}

export async function createLive(env, user) {
  const sid = randomId(12);
  await env.DB.prepare(`INSERT INTO live_sessions (sid, owner, owner_tg, status, created) VALUES (?1, ?2, ?3, 'live', ?4)`).bind(sid, user ? user.id : null, user && user.tg ? String(user.tg.id) : null, Date.now()).run();
  const now = Math.floor(Date.now() / 1000);
  const hostToken = await sign(secret(env), { aud: "nebu-live", sid, uid: user ? user.id : "host", name: (user && user.name) || "Host", role: "host", iat: now, exp: now + 12 * 3600 });
  return { sid, hostToken, ...links(env, sid) };
}

async function session(env, sid) {
  if (!SID_RE.test(sid || "")) return null;
  return env.DB.prepare(`SELECT sid, owner, owner_tg, status FROM live_sessions WHERE sid = ?1`).bind(sid).first();
}

export async function hostOf(env, sid, token) {
  const p = await verify(secret(env), token || "", "nebu-live");
  return p && p.sid === sid && p.role === "host" ? p : null;
}

// Viewer auth. Telegram: initData HMAC (bot token) + auth_date freshness. Web: guest name.
export async function authViewer(env, sid, body) {
  const s = await session(env, sid);
  if (!s || s.status !== "live") return { status: 410, body: { error: "session_ended", friendly: "This live chat has ended." } };
  const now = Math.floor(Date.now() / 1000);
  let me;
  if (body && body.initData) {
    if (!env.TELEGRAM_BOT_TOKEN) return { status: 503, body: { error: "telegram_not_connected" } };
    try { await validate(body.initData, env.TELEGRAM_BOT_TOKEN, { expiresIn: Number(env.LIVE_INITDATA_TTL || 3600) }); }
    catch { return { status: 401, body: { error: "bad_init_data" } }; }
    const d = parse(body.initData);
    const u = d.user || {};
    const startSid = d.start_param || d.startParam;
    if (startSid && startSid !== sid) return { status: 400, body: { error: "wrong_session" } };
    me = { uid: `tg_${u.id}`, name: clean([u.first_name || u.firstName, u.last_name || u.lastName].filter(Boolean).join(" ") || u.username || "Viewer", 40), via: "telegram", owner: Boolean(s.owner_tg && String(u.id) === s.owner_tg) };
  } else {
    const name = clean(body && body.guest, 24);
    if (name.length < 2) return { status: 400, body: { error: "name_required", friendly: "Pick a name with at least 2 letters." } };
    me = { uid: `web_${randomId(6)}`, name, via: "web", owner: false };
  }
  const token = await sign(secret(env), { aud: "nebu-live", sid, ...me, role: me.owner ? "host" : "viewer", iat: now, exp: now + 6 * 3600 });
  return { status: 200, body: { token, me } };
}

export async function endLive(env, sid, rotate) {
  await env.DB.prepare(`UPDATE live_sessions SET status = 'ended', ended = ?2 WHERE sid = ?1`).bind(sid, Date.now()).run();
  const hub = env.LIVE.get(env.LIVE.idFromName(sid));
  await hub.fetch(new Request("https://hub/end", { method: "POST" })).catch(() => {});
  return { ok: true };
}

// ---- Durable Object ----
export class LiveHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.rate = new Map();
  }
  async state() { return (await this.ctx.storage.get("s")) || { pinned: null, poll: null, queue: [], slow: 0, ended: false, history: [] }; }
  async save(s) { await this.ctx.storage.put("s", s); }
  broadcast(msg, except) { const d = JSON.stringify(msg); for (const ws of this.ctx.getWebSockets()) if (ws !== except) { try { ws.send(d); } catch { /* */ } } }
  viewers() { return this.ctx.getWebSockets().length; }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/end") { const s = await this.state(); s.ended = true; await this.save(s); this.broadcast({ type: "ended" }); for (const ws of this.ctx.getWebSockets()) ws.close(4000, "ended"); return new Response("ok"); }
    const me = JSON.parse(req.headers.get("X-Live-Me") || "null");
    if (!me) return new Response("no", { status: 403 });
    const s = await this.state();
    if (s.ended) return new Response("ended", { status: 410 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ ...me, at: 0, n: 0, win: Date.now() });
    server.send(JSON.stringify({ type: "hello", me, pinned: s.pinned, poll: publicPoll(s.poll), queue: s.queue, slow: s.slow, history: s.history.slice(-30), viewers: this.viewers(), reactions: REACTIONS }));
    this.broadcast({ type: "presence", viewers: this.viewers() }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  allow(ws, me, cost = 1, slow = 0, lane = "at", gap = 800) {
    const now = Date.now();
    if (now - me.win > 60e3) { me.win = now; me.n = 0; }
    if (me.role !== "host") {
      if (me.n + cost > 20) return false;           // 20 actions/minute per viewer
      if (now - (me[lane] || 0) < Math.max(gap, slow * 1000)) return false; // min gap (slow mode raises it for chat)
    }
    me.n += cost; me[lane] = now; ws.serializeAttachment(me); return true;
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 4096) return;
    let m; try { m = JSON.parse(raw); } catch { return; }
    const me = ws.deserializeAttachment();
    const host = me.role === "host";
    const s = await this.state();
    if (m.type === "ping") return;
    const who = { uid: me.uid, name: me.name, host, via: me.via };
    const push = (msg) => { s.history.push(msg); if (s.history.length > 60) s.history.shift(); };
    if (m.type === "react") { if (!REACTIONS.includes(m.emoji) || !this.allow(ws, me, 0.25, 0, "rt", 250)) return; this.broadcast({ type: "react", emoji: m.emoji, from: who }); return; }
    if (!this.allow(ws, me, 1, host ? 0 : s.slow)) { ws.send(JSON.stringify({ type: "slow", wait: Math.max(1, s.slow) })); return; }
    switch (m.type) {
      case "chat": { const text = clean(m.text, 300); if (!text) return; const msg = { type: "chat", id: randomId(6), from: who, text, at: Date.now(), nebu: host && m.nebu === true }; push(msg); this.broadcast(msg); break; }
      case "request": {
        const song = clean(m.song, 120); if (song.length < 2) return;
        if (s.queue.length >= 50) s.queue.shift();
        const item = { id: randomId(6), song, from: who.name, votes: 1, status: "queued" }; s.queue.push(item);
        this.broadcast({ type: "queue", queue: s.queue }); break;
      }
      case "upvote": { const it = s.queue.find((q) => q.id === m.id); if (!it) return; it.votes++; s.queue.sort((a, b) => (a.status === "playing" ? -1 : b.status === "playing" ? 1 : b.votes - a.votes)); this.broadcast({ type: "queue", queue: s.queue }); break; }
      case "vote": {
        if (!s.poll || s.poll.closed) return; const i = Number(m.option);
        if (!(i >= 0 && i < s.poll.options.length)) return;
        s.poll.voters = s.poll.voters || {}; const prev = s.poll.voters[me.uid];
        if (prev !== undefined) s.poll.counts[prev]--; s.poll.voters[me.uid] = i; s.poll.counts[i]++;
        this.broadcast({ type: "poll", poll: publicPoll(s.poll) }); break;
      }
      // Host-only admin actions
      case "pin": if (!host) return; s.pinned = m.text ? { text: clean(m.text, 200), at: Date.now() } : null; this.broadcast({ type: "pinned", pinned: s.pinned }); break;
      case "poll_open": {
        if (!host) return; const options = (m.options || []).map((o) => clean(o, 60)).filter(Boolean).slice(0, 4);
        if (options.length < 2) return; s.poll = { id: randomId(6), q: clean(m.q, 120), options, counts: options.map(() => 0), voters: {}, closed: false };
        this.broadcast({ type: "poll", poll: publicPoll(s.poll) }); break;
      }
      case "poll_close": if (!host || !s.poll) return; s.poll.closed = true; this.broadcast({ type: "poll", poll: publicPoll(s.poll) }); break;
      case "queue_set": { if (!host) return; const it = s.queue.find((q) => q.id === m.id); if (!it) return; if (m.status === "remove") s.queue = s.queue.filter((q) => q.id !== m.id); else { for (const q of s.queue) if (q.status === "playing") q.status = "played"; it.status = clean(m.status, 10); } this.broadcast({ type: "queue", queue: s.queue }); break; }
      case "slow": if (!host) return; s.slow = Math.max(0, Math.min(60, Number(m.seconds) || 0)); this.broadcast({ type: "slowmode", slow: s.slow }); break;
      case "announce": { if (!host) return; const msg = { type: "announce", id: randomId(6), text: clean(m.text, 300), at: Date.now() }; push({ ...msg, type: "chat", from: { name: "NEBU", host: true }, nebu: true }); this.broadcast(msg); break; }
      default: return;
    }
    await this.save(s);
  }
  webSocketClose() { this.broadcast({ type: "presence", viewers: Math.max(0, this.viewers() - 1) }); }
  webSocketError() { /* hibernation cleans up */ }
}
function publicPoll(p) { return p ? { id: p.id, q: p.q, options: p.options, counts: p.counts, closed: p.closed, total: p.counts.reduce((a, b) => a + b, 0) } : null; }

// Route handler used by index.js
export async function handleLive(env, req, parts, url, user, json, ip, limited) {
  if (!liveConfig(env).enabled) return json({ error: "live_not_enabled" }, 503);
  if (parts.length === 1 && req.method === "POST") {
    if (!user && !liveConfig(env).anonHosts) return json({ error: "sign_in_required" }, 401);
    if (await limited(env.WRITE_LIMIT, user ? user.id : `ip:${ip}`)) return json({ error: "slow down" }, 429);
    return json(await createLive(env, user), 201);
  }
  const sid = parts[1];
  if (parts[2] === "auth" && req.method === "POST") {
    if (await limited(env.JOIN_LIMIT, `live:${ip}`)) return json({ error: "slow down" }, 429);
    const r = await authViewer(env, sid, await req.json().catch(() => ({}))); return json(r.body, r.status);
  }
  if (parts[2] === "ws") {
    if (req.headers.get("Upgrade") !== "websocket") return json({ error: "expected websocket" }, 426);
    const p = await verify(secret(env), url.searchParams.get("t") || "", "nebu-live");
    if (!p || p.sid !== sid) return json({ error: "bad_token" }, 401);
    const s = await session(env, sid); if (!s || s.status !== "live") return json({ error: "session_ended" }, 410);
    return env.LIVE.get(env.LIVE.idFromName(sid)).fetch(new Request(req.url, { headers: { Upgrade: "websocket", "X-Live-Me": JSON.stringify({ uid: p.uid, name: p.name, role: p.role, via: p.via || "studio" }) } }));
  }
  if ((parts[2] === "end" || parts[2] === "rotate") && req.method === "POST") {
    const h = await hostOf(env, sid, (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, ""));
    if (!h) return json({ error: "forbidden" }, 403);
    await endLive(env, sid);
    if (parts[2] === "rotate") return json(await createLive(env, h.uid === "host" ? null : { id: h.uid, name: h.name }), 201);
    return json({ ok: true });
  }
  if (parts.length === 2 && req.method === "GET") { const s = await session(env, sid); return json(s ? { status: s.status, ...links(env, sid) } : { error: "not_found" }, s ? 200 : 404); }
  return json({ error: "not found" }, 404);
}
