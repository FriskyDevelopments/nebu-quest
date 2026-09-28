// Plans, add-ons, entitlements and the AI allowance: ONE config.
// Only decided prices live here (ALL-IN: $99.99 USD / month, Frisky's call). Everything else is "TBD"
// until PRICE_* is set. Checkout is Whop TEST MODE only (sandbox API, WHOP_PLAN_* sandbox plan ids).
export const PLANS = {
  free: {
    name: "Free", requires: "FRISKY ID", priceEnv: null,
    blurb: "The full studio with your FRISKY ID.",
    features: ["Full studio: scenes, mix, overlays, FX, stickers", "Rooms, recording, OBS setup, virtual cam", "Official FR!SKY and NEBU packs", "Small My packs space", "One element or a small set (up to 5) each month from the shared NEBU"],
    limits: { storageBytes: 250 * 1024 * 1024, packs: 30, monthlyRequests: 1, maxSetSize: 5, personalNebu: 0, telegramSubmit: false, aiUnitsMonthly: 0 },
  },
  nebu: {
    name: "Your NEBU", requires: "FRISKY ID + a second Telegram account", priceEnv: "PRICE_PLAN_NEBU", whopEnv: "WHOP_PLAN_NEBU",
    blurb: "Your own NEBU on our Cloudflare infrastructure.",
    features: ["Everything in Free", "Personal NEBU with your own bot", "Runs on a dedicated second Telegram account", "Design requests through your own NEBU", "Sticker sets submitted to Telegram for you (opt-in)", "More storage", "Small AI allowance to start; bring your own key any time"],
    limits: { storageBytes: 5 * 1024 * 1024 * 1024 /* TBD */, packs: 200, monthlyRequests: null /* unlimited via own NEBU; fair use */, maxSetSize: 5, personalNebu: 1, telegramSubmit: true, aiUnitsMonthly: 100 /* TBD placeholder */ },
  },
  all_in: {
    name: "ALL-IN", requires: "FRISKY ID + a second Telegram account", price: "$99.99 USD / month", priceUsdMonthly: 99.99, priceEnv: "PRICE_PLAN_ALL_IN", whopEnv: "WHOP_PLAN_ALL_IN",
    blurb: "Everything I make, in one plan.",
    features: ["The full studio", "Your NEBU: your own bot plus the second account it runs on", "A linked FR!sky Paperclip seat (clip.friskydev.com)", "Vellum, your hosted personal assistant: its own Cloudflare Container per FRISKY ID, asleep when idle", "Included AI credits (bring your own keys too)"],
    limits: { storageBytes: 10 * 1024 * 1024 * 1024 /* TBD */, packs: 500, monthlyRequests: null, maxSetSize: 5, personalNebu: 1, telegramSubmit: true, aiUnitsMonthly: 500 /* TBD: included credits */, paperclipSeat: 1, assistant: "vellum" },
  },
  nebu_assistant: {
    name: "Your NEBU + assistant", stage: 2, flagEnv: "ASSISTANT_TRIAL_ENABLED", priceEnv: "PRICE_PLAN_NEBU_ASSISTANT", whopEnv: "WHOP_PLAN_NEBU_ASSISTANT",
    blurb: "Stage 2. Not available yet.",
    features: ["Everything in Your NEBU", "Assistant upgrade (Vellum), or link your FR!sky Paperclip seat", "Trial first, then paid"],
    limits: { storageBytes: 5 * 1024 * 1024 * 1024, packs: 200, monthlyRequests: null, maxSetSize: 5, personalNebu: 1, telegramSubmit: true, aiUnitsMonthly: 100 /* TBD */ },
  },
};
export const ADDONS = {
  storage: { name: "Extra storage", detail: "More room in My packs.", priceEnv: "PRICE_ADDON_STORAGE", whopEnv: "WHOP_PLAN_ADDON_STORAGE", grant: { storageBytes: 10 * 1024 * 1024 * 1024 /* TBD */ } },
  stream_minutes: { name: "Streaming minutes", detail: "Metered live output minutes (Cloudflare Stream / relay).", priceEnv: "PRICE_ADDON_STREAM", whopEnv: "WHOP_PLAN_ADDON_STREAM", grant: { streamMinutes: 1000 /* TBD */ } },
  extra_request: { name: "Extra request this month", detail: "One more element or set (up to 5) this month.", priceEnv: "PRICE_EXTRA_REQUEST", whopEnv: "WHOP_PLAN_EXTRA_REQUEST", grant: { credit: "request" } },
  set_plus: { name: "Bigger set", detail: "A coordinated set of 6 to 12 elements.", priceEnv: "PRICE_SET_PLUS", whopEnv: "WHOP_PLAN_SET_PLUS", grant: { credit: "set_plus" } },
  design_system: { name: "Full design system", detail: "A complete kit in one style.", priceEnv: "PRICE_DESIGN_SYSTEM", whopEnv: "WHOP_PLAN_DESIGN_SYSTEM", grant: { credit: "design_system" } },
};
export const ASSISTANT_PROVIDERS = ["vellum", "paperclip-frisky"]; // stage 2, flag off. paperclip-frisky = FR!sky Paperclip seat link (clip.friskydev.com), not a hosted assistant

