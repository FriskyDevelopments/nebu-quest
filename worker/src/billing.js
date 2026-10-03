// Paid extras, TEST MODE ONLY. Ported from the Folios rails billing core
// (FriskyDevelopments/folios PR #40, packages/billing-core/providers/whop.ts).
// - Whop sandbox API only; live API refused.
// - No prices in code: display prices come from env (PRICE_*), Whop plan ids from env (WHOP_PLAN_*).
// - Webhooks: Standard Webhooks signature (webhook-id / webhook-timestamp / webhook-signature).
import { b64url, unb64url, randomId } from "./auth.js";
import { PLANS, ADDONS, applyMembership } from "./plans.js";
import { addCredits } from "./ai.js";

export const WHOP_SANDBOX_API = "https://sandbox-api.whop.com/api/v1";
export const TIERS = {
  // Frisky's decision: ALL-IN $99.99 USD / month. Whop TEST MODE only; WHOP_PLAN_ALL_IN must be a sandbox plan id.
  all_in: { label: "ALL-IN", detail: "Studio, Your NEBU (own bot + second account), a linked FR!sky Paperclip seat, the hosted Vellum assistant and included AI credits.", planEnv: "WHOP_PLAN_ALL_IN", priceEnv: "PRICE_PLAN_ALL_IN", price: "$99.99 USD / month", priceUsd: 99.99, interval: "month", plan: "all_in" },
  extra_request: { label: "Extra request this month", detail: "One more element or set (up to 5 elements) in the same month.", planEnv: "WHOP_PLAN_EXTRA_REQUEST", priceEnv: "PRICE_EXTRA_REQUEST", grant: { kind: "request", qty: 1 } },
  set_plus: { label: "Bigger set", detail: "A coordinated set of 6 to 12 elements in one style.", planEnv: "WHOP_PLAN_SET_PLUS", priceEnv: "PRICE_SET_PLUS", grant: { kind: "set_plus", qty: 1 } },
  design_system: { label: "Full design system", detail: "A complete kit: lower thirds, frames, overlays, stickers, transitions, colors and type.", planEnv: "WHOP_PLAN_DESIGN_SYSTEM", priceEnv: "PRICE_DESIGN_SYSTEM", grant: { kind: "design_system", qty: 1 } },
};

export const BILLING_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS credits (id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL, qty INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, source TEXT, created INTEGER)`,
  `CREATE INDEX IF NOT EXISTS credits_owner ON credits(owner)`,
  `CREATE TABLE IF NOT EXISTS billing_events (id TEXT PRIMARY KEY, type TEXT, owner TEXT, tier TEXT, created INTEGER)`,
  `CREATE TABLE IF NOT EXISTS checkouts (id TEXT PRIMARY KEY, owner TEXT NOT NULL, tier TEXT NOT NULL, status TEXT NOT NULL, created INTEGER)`,
];

export function catalog(env) {
  const mode = billingMode(env);
  return {
    mode,
    provider: env.WHOP_API_KEY ? "whop" : null,
    tiers: Object.entries(TIERS).map(([id, t]) => {
      const price = String(env[t.priceEnv] || t.price || "").trim();
      const planOk = Boolean(env[t.planEnv]);
      return { id, label: t.label, detail: t.detail, price: price || null, priceLabel: price || "TBD", interval: t.interval || null, available: Boolean(price && planOk && env.WHOP_API_KEY && mode === "test") };
    }),
  };
}

export function billingMode(env) {
  const base = env.WHOP_API_BASE || WHOP_SANDBOX_API;
  return base.includes("sandbox") ? "test" : "live-blocked";
}

export async function createCheckout(env, user, tierId, successUrl) {
  const t = TIERS[tierId];
  if (!t) return { status: 404, body: { error: "unknown_tier" } };
  if (billingMode(env) !== "test") return { status: 503, body: { error: "live_mode_blocked" } };
  if (!env.WHOP_API_KEY) return { status: 503, body: { error: "provider_not_configured", missing: ["WHOP_API_KEY"] } };
  if ((!env[t.priceEnv] && !t.price) || !env[t.planEnv]) return { status: 409, body: { error: "price_not_configured", missing: [t.priceEnv, t.planEnv].filter((k) => !env[k]) } };
  const id = "co_" + randomId(9);
  await env.DB.prepare(`INSERT INTO checkouts (id, owner, tier, status, created) VALUES (?1, ?2, ?3, 'open', ?4)`).bind(id, user.id, tierId, Date.now()).run();
  const res = await fetch(`${env.WHOP_API_BASE || WHOP_SANDBOX_API}/checkout_configurations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.WHOP_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ plan_id: env[t.planEnv], redirect_url: successUrl, metadata: { product: "nebu", tier: tierId, ...(t.plan ? { plan: t.plan } : {}), user_id: user.id, checkout_session_id: id } }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.purchase_url) return { status: 502, body: { error: "provider_error", status: res.status } };
  return { status: 200, body: { url: data.purchase_url, mode: "test" } };
}

