// End-to-end check of the NEBU studio with fake camera/mic/screen.
// BASE=http://127.0.0.1:8811 SIGNAL=http://127.0.0.1:8787 node tests/e2e.mjs
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8811';
const SIGNAL = process.env.SIGNAL || '';
const SHOTS = process.env.SHOTS || path.resolve('shots');
const CLIP = process.env.CLIP || '/workspace/audit/test-clip.webm';
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const ok = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); };
const errors = [];

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-accept-this-tab-capture', '--autoplay-policy=no-user-gesture-required', '--enable-usermedia-screen-capturing', '--auto-select-desktop-capture-source=Entire screen'],
});

async function ctx(opts) {
  const c = await browser.newContext({ permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'], acceptDownloads: true, ...opts });
  if (SIGNAL) {
    await c.route('**/studio/**', async (route) => {
      const url = route.request().url();
      if (!/\/studio\/(index\.html)?(\?.*)?$/.test(url)) return route.continue();
      const res = await route.fetch();
      const body = (await res.text()).replace(/(<meta name="nebu-signal" content=")[^"]*"/, `$1${SIGNAL}"`);
      route.fulfill({ response: res, body });
    });
  }
  return c;
}
function watch(page, tag) {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${tag} pageerror: ${e.message}`));
}
const canvasStats = (page, sel = '#program') => page.$eval(sel, (c) => {
  const x = document.createElement('canvas'); x.width = 64; x.height = 36; const g = x.getContext('2d'); g.drawImage(c, 0, 0, 64, 36);
  const d = g.getImageData(0, 0, 64, 36).data; let sum = 0, sq = 0; const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; sum += l; sq += l * l; }
  const mean = sum / n; return { mean: Math.round(mean), std: Math.round(Math.sqrt(sq / n - mean * mean)) };
});
const meter = (page, ch) => page.$eval(`.strip[data-ch="${ch}"]`, (s) => Number(getComputedStyle(s).getPropertyValue('--lvl') || 0));
async function maxMeter(page, ch, ms = 2500) { let m = 0; const end = Date.now() + ms; while (Date.now() < end) { m = Math.max(m, await meter(page, ch)); await page.waitForTimeout(100); } return m; }

// ---------- Host (desktop) ----------
const hostCtx = await ctx({ viewport: { width: 1440, height: 900 } });
const host = await hostCtx.newPage(); watch(host, 'host');
await host.goto(`${BASE}/studio/`, { waitUntil: 'networkidle' });
await host.screenshot({ path: `${SHOTS}/studio-gate-desktop.png` });
await host.click('#gate-go');
await host.waitForFunction(() => document.querySelector('#cam-toggle').getAttribute('aria-checked') === 'true', null, { timeout: 10000 });
await host.waitForTimeout(1200);
ok('camera starts via getUserMedia', true);
const camOpts = await host.$$eval('#cam-select option', (o) => o.map((x) => x.textContent));
ok('camera picker lists devices', camOpts.length > 0 && !/No camera/.test(camOpts[0]), camOpts.join(' | '));
const micOpts = await host.$$eval('#mic-select option', (o) => o.map((x) => x.textContent));
ok('mic picker lists devices', micOpts.length > 0 && !/No micro/.test(micOpts[0]), micOpts.join(' | '));
let st = await canvasStats(host);
ok('program canvas shows camera frames', st.std > 8, JSON.stringify(st));
const micLvl = await maxMeter(host, 'mic', 3000);
ok('mic meter moves', micLvl > 0.2, micLvl.toFixed(2));

// video file source
await host.setInputFiles('#video-file', CLIP);
await host.waitForFunction(() => document.querySelector('#video-state').textContent !== 'NONE', null, { timeout: 8000 });
await host.waitForTimeout(800);
const vidLvl = await maxMeter(host, 'video', 2000);
ok('video file plays into the mix', vidLvl > 0.2, vidLvl.toFixed(2));
ok('layout auto-switches to Screen + cam', (await host.$eval('.layout[aria-checked="true"]', (b) => b.dataset.layout)) === 'pip');

// fader + mute actually change level
await host.$eval('.strip[data-ch="video"] .tog-mute', (b) => b.click());
await host.waitForTimeout(700);
const muted = await maxMeter(host, 'video', 800);
ok('mute silences the channel', muted < 0.05, muted.toFixed(3));
await host.$eval('.strip[data-ch="video"] .tog-mute', (b) => b.click());

// screen share
await host.click('#screen-btn');
await host.waitForTimeout(1500);
const scr = await host.$eval('#screen-state', (e) => e.textContent);
ok('screen share starts (getDisplayMedia)', /LIVE/.test(scr), scr);

// lower third
await host.fill('#title-text', 'Frisky');
await host.fill('#title-sub', 'Setting the scene on NEBU');
await host.click('#title-toggle');

for (const l of ['cam', 'screen', 'pip', 'split']) {
  await host.click(`.layout[data-layout="${l}"]`);
  await host.waitForTimeout(400);
  st = await canvasStats(host);
  ok(`layout ${l} renders`, st.std > 8, JSON.stringify(st));
  await host.screenshot({ path: `${SHOTS}/studio-${l}-desktop.png` });
}

// recording
await host.click('.layout[data-layout="pip"]');
await host.click('#rec-btn');
await host.waitForTimeout(4200);
await host.click('#rec-btn');
await host.waitForSelector('.take a[download]', { timeout: 8000 });
const [dl] = await Promise.all([host.waitForEvent('download'), host.click('.take a[download]')]);
const takePath = path.join(SHOTS, await dl.suggestedFilename());
await dl.saveAs(takePath);
const size = fs.statSync(takePath).size;
let probe = '';
try { probe = execSync(`ffprobe -v error -show_entries stream=codec_type,codec_name,width,height -of csv=p=0 "${takePath}"`).toString().trim().replace(/\n/g, ' | '); } catch (e) { probe = 'ffprobe failed'; }
ok('recording downloads a playable file with video + audio', size > 50000 && /video/.test(probe) && /audio/.test(probe), `${(size / 1e6).toFixed(2)} MB; ${probe}`);

// ---------- Room ----------
await host.fill('#my-name', 'Frisky');
await host.click('#room-open');
await host.waitForSelector('#room-on:not([hidden])', { timeout: 10000 });
const invite = await host.$eval('#invite-url', (e) => e.textContent);
ok('room opens with an invite link', /\?room=[a-z0-9-]+$/.test(invite), invite);

const guestCtx = await ctx({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const guest = await guestCtx.newPage(); watch(guest, 'guest');
const guestUrl = invite.replace(/^https?:\/\/[^/]+/, BASE);
await guest.goto(guestUrl, { waitUntil: 'networkidle' });
await guest.screenshot({ path: `${SHOTS}/studio-invite-phone.png` });
await guest.fill('#gate-name', 'Guest Phone');
await guest.click('#gate-go');
await host.waitForFunction(() => [...document.querySelectorAll('#people .person')].some((p) => p.dataset.state === 'connected'), null, { timeout: 20000 }).catch(() => {});
await guest.waitForFunction(() => [...document.querySelectorAll('#people .person')].some((p) => p.dataset.state === 'connected'), null, { timeout: 20000 }).catch(() => {});
await host.waitForTimeout(2500);
const hostSees = await host.$$eval('#people .person video', (vs) => vs.map((v) => `${v.videoWidth}x${v.videoHeight}`));
const guestSees = await guest.$$eval('#people .person video', (vs) => vs.map((v) => `${v.videoWidth}x${v.videoHeight}`));
ok('host receives guest video over WebRTC', hostSees.some((s) => !s.startsWith('0x')), hostSees.join(','));
ok('guest receives host scene over WebRTC', guestSees.some((s) => !s.startsWith('0x')), guestSees.join(','));
const roomLvl = await maxMeter(host, 'room', 3000);
ok('guest audio reaches the host mix', roomLvl > 0.1, roomLvl.toFixed(2));
await host.click('.layout[data-layout="room"]');
await host.waitForTimeout(800);
await host.screenshot({ path: `${SHOTS}/studio-room-desktop.png` });
await guest.screenshot({ path: `${SHOTS}/studio-sources-phone.png` });
await guest.click('.st-tabs button[data-tab="mix"]'); await guest.waitForTimeout(500);
await guest.screenshot({ path: `${SHOTS}/studio-mix-phone.png` });
await guest.click('.st-tabs button[data-tab="room"]'); await guest.waitForTimeout(500);
await guest.screenshot({ path: `${SHOTS}/studio-room-phone.png` });

// OBS clean feed
const feedCtx = await ctx({ viewport: { width: 1280, height: 720 } });
const feed = await feedCtx.newPage(); watch(feed, 'feed');
await feed.goto(guestUrl + '&view=clean', { waitUntil: 'networkidle' });
await feed.waitForFunction(() => [...document.querySelectorAll('#feed-grid video')].some((v) => v.videoWidth > 0), null, { timeout: 20000 }).catch(() => {});
const feedSees = await feed.$$eval('#feed-grid video', (vs) => vs.map((v) => `${v.videoWidth}x${v.videoHeight}`));
ok('OBS clean feed receives the room', feedSees.some((s) => !s.startsWith('0x')), feedSees.join(','));
await feed.screenshot({ path: `${SHOTS}/studio-obs-feed.png` });
const status = await host.$eval('#room-status', (e) => e.textContent);
ok('host sees people + feed count', /2 of 4/.test(status) && /feed/.test(status), status);

// leave
await guest.click('#room-leave');
await host.waitForTimeout(1500);
const after = await host.$eval('#room-status', (e) => e.textContent);
ok('guest leaving updates the room', /1 of 4/.test(after), after);

// Phone layout + reduced motion
const rmCtx = await ctx({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
const rm = await rmCtx.newPage(); watch(rm, 'phone');
for (const u of ['/', '/studio/']) {
  await rm.goto(`${BASE}${u}`, { waitUntil: 'networkidle' }); await rm.waitForTimeout(800);
  const w = await rm.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  ok(`no horizontal overflow at 390px: ${u}`, w[0] <= w[1], w.join(' <= '));
}
const anim = await rm.evaluate(() => getComputedStyle(document.querySelector('.program-wrap'), '::before').animationName);
ok('prefers-reduced-motion stops studio animation', anim === 'none', anim);
await rm.goto(`${BASE}/`, { waitUntil: 'networkidle' });
const ctaHrefs = await rm.$$eval('a[data-studio]', (as) => [...new Set(as.map((a) => a.getAttribute('href')))]);
ok('every studio CTA opens /studio/', ctaHrefs.length === 1 && ctaHrefs[0] === '/studio/', ctaHrefs.join(','));
await rm.click('[data-nebu-action="start"]');
await rm.waitForFunction(() => { const n = document.querySelector('[data-nebu-health]'); return n && n.dataset.health !== 'checking'; }, null, { timeout: 8000 }).catch(() => {});
const health = await rm.$eval('[data-nebu-health]', (n) => n.dataset.health + ': ' + n.textContent);
const link = await rm.$eval('[data-nebu-invite]', (a) => a.getAttribute('href'));
ok('landing room widget issues a real studio room link + live health', /\/studio\/\?room=[a-z0-9-]{14}$/.test(link) && /^ok/.test(health), `${link} | ${health}`);

// TURN relay is actually reachable (Cloudflare Realtime TURN via /ice)
const relay = await host.evaluate(async () => {
  const sig = document.querySelector('meta[name="nebu-signal"]').content;
  const { iceServers, turn } = await (await fetch(sig + '/ice')).json();
  if (!turn) return 'no turn configured';
  const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'relay' });
  pc.createDataChannel('x');
  const found = new Promise((res) => { pc.onicecandidate = (e) => { if (e.candidate && / relay /.test(e.candidate.candidate)) res('relay candidate ' + e.candidate.address); if (!e.candidate) res('none'); }; setTimeout(() => res('timeout'), 8000); });
  await pc.setLocalDescription(await pc.createOffer());
  const r = await found; pc.close(); return r;
});
ok('TURN relay allocates a relay candidate', /^relay candidate/.test(relay), relay);

const benign = errors.filter((e) => !/favicon|ERR_BLOCKED_BY_CLIENT/.test(e));
ok('no console errors', benign.length === 0, benign.slice(0, 5).join(' || '));
await browser.close();
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
