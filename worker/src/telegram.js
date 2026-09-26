// Telegram: Login Widget verification, sticker-set import (getStickerSet/getFile -> R2 cache),
// and sticker-set submission for delivered requests. The bot token is a Worker secret and never
// leaves the Worker; file downloads are proxied and cached in R2.
import { hmacHex } from "./auth.js";

const API = "https://api.telegram.org";
const BATCH = 12; // stickers per import call (keeps subrequests well under limits)

export async function verifyLoginWidget(env, data) {
  if (!env.TELEGRAM_BOT_TOKEN || !data || typeof data !== "object" || !data.hash) return null;
  const fields = Object.keys(data).filter((k) => k !== "hash" && data[k] !== undefined && data[k] !== null).sort().map((k) => `${k}=${data[k]}`).join("\n");
  const secret = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.TELEGRAM_BOT_TOKEN)));
  const hash = await hmacHex(secret, fields);
  if (hash !== String(data.hash).toLowerCase()) return null;
  if (Math.floor(Date.now() / 1000) - Number(data.auth_date || 0) > 86400) return null;
  return { id: String(data.id), username: data.username ? String(data.username).slice(0, 64) : "", name: [data.first_name, data.last_name].filter(Boolean).join(" ").slice(0, 64) };
}

export function parseSetName(input) {
  const s = String(input || "").trim();
  const m = s.match(/(?:t\.me|telegram\.me)\/add(?:stickers|emoji)\/([A-Za-z0-9_]{1,64})/i);
  const name = m ? m[1] : s;
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : null;
}

async function bot(env, method, params) {
  const res = await fetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params || {}) });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw Object.assign(new Error(data.description || `telegram_${res.status}`), { code: data.error_code || res.status });
  return data.result;
}

const FORMAT = (s) => (s.is_animated ? { ext: "tgs", type: "application/x-tgsticker", format: "animated" } : s.is_video ? { ext: "webm", type: "video/webm", format: "video" } : { ext: "webp", type: "image/webp", format: "static" });

// Import one batch. Returns {set, items:[{id,name,emoji,format,key}], next|null}
export async function importBatch(env, setName, cursor = 0) {
  const set = await bot(env, "getStickerSet", { name: setName });
  const stickers = (set.stickers || []).slice(0, 120);
  const slice = stickers.slice(cursor, cursor + BATCH);
  const items = [];
  for (const s of slice) {
    const f = FORMAT(s);
    const key = `packs/tg-cache/${setName}/${s.file_unique_id}.${f.ext}`;
    const have = await env.PACKS.head(key);
    if (!have) {
      const file = await bot(env, "getFile", { file_id: s.file_id });
      if (!file.file_path || (file.file_size && file.file_size > 2e6)) continue;
      const dl = await fetch(`${API}/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
      if (!dl.ok) continue;
      await env.PACKS.put(key, dl.body, { httpMetadata: { contentType: f.type } });
    }
    items.push({ id: `tg/${setName}/${s.file_unique_id}`, name: s.emoji || "sticker", emoji: s.emoji || "", format: f.format, src: `r2:${key}` });
  }
  const next = cursor + BATCH < stickers.length ? cursor + BATCH : null;
  return { set: { name: set.name, title: set.title, count: stickers.length, type: set.sticker_type }, items, next };
}

// Submission of a delivered sticker request as a real set owned by the user.
// Modes: TELEGRAM_SUBMIT_MODE = off | mock (default) | test (only TELEGRAM_TEST_USER_ID) | live
export async function submitStickerSet(env, { tgUserId, title, stickers, requestId }) {
  const mode = env.TELEGRAM_SUBMIT_MODE || "mock";
  const me = env.TELEGRAM_BOT_USERNAME || "your_bot";
  const name = `nebu_${String(requestId).replace(/[^A-Za-z0-9]/g, "").slice(0, 20)}_by_${me}`.slice(0, 64);
  const link = `https://t.me/addstickers/${name}`;
  const input = stickers.slice(0, 50).map((s, i) => ({ key: s.r2Key, emoji: s.emoji || "✨", format: s.format === "video" ? "video" : "static", attach: `file${i}` }));
  if (mode === "off") return { skipped: "submission_off" };
  if (mode === "mock" || !env.TELEGRAM_BOT_TOKEN) return { mocked: true, name, link, count: input.length, note: "Mock mode: no set created, no message sent." };
  if (mode === "test" && String(tgUserId) !== String(env.TELEGRAM_TEST_USER_ID || "")) return { skipped: "not_test_account" };
  const form = new FormData();
  form.set("user_id", String(tgUserId));
  form.set("name", name);
  form.set("title", String(title).slice(0, 64));
  form.set("sticker_type", "regular");
  form.set("stickers", JSON.stringify(input.map((s) => ({ sticker: `attach://${s.attach}`, format: s.format, emoji_list: [s.emoji] }))));
  for (const s of input) {
    const obj = await env.PACKS.get(s.key);
    if (!obj) return { error: `missing_file:${s.key}` };
    // Files must already be 512px (one side) WEBP (static) or WEBM VP9 <=3s (video); the delivery tool prepares them.
    form.set(s.attach, new File([await obj.arrayBuffer()], `${s.attach}.${s.format === "video" ? "webm" : "webp"}`, { type: s.format === "video" ? "video/webm" : "image/webp" }));
  }
  const res = await fetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/createNewStickerSet`, { method: "POST", body: form });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) return { error: data.description || `telegram_${res.status}` };
  await bot(env, "sendMessage", { chat_id: tgUserId, text: `Your NEBU sticker set is ready: ${link}` }).catch(() => {});
  return { created: true, name, link };
}

export async function botStatus(token) {
  if (!token) return { ok: false, status: "no_token" };
  try {
    const res = await fetch(`${API}/bot${token}/getMe`);
    const data = await res.json();
    return data.ok ? { ok: true, status: "online", username: data.result.username, name: data.result.first_name } : { ok: false, status: "invalid_token" };
  } catch { return { ok: false, status: "unreachable" }; }
}
