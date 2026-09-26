/*
 * nebu-rooms: signaling for NEBU studio rooms.
 *
 * One Durable Object per room name. Browsers connect with a WebSocket,
 * learn who else is in the room, and relay SDP offers/answers and ICE
 * candidates to each other. Audio and video never pass through here: they go
 * browser to browser (WebRTC), or through Cloudflare Realtime TURN when a
 * direct path is blocked. Nothing is stored; a room disappears when the last
 * person leaves.
 *
 *   GET /health               -> { ok, turn }
 *   GET /ice                  -> { iceServers } (short-lived TURN creds if configured)
 *   GET /rooms/:room/ws       -> WebSocket upgrade (?name=&role=guest|viewer)
 */
import { DurableObject } from "cloudflare:workers";

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
    if (rule.endsWith(":*")) {
      const base = new URL(rule.slice(0, -2));
      return u.protocol === base.protocol && u.hostname === base.hostname;
    }
    return origin === rule;
  });
}

function cors(req, env) {
  const origin = req.headers.get("Origin");
  const h = { "Vary": "Origin", "Cache-Control": "no-store" };
  if (origin && originAllowed(origin, env)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "GET, OPTIONS";
  }
  return h;
}

function json(body, req, env, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(req, env) },
  });
}

async function iceServers(env) {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return { iceServers: STUN, turn: false };
  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: 6 * 60 * 60 }),
      }
    );
    if (!res.ok) throw new Error(`turn ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];
    // Drop port 53 URLs: browsers block them and they only slow ICE down.
    const cleaned = list.map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)) }));
    return { iceServers: cleaned, turn: true };
  } catch {
    return { iceServers: STUN, turn: false };
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req, env) });

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, service: "nebu-rooms", turn: Boolean(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN), maxPeers: Number(env.MAX_PEERS || 6) }, req, env);
    }

    if (url.pathname === "/ice") {
      // TURN credentials cost bandwidth: only hand them to NEBU pages.
      if (!originAllowed(req.headers.get("Origin"), env)) return json({ error: "origin not allowed" }, req, env, 403);
      const ice = await iceServers(env);
      return json(ice, req, env);
    }

    const m = url.pathname.match(/^\/rooms\/([^/]+)\/ws$/);
    if (m) {
      const room = decodeURIComponent(m[1]).toLowerCase();
      if (!ROOM_RE.test(room)) return json({ error: "bad room name" }, req, env, 400);
      if (req.headers.get("Upgrade") !== "websocket") return json({ error: "expected websocket" }, req, env, 426);
      if (!originAllowed(req.headers.get("Origin"), env)) return json({ error: "origin not allowed" }, req, env, 403);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
      return stub.fetch(req);
    }

    return json({ error: "not found" }, req, env, 404);
  },
};

function clean(value, max) {
  return String(value || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);
}

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

    const me = {
      id: crypto.randomUUID().replace(/-/g, "").slice(0, 10),
      name: clean(url.searchParams.get("name"), 32) || "Guest",
      role: url.searchParams.get("role") === "viewer" ? "viewer" : "guest",
      joined: Date.now(),
    };
    server.serializeAttachment(me);

    const peers = current.map((ws) => ws.deserializeAttachment()).filter(Boolean);
    server.send(JSON.stringify({ type: "welcome", you: me, peers, max }));
    this.broadcast({ type: "peer-joined", peer: me }, server);
    return new Response(null, { status: 101, webSocket: client });
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

  webSocketClose(ws, code) {
    this.leave(ws);
    try { ws.close(code === 1005 ? 1000 : code, "bye"); } catch { /* closed */ }
  }

  webSocketError(ws) {
    this.leave(ws);
  }
}
