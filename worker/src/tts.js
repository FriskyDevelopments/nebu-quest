// Spoken announcements. Provider interface: speak(env, { text, lang, voice }) -> { mime, bytes }.
// Default: Workers AI @cf/myshell-ai/melotts (Cloudflare-hosted, $0.000205 per audio minute).
// Designed, not enabled: BYOK ElevenLabs, xAI grok-tts (via AI Gateway), self-hosted Kokoro-82M (Apache-2.0).
const PROVIDERS = {
  "workers-ai": {
    async speak(env, { text, lang }) {
      if (!env.AI) throw Object.assign(new Error("ai_not_bound"), { status: 503 });
      const r = await env.AI.run("@cf/myshell-ai/melotts", { prompt: text, lang: lang === "es" ? "es" : "en" });
      const b64 = r && (r.audio || (r.result && r.result.audio));
      if (!b64) throw Object.assign(new Error("tts_empty"), { status: 502 });
      return { mime: "audio/mpeg", bytes: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) };
    },
  },
  mock: { async speak() { return { mime: "audio/mpeg", bytes: new Uint8Array(0), mock: true }; } },
};
export function ttsConfig(env) { return { enabled: env.TTS_ENABLED === "true", provider: env.TTS_PROVIDER || "workers-ai", anon: env.TTS_ANON === "true", maxChars: 240 }; }
export async function speak(env, body) {
  const text = String((body && body.text) || "").replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, 240);
  if (text.length < 2) return { status: 400, body: { error: "text_required" } };
  const p = PROVIDERS[env.TTS_PROVIDER || "workers-ai"] || PROVIDERS["workers-ai"];
  try { const out = await p.speak(env, { text, lang: body.lang }); return { status: 200, audio: out }; }
  catch (e) { return { status: e.status || 502, body: { error: e.message || "tts_failed" } }; }
}
