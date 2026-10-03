// "Your own number": a phone number for the NEBU second Telegram account, behind a provider interface.
//   search({ country, type, contains, limit }) -> [{ e164, region, type, monthly? }]
//   buy({ e164, inboundUrl })                  -> { ref, e164 }        (only when NUMBERS_BUY_ENABLED=true)
//   verifyInbound(req, rawBody, url)            -> { ok, to, from, body }
//   release(ref)                                -> { ok }
// Adapters: twilio (first), telnyx. NUMBERS_MODE=mock never calls a carrier (tests + preview default).
// Honest limit: Telegram may refuse carrier/VoIP-range numbers at signup (line-type checks). The UI says so
// and suggests a real mobile SIM/eSIM line if the code never arrives. No disposable SMS services.
import { b64url, randomId } from "./auth.js";
import { seal, unseal } from "./tenant.js";

export const NUMBERS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS numbers (id TEXT PRIMARY KEY, owner TEXT NOT NULL, tenant TEXT NOT NULL, provider TEXT NOT NULL, e164 TEXT NOT NULL, ref TEXT, status TEXT NOT NULL, created INTEGER, released INTEGER)`,
  `CREATE INDEX IF NOT EXISTS numbers_tenant ON numbers(tenant)`,
  `CREATE TABLE IF NOT EXISTS inbound_codes (tenant TEXT PRIMARY KEY, sealed TEXT NOT NULL, at INTEGER NOT NULL)`,
];

// Telegram login SMS look like "Telegram code: 12345" / "Login code: 12345" / "Código de inicio de sesión: 12345".
export function extractTelegramCode(text) {
  const s = String(text || "");
  const m = s.match(/(?:code|c[oó]digo)[^\d]{0,40}(\d{5,6})\b/i) || (/telegram/i.test(s) && s.match(/\b(\d{5,6})\b/));
  return m ? m[1] : null;
}

const te = new TextEncoder();
async function hmacB64(alg, key, data) {
  const k = await crypto.subtle.importKey("raw", te.encode(key), { name: "HMAC", hash: alg }, false, ["sign"]);
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", k, te.encode(data)))));
}
const safeEq = (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };

// ---- Twilio ----
// Signature: base64(HMAC-SHA1(authToken, fullUrl + concat(sorted POST params as key+value))) in X-Twilio-Signature.
export async function twilioSignature(authToken, url, params) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return hmacB64("SHA-1", authToken, data);
}
class Twilio {
  constructor(env) { this.env = env; this.id = "twilio"; this.sid = env.TWILIO_ACCOUNT_SID; this.token = env.TWILIO_AUTH_TOKEN; }
  get ready() { return Boolean(this.sid && this.token); }
  api(path, init = {}) {
    return fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.sid}${path}`, { ...init, headers: { Authorization: "Basic " + btoa(`${this.sid}:${this.token}`), ...(init.headers || {}) } });
  }
  async search({ country = "US", type = "Mobile", contains = "", limit = 10 }) {
    const t = { local: "Local", mobile: "Mobile", tollfree: "TollFree" }[String(type).toLowerCase()] || "Mobile";
    const q = new URLSearchParams({ SmsEnabled: "true", PageSize: String(Math.min(20, limit)) }); if (contains) q.set("Contains", contains);
    const r = await this.api(`/AvailablePhoneNumbers/${country.toUpperCase()}/${t}.json?${q}`);
    if (!r.ok) throw Object.assign(new Error("search_failed"), { status: r.status });
    const d = await r.json();
    return (d.available_phone_numbers || []).map((n) => ({ e164: n.phone_number, region: n.region || n.locality || "", type: t.toLowerCase(), sms: n.capabilities && n.capabilities.SMS !== false }));
  }
  async buy({ e164, inboundUrl }) {
    const r = await this.api(`/IncomingPhoneNumbers.json`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ PhoneNumber: e164, SmsUrl: inboundUrl, SmsMethod: "POST" }) });
    if (!r.ok) throw Object.assign(new Error("buy_failed"), { status: r.status });
    const d = await r.json(); return { ref: d.sid, e164: d.phone_number };
  }
  async verifyInbound(req, raw, url) {
    const params = Object.fromEntries(new URLSearchParams(raw));
    const sig = req.headers.get("X-Twilio-Signature") || "";
    const ok = Boolean(this.token) && safeEq(await twilioSignature(this.token, url, params), sig);
    return { ok, to: params.To, from: params.From, body: params.Body || "" };
  }
  async release(ref) { const r = await this.api(`/IncomingPhoneNumbers/${ref}.json`, { method: "DELETE" }); return { ok: r.status === 204 || r.ok }; }
  reply() { return new Response("<Response/>", { headers: { "Content-Type": "text/xml" } }); }
}

