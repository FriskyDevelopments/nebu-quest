// Monthly design by Code Pup Design, which uses Stitch through Frisky's Hermes dispatcher (docs/stitch-hermes.md).
// NEBU -> POST {HERMES_STITCH_URL}/stitch/jobs  (X-Nebu-Signature: hex HMAC-SHA256(raw body, HERMES_STITCH_SECRET)) -> 202 {job_id}
//   body also carries brief_mode:'auto'|'provided', rounds:3, nice_touch:true (pipeline rules, see docs)
// Hermes -> POST /api/stitch/callback {job_id, status:'designing'|'ready'|'failed', round?:1..3, screens:[{htmlCode, screenshotUrl}], nice_touch?:string, error?}
// Quota: 1 job per calendar month (UTC) per FRISKY ID, reserved at dispatch, refunded on 'failed'.
// No HERMES_STITCH_URL -> mock dispatcher that drives the same callback handler with sample screens.
import { randomId } from "./auth.js";
import { createPackFor } from "./packs.js";

export const STITCH_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS stitch_jobs (job_id TEXT PRIMARY KEY, owner TEXT NOT NULL, month TEXT NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, mode TEXT NOT NULL, pack TEXT, screens INTEGER DEFAULT 0, error TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS stitch_jobs_owner ON stitch_jobs (owner, created)`,
  // One row per (owner, month) = the reserved monthly slot. Deleted on 'failed' (refund).
  `CREATE TABLE IF NOT EXISTS stitch_quota (owner TEXT NOT NULL, month TEXT NOT NULL, job_id TEXT NOT NULL, PRIMARY KEY (owner, month))`,
];
// Added after the first preview deploy; each runs once and is ignored if the column exists.
export const STITCH_MIGRATIONS = [
  `ALTER TABLE stitch_jobs ADD COLUMN round INTEGER DEFAULT 0`,
  `ALTER TABLE stitch_jobs ADD COLUMN rounds INTEGER DEFAULT 3`,
  `ALTER TABLE stitch_jobs ADD COLUMN brief_mode TEXT DEFAULT 'auto'`,
  `ALTER TABLE stitch_jobs ADD COLUMN nice_touch TEXT`,
];
export const ROUNDS = 3;
const TERMINAL = new Set(["ready", "failed"]);
const MAX_SHOT = 6 * 1024 * 1024, MAX_HTML = 512 * 1024;
const month = (d = new Date()) => d.toISOString().slice(0, 7);
const enc = new TextEncoder();

export function stitchConfig(env) {
  const live = Boolean(env.HERMES_STITCH_URL && env.HERMES_STITCH_SECRET);
  return { enabled: Boolean(env.DB && env.PACKS), mode: live ? "hermes" : "mock", perMonth: 1, maxCount: 5 };
}
function secretOf(env) { return env.HERMES_STITCH_SECRET || (env.NEBU_SESSION_SECRET ? `mock:${env.NEBU_SESSION_SECRET}` : ""); }

export async function signBody(secret, raw) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(raw)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Constant-time: compare HMACs of both values (equal length, no early exit on content).
async function safeEq(a, b) {
  const k = await crypto.subtle.importKey("raw", crypto.getRandomValues(new Uint8Array(32)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const [x, y] = await Promise.all([a, b].map((v) => crypto.subtle.sign("HMAC", k, enc.encode(String(v || "").toLowerCase()))));
  const u = new Uint8Array(x), w = new Uint8Array(y); let d = 0; for (let i = 0; i < u.length; i++) d |= u[i] ^ w[i]; return d === 0;
}
export async function verifySig(secret, raw, sig) {
  if (!secret || !sig || !/^[0-9a-fA-F]{64}$/.test(String(sig).replace(/^sha256=/, ""))) return false;
  return safeEq(await signBody(secret, raw), String(sig).replace(/^sha256=/, ""));
}

export async function listStitch(env, user) {
  const rows = await env.DB.prepare(`SELECT job_id, month, kind, count, prompt, status, mode, pack, screens, error, round, rounds, brief_mode, nice_touch, created, updated FROM stitch_jobs WHERE owner = ?1 ORDER BY created DESC LIMIT 12`).bind(user.id).all();
  const slot = await env.DB.prepare(`SELECT job_id FROM stitch_quota WHERE owner = ?1 AND month = ?2`).bind(user.id, month()).first();
  return { month: month(), available: !slot, mode: stitchConfig(env).mode, jobs: rows.results };
}

// POST /stitch {prompt, kind, count}
export async function dispatchStitch(env, ctx, user, body, origin) {
  const prompt = String(body.prompt || "").replace(/[\u0000-\u0008\u000b-\u001f]/g, " ").trim().slice(0, 1500);
  const kind = body.kind === "set" ? "set" : "element";
  // Vague idea -> Hermes has a reasoning model write the brief first; a user-written brief goes straight to Stitch.
  const brief_mode = body.brief_mode === "provided" ? "provided" : "auto";
  const count = kind === "element" ? 1 : Math.max(2, Math.min(5, Number(body.count) || 3));
  if (prompt.length < 10) return { status: 400, body: { error: "prompt_too_short", friendly: "Tell me a bit more: at least a sentence." } };
  const m = month(), job_id = "sj_" + randomId(12), now = Date.now(), cfg = stitchConfig(env);
  // Reserve the monthly slot atomically (PK on owner+month).
  const res = await env.DB.prepare(`INSERT OR IGNORE INTO stitch_quota (owner, month, job_id) VALUES (?1, ?2, ?3)`).bind(user.id, m, job_id).run();
  if (!res.meta || !res.meta.changes) return { status: 409, body: { error: "monthly_used", friendly: "You've used this month's design. It resets on the 1st." } };
  await env.DB.prepare(`INSERT INTO stitch_jobs (job_id, owner, month, kind, count, prompt, status, mode, created, updated, round, rounds, brief_mode) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', ?7, ?8, ?8, 0, ?9, ?10)`).bind(job_id, user.id, m, kind, count, prompt, cfg.mode, now, ROUNDS, brief_mode).run();
  const payload = JSON.stringify({ job_id, frisky_id: user.id, prompt, kind, count, callback_url: `${origin}/api/stitch/callback`, brief_mode, rounds: ROUNDS, nice_touch: true });
  if (cfg.mode === "hermes") {
    let ok = false, err = "dispatch_failed";
    try {
      const r = await fetch(`${String(env.HERMES_STITCH_URL).replace(/\/+$/, "")}/stitch/jobs`, { method: "POST", headers: { "Content-Type": "application/json", "X-Nebu-Signature": await signBody(env.HERMES_STITCH_SECRET, payload) }, body: payload, signal: AbortSignal.timeout(10000) });
      ok = r.status === 202; if (!ok) err = `hermes_http_${r.status}`;
    } catch (e) { err = "hermes_unreachable"; }
    if (!ok) { await finishFailed(env, job_id, err); return { status: 502, body: { error: err, friendly: "Code Pup Design didn't pick this up. Your monthly design wasn't used, try again later." } }; }
  } else {
    ctx.waitUntil(mockHermes(env, JSON.parse(payload)));
  }
  return { status: 202, body: { job_id, status: "queued", mode: cfg.mode } };
}

