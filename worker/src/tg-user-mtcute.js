// PROTOTYPE (not bundled by default): mtcute over Telegram's WebSocket transport inside the TgUser
// Durable Object. Enable with TG_USER_MODE=mtcute after `npm i @mtcute/web` in worker/ and setting
// TG_API_ID / TG_API_HASH (my.telegram.org). Untested against real Telegram (no API app exists yet).
import { BaseTelegramClient, TelegramClient, MemoryStorage } from "@mtcute/web";

export class MtcuteAdapter {
  constructor(env, session) { this.env = env; this.session = session; }
  async client() {
    if (this.tg) return this.tg;
    const base = new BaseTelegramClient({ apiId: Number(this.env.TG_API_ID), apiHash: this.env.TG_API_HASH, storage: new MemoryStorage(), logLevel: 0 });
    this.tg = new TelegramClient({ client: base });
    if (this.session) await this.tg.importSession(this.session);
    await this.tg.connect();
    return this.tg;
  }
  async close() { try { await this.tg?.destroy(); } catch { /* */ } }
  async sendCode(phone) { const tg = await this.client(); const r = await tg.sendCode({ phone }); return { phoneCodeHash: r.phoneCodeHash }; }
  async signIn(phone, hash, code) {
    const tg = await this.client();
    try { const u = await tg.signIn({ phone, phoneCodeHash: hash, phoneCode: code }); return this.done(u); }
    catch (e) { if (String(e.message || e).includes("SESSION_PASSWORD_NEEDED")) return { needPassword: true }; throw e; }
  }
  async checkPassword(_phone, pw) { const tg = await this.client(); return this.done(await tg.checkPassword(pw)); }
  async done(u) { const session = await this.tg.exportSession(); await this.close(); return { user: { id: String(u.id), username: u.username || "", name: u.displayName }, session }; }
  async me() { const tg = await this.client(); const u = await tg.getMe(); await this.close(); return { id: String(u.id), username: u.username || "" }; }
  async logOut() { const tg = await this.client(); await tg.call({ _: "auth.logOut" }); await this.close(); return true; }
  async savedStickerSets() { const tg = await this.client(); const r = await tg.call({ _: "messages.getAllStickers", hash: 0 }); await this.close(); return (r.sets || []).map((s) => ({ name: s.shortName, title: s.title, count: s.count })); }
  async post(peer, text) { const tg = await this.client(); const m = await tg.sendText(peer, text); await this.close(); return { ok: true, id: m.id }; }
  async goLive(peer, opts = {}) {
    const tg = await this.client();
    const inputPeer = await tg.resolvePeer(peer);
    await tg.call({ _: "phone.createGroupCall", peer: inputPeer, randomId: Math.floor(Math.random() * 2 ** 31), rtmpStream: true });
    const r = await tg.call({ _: "phone.getGroupCallStreamRtmpUrl", peer: inputPeer, revoke: opts.revoke === true });
    await this.close();
    return { rtmpUrl: r.url, streamKey: r.key, mode: "mtcute" };
  }
  async videoChat() {
    return { ok: false, joined: false, active: false, mode: "unavailable", friendly: "This worker can open an RTMP stream on your second account. Joining the call as a participant is not in this runtime." };
  }
}
