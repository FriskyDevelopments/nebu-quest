// xAI allowance path. fetch is replaced in-process; these tests must not call api.x.ai.
import assert from "node:assert/strict";
import test from "node:test";
import { assist, saveUserKey } from "../src/ai.js";

const PLATFORM_KEY = "unit-test-platform-key-0001";
const BYOK_KEY = "unit-test-byok-key-000002";
const OWNER = "owner_unit";
const XAI_URL = "https://api.x.ai/v1/chat/completions";

globalThis.fetch = async () => {
  throw new Error("network disabled in unit tests");
};

function assertSecretAbsent(secret, parts) {
  for (const [name, value] of Object.entries(parts)) {
    if (value != null && String(value).includes(secret)) assert.fail(`${name} contained the secret value`);
  }
}

function createDb() {
  const state = {
    keys: null,
    sub: { plan: "all_in", status: "active", period_end: Date.now() + 86_400_000 },
    usageUnits: null,
    credits: null,
    logs: [],
  };
  return {
    state,
    prepare(sql) {
      let args = [];
      const api = {
        bind(...bound) {
          args = bound;
          return api;
        },
        async first() {
          if (sql.includes("FROM subscriptions")) return state.sub;
          if (sql.includes("provider, sealed")) return state.keys;
          if (sql.includes("FROM ai_keys")) return state.keys ? { provider: state.keys.provider } : null;
          if (sql.includes("FROM ai_usage")) return state.usageUnits == null ? null : { units: state.usageUnits };
          if (sql.includes("FROM ai_credits")) return state.credits;
          throw new Error(`unexpected first(): ${sql}`);
        },
        async all() {
          if (sql.includes("FROM addons")) return { results: [] };
          if (sql.includes("FROM ai_log")) return { results: state.logs };
          throw new Error(`unexpected all(): ${sql}`);
        },
        async run() {
          if (sql.includes("INSERT INTO ai_keys")) {
            state.keys = { provider: args[1], sealed: args[2] };
            return { meta: { changes: 1 } };
          }
          if (sql.includes("INSERT INTO ai_usage")) {
            state.usageUnits = (state.usageUnits || 0) + args[2];
            return { meta: { changes: 1 } };
          }
          if (sql.includes("INSERT INTO ai_log")) {
            state.logs.push({ via: args[4], provider: args[5], tokens_in: args[6], tokens_out: args[7] });
            return { meta: { changes: 1 } };
          }
          if (sql.includes("UPDATE ai_credits")) return { meta: { changes: 1 } };
          throw new Error(`unexpected run(): ${sql}`);
        },
      };
      return api;
    },
  };
}

function recordedCall(url, init) {
  const headers = new Headers(init?.headers || {});
  return {
    url: String(url),
    method: init?.method,
    body: init?.body == null ? "" : String(init.body),
    auth: headers.get("authorization"),
    signal: init?.signal,
  };
}