// ---- Telnyx ----
// Webhook signature: Ed25519 over `${telnyx-timestamp}|${rawBody}`, header telnyx-signature-ed25519 (base64),
// verified with the account's public key (TELNYX_PUBLIC_KEY, base64).
class Telnyx {
  constructor(env) { this.env = env; this.id = "telnyx"; this.key = env.TELNYX_API_KEY; }
  get ready() { return Boolean(this.key); }
  api(path, init = {}) { return fetch(`https://api.telnyx.com/v2${path}`, { ...init, headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json", ...(init.headers || {}) } }); }
  async search({ country = "US", type = "local", contains = "", limit = 10 }) {
    const q = new URLSearchParams({ "filter[country_code]": country.toUpperCase(), "filter[features][]": "sms", "filter[limit]": String(Math.min(20, limit)), "filter[phone_number_type]": String(type).toLowerCase().replace("tollfree", "toll_free") });
    if (contains) q.set("filter[phone_number][contains]", contains);
    const r = await this.api(`/available_phone_numbers?${q}`);
    if (!r.ok) throw Object.assign(new Error("search_failed"), { status: r.status });
    const d = await r.json();
    return (d.data || []).map((n) => ({ e164: n.phone_number, region: (n.region_information || []).map((x) => x.region_name).join(", "), type: n.phone_number_type || type, monthly: n.cost_information && n.cost_information.monthly_cost }));
  }
  async buy({ e164 }) {
    const r = await this.api(`/number_orders`, { method: "POST", body: JSON.stringify({ phone_numbers: [{ phone_number: e164 }], messaging_profile_id: this.env.TELNYX_MESSAGING_PROFILE_ID }) });
    if (!r.ok) throw Object.assign(new Error("buy_failed"), { status: r.status });
    const d = await r.json(); return { ref: (d.data && d.data.phone_numbers && d.data.phone_numbers[0] && d.data.phone_numbers[0].id) || e164, e164 };
  }
  async verifyInbound(req, raw) {
    const ts = req.headers.get("telnyx-timestamp") || "", sig = req.headers.get("telnyx-signature-ed25519") || "";
    let ok = false;
    try {
      if (this.env.TELNYX_PUBLIC_KEY && Math.abs(Date.now() / 1000 - Number(ts)) < 300) {
        const k = await crypto.subtle.importKey("raw", Uint8Array.from(atob(this.env.TELNYX_PUBLIC_KEY), (c) => c.charCodeAt(0)), { name: "Ed25519" }, false, ["verify"]);
        ok = await crypto.subtle.verify("Ed25519", k, Uint8Array.from(atob(sig), (c) => c.charCodeAt(0)), te.encode(`${ts}|${raw}`));
      }
    } catch { ok = false; }
    let p = {}; try { p = JSON.parse(raw).data.payload || {}; } catch { /* */ }
    return { ok, to: p.to && p.to[0] && p.to[0].phone_number, from: p.from && p.from.phone_number, body: p.text || "" };
  }
  async release(ref) { const r = await this.api(`/phone_numbers/${ref}`, { method: "DELETE" }); return { ok: r.ok }; }
  reply() { return new Response(null, { status: 204 }); }
}

// ---- Mock: deterministic, never calls a carrier ----
class Mock {
  constructor(env, base) { this.base = base; this.id = base.id; this.env = env; }
  get ready() { return true; }
  async search({ country = "US", limit = 3 }) { return Array.from({ length: Math.min(3, limit) }, (_, i) => ({ e164: `+1555010${String(i).padStart(4, "0")}`, region: "Mock", type: "mobile", country, mock: true })); }
  async buy({ e164 }) { return { ref: "MOCK" + randomId(6), e164, mock: true }; }
  async verifyInbound(req, raw, url) { return this.base.verifyInbound(req, raw, url); }
  async release() { return { ok: true, mock: true }; }
  reply() { return this.base.reply(); }
}

export function provider(env, id) {
  const pick = id || env.NUMBERS_PROVIDER || "twilio";
  const base = pick === "telnyx" ? new Telnyx(env) : new Twilio(env);
  return (env.NUMBERS_MODE || "mock") === "mock" ? new Mock(env, base) : base;
}

export function numbersConfig(env) {
  const p = provider(env);
  return { enabled: env.NUMBERS_ENABLED === "true", provider: p.id, mode: env.NUMBERS_MODE || "mock", buy: env.NUMBERS_BUY_ENABLED === "true", ready: p.ready };
}

export async function numberFor(env, tenant) {
  return env.DB.prepare(`SELECT id, provider, e164, status, created FROM numbers WHERE tenant = ?1 AND status = 'active'`).bind(tenant).first();
}

export async function buyNumber(env, user, tenant, e164, origin) {
  if (env.NUMBERS_BUY_ENABLED !== "true") return { status: 403, body: { error: "buy_disabled", friendly: "Buying numbers is switched off on this preview." } };
  if (await numberFor(env, tenant)) return { status: 409, body: { error: "already_has_number" } };
  if (!/^\+\d{8,15}$/.test(String(e164 || ""))) return { status: 400, body: { error: "bad_number" } };
  const p = provider(env);
  const id = "num_" + randomId(8);
  const inboundUrl = `${origin}/numbers/inbound/${p.id}/${id}`;
  const r = await p.buy({ e164, inboundUrl });
  await env.DB.prepare(`INSERT INTO numbers (id, owner, tenant, provider, e164, ref, status, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7)`).bind(id, user.id, tenant, p.id, r.e164, r.ref, Date.now()).run();
  return { status: 201, body: { ok: true, number: { id, e164: r.e164, provider: p.id, mock: Boolean(r.mock) } } };
}

export async function releaseNumber(env, owner, tenant) {
  const row = await env.DB.prepare(`SELECT id, provider, ref FROM numbers WHERE tenant = ?1 AND owner = ?2 AND status = 'active'`).bind(tenant, owner).first();
  if (!row) return { status: 404, body: { error: "no_number" } };
  const r = await provider(env, row.provider).release(row.ref);
  if (!r.ok) return { status: 502, body: { error: "release_failed" } };
  await env.DB.prepare(`UPDATE numbers SET status = 'released', released = ?2 WHERE id = ?1`).bind(row.id, Date.now()).run();
  await env.DB.prepare(`DELETE FROM inbound_codes WHERE tenant = ?1`).bind(tenant).run();
  return { status: 200, body: { ok: true } };
}

// Inbound SMS webhook: verify the carrier signature, keep only a Telegram login code (sealed, 10 minutes),
// drop everything else. The studio's NEBU setup step picks it up once (then it's deleted).
export async function handleInbound(env, req, providerId, numberId) {
  const row = await env.DB.prepare(`SELECT tenant, provider, e164 FROM numbers WHERE id = ?1 AND status = 'active'`).bind(numberId).first();
  const raw = await req.text();
  if (!row || row.provider !== providerId) return new Response("not found", { status: 404 });
  const p = provider(env, providerId);
  const v = await p.verifyInbound(req, raw, req.url);
  if (!v.ok) return new Response("bad signature", { status: 403 });
  if (v.to && v.to !== row.e164) return new Response("wrong number", { status: 403 });
  const code = extractTelegramCode(v.body);
  if (code) await env.DB.prepare(`INSERT INTO inbound_codes (tenant, sealed, at) VALUES (?1, ?2, ?3) ON CONFLICT(tenant) DO UPDATE SET sealed = excluded.sealed, at = excluded.at`).bind(row.tenant, await seal(env, code), Date.now()).run();
  return p.reply();
}

export async function takeCode(env, tenant) {
  const r = await env.DB.prepare(`SELECT sealed, at FROM inbound_codes WHERE tenant = ?1`).bind(tenant).first();
  if (!r) return null;
  await env.DB.prepare(`DELETE FROM inbound_codes WHERE tenant = ?1`).bind(tenant).run();
  if (Date.now() - r.at > 10 * 60e3) return null;
  return unseal(env, r.sealed);
}
