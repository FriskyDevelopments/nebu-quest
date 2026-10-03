// Signed tokens (HMAC-SHA256) shared by the FriskyDev handoff, NEBU sessions,
// signed file URLs and share links. Format: base64url(json).base64url(mac)
const enc = new TextEncoder();
const keyCache = new Map();

export function b64url(bytes) {
  let s = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64url(str) {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function hmacKey(secret) {
  if (keyCache.has(secret)) return keyCache.get(secret);
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  keyCache.set(secret, k);
  return k;
}
export async function hmac(secret, data) {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), typeof data === "string" ? enc.encode(data) : data);
  return new Uint8Array(sig);
}
export async function hmacHex(keyBytes, data) {
  const k = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
export async function sign(secret, payload) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return `${body}.${b64url(await hmac(secret, body))}`;
}
export async function verify(secret, token, aud) {
  if (!secret || typeof token !== "string" || token.length > 4096) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expect = b64url(await hmac(secret, body));
  if (!safeEqual(expect, mac)) return null;
  let p;
  try { p = JSON.parse(new TextDecoder().decode(unb64url(body))); } catch { return null; }
  const now = Math.floor(Date.now() / 1000);
  if (!p || typeof p !== "object" || (p.exp && p.exp < now)) return null;
  if (aud && p.aud !== aud) return null;
  return p;
}
export function randomId(n = 16) {
  return b64url(crypto.getRandomValues(new Uint8Array(n)));
}

export const SESSION_TTL = 12 * 3600;

// FriskyDev handoff (issued by forge.friskydev.com /auth/nebu/handoff) -> NEBU session
export async function exchangeHandoff(env, token) {
  const p = await verify(env.FD_HANDOFF_SECRET, token, "nebu.quest");
  if (!p || !p.sub || p.iss !== "forge.friskydev.com") return null;
  if (!p.exp || p.exp - Math.floor(Date.now() / 1000) > 600) return null; // handoffs are short-lived
  const user = {
    id: "fd_" + String(p.sub).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64),
    name: String(p.name || p.email || "FriskyDev user").slice(0, 64),
    email: p.email ? String(p.email).slice(0, 128) : "",
    picture: p.picture && /^https:\/\//.test(p.picture) ? String(p.picture).slice(0, 512) : "",
  };
  const now = Math.floor(Date.now() / 1000);
  const session = await sign(env.NEBU_SESSION_SECRET, { aud: "nebu-session", sub: user.id, name: user.name, email: user.email, picture: user.picture, iat: now, exp: now + SESSION_TTL });
  return { session, user, expiresAt: now + SESSION_TTL };
}

export async function sessionUser(env, token) {
  const p = await verify(env.NEBU_SESSION_SECRET, token, "nebu-session");
  if (!p || !p.sub) return null;
  return { id: p.sub, name: p.name || "", email: p.email || "", picture: p.picture || "", tg: p.tg || null };
}

export function bearer(req) {
  const h = req.headers.get("Authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

export async function reissueWithTelegram(env, user, tg) {
  const now = Math.floor(Date.now() / 1000);
  return sign(env.NEBU_SESSION_SECRET, { aud: "nebu-session", sub: user.id, name: user.name, email: user.email, picture: user.picture, tg, iat: now, exp: now + SESSION_TTL });
}
