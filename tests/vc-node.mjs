// VC node: mock streams never reveal a key, and a video chat is joined only when confirmed.
import { describeGoLive, describeVideoChat, vcFlags } from "../worker/src/vc.js";
import { verifyDiscord } from "../worker/src/discord.js";

let failed = 0;
const check = (name, cond) => {
  if (!cond) { failed++; console.error("FAIL", name); }
  else console.log("PASS", name);
};

const mock = describeGoLive({ mocked: true, rtmpUrl: "rtmps://dc4-1.rtmp.t.me/s/", streamKey: "mock-key-not-real" });
check("mock go-live hides the key", mock.status === 200 && mock.body.mocked === true && !("streamKey" in mock.body) && !("rtmpUrl" in mock.body));
check("mock go-live is not joined", mock.body.joined === false && mock.body.ok === false);

const fake = describeGoLive({ rtmpUrl: "rtmp://example.invalid/s/", streamKey: "not-real-key-value" });
check("fake key is not revealed", fake.status === 502 && !fake.body.streamKey);

const real = describeGoLive({ rtmpUrl: "rtmps://dc4-1.rtmp.t.me/s/", streamKey: "abc123XYZ789real" });
check("real go-live reveals once", real.status === 200 && real.body.reveal === true && real.body.streamKey === "abc123XYZ789real");

const idle = describeVideoChat({ ok: false, joined: false, active: false, mode: "mock" });
check("mock video chat is not joined", idle.joined === false && idle.active === false);

const liar = describeVideoChat({ ok: true, joined: true, active: false, mode: "mtcute" });
check("joined without active is not joined", liar.joined === false);

const mockTrue = describeVideoChat({ ok: true, joined: true, active: true, mode: "mock" });
check("mock cannot confirm a join", mockTrue.joined === false && mockTrue.mode === "mock");

const live = describeVideoChat({ ok: true, joined: true, active: true, mode: "mtcute", participants: [{ id: "1" }] });
check("confirmed join passes through", live.joined === true && live.active === true && live.participants.length === 1);

const flags = vcFlags({ VC_NODE_OPEN: "true", SPOTIFY_CLIENT_ID: "abc", TG_USER_MODE: "mock" });
check("video chat join stays off", flags.videoChatJoin === false && flags.virtualCam === false);
check("wired surfaces are on", flags.tenantUserbot && flags.discord && flags.rtmpOut && flags.ownNumbers && flags.credits && flags.paperclip && flags.spotify && flags.open);
check("drive stays off without a client id", flags.drive === false);

const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
const pub = [...rawPub].map((b) => b.toString(16).padStart(2, "0")).join("");
const body = '{"type":1}';
const ts = "1700000000";
const sigBytes = new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, new TextEncoder().encode(ts + body)));
const sig = [...sigBytes].map((b) => b.toString(16).padStart(2, "0")).join("");
check("discord signature accepts a real request", await verifyDiscord(pub, sig, ts, body));
check("discord signature rejects a flipped body", !(await verifyDiscord(pub, sig, ts, body + " ")));

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log("all vc node checks passed");
