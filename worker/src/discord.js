// Bring-your-own Discord bot for "Your NEBU". The user pastes bot token + application ID + public key
// (Discord Developer Portal: General Information -> Application ID / Public Key; Bot -> Reset Token).
// The token is AES-GCM sealed in tenant_secrets (kind "discord_bot"), never returned or logged.
// Interactions arrive over HTTP at /discord/interactions/:tenant, verified with Ed25519
// (X-Signature-Ed25519 over X-Signature-Timestamp + raw body, with the app's public key).
// DISCORD_MODE=mock replaces every call to discord.com with canned answers (tests).
import { putSecret, getSecret, mask, ownTenant } from "./tenant.js";

const API = "https://discord.com/api/v10";
// Minimal install: slash commands need no bot permissions. "post" adds only what posting an
// announcement needs: Send Messages (1<<11) + Embed Links (1<<14) + Attach Files (1<<15).
export const PERMS = { commands: "0", post: String((1 << 11) | (1 << 14) | (1 << 15)) };
export const COMMANDS = [
  { name: "design", description: "Ask for a custom design from my NEBU", type: 1, options: [{ type: 3, name: "brief", description: "What should it look like?", required: true, max_length: 400 }, { type: 3, name: "size", description: "One element or a matching set", required: false, choices: [{ name: "One element", value: "element" }, { name: "A matching set", value: "set" }] }] },
  { name: "packs", description: "Show my shared NEBU packs", type: 1 },
  { name: "status", description: "Is my NEBU online?", type: 1 },
  { name: "announce", description: "Owner only: post an announcement", type: 1, options: [{ type: 3, name: "text", description: "Announcement text", required: true, max_length: 500 }] },
  { name: "help", description: "What my NEBU can do", type: 1 },
];

const hex = (s) => Uint8Array.from(String(s).match(/.{1,2}/g) || [], (b) => parseInt(b, 16));
export async function verifyDiscord(publicKeyHex, signatureHex, timestamp, rawBody) {
  try {
    if (!/^[0-9a-f]{64}$/i.test(publicKeyHex) || !/^[0-9a-f]{128}$/i.test(signatureHex || "") || !timestamp) return false;
    const key = await crypto.subtle.importKey("raw", hex(publicKeyHex), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, hex(signatureHex), new TextEncoder().encode(timestamp + rawBody));
  } catch { return false; }
}