function keyBytes(secret) {
  return secret.startsWith("whsec_") ? unb64url(secret.slice(6).replace(/\+/g, "-").replace(/\//g, "_")) : new TextEncoder().encode(secret);
}
export async function signStandardWebhook(secret, id, ts, raw) {
  const k = await crypto.subtle.importKey("raw", keyBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${id}.${ts}.${raw}`)));
  let s = ""; for (const b of sig) s += String.fromCharCode(b);
  return `v1,${btoa(s)}`;
}
function eq(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }

export async function handleWebhook(env, req) {
  const secret = env.WHOP_WEBHOOK_SECRET;
  if (!secret) return { status: 503, body: { error: "webhook_secret_missing" } };
  const raw = await req.text();
  const id = req.headers.get("webhook-id"), ts = Number(req.headers.get("webhook-timestamp")), sigH = req.headers.get("webhook-signature") || "";
  if (!id || !ts || !sigH) return { status: 400, body: { error: "signature_missing" } };
  if (Math.abs(Date.now() / 1000 - ts) > 300) return { status: 400, body: { error: "timestamp_outside_tolerance" } };
  const expected = await signStandardWebhook(secret, id, ts, raw);
  if (!sigH.split(" ").some((c) => eq(c, expected))) return { status: 401, body: { error: "signature_mismatch" } };
  if (billingMode(env) !== "test") return { status: 409, body: { error: "live_event_rejected" } };
  let ev; try { ev = JSON.parse(raw); } catch { return { status: 400, body: { error: "bad_json" } }; }
  const seen = await env.DB.prepare(`SELECT id FROM billing_events WHERE id = ?1`).bind(id).first();
  if (seen) return { status: 200, body: { ok: true, duplicate: true } };
  const d = ev.data || {}, meta = d.metadata || {};
  const tier = TIERS[meta.tier] ? meta.tier : null;
  const owner = typeof meta.user_id === "string" ? meta.user_id : null;
  let granted = null;
  // Plan memberships (Your NEBU etc.) -> subscriptions. Tier ids come from metadata.plan.
  if (/^membership\./.test(ev.type || "") && owner && meta.product === "nebu" && PLANS[meta.plan]) {
    await applyMembership(env, owner, meta.plan, ev.type === "membership.deactivated" ? "canceled" : "active", String(d.id || ""), d.renewal_period_end ? Date.parse(d.renewal_period_end) || null : null);
    granted = { plan: meta.plan };
  }
  if (ev.type === "payment.succeeded" && owner && meta.product === "nebu" && /^ai_topup_\d+$/.test(meta.addon || "")) {
    const usd = Number(meta.addon.split("_").pop());
    await addCredits(env, owner, usd * 1e6); // credits = provider cost amount; the markup was the price paid
    granted = { aiCreditsUsd: usd };
  }
  if (ev.type === "payment.succeeded" && owner && meta.product === "nebu" && meta.addon === "storage") {
    await env.DB.prepare(`INSERT INTO addons (id, owner, kind, amount, created) VALUES (?1, ?2, 'storage', ?3, ?4)`).bind("ad_" + randomId(8), owner, ADDONS.storage.grant.storageBytes, Date.now()).run();
    granted = { addon: "storage" };
  }
  if (ev.type === "payment.succeeded" && tier && TIERS[tier] && TIERS[tier].grant && owner && meta.product === "nebu") {
    const g = TIERS[tier].grant;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO credits (id, owner, kind, qty, source, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`).bind("cr_" + randomId(9), owner, g.kind, g.qty, `whop:${id}`, Date.now()),
      env.DB.prepare(`UPDATE checkouts SET status = 'paid' WHERE id = ?1`).bind(String(meta.checkout_session_id || "")),
    ]);
    granted = g;
  }
  await env.DB.prepare(`INSERT INTO billing_events (id, type, owner, tier, created) VALUES (?1, ?2, ?3, ?4, ?5)`).bind(id, String(ev.type || ""), owner, tier, Date.now()).run();
  return { status: 200, body: { ok: true, granted } };
}

export async function balance(env, owner) {
  const rows = await env.DB.prepare(`SELECT kind, SUM(qty - used) AS left FROM credits WHERE owner = ?1 GROUP BY kind`).bind(owner).all();
  const out = { request: 0, set_plus: 0, design_system: 0 };
  for (const r of rows.results) out[r.kind] = Math.max(0, r.left || 0);
  return out;
}
export async function spend(env, owner, kind) {
  const row = await env.DB.prepare(`SELECT id FROM credits WHERE owner = ?1 AND kind = ?2 AND used < qty ORDER BY created LIMIT 1`).bind(owner, kind).first();
  if (!row) return false;
  await env.DB.prepare(`UPDATE credits SET used = used + 1 WHERE id = ?1`).bind(row.id).run();
  return true;
}