async function withCapture(fn) {
  const logs = [];
  const calls = [];
  const prev = {
    fetch: globalThis.fetch,
    timeout: AbortSignal.timeout,
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  for (const method of ["log", "info", "warn", "error", "debug"]) {
    console[method] = (...args) => logs.push(args);
  }
  let fetchImpl = async () => {
    throw new Error("unexpected fetch");
  };
  globalThis.fetch = async (url, init) => {
    const call = recordedCall(url, init);
    calls.push(call);
    return fetchImpl(url, init, call);
  };
  try {
    return await fn({
      calls,
      logs,
      onFetch(impl) {
        fetchImpl = impl;
      },
    });
  } finally {
    globalThis.fetch = prev.fetch;
    AbortSignal.timeout = prev.timeout;
    console.log = prev.log;
    console.info = prev.info;
    console.warn = prev.warn;
    console.error = prev.error;
    console.debug = prev.debug;
  }
}

function envFor(db, extra) {
  return { DB: db, TENANT_KEY: "unit-test-tenant-key", ...extra };
}

function chatResponse(text) {
  return new Response(JSON.stringify({
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function dumped(db, logs, result) {
  return {
    result: JSON.stringify(result),
    logs: JSON.stringify(logs),
    stored: JSON.stringify({ logs: db.state.logs, usage: db.state.usageUnits, credits: db.state.credits }),
  };
}

test("AI_ALLOWANCE_PROVIDER=xai selects xAI and does not call Workers AI", async () => {
  const db = createDb();
  let workersRan = false;
  await withCapture(async ({ calls, onFetch }) => {
    onFetch(async () => chatResponse("from xai"));
    const result = await assist(envFor(db, {
      AI_ALLOWANCE_PROVIDER: "xai",
      XAI_API_KEY: PLATFORM_KEY,
      AI: { async run() { workersRan = true; throw new Error("workers_ai_should_not_run"); } },
    }), OWNER, "ticker", "saturday market");
    assert.equal(workersRan, false);
    assert.equal(result.status, 200);
    assert.equal(result.body.via, "allowance");
    assert.equal(result.body.text, "from xai");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, XAI_URL);
    assert.equal(db.state.logs[0].provider, "xai");
  });
});

test("an allowance provider other than xai does not call xAI", async () => {
  const db = createDb();
  await withCapture(async ({ calls, onFetch }) => {
    onFetch(async () => {
      throw new Error("xAI must not be called");
    });
    const result = await assist(envFor(db, {
      XAI_API_KEY: PLATFORM_KEY,
      AI: { async run() { return { response: "from workers", usage: { prompt_tokens: 2, completion_tokens: 3 } }; } },
    }), OWNER, "brief", "plain stickers");
    assert.equal(calls.length, 0);
    assert.equal(result.status, 200);
    assert.equal(result.body.text, "from workers");
    assert.equal(db.state.logs[0].provider, "workers-ai");
  });
});

test("missing XAI_API_KEY does not call xAI and reports ai_not_configured when Workers AI is absent", async () => {
  const db = createDb();
  await withCapture(async ({ calls, logs }) => {
    const result = await assist(envFor(db, { AI_ALLOWANCE_PROVIDER: "xai" }), OWNER, "ticker", "no key");
    assert.equal(calls.length, 0);
    assert.equal(result.status, 503);
    assert.equal(result.body.error, "ai_not_configured");
    assertSecretAbsent(PLATFORM_KEY, dumped(db, logs, result));
  });
});

test("missing XAI_API_KEY keeps the Workers AI fallback and still does not call xAI", async () => {
  const db = createDb();
  await withCapture(async ({ calls, onFetch }) => {
    onFetch(async () => {
      throw new Error("xAI must not be called without XAI_API_KEY");
    });
    const result = await assist(envFor(db, {
      AI_ALLOWANCE_PROVIDER: "xai",
      AI: { async run() { return { response: "fallback", usage: { prompt_tokens: 1, completion_tokens: 1 } }; } },
    }), OWNER, "ticker", "fallback");
    assert.equal(calls.length, 0);
    assert.equal(result.status, 200);
    assert.equal(result.body.text, "fallback");
    assert.equal(db.state.logs[0].provider, "workers-ai");
  });
});

test("a saved BYOK key is sent instead of XAI_API_KEY", async () => {
  const db = createDb();
  const env = envFor(db, { AI_ALLOWANCE_PROVIDER: "xai", XAI_API_KEY: PLATFORM_KEY });
  assert.equal(await saveUserKey(env, OWNER, "xai", BYOK_KEY), true);
  await withCapture(async ({ calls, logs, onFetch }) => {
    onFetch(async () => chatResponse("from byok"));
    const result = await assist(env, OWNER, "lower-third", "host");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, XAI_URL);
    assert.equal(calls[0].auth, `Bearer ${BYOK_KEY}`);
    assert.notEqual(calls[0].auth, `Bearer ${PLATFORM_KEY}`);
    assert.equal(result.status, 200);
    assert.equal(result.body.via, "your key");
    assert.equal(result.body.text, "from byok");
    assert.equal(JSON.parse(calls[0].body).model, "grok-3-mini");
    assertSecretAbsent(PLATFORM_KEY, { ...dumped(db, logs, result), body: calls[0].body });
    assertSecretAbsent(BYOK_KEY, dumped(db, logs, result));
  });
});

test("a failed BYOK key does not fall through to XAI_API_KEY", async () => {
  const db = createDb();
  const env = envFor(db, { AI_ALLOWANCE_PROVIDER: "xai", XAI_API_KEY: PLATFORM_KEY });
  assert.equal(await saveUserKey(env, OWNER, "xai", BYOK_KEY), true);
  await withCapture(async ({ calls, logs, onFetch }) => {
    onFetch(async () => new Response("no", { status: 401 }));
    const result = await assist(env, OWNER, "ticker", "byok fails");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].auth, `Bearer ${BYOK_KEY}`);
    assert.equal(result.status, 502);
    assert.equal(result.body.error, "your_key_failed");
    assertSecretAbsent(PLATFORM_KEY, dumped(db, logs, result));
    assertSecretAbsent(BYOK_KEY, { ...dumped(db, logs, result), body: calls[0].body });
  });
});

test("xAI request uses grok-3-mini, the direct base URL, and an Authorization header that is not logged", async () => {
  const db = createDb();
  await withCapture(async ({ calls, logs, onFetch }) => {
    onFetch(async () => chatResponse("shaped"));
    const result = await assist(envFor(db, {
      AI_ALLOWANCE_PROVIDER: "xai",
      XAI_API_KEY: PLATFORM_KEY,
    }), OWNER, "ticker", "shape");
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.method, "POST");
    assert.equal(call.url, XAI_URL);
    assert.equal(new URL(call.url).origin, "https://api.x.ai");
    const payload = JSON.parse(call.body);
    assert.equal(payload.model, "grok-3-mini");
    assert.ok(call.auth);
    assert.equal(call.auth.startsWith("Bearer "), true);
    assert.equal(call.auth.slice("Bearer ".length).length > 0, true);
    assert.equal(call.auth, `Bearer ${PLATFORM_KEY}`);
    assert.equal(call.body.includes(PLATFORM_KEY), false);
    assertSecretAbsent(PLATFORM_KEY, dumped(db, logs, result));
    assert.equal(result.status, 200);
  });
});