async function finishFailed(env, job_id, error) {
  const j = await env.DB.prepare(`SELECT owner, month FROM stitch_jobs WHERE job_id = ?1`).bind(job_id).first();
  const r = await env.DB.prepare(`UPDATE stitch_jobs SET status = 'failed', error = ?2, updated = ?3 WHERE job_id = ?1 AND status NOT IN ('ready','failed')`).bind(job_id, String(error || "failed").slice(0, 300), Date.now()).run();
  if (j && r.meta && r.meta.changes) await env.DB.prepare(`DELETE FROM stitch_quota WHERE owner = ?1 AND month = ?2 AND job_id = ?3`).bind(j.owner, j.month, job_id).run(); // refund
  return Boolean(r.meta && r.meta.changes);
}

// POST /api/stitch/callback (raw body, X-Nebu-Signature)
export async function stitchCallback(env, req) {
  const raw = await req.text();
  if (raw.length > 4 * 1024 * 1024) return { status: 413, body: { error: "too_big" } };
  if (!(await verifySig(secretOf(env), raw, req.headers.get("X-Nebu-Signature")))) return { status: 401, body: { error: "bad_signature" } };
  let m; try { m = JSON.parse(raw); } catch { return { status: 400, body: { error: "bad_json" } }; }
  return applyCallback(env, m);
}

