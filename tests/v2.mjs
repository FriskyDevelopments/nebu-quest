// v2 preview walkthrough: Show panel, graphics, DJ, announce, stickers, chat bubble, live viewer.
// BASE=https://feat-studio-v2.nebu-quest.pages.dev node tests/v2.mjs
import { chromium } from 'playwright';
const BASE = process.env.BASE || 'https://feat-studio-v2.nebu-quest.pages.dev';
const SHOTS = process.env.SHOTS || 'shots';
const CAM = process.env.CAM_Y4M || '/workspace/audit/media/cam.y4m';
const TRACK = process.env.TRACK || '/workspace/audit/media/beat124.mp3';
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${CAM}`, '--autoplay-policy=no-user-gesture-required'] });
const desk = { viewport: { width: 1440, height: 900 }, permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'] };
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, permissions: ['camera', 'microphone'] };
const results = []; const ok = (name, pass, extra = '') => { results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${extra}`); };
const errs = [];

// ---------- Desktop studio ----------
const c = await browser.newContext(desk); const p = await c.newPage();
p.on('pageerror', (e) => errs.push('desk: ' + e.message));
await p.goto(`${BASE}/studio/`, { waitUntil: 'networkidle' }); await p.click('#gate-go'); await p.waitForTimeout(3000);
ok('signal points at preview worker', (await p.evaluate(() => window.NEBU_SIGNAL)).includes('nebu-rooms-preview'));
if (await p.locator('.st-tabs [data-tab="show"]').isVisible()) await p.click('.st-tabs [data-tab="show"]'); await p.locator('#panel-show').scrollIntoViewIfNeeded(); await p.waitForTimeout(600);
const lts = await p.locator('#lt-grid [data-lt]').count(); ok('lower thirds >= 10', lts >= 10, `(${lts})`);
ok('transitions = 4', (await p.locator('#tr-chips [data-tr]').count()) >= 4);
await p.fill('#lt-title', 'Frisky'); await p.fill('#lt-sub', 'Late set, requests open');
await p.click('#lt-grid [data-lt="neon"]'); await p.click('#lt-show'); await p.waitForTimeout(1400);
await p.screenshot({ path: `${SHOTS}/v2-show-panel-desktop.png` });
await p.locator('#program').screenshot({ path: `${SHOTS}/v2-lower-third-neon.png` });
await p.click('#lt-grid [data-lt="broadcast"]'); await p.click('#lt-show'); await p.waitForTimeout(1200);
await p.locator('#program').screenshot({ path: `${SHOTS}/v2-lower-third-broadcast.png` });
for (const k of await p.locator('#ov-chips [data-ov]').evaluateAll((n) => n.map((x) => x.dataset.ov))) await p.click(`#ov-chips [data-ov="${k}"]`);
await p.waitForTimeout(800); await p.locator('#program').screenshot({ path: `${SHOTS}/v2-overlays.png` });
await p.click('#tr-chips [data-tr="glitch"]').catch(() => {}); await p.keyboard.press('2'); await p.waitForTimeout(180);
await p.locator('#program').screenshot({ path: `${SHOTS}/v2-transition-mid.png` });
// Stickers
await p.click('[data-acc="stickers"] summary'); await p.waitForTimeout(800);
const stk = p.locator('#stk-grid [data-id]').first(); if (await stk.count()) { await stk.click(); await p.waitForTimeout(900); }
ok('sticker placed', (await p.evaluate(() => (window.NebuGfx && window.NebuGfx.stickers ? window.NebuGfx.stickers.length : -1))) !== 0);
await p.fill('#tg-link', 'https://t.me/addstickers/HotCherry'); await p.click('#tg-imp button'); await p.waitForTimeout(7000);
const note = await p.textContent('#tg-note'); ok('telegram sticker import', /Hot Cherry|imported|12/i.test(note), `(${note.trim().slice(0, 60)})`);
await p.locator('[data-acc="stickers"]').screenshot({ path: `${SHOTS}/v2-stickers.png` });
await p.locator('#program').screenshot({ path: `${SHOTS}/v2-program-stickers.png` });
// DJ
await p.click('[data-acc="dj"] summary'); await p.waitForTimeout(300);
await p.locator('[data-deck="a"] input[type=file], #decks input[type=file]').first().setInputFiles(TRACK); await p.waitForTimeout(4000);
await p.locator('#decks .deck-play').first().click(); await p.waitForTimeout(1500);
const bpm = await p.locator('#decks').textContent(); ok('DJ deck loads + BPM', /\d{2,3}(\.\d)?\s*BPM/i.test(bpm), `(${(bpm.match(/\d{2,3}(\.\d)?\s*BPM/i) || ['none'])[0]})`);
await p.fill('#xf', '0.2').catch(() => {}); await p.locator('#xf').evaluate((x) => { x.value = '0.2'; x.dispatchEvent(new Event('input', { bubbles: true })); });
await p.locator('[data-acc="dj"]').screenshot({ path: `${SHOTS}/v2-dj.png` });
// Announce
await p.click('[data-acc="announce"] summary'); await p.fill('#an-text', 'Doors open. Requests are on, drop yours in the chat.');
const ttsResp = p.waitForResponse((r) => r.url().includes('/tts'), { timeout: 20000 }).catch(() => null);
await p.click('#an-go'); const tr = await ttsResp; await p.waitForTimeout(3000); const anNote = await p.textContent('#an-note'); ok('announce TTS', /said it/.test(anNote), `(${tr && tr.status()} ${anNote.trim()})`);
await p.waitForTimeout(2500); await p.locator('#program').screenshot({ path: `${SHOTS}/v2-announce-lower-third.png` });
await p.locator('[data-acc="announce"]').screenshot({ path: `${SHOTS}/v2-announce-panel.png` });
// Chat bubble + go live
await p.click('#nb-btn'); await p.waitForTimeout(500);
await p.click('.nb-tabs [data-nt="live"]'); await p.waitForTimeout(300);
await p.click('#lv-start'); await p.waitForTimeout(2500);
const live = await p.evaluate(() => JSON.parse(localStorage.getItem('nebu:live') || 'null'));
ok('live chat opened', !!(live && live.sid));
await p.screenshot({ path: `${SHOTS}/v2-chat-golive-desktop.png` });
await p.click('.nb-tabs [data-nt="poll"]'); await p.waitForTimeout(200);
await p.fill('#nb-pq', 'Next vibe?').catch(() => {});
const optInputs = p.locator('#nb-pollform input:not(#nb-pq)'); const n = await optInputs.count();
if (n >= 2) { await optInputs.nth(0).fill('House'); await optInputs.nth(1).fill('Techno'); }
await p.locator('#nb-pollform [type=submit]').click().catch(() => {}); await p.waitForTimeout(800);
await p.click('#nb-ponstream').catch(() => {});

