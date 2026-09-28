// "Your NEBU": one personal NEBU per FRISKY ID (MAX_NEBU_PER_ID, default 1) on the shared,
// multi-tenant Worker. Everything is keyed on the FRISKY ID user id (fd_<sub>): tenant, bot token
// (AES-GCM encrypted with TENANT_KEY), packs, credits, Whop events, linked accounts.
import { b64url, unb64url, randomId } from "./auth.js";
import { botStatus } from "./telegram.js";
import { balance } from "./billing.js";
import { entitlements, planOf } from "./plans.js";

export const TENANT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, bot_token TEXT, bot_username TEXT, bot_status TEXT, tg_session TEXT, tg_user TEXT, assistant_provider TEXT, trial_started_at INTEGER, trial_ends_at INTEGER, created INTEGER, updated INTEGER)`,
  `CREATE INDEX IF NOT EXISTS tenants_owner ON tenants(owner)`,
  `CREATE TABLE IF NOT EXISTS links (owner TEXT NOT NULL, provider TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER, PRIMARY KEY (owner, provider))`,
  // Per-tenant secrets that the user brings: telegram_api (their own api_id/api_hash), discord_bot,
  // discord_pending (half-filled from the setup extension), tg_rtmp (video chat stream key per peer).
  // "sealed" is AES-GCM (TENANT_KEY); "meta" holds only non-secret display data.
  `CREATE TABLE IF NOT EXISTS tenant_secrets (tenant TEXT NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL, sealed TEXT, meta TEXT, updated INTEGER, PRIMARY KEY (tenant, kind))`,
  `CREATE TABLE IF NOT EXISTS pair_codes (code TEXT PRIMARY KEY, owner TEXT NOT NULL, tenant TEXT, expires INTEGER NOT NULL, used INTEGER DEFAULT 0)`,
];

// ---- Tenant secrets (never returned to the client, never logged) ----
export async function putSecret(env, tenant, owner, kind, value, meta = {}) {
  await env.DB.prepare(`INSERT INTO tenant_secrets (tenant, owner, kind, sealed, meta, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    ON CONFLICT(tenant, kind) DO UPDATE SET sealed = excluded.sealed, meta = excluded.meta, updated = excluded.updated`)
    .bind(tenant, owner, kind, value == null ? null : await seal(env, typeof value === "string" ? value : JSON.stringify(value)), JSON.stringify(meta), Date.now()).run();
}
export async function getSecret(env, tenant, kind) {
  const r = await env.DB.prepare(`SELECT owner, sealed, meta FROM tenant_secrets WHERE tenant = ?1 AND kind = ?2`).bind(tenant, kind).first();
  if (!r) return null;
  const raw = r.sealed ? await unseal(env, r.sealed) : "";
  let value = raw; try { value = JSON.parse(raw); } catch { /* plain string */ }
  return { owner: r.owner, value, meta: JSON.parse(r.meta || "{}") };
}
export async function dropSecret(env, tenant, owner, kind) {
  await env.DB.prepare(`DELETE FROM tenant_secrets WHERE tenant = ?1 AND owner = ?2 AND kind = ?3`).bind(tenant, owner, kind).run();
}
export async function secretsMeta(env, tenant) {
  const rows = await env.DB.prepare(`SELECT kind, meta, updated FROM tenant_secrets WHERE tenant = ?1`).bind(tenant).all();
  return Object.fromEntries(rows.results.filter((r) => !r.kind.endsWith("_pending")).map((r) => [r.kind, { ...JSON.parse(r.meta || "{}"), updated: r.updated }]));
}
export const mask = (s, keep = 4) => { s = String(s || ""); return s.length <= keep ? "•".repeat(s.length) : "•".repeat(Math.min(8, s.length - keep)) + s.slice(-keep); };

// Their OWN Telegram api_id / api_hash (my.telegram.org, logged in as the second account).
export async function setTenantTgApi(env, user, id, body) {
  const t = await ownTenant(env, user, id);
  if (!t) return { status: 404, body: { error: "not_found" } };
  const apiId = String((body && body.apiId) || "").trim(), apiHash = String((body && body.apiHash) || "").trim().toLowerCase();
  if (!/^\d{3,12}$/.test(apiId)) return { status: 400, body: { error: "bad_api_id", friendly: "api_id is a number (digits only). Copy it from “App api_id” on my.telegram.org." } };
  if (!/^[a-f0-9]{32}$/.test(apiHash)) return { status: 400, body: { error: "bad_api_hash", friendly: "api_hash is 32 letters and numbers (0-9, a-f). Copy it from “App api_hash” on my.telegram.org." } };
  await putSecret(env, id, user.id, "telegram_api", { apiId, apiHash }, { apiId: mask(apiId, 3), apiHash: mask(apiHash) });
  return { status: 200, body: { ok: true, telegramApi: { apiId: mask(apiId, 3), apiHash: mask(apiHash) } } };
}
const PROVIDERS = new Set(["telegram", "telegram_nebu", "spotify", "drive", "stix", "paperclip"]);

async function aesKey(env) {
  if (!env.TENANT_KEY) return null;
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.TENANT_KEY));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function seal(env, text) {
  const k = await aesKey(env); if (!k) throw new Error("TENANT_KEY missing");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, new TextEncoder().encode(text)));
  return `${b64url(iv)}.${b64url(ct)}`;
}
export async function unseal(env, sealed) {
  const k = await aesKey(env); if (!k || !sealed) return "";
  const [iv, ct] = sealed.split(".");
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64url(iv) }, k, unb64url(ct)));
}

export async function getLinks(env, owner) {
  const rows = await env.DB.prepare(`SELECT provider, data, updated FROM links WHERE owner = ?1`).bind(owner).all();
  const out = {};
  for (const r of rows.results) out[r.provider] = { ...JSON.parse(r.data || "{}"), updated: r.updated };
  return out;
}
export async function setLink(env, owner, provider, data) {
  if (!PROVIDERS.has(provider)) throw new Error("bad provider");
  if (provider === "paperclip") {
    const seat = String((data && (data.seat || data.id)) || "").trim();
    if (!/^FRSKY-PC-[A-Za-z0-9]{4,32}$/.test(seat)) {
      const e = new Error("bad_seat");
      e.friendly = "A Paperclip seat key looks like FRSKY-PC- followed by letters and numbers.";
      throw e;
    }
    data = { id: seat, name: mask(seat, 4) };
  }
  // The NEBU account is a SECOND, dedicated Telegram account. It must differ from the personal one.
  if (provider === "telegram" || provider === "telegram_nebu") {
    const other = await env.DB.prepare(`SELECT data FROM links WHERE owner = ?1 AND provider = ?2`).bind(owner, provider === "telegram" ? "telegram_nebu" : "telegram").first();
    if (other && JSON.parse(other.data || "{}").id === String(data.id)) {
      const e = new Error("same_telegram_account"); e.friendly = provider === "telegram_nebu"
        ? "That's your personal Telegram. Sign in to the Login Widget with your second, NEBU-only Telegram account instead."
        : "That Telegram account is already linked as your NEBU account. Use your personal account here."; throw e;
    }
    const taken = await env.DB.prepare(`SELECT owner FROM links WHERE provider = 'telegram_nebu' AND json_extract(data, '$.id') = ?1 AND owner != ?2`).bind(String(data.id), owner).first();
    if (provider === "telegram_nebu" && taken) { const e = new Error("nebu_account_taken"); e.friendly = "That Telegram account is already the NEBU account of another FRISKY ID."; throw e; }
  }
  // Only non-secret display data is stored (tokens for Spotify/Drive stay in the browser).
  const clean = JSON.stringify(Object.fromEntries(Object.entries(data || {}).filter(([k]) => ["id", "username", "name", "email", "product"].includes(k)).map(([k, v]) => [k, String(v).slice(0, 128)])));
  await env.DB.prepare(`INSERT INTO links (owner, provider, data, updated) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(owner, provider) DO UPDATE SET data = excluded.data, updated = excluded.updated`).bind(owner, provider, clean, Date.now()).run();
  if (provider === "telegram") await env.DB.prepare(`UPDATE users SET tg_id = ?2, tg_username = ?3 WHERE id = ?1`).bind(owner, data.id || null, data.username || null).run();
}
export async function removeLink(env, owner, provider) {
  await env.DB.prepare(`DELETE FROM links WHERE owner = ?1 AND provider = ?2`).bind(owner, provider).run();
  if (provider === "telegram") await env.DB.prepare(`UPDATE users SET tg_id = NULL, tg_username = NULL WHERE id = ?1`).bind(owner).run();
}

export async function yourNebu(env, user) {
  const tenants = await env.DB.prepare(`SELECT id, name, bot_username, bot_status, tg_user, created, updated FROM tenants WHERE owner = ?1 ORDER BY created`).bind(user.id).all();
  const u = await env.DB.prepare(`SELECT bytes FROM users WHERE id = ?1`).bind(user.id).first();
  const packs = await env.DB.prepare(`SELECT id, name, kind, bytes, share IS NOT NULL AS shared, updated FROM packs WHERE owner = ?1 ORDER BY updated DESC LIMIT 50`).bind(user.id).all();
  return {
    friskyId: { id: user.id, name: user.name, email: user.email },
    limit: Number(env.MAX_NEBU_PER_ID || 1),
    nebu: tenants.results.map((t) => ({ ...t, tg_user: t.tg_user ? JSON.parse(t.tg_user) : null, hasBot: Boolean(t.bot_username) })),
    packs: packs.results,
    plan: await planOf(env, user.id),
    storage: { used: (u && u.bytes) || 0, limit: (await entitlements(env, user.id)).limits.storageBytes },
    credits: await balance(env, user.id),
    links: await getLinks(env, user.id),
    secrets: Object.fromEntries(await Promise.all(tenants.results.map(async (t) => [t.id, await secretsMeta(env, t.id)]))),
  };
}

export async function createTenant(env, user, body) {
  const ent = await entitlements(env, user.id);
  const open = env.VC_NODE_OPEN === "true";
  if (!ent.limits.personalNebu && !open) return { status: 402, body: { error: "plan_required", plan: "nebu", friendly: "A personal NEBU is part of the Your NEBU plan." } };
  const max = Math.min(Number(env.MAX_NEBU_PER_ID || 1), open ? Math.max(1, ent.limits.personalNebu || 0) : ent.limits.personalNebu);
  const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tenants WHERE owner = ?1`).bind(user.id).first();
  if (n.n >= max) return { status: 409, body: { error: "limit_reached", limit: max } };
  const id = "n_" + randomId(8);
  const name = String((body && body.name) || `${user.name || "My"} NEBU`).replace(/[\u0000-\u001f<>]/g, "").slice(0, 60);
  await env.DB.prepare(`INSERT INTO tenants (id, owner, name, bot_status, created, updated) VALUES (?1, ?2, ?3, 'no_bot', ?4, ?4)`).bind(id, user.id, name, Date.now()).run();
  return { status: 201, body: { id, name } };
}