export async function applyCallback(env, m) {
  const job = m && typeof m.job_id === "string" ? await env.DB.prepare(`SELECT * FROM stitch_jobs WHERE job_id = ?1`).bind(m.job_id).first() : null;
  if (!job) return { status: 404, body: { error: "unknown_job" } };
  if (TERMINAL.has(job.status)) return { status: 200, body: { ok: true, already: job.status } }; // idempotent
  if (m.status === "designing") {
    const round = Math.max(1, Math.min(job.rounds || ROUNDS, Number(m.round) || 1));
    // Rounds only move forward (a late round-1 callback can't undo round 2).
    await env.DB.prepare(`UPDATE stitch_jobs SET status = 'designing', round = MAX(COALESCE(round, 0), ?3), updated = ?2 WHERE job_id = ?1 AND status IN ('queued','designing')`).bind(job.job_id, Date.now(), round).run();
    return { status: 200, body: { ok: true } };
  }
  if (m.status === "failed") { await finishFailed(env, job.job_id, m.error || "failed"); return { status: 200, body: { ok: true, refunded: true } }; }
  if (m.status !== "ready") return { status: 400, body: { error: "bad_status" } };
  const screens = (Array.isArray(m.screens) ? m.screens : []).slice(0, job.count);
  if (!screens.length) { await finishFailed(env, job.job_id, "no_screens"); return { status: 200, body: { ok: true, refunded: true } }; }
  // Claim the job so a duplicate 'ready' can't double-save.
  const claim = await env.DB.prepare(`UPDATE stitch_jobs SET status = 'saving', updated = ?2 WHERE job_id = ?1 AND status IN ('queued','designing')`).bind(job.job_id, Date.now()).run();
  if (!claim.meta || !claim.meta.changes) return { status: 200, body: { ok: true, already: "saving" } };
  try {
    const items = [];
    for (let i = 0; i < screens.length; i++) {
      const s = screens[i] || {}, base = `packs/stitch/${job.owner}/${job.job_id}/${i + 1}`;
      const shot = await grab(s.screenshotUrl);  // download now: Hermes/Stitch URLs can expire
      const ext = shot.type.includes("svg") ? "svg" : shot.type.includes("webp") ? "webp" : shot.type.includes("jpeg") ? "jpg" : "png";
      await env.PACKS.put(`${base}.${ext}`, shot.buf, { httpMetadata: { contentType: shot.type } });
      const html = String(s.htmlCode || "").slice(0, MAX_HTML);
      if (html) await env.PACKS.put(`${base}.html`, html, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
      items.push({ id: `stitch-${i + 1}`, type: "design", src: `r2:${base}.${ext}`, source: html ? `r2:${base}.html` : null, editable: Boolean(html), visible: true, locked: false, opacity: 1, blend: "normal" });
    }
    const name = `Monthly design · ${job.month}`;
    const niceTouch = typeof m.nice_touch === "string" ? m.nice_touch.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 160) || null : null;
    const pack = await createPackFor(env, job.owner, name, "mixed", { version: 1, kind: "stitch", job: job.job_id, prompt: job.prompt, rounds: job.rounds || ROUNDS, niceTouch, layers: items }, `stitch:${job.job_id}`);
    await env.DB.prepare(`UPDATE stitch_jobs SET status = 'ready', pack = ?2, screens = ?3, round = ?5, nice_touch = ?6, updated = ?4 WHERE job_id = ?1`).bind(job.job_id, pack, items.length, Date.now(), job.rounds || ROUNDS, niceTouch).run();
    return { status: 200, body: { ok: true, pack } };
  } catch (e) {
    await env.DB.prepare(`UPDATE stitch_jobs SET status = 'designing', updated = ?2 WHERE job_id = ?1 AND status = 'saving'`).bind(job.job_id, Date.now()).run();
    await finishFailed(env, job.job_id, `save_failed: ${String(e.message || e).slice(0, 120)}`);
    return { status: 200, body: { ok: true, refunded: true } };
  }
}

async function grab(url) {
  if (typeof url !== "string" || !/^https:\/\//.test(url)) throw new Error("bad_screenshot_url");
  const r = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: "follow" });
  if (!r.ok) throw new Error(`screenshot_http_${r.status}`);
  const type = (r.headers.get("content-type") || "").split(";")[0].trim();
  if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(type)) throw new Error("screenshot_not_image");
  const buf = await r.arrayBuffer(); if (buf.byteLength > MAX_SHOT) throw new Error("screenshot_too_big");
  return { buf, type };
}

// ---- Mock dispatcher: same contract, signed callbacks, sample screens ----
const MOCK_TOUCHES = ["A soft yellow glint sweeps across the edge on entry", "The NEBU star hides in the corner and twinkles once", "Matching dark and light variants, same layers", "A subtle grain so it sits nicely on camera"];
const SAMPLES = ["lower-third", "sticker", "frame", "overlay", "badge"];
async function mockHermes(env, job) {
  const base = String(env.STITCH_SAMPLE_BASE || "https://feat-studio-v2.nebu-quest.pages.dev/studio/stitch-samples/").replace(/\/?$/, "/");
  const send = async (msg) => { const raw = JSON.stringify(msg); const req = new Request("https://mock/api/stitch/callback", { method: "POST", body: raw, headers: { "X-Nebu-Signature": await signBody(secretOf(env), raw) } }); return stitchCallback(env, req); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Mirrors the real pipeline: (brief if auto) -> Stitch round 1 -> vision review -> round 2 -> review -> round 3.
  for (let r = 1; r <= (job.rounds || ROUNDS); r++) { await wait(r === 1 ? 1500 : 2200); await send({ job_id: job.job_id, status: "designing", round: r, screens: [] }); }
  await wait(2200);
  if (/\bfail\b/i.test(job.prompt)) return send({ job_id: job.job_id, status: "failed", screens: [], error: "mock_failure_requested" });
  const screens = Array.from({ length: job.count }, (_, i) => { const s = SAMPLES[i % SAMPLES.length]; return { screenshotUrl: `${base}${s}.svg`, htmlCode: sampleHtml(s, job.prompt) }; });
  await send({ job_id: job.job_id, status: "ready", round: job.rounds || ROUNDS, screens, nice_touch: MOCK_TOUCHES[job.job_id.charCodeAt(3) % MOCK_TOUCHES.length] });
}
function sampleHtml(kind, prompt) {
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  return `<!-- NEBU mock Stitch screen: ${kind} -->\n<div class="nebu-${kind}" style="font-family:Inter,system-ui;background:#0b0b10;color:#f5f1e6;padding:24px;border-radius:18px">\n  <span style="color:#ffd400;font-weight:800;letter-spacing:.08em">FR!SKY</span>\n  <p>${esc(prompt.slice(0, 120))}</p>\n</div>`;
}