function dfetch(env, path, token, init = {}) {
  if ((env.DISCORD_MODE || "live") === "mock") {
    if (path === "/users/@me") return Promise.resolve(Response.json(token === "bad" ? { message: "401: Unauthorized" } : { id: "111111111111111111", username: "nebu-test-bot", bot: true }, { status: token === "bad" ? 401 : 200 }));
    if (path === "/applications/@me") return Promise.resolve(Response.json({ id: env.__mockAppId || "111111111111111111", verify_key: env.__mockVerifyKey || "" }));
    return Promise.resolve(Response.json([], { status: 200 }));
  }
  return fetch(API + path, { ...init, headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json", "User-Agent": "DiscordBot (https://nebu.quest, 2)", ...(init.headers || {}) } });
}

export function inviteLink(appId, mode = "commands") {
  const u = new URL("https://discord.com/oauth2/authorize");
  u.searchParams.set("client_id", appId);
  u.searchParams.set("scope", "bot applications.commands");
  u.searchParams.set("permissions", PERMS[mode] || "0");
  return u.toString();
}

export function validDiscordInput({ token, appId, publicKey }) {
  const errs = [];
  if (token !== undefined && !/^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/.test(String(token))) errs.push("bad_token_format");
  if (appId !== undefined && !/^\d{17,20}$/.test(String(appId))) errs.push("bad_app_id");
  if (publicKey !== undefined && !/^[0-9a-f]{64}$/i.test(String(publicKey))) errs.push("bad_public_key");
  return errs;
}

// Save + verify. GET /users/@me proves the token is a live bot; GET /applications/@me proves the
// Application ID and Public Key belong to that same bot.
export async function setTenantDiscord(env, user, id, body, origin) {
  const t = await ownTenant(env, user, id);
  if (!t) return { status: 404, body: { error: "not_found" } };
  const token = String(body.token || "").trim(), appId = String(body.appId || "").trim(), publicKey = String(body.publicKey || "").trim().toLowerCase();
  const errs = validDiscordInput({ token, appId, publicKey });
  if (errs.length) return { status: 400, body: { error: errs[0], friendly: "Check the three values: bot token (from the Bot page), Application ID and Public Key (from General Information)." } };
  const me = await dfetch(env, "/users/@me", token);
  if (!me.ok) return { status: 400, body: { error: "token_rejected", friendly: "Discord didn't accept that token. Reset it on the Bot page and paste the new one." } };
  const bot = await me.json();
  if (!bot.bot) return { status: 400, body: { error: "not_a_bot_token" } };
  const app = await dfetch(env, "/applications/@me", token);
  if (app.ok) {
    const a = await app.json();
    if (a.id && a.id !== appId) return { status: 400, body: { error: "app_id_mismatch", friendly: "That Application ID belongs to a different app than the token." } };
    if (a.verify_key && a.verify_key.toLowerCase() !== publicKey) return { status: 400, body: { error: "public_key_mismatch", friendly: "That Public Key belongs to a different app than the token." } };
  }
  const ownerDiscordId = /^\d{17,20}$/.test(String(body.ownerDiscordId || "")) ? String(body.ownerDiscordId) : "";
  await putSecret(env, id, user.id, "discord_bot", { token }, { appId, publicKey, bot: bot.username, botId: bot.id, ownerDiscordId, token: mask(token) });
  // Register slash commands on the user's own app (global). Skipped in mock mode.
  let commands = "skipped";
  if ((env.DISCORD_MODE || "live") !== "mock") { const r = await dfetch(env, `/applications/${appId}/commands`, token, { method: "PUT", body: JSON.stringify(COMMANDS) }); commands = r.ok ? "registered" : `failed_${r.status}`; }
  return { status: 200, body: { ok: true, discord: { bot: bot.username, appId, token: mask(token), commands, interactionsUrl: `${origin}/discord/interactions/${id}`, invite: inviteLink(appId, "commands"), invitePost: inviteLink(appId, "post") } } };
}

const reply = (content, ephemeral = true) => Response.json({ type: 4, data: { content, flags: ephemeral ? 64 : 0, allowed_mentions: { parse: [] } } });

// hooks: { createRequest(owner, body), sharedPacks(owner), status(tenant), announce(tenant, owner, text, trigger) }
export async function handleInteraction(env, req, tenantId, hooks) {
  const raw = await req.text();
  const sec = await getSecret(env, tenantId, "discord_bot");
  if (!sec) return new Response("unknown app", { status: 404 });
  const ok = await verifyDiscord(sec.meta.publicKey, req.headers.get("X-Signature-Ed25519"), req.headers.get("X-Signature-Timestamp"), raw);
  if (!ok) return new Response("invalid request signature", { status: 401 });
  const i = JSON.parse(raw);
  if (i.type === 1) return Response.json({ type: 1 }); // PING -> PONG
  if (i.type !== 2) return reply("I only understand slash commands for now.");
  const who = (i.member && i.member.user) || i.user || {};
  const isOwner = Boolean(sec.meta.ownerDiscordId) && who.id === sec.meta.ownerDiscordId;
  const opt = (n) => ((i.data.options || []).find((o) => o.name === n) || {}).value;
  switch (i.data.name) {
    case "help": return reply("**NEBU** · /design asks for a custom design · /packs shows shared packs · /status checks if I'm online · /announce is for the owner.");
    case "status": { const s = await hooks.status(tenantId); return reply(`NEBU is ${s.online ? "online" : "resting"}${s.live ? " · live now" : ""}.`); }
    case "packs": { const p = await hooks.sharedPacks(sec.owner); return reply(p.length ? p.map((x) => `• ${x.name}: ${x.url}`).join("\n").slice(0, 1900) : "No shared packs yet."); }
    case "design": {
      if (!isOwner) return reply("Design requests come from the NEBU owner. Ask them, or open nebu.quest/studio to get your own.");
      const r = await hooks.createRequest(sec.owner, { brief: String(opt("brief") || ""), size: opt("size") === "set" ? "set" : "element", via: "discord" });
      return reply(r.status < 300 ? "Got it. Your request is in the queue." : (r.body.friendly || `Couldn't queue that (${r.body.error}).`));
    }
    case "announce": {
      if (!isOwner) return reply("Only the NEBU owner can announce.");
      const r = await hooks.announce(tenantId, sec.owner, String(opt("text") || ""), "discord");
      return reply(r.ok ? "Announcement queued." : (r.friendly || r.error || "Couldn't announce."));
    }
    default: return reply("Unknown command.");
  }
}
