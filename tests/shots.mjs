// Marketing-grade screenshots of the landing page + studio at 1440 and 390.
// Uses a branded fake camera (CAM_Y4M) and a video file (SLIDE) as sources.
// BASE=http://127.0.0.1:8811 node tests/shots.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8811';
const SHOTS = process.env.SHOTS || path.resolve('shots');
const CAM = process.env.CAM_Y4M || '/workspace/audit/media/cam.y4m';
const SLIDE = process.env.SLIDE || '/workspace/audit/media/slide.webm';
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${CAM}`, '--autoplay-policy=no-user-gesture-required'],
});
const desk = { viewport: { width: 1440, height: 900 }, permissions: ['camera', 'microphone'] };
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, permissions: ['camera', 'microphone'] };

const snap = async (p, file) => { await p.evaluate(() => { document.activeElement && document.activeElement.blur(); window.scrollTo(0, 0); }); await p.waitForTimeout(250); await p.screenshot({ path: file }); };

// Landing
for (const [tag, opts] of [['desktop', desk], ['phone', phone]]) {
  const c = await browser.newContext(opts); const p = await c.newPage();
  await p.goto(`${BASE}/`, { waitUntil: 'networkidle' }); await p.waitForTimeout(2000);
  await p.screenshot({ path: `${SHOTS}/landing-hero-${tag}.png` });
  await p.evaluate(() => document.querySelectorAll('[data-reveal]').forEach((n) => n.classList.add('is-visible')));
  await p.locator('#live-room').scrollIntoViewIfNeeded(); await p.click('[data-nebu-action="start"]'); await p.waitForTimeout(1500);
  await p.locator('#live-room').screenshot({ path: `${SHOTS}/landing-room-widget-${tag}.png` });
  // Walk the page so lazy images load before the full-page capture.
  const hgt = await p.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < hgt; y += 600) { await p.evaluate((yy) => window.scrollTo(0, yy), y); await p.waitForTimeout(80); }
  await p.waitForTimeout(600);
  await p.screenshot({ path: `${SHOTS}/landing-full-${tag}.png`, fullPage: true });
  if (tag === 'phone') {
    await p.evaluate(() => window.scrollTo(0, 0)); await p.click('.menu-toggle'); await p.waitForTimeout(400);
    await p.screenshot({ path: `${SHOTS}/landing-menu-phone.png` });
  }
  await c.close();
}

// Studio, desktop host
const hc = await browser.newContext(desk); const host = await hc.newPage();
await host.goto(`${BASE}/studio/`, { waitUntil: 'networkidle' }); await host.waitForTimeout(800);
await snap(host, `${SHOTS}/studio-gate-desktop.png`);
await host.click('#gate-go');
await host.waitForFunction(() => document.querySelector('#cam-toggle').getAttribute('aria-checked') === 'true');
await host.setInputFiles('#video-file', SLIDE);
await host.fill('#title-text', 'Frisky');
await host.fill('#title-sub', 'Setting the scene on NEBU');
await host.click('#title-toggle');
await host.click('.layout[data-layout="pip"]');
await host.waitForTimeout(2500);
await host.click('#rec-btn'); await host.waitForTimeout(3000); await host.click('#rec-btn');
await host.waitForSelector('.take'); await host.waitForTimeout(2900);
await snap(host, `${SHOTS}/studio-desktop.png`);
await host.click('.layout[data-layout="split"]'); await host.waitForTimeout(800);
await snap(host, `${SHOTS}/studio-split-desktop.png`);
await host.click('.layout[data-layout="pip"]');
await host.fill('#my-name', 'Frisky'); await host.click('#room-open');
await host.waitForSelector('#room-on:not([hidden])');
const invite = (await host.$eval('#invite-url', (e) => e.textContent)).replace(/^https?:\/\/[^/]+/, BASE);

// Studio, phone guest
const gc = await browser.newContext(phone); const guest = await gc.newPage();
await guest.goto(invite, { waitUntil: 'networkidle' }); await guest.waitForTimeout(800);
await snap(guest, `${SHOTS}/studio-invite-phone.png`);
await guest.fill('#gate-name', 'Guest'); await guest.click('#gate-go');
await host.waitForFunction(() => [...document.querySelectorAll('#people .person')].some((p) => p.dataset.state === 'connected'), null, { timeout: 20000 });
await host.waitForTimeout(3000);
await host.click('.layout[data-layout="room"]'); await host.waitForTimeout(1200);
await snap(host, `${SHOTS}/studio-room-desktop.png`);
await guest.waitForTimeout(1500);
await snap(guest, `${SHOTS}/studio-phone.png`);
for (const t of ['mix', 'room']) { await guest.click(`.st-tabs button[data-tab="${t}"]`); await guest.waitForTimeout(600); await snap(guest, `${SHOTS}/studio-${t}-phone.png`); }
await browser.close();
console.log('shots in', SHOTS);
