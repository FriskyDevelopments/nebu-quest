// AI helper: monthly allowance (plan config) -> prepaid credits -> hard stop. Or BYOK (default path).
// Metered + cached through Cloudflare AI Gateway. No overage billing, ever.
// Credits are denominated in provider cost (micro-USD). Top-up price = provider cost x (1 + AI_MARKUP_PCT/100);
// AI_MARKUP_PCT unset -> top-ups show "Price coming soon" and checkout stays closed.
import { entitlements } from "./plans.js";
import { b64url, unb64url, randomId } from "./auth.js";

export const AI_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ai_credits (owner TEXT PRIMARY KEY, micro_usd INTEGER NOT NULL DEFAULT 0, auto_topup INTEGER NOT NULL DEFAULT 0, updated INTEGER)`,
  `CREATE TABLE IF NOT EXISTS ai_log (id TEXT PRIMARY KEY, owner TEXT NOT NULL, at INTEGER NOT NULL, task TEXT, via TEXT, provider TEXT, tokens_in INTEGER, tokens_out INTEGER, units INTEGER, cost_micro INTEGER)`,
  `CREATE INDEX IF NOT EXISTS ai_log_owner ON ai_log(owner, at)`,
];
const PROVIDERS = {
  "workers-ai": { model: "@cf/meta/llama-3.1-8b-instruct" },
  openai: { gw: "openai/chat/completions", direct: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini" },
  xai: { gw: "grok/v1/chat/completions", direct: "https://api.x.ai/v1/chat/completions", model: "grok-3-mini" }, // OpenAI-compatible
  anthropic: { gw: "anthropic/v1/messages", direct: "https://api.anthropic.com/v1/messages", model: "claude-3-5-haiku-latest" },
};
const UNITS_PER_CALL = 1; // 1 allowance unit = one short assist call (<= 300 output tokens)
const month = () => new Date().toISOString().slice(0, 7);
const TASKS = {
  "lower-third": (i) => `Write 3 short lower-third options for a live stream. Each: a name line (max 28 chars) and a title line (max 40 chars). Plain text, no emojis, no hype. Context: ${i}`,
  brief: (i) => `Tighten this design brief for a sticker/overlay designer into 5 short bullet points. Keep the user's words; no hype. Brief: ${i}`,
  ticker: (i) => `Write 4 short ticker lines (max 70 chars each) for a live stream. Plain, first person, no hype. Context: ${i}`,
};

async function aes(env) { const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.TENANT_KEY || "")); return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]); }
export async function saveUserKey(env, owner, provider, apiKey) {
  if (!["openai", "anthropic", "xai"].includes(provider) || typeof apiKey !== "string" || apiKey.length < 20 || apiKey.length > 300) return false;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aes(env), new TextEncoder().encode(apiKey)));
  await env.DB.prepare(`INSERT INTO ai_keys (owner, provider, sealed, updated) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(owner) DO UPDATE SET provider = excluded.provider, sealed = excluded.sealed, updated = excluded.updated`).bind(owner, provider, `${b64url(iv)}.${b64url(ct)}`, Date.now()).run();
  return true;
}
async function userKey(env, owner) {
  const r = await env.DB.prepare(`SELECT provider, sealed FROM ai_keys WHERE owner = ?1`).bind(owner).first();
  if (!r) return null;
  const [iv, ct] = r.sealed.split(".");
  return { provider: r.provider, key: new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64url(iv) }, await aes(env), unb64url(ct))) };
}

// Provider cost estimate in micro-USD from token counts; rates (USD per 1M tokens) come from config.
function costMicro(env, tin, tout) {
  const rin = Number(env.AI_RATE_IN_PER_M || 0), rout = Number(env.AI_RATE_OUT_PER_M || 0);
  return Math.ceil((tin * rin + tout * rout)); // (tokens * USD/1M) * 1e6 micro / 1e6 = tokens * rate
}

export function topupCatalog(env) {
  const markup = env.AI_MARKUP_PCT === undefined || env.AI_MARKUP_PCT === "" ? null : Number(env.AI_MARKUP_PCT);
  const packs = String(env.AI_TOPUP_PACKS_USD || "5,20").split(",").map(Number).filter((n) => n > 0);
  return {
    label: markup === null ? "Provider cost + markup (price coming soon)" : `Provider cost + ${markup}%`,
    markupPct: markup,
    packs: packs.map((usd) => ({ id: `ai_topup_${usd}`, providerCostUsd: usd, price: markup === null ? "Price coming soon" : `$${(usd * (1 + markup / 100)).toFixed(2)}`, checkout: markup !== null && Boolean(env[`WHOP_PLAN_AI_TOPUP_${usd}`] && env.WHOP_API_KEY) })),
  };
}

export async function usage(env, owner) {
  const ent = await entitlements(env, owner);
  const u = await env.DB.prepare(`SELECT units FROM ai_usage WHERE owner = ?1 AND month = ?2`).bind(owner, month()).first();
  const byok = await env.DB.prepare(`SELECT provider FROM ai_keys WHERE owner = ?1`).bind(owner).first();
  const cr = await env.DB.prepare(`SELECT micro_usd, auto_topup FROM ai_credits WHERE owner = ?1`).bind(owner).first();
  const log = await env.DB.prepare(`SELECT at, task, via, provider, tokens_in, tokens_out, units, cost_micro FROM ai_log WHERE owner = ?1 ORDER BY at DESC LIMIT 50`).bind(owner).all();
  return { plan: ent.plan, month: month(), used: (u && u.units) || 0, limit: ent.limits.aiUnitsMonthly || 0, byok: byok ? byok.provider : null,
    credits: { microUsd: (cr && cr.micro_usd) || 0, autoTopup: Boolean(cr && cr.auto_topup) }, topups: topupCatalog(env), history: log.results, configured: Boolean(env.AI) };
}