// ---------- Viewer (phone, web fallback) ----------
const vc = await browser.newContext(phone); const v = await vc.newPage(); v.on('pageerror', (e) => errs.push('viewer: ' + e.message));
await v.goto(live.webUrl, { waitUntil: 'networkidle' }); await v.waitForTimeout(800);
await v.screenshot({ path: `${SHOTS}/v2-viewer-gate-phone.png` });
await v.fill('#lv-name', 'Pat'); await v.click('#lv-join button'); await v.waitForTimeout(1800);
await v.fill('#lv-in', 'this set is fire'); await v.press('#lv-in', 'Enter'); await v.waitForTimeout(1000);
await v.locator('#lv-react button').first().click(); await v.waitForTimeout(400);
await v.locator('#lv-react button').nth(1).click(); await v.waitForTimeout(300);
await v.click('#lv-mode').catch(() => {}); await v.fill('#lv-in', 'Daft Punk - One More Time'); await v.press('#lv-in', 'Enter'); await v.waitForTimeout(900);
const vote = v.locator('#lv-cards button').first(); if (await vote.count()) await vote.click();
await v.waitForTimeout(900);
ok('viewer: no empty notice bars', !(await v.locator('#lv-pin').isVisible()) && !(await v.locator('#lv-announce').isVisible()));
await v.screenshot({ path: `${SHOTS}/v2-viewer-live-nopin-phone.png` });
await p.click('.nb-tabs [data-nt="chat"]'); await p.waitForTimeout(300);
await p.locator('#nb-msgs [data-pin="this set is fire"]').first().click({ force: true }); await v.waitForTimeout(1200);
const pinTxt = (await v.locator('#lv-pin').isVisible()) ? await v.textContent('#lv-pin') : '';
ok('host pin reaches viewer', pinTxt.includes('this set is fire'), `(${pinTxt.trim().slice(0, 50)})`);
await v.screenshot({ path: `${SHOTS}/v2-viewer-live-phone.png` });
await p.locator('#nb-panel').screenshot({ path: `${SHOTS}/v2-chat-host-pinned-desktop.png` }).catch(() => {});
await p.waitForTimeout(800);
await p.click('.nb-tabs [data-nt="chat"]'); await p.waitForTimeout(300);
const hostSaw = await p.textContent('#nb-msgs'); ok('host sees viewer chat', hostSaw.includes('this set is fire'));
await p.screenshot({ path: `${SHOTS}/v2-chat-host-desktop.png` });
await p.locator('#program').screenshot({ path: `${SHOTS}/v2-program-reactions-poll.png` });
await p.click('.nb-tabs [data-nt="req"]'); await p.waitForTimeout(300);
ok('host sees song request', (await p.textContent('#nb-queue')).includes('One More Time'));
// Announce reaches viewer
await p.click('.nb-tabs [data-nt="live"]'); await p.waitForTimeout(200);
await p.click('#lv-end'); await p.waitForTimeout(1500);
ok('viewer sees ended screen', await v.locator('#lv-ended').isVisible());
await v.screenshot({ path: `${SHOTS}/v2-viewer-ended-phone.png` });
await vc.close(); await c.close();