test("an xAI HTTP error is returned without the key or the upstream body", async () => {
  const db = createDb();
  await withCapture(async ({ calls, logs, onFetch }) => {
    onFetch(async () => new Response(JSON.stringify({ error: PLATFORM_KEY, detail: "unauthorized" }), { status: 401 }));
    const result = await assist(envFor(db, {
      AI_ALLOWANCE_PROVIDER: "xai",
      XAI_API_KEY: PLATFORM_KEY,
    }), OWNER, "ticker", "denied");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].auth, `Bearer ${PLATFORM_KEY}`);
    assert.equal(result.status, 502);
    assert.equal(result.body.error, "provider_failed");
    assert.equal(result.body.friendly, undefined);
    assertSecretAbsent(PLATFORM_KEY, dumped(db, logs, result));
  });
});

test("a provider timeout rejection is an error response and does not include the key", async () => {
  const db = createDb();
  await withCapture(async ({ logs, onFetch }) => {
    onFetch(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const result = await assist(envFor(db, {
      AI_ALLOWANCE_PROVIDER: "xai",
      XAI_API_KEY: PLATFORM_KEY,
    }), OWNER, "ticker", "stall");
    assert.equal(result.status, 502);
    assert.match(result.body.error, /timeout/i);
    assertSecretAbsent(PLATFORM_KEY, dumped(db, logs, result));
  });
});

test("the xAI fetch is armed with a timeout signal and an abort does not leak the key", async () => {
  const db = createDb();
  await withCapture(async ({ calls, logs, onFetch }) => {
    let armed = 0;
    AbortSignal.timeout = (ms) => {
      armed = ms;
      const controller = new AbortController();
      controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
      return controller.signal;
    };
    onFetch(async (_url, init) => {
      if (init?.signal?.aborted) throw init.signal.reason;
      throw new Error("xAI fetch was not given an aborted timeout signal");
    });
    const result = await assist(envFor(db, {
      AI_ALLOWANCE_PROVIDER: "xai",
      XAI_API_KEY: PLATFORM_KEY,
    }), OWNER, "ticker", "deadline");
    assert.equal(typeof armed, "number");
    assert.equal(armed >= 1000 && armed <= 60_000, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].signal?.aborted, true);
    assert.equal(result.status, 502);
    assert.match(result.body.error, /timeout/i);
    assertSecretAbsent(PLATFORM_KEY, dumped(db, logs, result));
  });
});
