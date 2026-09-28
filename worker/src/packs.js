// "My packs": per-user storage in R2 (files) + D1 (pack rows, manifests, quota).
// Keys: packs/<userId>/<packId>/<file>, packs/official/<packId>/<file>,
// packs/tg-cache/<setName>/<fileUniqueId>.<ext> (shared Telegram cache).
import { sign, verify, randomId } from "./auth.js";
import { entitlements } from "./plans.js";

export const LIMITS = {
  quotaBytes: 250 * 1024 * 1024, // per user
  maxPacks: 30,
  maxFilesPerPack: 300,
  manifestBytes: 512 * 1024,
  types: {
    "image/png": 5e6, "image/webp": 5e6, "image/jpeg": 5e6, "image/gif": 8e6, "image/svg+xml": 1e6,
    "application/x-tgsticker": 1e6, "video/webm": 50e6, "video/mp4": 50e6,
    "audio/mpeg": 30e6, "audio/wav": 30e6, "audio/x-wav": 30e6, "application/json": 1e6,
    "text/plain": 512e3, // .cube LUTs
  },
};
const KINDS = new Set(["stickers", "lower-thirds", "overlays", "frames", "luts", "stingers", "clips", "mixed", "telegram"]);
const EXT = { "image/png": "png", "image/webp": "webp", "image/jpeg": "jpg", "image/gif": "gif", "image/svg+xml": "svg", "application/x-tgsticker": "tgs", "video/webm": "webm", "video/mp4": "mp4", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "application/json": "json", "text/plain": "cube" };

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT, bytes INTEGER NOT NULL DEFAULT 0, tg_id TEXT, tg_username TEXT, created INTEGER)`,
  `CREATE TABLE IF NOT EXISTS packs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, manifest TEXT NOT NULL DEFAULT '{}', bytes INTEGER NOT NULL DEFAULT 0, share TEXT UNIQUE, source TEXT, created INTEGER, updated INTEGER)`,
  `CREATE INDEX IF NOT EXISTS packs_owner ON packs(owner)`,
  `CREATE TABLE IF NOT EXISTS files (key TEXT PRIMARY KEY, pack TEXT NOT NULL, owner TEXT NOT NULL, type TEXT, size INTEGER, name TEXT, created INTEGER)`,
  `CREATE INDEX IF NOT EXISTS files_pack ON files(pack)`,
  `CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, owner TEXT NOT NULL, month TEXT NOT NULL, scope TEXT NOT NULL, items TEXT NOT NULL, brief TEXT, style TEXT, tg_submit INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, pack TEXT, tg_set TEXT, created INTEGER, updated INTEGER, UNIQUE(owner, month))`,
];

let schemaReady = false;
export async function ensureSchema(env) {
  if (schemaReady || !env.DB) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  schemaReady = true;
}

export function packsEnabled(env) { return Boolean(env.PACKS && env.DB && env.NEBU_SESSION_SECRET); }

export async function ensureUser(env, user) {
  await env.DB.prepare(`INSERT INTO users (id, name, created) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET name = excluded.name`).bind(user.id, user.name || "", Date.now()).run();
  return env.DB.prepare(`SELECT id, name, bytes, tg_id, tg_username FROM users WHERE id = ?1`).bind(user.id).first();
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

// A manifest may only mint URLs for keys this pack is allowed to read:
// this pack's own uploads, this pack's stitch job, the public official prefix,
// and the shared Telegram sticker cache. A copied foreign key is not signed.
export function keyAllowed(key, pack) {
  if (!pack || typeof key !== "string" || key.length > 300 || /[\\%\u0000]/.test(key) || key.includes("..")) return false;
  const owner = String(pack.owner || "");
  const id = String(pack.id || "");
  if (!SAFE_ID.test(owner) || !SAFE_ID.test(id)) return false;
  if (/^packs\/official\/[A-Za-z0-9_-]{1,80}\/[A-Za-z0-9._-]{1,160}$/.test(key)) return true;
  if (/^packs\/tg-cache\/[A-Za-z][A-Za-z0-9_]{0,63}\/[A-Za-z0-9_-]{1,200}\.(webp|webm|tgs)$/.test(key)) return true;
  if (key.startsWith(`packs/${owner}/${id}/`) && new RegExp(`^packs/${owner}/${id}/[A-Za-z0-9._-]{1,160}$`).test(key)) return true;
  const source = String(pack.source || "");
  if (source.startsWith("stitch:")) {
    const job = source.slice("stitch:".length);
    if (SAFE_ID.test(job) && new RegExp(`^packs/stitch/${owner}/${job}/\\d{1,2}\\.(png|jpe?g|webp|svg|html)$`).test(key)) return true;
  }
  return false;
}

export function manifestRefsAllowed(manifestText, pack) {
  return [...String(manifestText).matchAll(/"r2:([^"]+)"/g)].every((m) => keyAllowed(m[1], pack));
}

export async function fileUrl(env, origin, key, ttl = 6 * 3600) {
  if (key.startsWith("packs/official/")) return `${origin}/f/${encodeURI(key)}`;
  const e = Math.floor(Date.now() / 1000) + ttl;
  const s = await sign(env.NEBU_SESSION_SECRET, { aud: "file", k: key, exp: e });
  return `${origin}/f/${encodeURI(key)}?t=${encodeURIComponent(s)}`;
}

// Replace "r2:<key>" references in a manifest with signed URLs for the reader.
// Keys this pack cannot read become an empty string and are not signed.
export async function resolveManifest(env, origin, manifest, pack) {
  const txt = JSON.stringify(manifest || {});
  const keys = [...new Set([...txt.matchAll(/"r2:([^"]+)"/g)].map((m) => m[1]))];
  const map = {};
  for (const k of keys) map[k] = pack && keyAllowed(k, pack) ? await fileUrl(env, origin, k) : "";
  return JSON.parse(txt.replace(/"r2:([^"]+)"/g, (_, k) => JSON.stringify(map[k] ?? "")));
}

function packRow(r, extra = {}) {
  return { id: r.id, name: r.name, kind: r.kind, bytes: r.bytes, shared: Boolean(r.share), source: r.source || "", updated: r.updated, official: r.owner === "official", ...extra };
}

export async function serveFile(env, req, key) {
  if (!key.startsWith("packs/") || key.includes("..") || /[\\%\u0000]/.test(key)) return new Response("not found", { status: 404 });
  if (!key.startsWith("packs/official/")) {
    const t = new URL(req.url).searchParams.get("t");
    const p = await verify(env.NEBU_SESSION_SECRET, t, "file");
    if (!p || p.k !== key) return new Response("forbidden", { status: 403 });
  }
  const obj = await env.PACKS.get(key);
  if (!obj) return new Response("not found", { status: 404 });
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set("ETag", obj.httpEtag);
  h.set("Cache-Control", key.startsWith("packs/official/") || key.startsWith("packs/tg-cache/") ? "public, max-age=86400" : "private, max-age=3600");
  h.set("Access-Control-Allow-Origin", "*");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  return new Response(obj.body, { headers: h });
}

export async function handlePacks(env, req, user, parts, origin, json) {
  const db = env.DB;
  const method = req.method;
  // GET /packs  -> mine + official
  if (parts.length === 1 && method === "GET") {
    const u = await ensureUser(env, user);
    const mine = await db.prepare(`SELECT * FROM packs WHERE owner = ?1 ORDER BY updated DESC`).bind(user.id).all();
    const official = await db.prepare(`SELECT * FROM packs WHERE owner = 'official' ORDER BY name`).all();
    const ent = await entitlements(env, user.id);
    return json({ plan: ent.plan, quota: { used: u.bytes, limit: ent.limits.storageBytes }, packs: mine.results.map((r) => packRow(r)), official: official.results.map((r) => packRow(r)) });
  }
  // POST /packs {name, kind, manifest?}
  if (parts.length === 1 && method === "POST") {
    await ensureUser(env, user);
    const body = await req.json().catch(() => ({}));
    const name = String(body.name || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 60);
    const kind = KINDS.has(body.kind) ? body.kind : "mixed";
    if (!name) return json({ error: "name_required" }, 400);
    const n = await db.prepare(`SELECT COUNT(*) AS n FROM packs WHERE owner = ?1`).bind(user.id).first();
    const lim = (await entitlements(env, user.id)).limits.packs;
    if (n.n >= lim) return json({ error: "too_many_packs", limit: lim }, 409);
    const manifest = JSON.stringify(body.manifest && typeof body.manifest === "object" ? body.manifest : { version: 1, items: [] });
    if (manifest.length > LIMITS.manifestBytes) return json({ error: "manifest_too_big" }, 413);
    const id = "p_" + randomId(9);
    const source = String(body.source || "studio").slice(0, 80);
    if (!manifestRefsAllowed(manifest, { id, owner: user.id, source })) return json({ error: "manifest_key" }, 400);
    const now = Date.now();
    await db.prepare(`INSERT INTO packs (id, owner, name, kind, manifest, source, created, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`).bind(id, user.id, name, kind, manifest, source, now).run();
    return json({ pack: { id, name, kind } }, 201);
  }
  const id = parts[1];
  const row = await db.prepare(`SELECT * FROM packs WHERE id = ?1`).bind(id).first();
  if (!row) return json({ error: "not_found" }, 404);
  const mine = row.owner === user.id;
  // GET /packs/:id
  if (parts.length === 2 && method === "GET") {
    if (!mine && row.owner !== "official") return json({ error: "not_found" }, 404);
    const manifest = await resolveManifest(env, origin, JSON.parse(row.manifest || "{}"), row);
    return json({ pack: packRow(row, { mine, share: mine && row.share ? `${origin}/s/${row.share}` : null }), manifest });
  }
  if (!mine) return json({ error: "forbidden" }, 403);
  // PUT /packs/:id {name?, manifest?}
  if (parts.length === 2 && method === "PUT") {
    const body = await req.json().catch(() => ({}));
    const manifest = body.manifest ? JSON.stringify(body.manifest) : row.manifest;
    if (manifest.length > LIMITS.manifestBytes) return json({ error: "manifest_too_big" }, 413);
    if (body.manifest && !manifestRefsAllowed(manifest, row)) return json({ error: "manifest_key" }, 400);
    const name = body.name ? String(body.name).replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 60) : row.name;
    await db.prepare(`UPDATE packs SET name = ?2, manifest = ?3, updated = ?4 WHERE id = ?1`).bind(id, name, manifest, Date.now()).run();
    return json({ ok: true });
  }
  // DELETE /packs/:id
  if (parts.length === 2 && method === "DELETE") {
    const files = await db.prepare(`SELECT key FROM files WHERE pack = ?1`).bind(id).all();
    const keys = files.results.map((f) => f.key).filter((k) => k.startsWith(`packs/${user.id}/`));
    for (let i = 0; i < keys.length; i += 500) await env.PACKS.delete(keys.slice(i, i + 500));
    await db.batch([
      db.prepare(`DELETE FROM files WHERE pack = ?1`).bind(id),
      db.prepare(`DELETE FROM packs WHERE id = ?1`).bind(id),
      db.prepare(`UPDATE users SET bytes = MAX(0, bytes - ?2) WHERE id = ?1`).bind(user.id, row.bytes),
    ]);
    return json({ ok: true });
  }
  // POST /packs/:id/share {on}
  if (parts[2] === "share" && method === "POST") {
    const body = await req.json().catch(() => ({}));
    const token = body.on === false ? null : (row.share || randomId(12));
    await db.prepare(`UPDATE packs SET share = ?2, updated = ?3 WHERE id = ?1`).bind(id, token, Date.now()).run();
    return json({ share: token ? `${origin}/s/${token}` : null });
  }
  // POST /packs/:id/files?name=  (raw body, Content-Type required)
  if (parts[2] === "files" && parts.length === 3 && method === "POST") {
    const type = (req.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
    const cap = LIMITS.types[type];
    if (!cap) return json({ error: "type_not_allowed", allowed: Object.keys(LIMITS.types) }, 415);
    const len = Number(req.headers.get("Content-Length") || 0);
    if (!len || len > cap) return json({ error: "too_big", limit: cap }, 413);
    const u = await ensureUser(env, user);
    const ent = await entitlements(env, user.id);
    if (u.bytes + len > ent.limits.storageBytes) return json({ error: "quota_exceeded", used: u.bytes, limit: ent.limits.storageBytes }, 413);
    const count = await db.prepare(`SELECT COUNT(*) AS n FROM files WHERE pack = ?1`).bind(id).first();
    if (count.n >= LIMITS.maxFilesPerPack) return json({ error: "too_many_files" }, 409);
    const nm = String(new URL(req.url).searchParams.get("name") || "file").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60);
    const key = `packs/${user.id}/${id}/${randomId(6)}-${nm.replace(/\.[A-Za-z0-9]+$/, "")}.${EXT[type]}`;
    const buf = await req.arrayBuffer();
    if (buf.byteLength > cap) return json({ error: "too_big", limit: cap }, 413);
    await env.PACKS.put(key, buf, { httpMetadata: { contentType: type } });
    await db.batch([
      db.prepare(`INSERT INTO files (key, pack, owner, type, size, name, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`).bind(key, id, user.id, type, buf.byteLength, nm, Date.now()),
      db.prepare(`UPDATE packs SET bytes = bytes + ?2, updated = ?3 WHERE id = ?1`).bind(id, buf.byteLength, Date.now()),
      db.prepare(`UPDATE users SET bytes = bytes + ?2 WHERE id = ?1`).bind(user.id, buf.byteLength),
    ]);
    return json({ key, ref: `r2:${key}`, url: await fileUrl(env, origin, key), size: buf.byteLength, type }, 201);
  }
  return json({ error: "not_found" }, 404);
}

// Public share link: GET /s/:token -> read-only manifest (signed URLs)
export async function handleShare(env, token, origin, json) {
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(token)) return json({ error: "not_found" }, 404);
  const row = await env.DB.prepare(`SELECT * FROM packs WHERE share = ?1`).bind(token).first();
  if (!row) return json({ error: "not_found" }, 404);
  const manifest = await resolveManifest(env, origin, JSON.parse(row.manifest || "{}"), row);
  return json({ pack: packRow(row, { mine: false }), manifest });
}

// Save a server-built pack for a user (Telegram import, delivered requests).
export async function createPackFor(env, owner, name, kind, manifest, source) {
  const id = "p_" + randomId(9);
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO packs (id, owner, name, kind, manifest, source, created, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`).bind(id, owner, name.slice(0, 60), kind, JSON.stringify(manifest), source, now).run();
  return id;
}