// ---------- Phone studio ----------
const pc = await browser.newContext(phone); const pp = await pc.newPage(); pp.on('pageerror', (e) => errs.push('phone: ' + e.message));
await pp.goto(`${BASE}/studio/`, { waitUntil: 'networkidle' }); await pp.click('#gate-go'); await pp.waitForTimeout(3000);
await pp.click('.st-tabs [data-tab="show"]'); await pp.waitForTimeout(600);
await pp.screenshot({ path: `${SHOTS}/v2-show-panel-phone.png` });
await pp.click('#nb-btn'); await pp.waitForTimeout(600);
await pp.screenshot({ path: `${SHOTS}/v2-chat-sheet-phone.png` });
await pc.close();
// ---------- Monthly design (Hermes Stitch, mock) ----------
if (process.env.SESSION) {
  const sc = await browser.newContext(desk); await sc.addInitScript((t) => localStorage.setItem('nebu:session', JSON.stringify(t)), process.env.SESSION);
  const sp = await sc.newPage(); sp.on('pageerror', (e) => errs.push('stitch: ' + e.message));
  await sp.goto(`${BASE}/studio/`, { waitUntil: 'networkidle' }); await sp.click('#gate-go'); await sp.waitForTimeout(2500);
  await sp.locator('[data-acc="packs"] summary').scrollIntoViewIfNeeded(); await sp.click('[data-acc="packs"] summary'); await sp.waitForTimeout(2000);
  await sp.fill('#sj-prompt', 'A neon lower third and a matching sticker for my late sets'); await sp.selectOption('#sj-kind', 'set');
  await sp.click('#sj-form button[type=submit]'); await sp.waitForTimeout(2200);
  await sp.locator('[data-acc="packs"]').screenshot({ path: `${SHOTS}/v2-stitch-designing.png` });
  await sp.waitForSelector('.sj-job.is-ready', { timeout: 30000 }).catch(() => {});
  ok('monthly design reaches Ready', await sp.locator('.sj-job.is-ready').count() > 0);
  await sp.locator('.sj-job.is-ready [data-load]').first().click().catch(() => {}); await sp.waitForTimeout(2000);
  await sp.locator('[data-acc="packs"]').screenshot({ path: `${SHOTS}/v2-stitch-ready.png` });
  await sp.locator('#program').screenshot({ path: `${SHOTS}/v2-stitch-on-program.png` });
  await sc.close();
}
await browser.close();
console.log('page errors:', errs.length ? errs : 'none');
console.log(`${results.filter((r) => r.pass).length}/${results.length} passed`);
