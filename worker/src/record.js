// What survives the night. LiveHub keeps the room; InsForge keeps the record.
// Secrets (wrangler secret put, never in git): INSFORGE_URL, INSFORGE_ADMIN_KEY.
// URL is https://3ccekxua.us-east.insforge.app — no trailing path.

const TABLES = [
  `CREATE TABLE IF NOT EXISTS shows (
    sid text PRIMARY KEY,
    host_id text,
    status text NOT NULL,
    created timestamptz,
    ended timestamptz
  )`,
  `CREATE TABLE IF NOT EXISTS stamps (
    id text PRIMARY KEY,
    sid text NOT NULL,
    line text NOT NULL,
    stamped_by text,
    stamped_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS telegram_links (
    tg_id text PRIMARY KEY,
    host_id text NOT NULL,
    linked_at timestamptz NOT NULL DEFAULT now()
  )`,
];

let ready = false;

function configured(env) {
  return Boolean(env.INSFORGE_URL && env.INSFORGE_ADMIN_KEY);
}

async function sql(env, query, params) {
  const root = String(env.INSFORGE_URL).replace(/\/$/, "");
  const res = await fetch(`${root}/api/database/advance/rawsql`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.INSFORGE_ADMIN_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, params: params || [] }),
  });
  if (!res.ok) throw new Error(`insforge ${res.status}`);
  return res.json().catch(() => ({}));
}

async function ensure(env) {
  if (ready || !configured(env)) return;
  for (const query of TABLES) await sql(env, query, []);
  ready = true;
}

export async function recordShow(env, row) {
  if (!configured(env) || !row || !row.sid) return;
  try {
    await ensure(env);
    await sql(
      env,
      `INSERT INTO shows (sid, host_id, status, created, ended)
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), to_timestamp($5 / 1000.0))
       ON CONFLICT (sid) DO UPDATE SET status = EXCLUDED.status, host_id = EXCLUDED.host_id, ended = EXCLUDED.ended`,
      [row.sid, row.host_id || null, row.status, Number(row.created) || Date.now(), Number(row.ended) || Date.now()],
    );
  } catch (err) {
    console.log("record show", err instanceof Error ? err.message : err);
  }
}

export async function recordStamp(env, row) {
  if (!configured(env) || !row || !row.sid || !row.line) return;
  try {
    await ensure(env);
    await sql(
      env,
      `INSERT INTO stamps (id, sid, line, stamped_by) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [row.id, row.sid, row.line, row.stamped_by || null],
    );
  } catch (err) {
    console.log("record stamp", err instanceof Error ? err.message : err);
  }
}

export async function linkTelegram(env, tgId, hostId) {
  if (!configured(env) || !tgId || !hostId) return;
  try {
    await ensure(env);
    await sql(
      env,
      `INSERT INTO telegram_links (tg_id, host_id) VALUES ($1, $2)
       ON CONFLICT (tg_id) DO UPDATE SET host_id = EXCLUDED.host_id, linked_at = now()`,
      [String(tgId), String(hostId)],
    );
  } catch (err) {
    console.log("record telegram", err instanceof Error ? err.message : err);
  }
}
