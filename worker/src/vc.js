// VC node surface for the studio. These helpers only describe observed results.
// A mock stream key is never treated as a publishable secret, and a video chat
// is "joined" only when the runtime reports both joined and active.

export function vcFlags(env) {
  const e = env || {};
  return {
    tenantUserbot: true,
    discord: true,
    videoChatJoin: false,
    rtmpOut: true,
    ownNumbers: true,
    assistant: e.ASSISTANT_TRIAL_ENABLED === "true",
    credits: true,
    drive: Boolean(e.GOOGLE_CLIENT_ID),
    spotify: Boolean(e.SPOTIFY_CLIENT_ID),
    virtualCam: false,
    extension: true,
    paperclip: true,
    open: e.VC_NODE_OPEN === "true",
    modes: {
      telegramUser: e.TG_USER_MODE || "mock",
      discord: e.DISCORD_MODE || "live",
      numbers: e.NUMBERS_MODE || "mock",
      numbersBuy: e.NUMBERS_BUY_ENABLED === "true",
    },
  };
}

const FAKE_KEY = /mock|not-real|fake|example|changeme/i;

export function describeGoLive(result) {
  if (!result || typeof result !== "object") {
    return { status: 502, body: { ok: false, joined: false, error: "rtmp_unavailable", friendly: "Telegram did not return a stream." } };
  }
  if (result.error) {
    return { status: 400, body: { ok: false, joined: false, error: String(result.error).slice(0, 80), friendly: result.friendly || "" } };
  }
  if (result.mocked) {
    return { status: 200, body: { ok: false, joined: false, mocked: true, mode: "mock", friendly: "Test mode does not open a real Telegram stream." } };
  }
  const rtmpUrl = String(result.rtmpUrl || "");
  const streamKey = String(result.streamKey || "");
  if (!/^rtmps?:\/\//i.test(rtmpUrl) || streamKey.length < 8 || FAKE_KEY.test(streamKey) || FAKE_KEY.test(rtmpUrl)) {
    return { status: 502, body: { ok: false, joined: false, error: "rtmp_unavailable", friendly: "Telegram did not return a real stream." } };
  }
  return { status: 200, body: { ok: true, reveal: true, rtmpUrl, streamKey } };
}

export function describeVideoChat(result) {
  const mode = (result && result.mode) || "unavailable";
  const confirmed = Boolean(result && result.joined === true && result.active === true && mode !== "mock" && mode !== "unavailable");
  return {
    ok: Boolean(result && result.ok),
    joined: confirmed,
    active: confirmed,
    mode,
    friendly: (result && result.friendly) || (confirmed ? "In the video chat." : "Not in a video chat."),
    participants: confirmed && Array.isArray(result.participants) ? result.participants.slice(0, 32) : [],
  };
}
