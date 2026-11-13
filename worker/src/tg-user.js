// NEBU account = a SECOND, dedicated Telegram USER account that the user's NEBU runs on (MTProto).
// One Durable Object per tenant (idFromName(tenantId)) serializes login steps and actions.
// The session string is AES-GCM encrypted (TENANT_KEY) and stored in D1 (tenants.tg_session), keyed
// to the FRISKY ID; it is never returned to the client or logged. Connections are on demand (connect,
// do the call, disconnect) because outgoing sockets keep a Durable Object awake and billed.
//
// Adapters: TG_USER_MODE = "mock" (default; tests) | "mtcute" (prototype; needs TG_API_ID + TG_API_HASH
// from my.telegram.org and the @mtcute/web dependency, see docs/TELEGRAM-USER-ACCOUNT.md).
import { DurableObject } from "cloudflare:workers";
import { b64url, unb64url } from "./auth.js";

async function aes(env) {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.TENANT_KEY || ""));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function seal(env, text) { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aes(env), new TextEncoder().encode(text))); return `${b64url(iv)}.${b64url(ct)}`; }
async function unseal(env, s) { if (!s) return ""; const [iv, ct] = s.split("."); return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64url(iv) }, await aes(env), unb64url(ct))); }

// ---- Mock adapter: deterministic, never touches Telegram. Test phone +99966 2xxxx, code 22222, 2FA "nebu-test".
class MockAdapter {
  constructor(session) { this.session = session ? JSON.parse(session) : null; }
  async sendCode(phone) { if (!/^\+?99966\d{5}$/.test(phone.replace(/[\s-]/g, ""))) throw Object.assign(new Error("PHONE_NUMBER_INVALID"), { friendly: "Mock mode only accepts Telegram test numbers (+99966 followed by 5 digits)." }); return { phoneCodeHash: "mock-hash", phone }; }
  async signIn(phone, hash, code) { if (code !== "22222") throw Object.assign(new Error("PHONE_CODE_INVALID"), { friendly: "That code didn't match." }); if (phone.endsWith("0")) return { needPassword: true, hint: "test" }; return this.done(phone); }
  async checkPassword(phone, pw) { if (pw !== "nebu-test") throw Object.assign(new Error("PASSWORD_HASH_INVALID"), { friendly: "Wrong 2FA password." }); return this.done(phone); }
  done(phone) { const id = String(9000000000 + Number(phone.slice(-5))); this.session = { id, username: `nebu_test_${phone.slice(-5)}`, phone: phone.slice(-4) }; return { user: { id, username: this.session.username, name: "NEBU test account" }, session: JSON.stringify(this.session) }; }
  async me() { return this.session ? { id: this.session.id, username: this.session.username } : null; }
  async logOut() { this.session = null; return true; }
  async savedStickerSets() { return [{ name: "StixMagicArcanum", title: "Stix Magic Arcanum (mock)", count: 50 }]; }
  async post() { return { mocked: true }; }
  async goLive() { return { mocked: true, mode: "mock" }; }
  async videoChat() { return { ok: false, joined: false, active: false, mode: "mock", friendly: "Test mode cannot join a Telegram video chat." }; }
}

async function adapterFor(env, session) {
  if ((env.TG_USER_MODE || "mock") === "mtcute") {
    if (!env.TG_API_ID || !env.TG_API_HASH) throw Object.assign(new Error("TG_API_NOT_CONFIGURED"), { friendly: "Telegram API app (API_ID / API_HASH) isn't connected yet." });
    const { MtcuteAdapter } = await import("./tg-user-mtcute.js");
    return new MtcuteAdapter(env, session);
  }
  return new MockAdapter(session);
}

export class TgUser extends DurableObject {
  async fetch(req) {
    const url = new URL(req.url);
    const op = url.pathname.split("/").pop();
    const { tenant, owner, personalTgId } = JSON.parse(req.headers.get("X-Nebu-Tenant") || "{}");
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const out = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
    const row = await this.env.DB.prepare(`SELECT tg_session FROM tenants WHERE id = ?1 AND owner = ?2`).bind(tenant, owner).first();
    if (!row && op !== "status") return out({ error: "not_found" }, 404);
    const session = row && row.tg_session ? await unseal(this.env, row.tg_session) : "";
    try {
      const tg = await adapterFor(this.env, session);
      if (op === "status") { const me = session ? await tg.me().catch(() => null) : null; return out({ connected: Boolean(me), account: me, mode: this.env.TG_USER_MODE || "mock" }); }
      if (op === "send-code") {
        const phone = String(body.phone || "").replace(/[^\d+]/g, "").slice(0, 16);
        if (phone.length < 8) return out({ error: "bad_phone", friendly: "Enter the phone number of your second Telegram account, with country code." }, 400);
        const r = await tg.sendCode(phone);
        await this.ctx.storage.put("pending", await seal(this.env, JSON.stringify({ phone, hash: r.phoneCodeHash, at: Date.now() })));
        return out({ ok: true, step: "code" });
      }
      const pending = await this.ctx.storage.get("pending");
      const p = pending ? JSON.parse(await unseal(this.env, pending)) : null;
      if (op === "sign-in" || op === "password") {
        if (!p || Date.now() - p.at > 10 * 60e3) return out({ error: "start_again", friendly: "That login timed out. Send a new code." }, 409);
        const r = op === "sign-in" ? await tg.signIn(p.phone, p.hash, String(body.code || "").replace(/\D/g, "").slice(0, 8)) : await tg.checkPassword(p.phone, String(body.password || "").slice(0, 256));
        if (r.needPassword) return out({ ok: true, step: "password", hint: r.hint || "" });
        if (personalTgId && String(r.user.id) === String(personalTgId)) {
          await tg.logOut().catch(() => {});
          await this.ctx.storage.delete("pending");
          return out({ error: "same_telegram_account", friendly: "That's your personal Telegram account. NEBU has to run on a second, dedicated account." }, 409);
        }
        await this.env.DB.prepare(`UPDATE tenants SET tg_session = ?3, tg_user = ?4, updated = ?5 WHERE id = ?1 AND owner = ?2`).bind(tenant, owner, await seal(this.env, r.session), JSON.stringify({ id: r.user.id, username: r.user.username || "" }), Date.now()).run();
        await this.ctx.storage.delete("pending");
        return out({ ok: true, step: "done", account: { id: r.user.id, username: r.user.username || "" } });
      }
      if (!session) return out({ error: "not_connected" }, 409);
      if (op === "logout") {
        await tg.logOut().catch(() => {}); // auth.logOut revokes the session on Telegram's side
        await this.env.DB.prepare(`UPDATE tenants SET tg_session = NULL, tg_user = NULL, updated = ?3 WHERE id = ?1 AND owner = ?2`).bind(tenant, owner, Date.now()).run();
        await this.ctx.storage.deleteAll();
        return out({ ok: true });
      }
      if (op === "saved-sets") return out({ sets: await tg.savedStickerSets() });
      if (op === "post") return out(await tg.post(String(body.peer || ""), String(body.text || "").slice(0, 4000)));
      if (op === "go-live") return out(await tg.goLive(String(body.peer || ""), { revoke: body.revoke === true }));
      if (op === "vc") return out(await tg.videoChat(String(body.action || "status"), body));
      return out({ error: "unknown_op" }, 404);
    } catch (e) {
      return out({ error: String(e.message || "telegram_error").slice(0, 60), friendly: e.friendly || "Telegram didn't accept that. Try again in a moment." }, e.message === "TG_API_NOT_CONFIGURED" ? 503 : 400);
    }
  }
}
