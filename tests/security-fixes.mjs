// Allowlist for ?signal= and pack-manifest R2 signing.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { keyAllowed, manifestRefsAllowed, resolveManifest } from "../worker/src/packs.js";
import { verify } from "../worker/src/auth.js";

const context = { URL, URLSearchParams };
vm.createContext(context);
vm.runInContext(readFileSync(new URL("../brand/nebu-signal.js", import.meta.url), "utf8"), context);
const nebuSignalBase = context.nebuSignalBase;

const metas = {
  prod: "https://nebu-rooms.hrgrrtks2p.workers.dev",
  preview: "https://nebu-rooms-preview.hrgrrtks2p.workers.dev",
};
const base = (hostname, search) => nebuSignalBase({ search, hostname, metas });
let failed = 0;
const check = (name, cond) => {
  if (!cond) { failed++; console.error("FAIL", name); }
  else console.log("PASS", name);
};

const PROD = "https://nebu-rooms.hrgrrtks2p.workers.dev";
const PREVIEW = "https://nebu-rooms-preview.hrgrrtks2p.workers.dev";

check("prod host ignores signal", base("nebu.quest", "?signal=https://attacker.example") === PROD);
check("prod pages ignores signal", base("nebu-quest.pages.dev", "?signal=https://attacker.example") === PROD);
check("preview host uses preview worker", base("feat-studio-v2.nebu-quest.pages.dev", "") === PREVIEW);
check("preview host rejects attacker signal", base("feat-studio-v2.nebu-quest.pages.dev", "?signal=https://attacker.example") === PREVIEW);
check("preview host rejects lookalike host", base("feat-studio-v2.nebu-quest.pages.dev", "?signal=https://nebu-rooms-preview.hrgrrtks2p.workers.dev.attacker.example") === PREVIEW);
check("preview host rejects userinfo", base("feat-studio-v2.nebu-quest.pages.dev", "?signal=https://user:pass@nebu-rooms-preview.hrgrrtks2p.workers.dev") === PREVIEW);
check("preview host rejects path", base("feat-studio-v2.nebu-quest.pages.dev", "?signal=https://nebu-rooms-preview.hrgrrtks2p.workers.dev/steal") === PREVIEW);
check("preview host rejects loopback", base("feat-studio-v2.nebu-quest.pages.dev", "?signal=http://127.0.0.1:8787") === PREVIEW);
check("preview host allows its own worker", base("feat-studio-v2.nebu-quest.pages.dev", `?signal=${PREVIEW}/`) === PREVIEW);
check("localhost allows loopback worker", base("localhost", "?signal=http://127.0.0.1:8787") === "http://127.0.0.1:8787");
check("localhost rejects remote signal", base("127.0.0.1", "?signal=https://attacker.example") === PREVIEW);

const pack = { id: "p_abc", owner: "fd_user", source: "studio" };
const own = "packs/fd_user/p_abc/abcd1234-file.png";
const foreign = "packs/fd_victim/p_v/secret.png";
check("own upload key", keyAllowed(own, pack));
check("foreign owner rejected", !keyAllowed(foreign, pack));
check("other pack of same owner rejected", !keyAllowed("packs/fd_user/p_other/abcd1234-file.png", pack));
check("dotdot rejected", !keyAllowed("packs/fd_user/p_abc/../../fd_victim/p_v/secret.png", pack));
check("telegram cache allowed", keyAllowed("packs/tg-cache/HotCherry/AgADBAAD.webp", pack));
check("telegram traversal rejected", !keyAllowed("packs/tg-cache/HotCherry/../../fd_victim/p_v/secret.png", pack));
check("official allowed", keyAllowed("packs/official/p_brand/mark.svg", pack));

const stitch = { id: "p_s", owner: "fd_user", source: "stitch:sj_job1" };
check("own stitch key", keyAllowed("packs/stitch/fd_user/sj_job1/1.png", stitch));
check("own stitch html", keyAllowed("packs/stitch/fd_user/sj_job1/2.html", stitch));
check("other stitch job rejected", !keyAllowed("packs/stitch/fd_user/sj_job2/1.png", stitch));
check("victim stitch rejected", !keyAllowed("packs/stitch/fd_victim/sj_job1/1.png", stitch));
check("studio pack cannot sign stitch", !keyAllowed("packs/stitch/fd_user/sj_job1/1.png", pack));

const manifest = JSON.stringify({ items: [{ src: `r2:${foreign}` }, { src: `r2:${own}` }] });
check("write rejects foreign ref", !manifestRefsAllowed(manifest, pack));
check("write accepts own ref", manifestRefsAllowed(JSON.stringify({ items: [{ src: `r2:${own}` }] }), pack));

const env = { NEBU_SESSION_SECRET: "test-secret" };
const out = await resolveManifest(env, "https://worker.example", JSON.parse(manifest), pack);
const dumped = JSON.stringify(out);
check("foreign key not signed", out.items[0].src === "" && !dumped.includes("fd_victim") && !dumped.includes("secret.png"));
check("own key signed", out.items[1].src.startsWith("https://worker.example/f/packs/fd_user/p_abc/abcd1234-file.png?t="));
const token = new URL(out.items[1].src).searchParams.get("t");
const payload = await verify(env.NEBU_SESSION_SECRET, token, "file");
check("signed token binds own key", payload && payload.k === own);
const bare = await resolveManifest(env, "https://worker.example", { items: [{ src: `r2:${foreign}` }] });
check("missing pack signs nothing", bare.items[0].src === "" && !JSON.stringify(bare).includes("fd_victim"));

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log("all security checks passed");