export async function setAutoTopup(env, owner, on) {
  // Preference only. In test mode nothing is charged automatically; when credits run low we show a checkout prompt.
  await env.DB.prepare(`INSERT INTO ai_credits (owner, auto_topup, updated) VALUES (?1, ?2, ?3) ON CONFLICT(owner) DO UPDATE SET auto_topup = excluded.auto_topup, updated = excluded.updated`).bind(owner, on ? 1 : 0, Date.now()).run();
}
export async function addCredits(env, owner, microUsd) {
  await env.DB.prepare(`INSERT INTO ai_credits (owner, micro_usd, updated) VALUES (?1, ?2, ?3) ON CONFLICT(owner) DO UPDATE SET micro_usd = micro_usd + ?2, updated = ?3`).bind(owner, microUsd, Date.now()).run();
}

async function logCall(env, owner, row) {
  await env.DB.prepare(`INSERT INTO ai_log (id, owner, at, task, via, provider, tokens_in, tokens_out, units, cost_micro) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`)
    .bind("ai_" + randomId(8), owner, Date.now(), row.task, row.via, row.provider, row.tin || 0, row.tout || 0, row.units || 0, row.cost || 0).run();
}

async function callOpenAICompat(env, provider, key, messages) {
  const p = PROVIDERS[provider];
  const url = env.AI_GATEWAY_ID && env.CF_ACCOUNT_ID ? `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/${p.gw}` : p.direct;
  if (provider === "anthropic") {
    const r = await fetch(url, { method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" }, body: JSON.stringify({ model: p.model, max_tokens: 300, system: messages[0].content, messages: messages.slice(1) }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("provider_failed");
    return { text: (d.content || []).map((c) => c.text || "").join(""), tin: d.usage?.input_tokens || 0, tout: d.usage?.output_tokens || 0 };
  }
  const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: p.model, messages, max_tokens: 300 }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("provider_failed");
  return { text: d.choices?.[0]?.message?.content || "", tin: d.usage?.prompt_tokens || 0, tout: d.usage?.completion_tokens || 0 };
}

async function runOurs(env, messages) {
  // Our side: Workers AI (default) or xAI with our key (AI_ALLOWANCE_PROVIDER=xai + XAI_API_KEY).
  if (env.AI_ALLOWANCE_PROVIDER === "xai" && env.XAI_API_KEY) return { ...(await callOpenAICompat(env, "xai", env.XAI_API_KEY, messages)), provider: "xai" };
  if (!env.AI) throw Object.assign(new Error("ai_not_configured"), { status: 503 });
  const opts = env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID, skipCache: false, cacheTtl: 3600 } } : {};
  const out = await env.AI.run(PROVIDERS["workers-ai"].model, { messages, max_tokens: 300 }, opts);
  return { text: out.response || "", tin: out.usage?.prompt_tokens || 0, tout: out.usage?.completion_tokens || 0, provider: "workers-ai" };
}

export async function assist(env, owner, task, input) {
  const build = TASKS[task];
  if (!build) return { status: 400, body: { error: "unknown_task" } };
  const messages = [{ role: "system", content: "You write short, plain, honest copy for a creator's live stream. No hype, no invented numbers." }, { role: "user", content: build(String(input || "").slice(0, 800)) }];
  const own = await userKey(env, owner);
  if (own) {
    try {
      const r = await callOpenAICompat(env, own.provider, own.key, messages);
      await logCall(env, owner, { task, via: "your key", provider: own.provider, tin: r.tin, tout: r.tout });
      return { status: 200, body: { text: r.text, via: "your key" } };
    } catch { return { status: 502, body: { error: "your_key_failed", friendly: "Your key didn't work. Check it in Accounts." } }; }
  }
  const u = await usage(env, owner);
  const allowanceLeft = u.limit - u.used >= UNITS_PER_CALL;
  if (!allowanceLeft && u.credits.microUsd <= 0) return { status: 402, body: { error: "allowance_used", used: u.used, limit: u.limit, credits: 0, choices: ["add_key", "buy_credits"] } };
  let r;
  try { r = await runOurs(env, messages); } catch (e) { return { status: e.status || 502, body: { error: e.message || "ai_failed" } }; }
  if (allowanceLeft) {
    await env.DB.prepare(`INSERT INTO ai_usage (owner, month, units) VALUES (?1, ?2, ?3) ON CONFLICT(owner, month) DO UPDATE SET units = units + ?3`).bind(owner, month(), UNITS_PER_CALL).run();
    await logCall(env, owner, { task, via: "allowance", provider: r.provider, tin: r.tin, tout: r.tout, units: UNITS_PER_CALL });
    return { status: 200, body: { text: r.text, via: "allowance", used: u.used + UNITS_PER_CALL, limit: u.limit } };
  }
  const cost = Math.max(1, costMicro(env, r.tin, r.tout));
  // Hard stop at zero: never go negative.
  const res = await env.DB.prepare(`UPDATE ai_credits SET micro_usd = micro_usd - ?2, updated = ?3 WHERE owner = ?1 AND micro_usd >= ?2`).bind(owner, cost, Date.now()).run();
  if (!res.meta.changes) await env.DB.prepare(`UPDATE ai_credits SET micro_usd = 0, updated = ?2 WHERE owner = ?1`).bind(owner, Date.now()).run();
  await logCall(env, owner, { task, via: "credits", provider: r.provider, tin: r.tin, tout: r.tout, cost });
  return { status: 200, body: { text: r.text, via: "credits", costMicro: cost } };
}
