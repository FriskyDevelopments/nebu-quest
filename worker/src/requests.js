// Monthly custom design: one free credit per month = one element OR one coordinated set (up to 5).
// Bigger sets / extra requests / design systems use paid credits (billing.js, test mode).
// Delivery ("submitted for you") saves the result into the user's My packs and, when the user
// opted in and linked Telegram, creates a real Telegram sticker set owned by them.
import { randomId } from "./auth.js";
import { createPackFor } from "./packs.js";
import { balance, spend } from "./billing.js";
import { submitStickerSet } from "./telegram.js";
import { entitlements } from "./plans.js";

const ELEMENTS = new Set(["sticker", "lower-third", "frame", "overlay", "transition"]);
export const month = (d = new Date()) => d.toISOString().slice(0, 7);

export async function listRequests(env, user) {
  const rows = await env.DB.prepare(`SELECT id, month, scope, items, brief, style, tg_submit, status, pack, tg_set, created, updated FROM requests WHERE owner = ?1 ORDER BY created DESC LIMIT 24`).bind(user.id).all();
  const used = rows.results.some((r) => r.month === month() && !String(r.id).startsWith("x"));
  return { month: month(), freeUsed: used, credits: await balance(env, user.id), requests: rows.results.map((r) => ({ ...r, items: JSON.parse(r.items || "[]"), tg_submit: !!r.tg_submit })) };
}

export async function createRequest(env, user, body) {
  const scope = body.scope === "set" ? "set" : body.scope === "design_system" ? "design_system" : "element";
  let items = (Array.isArray(body.items) ? body.items : [body.item]).map((x) => ({ type: String(x && x.type || x || ""), count: Math.max(1, Math.min(12, Number(x && x.count) || 1)) })).filter((x) => ELEMENTS.has(x.type));
  if (scope === "element") items = items.slice(0, 1).map((x) => ({ ...x, count: 1 }));
  if (scope !== "design_system" && !items.length) return { status: 400, body: { error: "pick_an_element" } };
  const total = items.reduce((n, x) => n + x.count, 0);
  const brief = String(body.brief || "").replace(/[\u0000-\u0008]/g, "").slice(0, 2000);
  const style = String(body.style || "").slice(0, 200);
  if (brief.length < 10) return { status: 400, body: { error: "brief_too_short" } };
  const m = month();
  const freeUsed = await env.DB.prepare(`SELECT id FROM requests WHERE owner = ?1 AND month = ?2`).bind(user.id, m).first();
  // Which credit pays for it?
  const ent = await entitlements(env, user.id);
  let pay = "free";
  if (scope === "design_system") pay = "design_system";
  else if (total > ent.limits.maxSetSize) pay = "set_plus";
  else if (freeUsed && ent.limits.monthlyRequests !== null) pay = "request"; // null = unlimited (Your NEBU)
  // The free monthly design now goes through Hermes Stitch (stitch.js, POST /stitch).
  if (pay === "free") return { status: 409, body: { error: "use_stitch", friendly: "Your monthly design lives in My packs now." } };
  if (body.telegramSubmit && !ent.limits.telegramSubmit) return { status: 402, body: { error: "plan_required", plan: "nebu", friendly: "Telegram submission is part of Your NEBU." } };
  if (pay !== "free" && !(await spend(env, user.id, pay))) return { status: 402, body: { error: "credit_required", tier: pay === "request" ? "extra_request" : pay } };
  // Free requests use the (owner, month) unique slot; paid ones get a distinct month key.
  const monthKey = pay === "free" && !freeUsed ? m : `${m}#${randomId(4)}`;
  const id = (pay === "free" ? "r" : "x") + "_" + randomId(9);
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO requests (id, owner, month, scope, items, brief, style, tg_submit, status, created, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'queued', ?9, ?9)`)
    .bind(id, user.id, monthKey, scope, JSON.stringify(items), brief, style, body.telegramSubmit ? 1 : 0, now).run();
  return { status: 201, body: { id, paidWith: pay, status: "queued" } };
}

// Admin/bot delivery: POST /admin/requests/:id/deliver  (Authorization: Bearer ADMIN_TOKEN)
// body: { name, manifest: {version, items:[layered designs...]}, stickers?: [{r2Key, emoji, format:'static'|'video'}] }
export async function deliverRequest(env, id, body) {
  const r = await env.DB.prepare(`SELECT * FROM requests WHERE id = ?1`).bind(id).first();
  if (!r) return { status: 404, body: { error: "not_found" } };
  if (r.status === "delivered") return { status: 200, body: { ok: true, already: true, pack: r.pack } };
  const manifest = body.manifest && typeof body.manifest === "object" ? body.manifest : { version: 1, items: [] };
  const pack = await createPackFor(env, r.owner, String(body.name || "Your monthly design"), r.scope === "element" ? "mixed" : "mixed", manifest, `request:${id}`);
  let tg = null;
  const wantsStickers = JSON.parse(r.items || "[]").some((x) => x.type === "sticker");
  if (r.tg_submit && wantsStickers && Array.isArray(body.stickers) && body.stickers.length) {
    const u = await env.DB.prepare(`SELECT tg_id FROM users WHERE id = ?1`).bind(r.owner).first();
    if (u && u.tg_id) tg = await submitStickerSet(env, { tgUserId: u.tg_id, title: String(body.name || "NEBU pack"), stickers: body.stickers, requestId: id });
    else tg = { skipped: "telegram_not_linked" };
  }
  await env.DB.prepare(`UPDATE requests SET status = 'delivered', pack = ?2, tg_set = ?3, updated = ?4 WHERE id = ?1`).bind(id, pack, tg && tg.link ? tg.link : null, Date.now()).run();
  return { status: 200, body: { ok: true, pack, telegram: tg } };
}
