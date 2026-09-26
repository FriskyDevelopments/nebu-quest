// NEBU chat actions in a Telegram group through the platform bot: post (and optionally pin) the
// "Join the live chat" message. Rate-limited per owner and logged. TELEGRAM_ACTIONS_MODE=mock (default)
// never calls Telegram. The bot must be an admin with "Pin messages" in that group to pin.
import { randomId } from "./auth.js";
export const ACTIONS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS action_log (id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL, target TEXT, status TEXT NOT NULL, detail TEXT, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS action_log_owner ON action_log(owner, at)`,
];
const LIMIT = { post: 6, pin: 6 }; // per 10 minutes
async function log(env, owner, kind, target, status, detail) {
  await env.DB.prepare(`INSERT INTO action_log (id, owner, kind, target, status, detail, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`).bind(randomId(8), owner, kind, String(target || "").slice(0, 64), status, String(detail || "").slice(0, 200), Date.now()).run();
}
export async function actionLog(env, owner) {
  return (await env.DB.prepare(`SELECT kind, target, status, detail, at FROM action_log WHERE owner = ?1 ORDER BY at DESC LIMIT 30`).bind(owner).all()).results;
}
async function tg(env, method, body) {
  if ((env.TELEGRAM_ACTIONS_MODE || "mock") === "mock") return { ok: true, result: { message_id: 1000 + Math.floor(Math.random() * 999) }, mock: true };
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
export async function postJoinMessage(env, owner, { chat, text, url, pin }) {
  if (!/^(-?\d{5,20}|@[A-Za-z0-9_]{5,32})$/.test(String(chat || ""))) return { status: 400, body: { error: "bad_chat", friendly: "Use the group's @username or its numeric id." } };
  const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM action_log WHERE owner = ?1 AND kind = 'post' AND at > ?2`).bind(owner, Date.now() - 10 * 60e3).first();
  if (n.n >= LIMIT.post) { await log(env, owner, "post", chat, "rate_limited", ""); return { status: 429, body: { error: "rate_limited", friendly: "NEBU already posted a lot in the last 10 minutes. Give it a moment." } }; }
  // Direct Mini App links work in groups (inline web_app buttons don't), so it's a URL button.
  const msg = await tg(env, "sendMessage", { chat_id: chat, text: String(text || "We're live. Join the chat 👇").slice(0, 500), reply_markup: { inline_keyboard: [[{ text: "Join the live chat", url }]] } });
  await log(env, owner, "post", chat, msg.ok ? (msg.mock ? "mock_ok" : "ok") : "failed", msg.ok ? "" : msg.description);
  if (!msg.ok) return { status: 502, body: { error: "telegram_error", friendly: msg.description || "Telegram said no." } };
  let pinned = false;
  if (pin) { const p = await tg(env, "pinChatMessage", { chat_id: chat, message_id: msg.result.message_id, disable_notification: true }); pinned = Boolean(p.ok); await log(env, owner, "pin", chat, p.ok ? (p.mock ? "mock_ok" : "ok") : "failed", p.ok ? "" : p.description); }
  return { status: 200, body: { ok: true, messageId: msg.result.message_id, pinned, mock: Boolean(msg.mock) } };
}