export const PLAN_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS subscriptions (owner TEXT PRIMARY KEY, plan TEXT NOT NULL, status TEXT NOT NULL, provider_ref TEXT, period_end INTEGER, updated INTEGER)`,
  `CREATE TABLE IF NOT EXISTS ai_usage (owner TEXT NOT NULL, month TEXT NOT NULL, units INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (owner, month))`,
  `CREATE TABLE IF NOT EXISTS ai_keys (owner TEXT PRIMARY KEY, provider TEXT NOT NULL, sealed TEXT NOT NULL, updated INTEGER)`,
  `CREATE TABLE IF NOT EXISTS addons (id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL, created INTEGER)`,
];

export function publicPlans(env) {
  const price = (k) => (k && String(env[k] || "").trim()) || null;
  return {
    mode: "test",
    plans: Object.entries(PLANS).map(([id, p]) => ({ id, name: p.name, blurb: p.blurb, requires: p.requires || null, features: p.features, stage: p.stage || 1,
      available: id === "free" || (p.stage === 2 ? env[p.flagEnv] === "true" : true),
      price: id === "free" ? "No charge" : (price(p.priceEnv) || p.price || "TBD"), testMode: id !== "free", checkout: id !== "free" && Boolean((price(p.priceEnv) || p.price) && env[p.whopEnv] && env.WHOP_API_KEY) && (p.stage !== 2 || env[p.flagEnv] === "true") })),
    addons: Object.entries(ADDONS).map(([id, a]) => ({ id, name: a.name, detail: a.detail, price: price(a.priceEnv) || "TBD", checkout: Boolean(price(a.priceEnv) && env[a.whopEnv] && env.WHOP_API_KEY) })),
  };
}

export async function planOf(env, owner) {
  const s = await env.DB.prepare(`SELECT plan, status, period_end FROM subscriptions WHERE owner = ?1`).bind(owner).first();
  const active = s && s.status === "active" && (!s.period_end || s.period_end > Date.now()) && PLANS[s.plan];
  return active ? s.plan : "free";
}
export async function entitlements(env, owner) {
  const plan = await planOf(env, owner);
  const lim = { ...PLANS[plan].limits };
  const add = await env.DB.prepare(`SELECT kind, SUM(amount) AS n FROM addons WHERE owner = ?1 GROUP BY kind`).bind(owner).all();
  for (const r of add.results) if (r.kind === "storage") lim.storageBytes += r.n;
  return { plan, limits: lim };
}

// Whop membership events -> subscriptions (test mode only; called from billing webhook)
export async function applyMembership(env, owner, planId, status, ref, periodEnd) {
  if (!PLANS[planId] || planId === "free") return;
  await env.DB.prepare(`INSERT INTO subscriptions (owner, plan, status, provider_ref, period_end, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(owner) DO UPDATE SET plan = excluded.plan, status = excluded.status, provider_ref = excluded.provider_ref, period_end = excluded.period_end, updated = excluded.updated`).bind(owner, planId, status, ref || null, periodEnd || null, Date.now()).run();
}