export async function ownTenant(env, user, id) {
  return env.DB.prepare(`SELECT * FROM tenants WHERE id = ?1 AND owner = ?2`).bind(id, user.id).first();
}

export async function setTenantBot(env, user, id, token) {
  const t = await ownTenant(env, user, id);
  if (!t) return { status: 404, body: { error: "not_found" } };
  const nebuTg = await env.DB.prepare(`SELECT data FROM links WHERE owner = ?1 AND provider = 'telegram_nebu'`).bind(user.id).first();
  if (!nebuTg) return { status: 409, body: { error: "nebu_account_required", friendly: "Link your second, NEBU-only Telegram account first. It owns the bot and its sticker sets." } };
  if (!/^\d{6,12}:[A-Za-z0-9_-]{30,50}$/.test(String(token || ""))) return { status: 400, body: { error: "bad_token_format" } };
  const st = await botStatus(token);
  if (!st.ok) return { status: 400, body: { error: st.status } };
  await env.DB.prepare(`UPDATE tenants SET bot_token = ?3, bot_username = ?4, bot_status = 'online', updated = ?5 WHERE id = ?1 AND owner = ?2`).bind(id, user.id, await seal(env, token), st.username, Date.now()).run();
  return { status: 200, body: { ok: true, bot: { username: st.username, status: "online" } } };
}

export async function checkTenantBot(env, user, id) {
  const t = await ownTenant(env, user, id);
  if (!t) return { status: 404, body: { error: "not_found" } };
  if (!t.bot_token) return { status: 200, body: { status: "no_bot" } };
  const st = await botStatus(await unseal(env, t.bot_token));
  await env.DB.prepare(`UPDATE tenants SET bot_status = ?3, updated = ?4 WHERE id = ?1 AND owner = ?2`).bind(id, user.id, st.status, Date.now()).run();
  return { status: 200, body: { status: st.status, username: st.username || t.bot_username } };
}

export async function deleteTenant(env, user, id) {
  await env.DB.prepare(`DELETE FROM tenant_secrets WHERE tenant = ?1 AND owner = ?2`).bind(id, user.id).run();
  const r = await env.DB.prepare(`DELETE FROM tenants WHERE id = ?1 AND owner = ?2`).bind(id, user.id).run();
  return r.meta.changes ? { status: 200, body: { ok: true } } : { status: 404, body: { error: "not_found" } };
}
