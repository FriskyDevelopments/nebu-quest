/* NEBU graphics layer: lower thirds (12 designs), overlays, 4 transitions, stickers, reaction bursts.
 * Everything draws into the scene canvas through NebuStudio.addOverlay, so it lands in the program,
 * the recording, the room and the OBS clean feed. Layered: stickers < lower third < overlays < poll
 * < reactions < transition. */
(() => {
  'use strict';
  const C = { night: '#0B001A', violet: '#9D00FF', cyan: '#00E5FF', lime: '#B7FF2A', yellow: '#FFD100', paper: '#F7F5F2', ink: '#121212', pink: '#FF2E88' };
  const D = '"Bricolage Grotesque", Manrope, sans-serif', B = 'Manrope, sans-serif', M = '"JetBrains Mono", ui-monospace, monospace';
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ease = { out: (x) => 1 - Math.pow(1 - x, 3), back: (x) => { const c = 1.70158, c3 = c + 1; return 1 + c3 * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); }, inOut: (x) => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2 };
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }
  function tw(ctx, font, s) { ctx.font = font; return ctx.measureText(s || ' ').width; }
  const mark = new Image(); mark.src = '../assets/nebu-mark-yellow.svg';

  // ---- Lower thirds: each design gets (ctx, p 0..1 enter/exit, t ms, a {title, sub, W, H}) ----
  const LT = {
    minimal: { name: 'Minimal', draw(ctx, p, t, a) {
      const x = 64, y = a.H - 150, e = ease.out(p);
      ctx.globalAlpha = e; ctx.fillStyle = C.paper; ctx.fillRect(x, y, 4, 76 * e);
      ctx.font = `800 40px ${D}`; ctx.fillText(a.title, x + 22 - (1 - e) * 30, y + 38);
      ctx.font = `600 19px ${B}`; ctx.fillStyle = 'rgba(247,245,242,.72)'; ctx.fillText(a.sub, x + 22 - (1 - e) * 50, y + 70);
    } },
    broadcast: { name: 'Bold broadcast', draw(ctx, p, t, a) {
      const x = 0, y = a.H - 170, e = ease.out(p), w = Math.max(tw(ctx, `800 44px ${D}`, a.title), tw(ctx, `700 20px ${B}`, a.sub)) + 150;
      ctx.fillStyle = C.yellow; ctx.fillRect(x, y, w * e, 70);
      ctx.fillStyle = C.ink; ctx.fillRect(x, y + 70, (w - 60) * ease.out(clamp(p * 1.3 - .3)), 40);
      ctx.save(); ctx.beginPath(); ctx.rect(x, y, w * e, 110); ctx.clip();
      ctx.fillStyle = C.ink; ctx.font = `800 44px ${D}`; ctx.fillText(a.title.toUpperCase(), 64, y + 50);
      ctx.fillStyle = C.paper; ctx.font = `700 20px ${B}`; ctx.fillText(a.sub, 64, y + 98); ctx.restore();
    } },
    neon: { name: 'Neon', draw(ctx, p, t, a) {
      const x = 60, y = a.H - 160, e = ease.out(p), flick = reduce ? 1 : (p < 1 ? (Math.random() > .3 ? 1 : .4) : .92 + .08 * Math.sin(t / 90));
      const w = Math.max(tw(ctx, `800 42px ${D}`, a.title), tw(ctx, `600 20px ${B}`, a.sub)) + 60;
      ctx.globalAlpha = e * flick; ctx.shadowColor = C.cyan; ctx.shadowBlur = 24; ctx.strokeStyle = C.cyan; ctx.lineWidth = 3;
      rr(ctx, x, y, w, 104, 18); ctx.stroke();
      ctx.shadowColor = C.violet; ctx.fillStyle = C.paper; ctx.font = `800 42px ${D}`; ctx.fillText(a.title, x + 30, y + 50);
      ctx.shadowBlur = 10; ctx.fillStyle = C.cyan; ctx.font = `600 20px ${B}`; ctx.fillText(a.sub, x + 30, y + 84);
    } },
    glass: { name: 'Glass', draw(ctx, p, t, a) {
      const x = 56, y = a.H - 162, e = ease.back(p), w = Math.max(tw(ctx, `800 40px ${D}`, a.title), tw(ctx, `600 19px ${B}`, a.sub)) + 80;
      ctx.globalAlpha = clamp(p * 2); ctx.translate(0, (1 - e) * 40);
      const g = ctx.createLinearGradient(x, y, x + w, y + 104); g.addColorStop(0, 'rgba(255,255,255,.22)'); g.addColorStop(1, 'rgba(255,255,255,.06)');
      ctx.fillStyle = g; rr(ctx, x, y, w, 104, 24); ctx.fill(); ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = C.paper; ctx.font = `800 40px ${D}`; ctx.fillText(a.title, x + 34, y + 48);
      ctx.fillStyle = 'rgba(247,245,242,.75)'; ctx.font = `600 19px ${B}`; ctx.fillText(a.sub, x + 34, y + 80);
    } },
    ticker: { name: 'Ticker', draw(ctx, p, t, a) {
      const y = a.H - 64, e = ease.out(p); ctx.translate(0, (1 - e) * 80);
      ctx.fillStyle = C.ink; ctx.fillRect(0, y, a.W, 64); ctx.fillStyle = C.yellow; ctx.fillRect(0, y, 220, 64);
      ctx.fillStyle = C.ink; ctx.font = `800 24px ${D}`; ctx.fillText(a.title.toUpperCase().slice(0, 12), 22, y + 41);
      ctx.save(); ctx.beginPath(); ctx.rect(236, y, a.W - 236, 64); ctx.clip();
      const msg = `${a.sub}   ✦   `; ctx.font = `700 24px ${B}`; const mw = ctx.measureText(msg).width; const off = reduce ? 0 : (t / 12) % mw;
      ctx.fillStyle = C.paper; for (let x = 250 - off; x < a.W; x += mw) ctx.fillText(msg, x, y + 41); ctx.restore();
    } },
    split: { name: 'Split name / title', draw(ctx, p, t, a) {
      const x = 60, y = a.H - 150, e1 = ease.out(clamp(p * 1.4)), e2 = ease.out(clamp(p * 1.4 - .4));
      const w1 = tw(ctx, `800 36px ${D}`, a.title) + 48, w2 = tw(ctx, `700 18px ${B}`, a.sub) + 40;
      ctx.fillStyle = C.violet; ctx.fillRect(x, y, w1 * e1, 60); ctx.fillStyle = C.paper; ctx.fillRect(x + 24, y + 60, w2 * e2, 40);
      ctx.save(); ctx.beginPath(); ctx.rect(x, y, w1 * e1, 60); ctx.clip(); ctx.fillStyle = C.paper; ctx.font = `800 36px ${D}`; ctx.fillText(a.title, x + 24, y + 43); ctx.restore();
      ctx.save(); ctx.beginPath(); ctx.rect(x + 24, y + 60, w2 * e2, 40); ctx.clip(); ctx.fillStyle = C.ink; ctx.font = `700 18px ${B}`; ctx.fillText(a.sub, x + 44, y + 87); ctx.restore();
    } },
    nowplaying: { name: 'Now playing', draw(ctx, p, t, a) {
      const x = 56, y = a.H - 150, e = ease.back(p), w = Math.max(tw(ctx, `800 30px ${D}`, a.title), tw(ctx, `600 18px ${B}`, a.sub)) + 170;
      ctx.globalAlpha = clamp(p * 2); ctx.translate((1 - e) * -60, 0);
      ctx.fillStyle = 'rgba(11,0,26,.86)'; rr(ctx, x, y, w, 96, 48); ctx.fill();
      ctx.save(); ctx.translate(x + 48, y + 48); ctx.rotate(reduce ? 0 : t / 700); ctx.fillStyle = C.ink; ctx.beginPath(); ctx.arc(0, 0, 34, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.18)'; for (let r = 14; r < 34; r += 6) { ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.stroke(); } ctx.fillStyle = C.yellow; ctx.beginPath(); ctx.arc(0, 0, 10, 0, 7); ctx.fill(); ctx.restore();
      for (let i = 0; i < 4; i++) { const h = reduce ? 10 : 6 + Math.abs(Math.sin(t / 160 + i * 1.7)) * 18; ctx.fillStyle = C.lime; ctx.fillRect(x + w - 50 + i * 8, y + 60 - h, 5, h); }
      ctx.fillStyle = C.lime; ctx.font = `700 12px ${M}`; ctx.fillText('NOW PLAYING', x + 98, y + 30);
      ctx.fillStyle = C.paper; ctx.font = `800 30px ${D}`; ctx.fillText(a.title, x + 98, y + 62);
      ctx.fillStyle = 'rgba(247,245,242,.7)'; ctx.font = `600 18px ${B}`; ctx.fillText(a.sub, x + 98, y + 84);
    } },
    social: { name: 'Social handle', draw(ctx, p, t, a) {
      const x = 60, y = a.H - 128, e = ease.back(p), w = tw(ctx, `800 30px ${D}`, a.title) + 110;
      ctx.globalAlpha = clamp(p * 2); ctx.translate(x, y); ctx.scale(.6 + .4 * e, .6 + .4 * e);
      ctx.fillStyle = C.paper; rr(ctx, 0, 0, w, 64, 32); ctx.fill();
      ctx.fillStyle = C.violet; ctx.beginPath(); ctx.arc(32, 32, 22, 0, 7); ctx.fill(); ctx.fillStyle = C.paper; ctx.font = `800 24px ${D}`; ctx.textAlign = 'center'; ctx.fillText('@', 32, 41); ctx.textAlign = 'left';
      ctx.fillStyle = C.ink; ctx.font = `800 30px ${D}`; ctx.fillText(a.title.startsWith('@') ? a.title : '@' + a.title, 66, 43);
      if (a.sub) { ctx.fillStyle = C.paper; ctx.font = `600 17px ${B}`; ctx.fillText(a.sub, 12, 92); }
    } },
    sticker: { name: 'Sticker-accented', draw(ctx, p, t, a) {
      const x = 70, y = a.H - 160, e = ease.back(p), w = Math.max(tw(ctx, `800 40px ${D}`, a.title), tw(ctx, `600 19px ${B}`, a.sub)) + 70;
      ctx.globalAlpha = clamp(p * 2);
      ctx.save(); ctx.translate(x + w / 2, y + 52); ctx.rotate(-.025 * e); ctx.translate(-(x + w / 2), -(y + 52));
      ctx.fillStyle = '#000'; rr(ctx, x + 6, y + 7, w, 104, 16); ctx.fill(); ctx.fillStyle = C.lime; rr(ctx, x, y, w, 104, 16); ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = C.ink; ctx.stroke();
      ctx.fillStyle = C.ink; ctx.font = `800 40px ${D}`; ctx.fillText(a.title, x + 30, y + 50); ctx.font = `600 19px ${B}`; ctx.fillText(a.sub, x + 30, y + 82); ctx.restore();
      if (mark.complete && mark.naturalWidth) { const s = 70 * e, bob = reduce ? 0 : Math.sin(t / 400) * 4; ctx.save(); ctx.translate(x + w - 10, y - 8 + bob); ctx.rotate(.18); ctx.drawImage(mark, -s / 2, -s / 2 * .8, s, s * .8); ctx.restore(); }
    } },
    breaking: { name: 'Breaking news', draw(ctx, p, t, a) {
      const y = a.H - 180, e = ease.out(p), pulse = reduce ? 1 : .85 + .15 * Math.sin(t / 180);
      ctx.fillStyle = C.pink; ctx.fillRect(0, y, 300 * e, 54); ctx.globalAlpha = pulse; ctx.fillStyle = C.paper; ctx.font = `800 26px ${D}`; ctx.fillText('● LIVE UPDATE', 40, y + 37); ctx.globalAlpha = 1;
      const w = Math.max(tw(ctx, `800 40px ${D}`, a.title) + 100, 700);
      ctx.fillStyle = C.paper; ctx.fillRect(0, y + 54, w * ease.out(clamp(p * 1.3 - .2)), 64); ctx.fillStyle = C.ink; ctx.fillRect(0, y + 118, w * .8 * ease.out(clamp(p * 1.3 - .3)), 36);
      ctx.save(); ctx.beginPath(); ctx.rect(0, y + 54, w * e, 100); ctx.clip();
      ctx.fillStyle = C.ink; ctx.font = `800 40px ${D}`; ctx.fillText(a.title, 40, y + 100); ctx.fillStyle = C.paper; ctx.font = `700 19px ${B}`; ctx.fillText(a.sub, 40, y + 143); ctx.restore();
    } },
    stripe: { name: 'FR!SKY stripe', draw(ctx, p, t, a) {
      const x = 0, y = a.H - 150, e = ease.inOut(p), w = Math.max(tw(ctx, `800 40px ${D}`, a.title), tw(ctx, `600 19px ${B}`, a.sub)) + 140;
      const g = ctx.createLinearGradient(0, 0, w, 0); g.addColorStop(0, C.violet); g.addColorStop(1, C.cyan);
      ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + w * e, y); ctx.lineTo(x + w * e - 40, y + 100); ctx.lineTo(x, y + 100); ctx.fill();
      ctx.save(); ctx.globalAlpha = .18; ctx.fillStyle = C.paper; for (let i = 0; i < 6; i++) { ctx.beginPath(); const sx = (x + w * e) - 60 - i * 26; ctx.moveTo(sx, y); ctx.lineTo(sx + 10, y); ctx.lineTo(sx - 30, y + 100); ctx.lineTo(sx - 40, y + 100); ctx.fill(); } ctx.restore();
      ctx.save(); ctx.beginPath(); ctx.rect(0, y, w * e, 100); ctx.clip(); ctx.fillStyle = C.paper; ctx.font = `800 40px ${D}`; ctx.fillText(a.title, 56, y + 50); ctx.font = `600 19px ${B}`; ctx.fillText(a.sub, 56, y + 80); ctx.restore();
    } },
    mono: { name: 'Outline mono', draw(ctx, p, t, a) {
      const x = 64, y = a.H - 156, e = ease.out(p), w = Math.max(tw(ctx, `800 40px ${D}`, a.title), tw(ctx, `500 16px ${M}`, a.sub)) + 64;
      ctx.strokeStyle = C.paper; ctx.lineWidth = 2; ctx.setLineDash([w * 2 * e + 1, 9999]); rr(ctx, x, y, w, 104, 4); ctx.stroke(); ctx.setLineDash([]);
      ctx.globalAlpha = clamp(p * 1.5 - .3); ctx.fillStyle = C.paper; ctx.font = `800 40px ${D}`; ctx.fillText(a.title, x + 32, y + 50); ctx.font = `500 16px ${M}`; ctx.fillStyle = C.yellow; ctx.fillText(a.sub.toUpperCase(), x + 32, y + 80);
    } },
  };

  // ---- State ----
  const G = window.NebuGfx = {
    C, LT, lt: { design: 'broadcast', title: '', sub: '', on: false, p: 0, target: 0, hold: 0 },
    overlays: { logo: true, live: false, clock: false, ticker: false, nowplaying: false },
    viewers: 0, tickerText: '', nowPlaying: null, poll: null, pollOnStream: true,
    stickers: [], selected: null, particles: [], transition: { kind: 'stripe', run: null }, imgCache: new Map(),
    showLT(on, opts = {}) { Object.assign(this.lt, opts); this.lt.on = on; this.lt.target = on ? 1 : 0; if (on && opts.holdMs) this.lt.hold = performance.now() + opts.holdMs; else if (on) this.lt.hold = 0; },
    burst(emoji, n = 6) {
      const { W, H } = NebuStudio.size();
      for (let i = 0; i < n; i++) this.particles.push({ e: emoji, x: W - 140 + (Math.random() - .5) * 120, y: H - 60, vx: (Math.random() - .5) * .08, vy: -(.18 + Math.random() * .16), s: 34 + Math.random() * 26, born: performance.now() + i * 70, life: 2400 + Math.random() * 900, sway: Math.random() * 6 });
      if (this.particles.length > 160) this.particles.splice(0, this.particles.length - 160);
    },
    addSticker(item, anim = 'pop') {
      const { W, H } = NebuStudio.size();
      const s = { id: Math.random().toString(36).slice(2), item, x: W * (.3 + Math.random() * .4), y: H * (.28 + Math.random() * .3), scale: 1, rot: (Math.random() - .5) * .3, anim, born: performance.now(), size: 220 };
      this.stickers.push(s); this.selected = s.id; this.loadSticker(item); return s;
    },
    loadSticker(item) {
      const key = item.url || item.src; if (this.imgCache.has(key)) return this.imgCache.get(key);
      let el;
      if (/\.webm(\?|$)/.test(key) || item.format === 'video') { el = document.createElement('video'); el.muted = true; el.loop = true; el.playsInline = true; el.crossOrigin = 'anonymous'; el.src = key; el.play().catch(() => {}); }
      else if (/\.tgs(\?|$)/.test(key) || item.format === 'animated') { el = document.createElement('canvas'); el.width = el.height = 256; loadTgs(key, el); }
      else { el = new Image(); el.crossOrigin = 'anonymous'; el.src = key; }
      this.imgCache.set(key, el); return el;
    },
    startTransition() {
      if (reduce || this.transition.kind === 'none') return;
      const src = document.getElementById('program'); const snap = document.createElement('canvas'); snap.width = src.width; snap.height = src.height;
      snap.getContext('2d').drawImage(src, 0, 0); this.transition.run = { snap, t0: performance.now(), kind: this.transition.kind };
    },
  };
  G.TRANSITIONS = { fade: 'Fade', stripe: 'Stripe wipe', zoom: 'Zoom punch', glitch: 'Glitch slice' };

  async function loadTgs(url, canvas) {
    try {
      if (!window.lottie) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'vendor/lottie_light_canvas.min.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
      const buf = await (await fetch(url)).arrayBuffer();
      const json = JSON.parse(await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
      window.lottie.loadAnimation({ renderer: 'canvas', loop: true, autoplay: true, animationData: json, rendererSettings: { context: canvas.getContext('2d'), clearCanvas: true } });
    } catch { /* leave blank */ }
  }

  function drawStickers(ctx, t) {
    const now = performance.now();
    for (const s of G.stickers) {
      const el = G.imgCache.get(s.item.url || s.item.src); if (!el) continue;
      const ready = el instanceof HTMLVideoElement ? el.readyState >= 2 : el instanceof HTMLCanvasElement ? true : el.complete && el.naturalWidth;
      if (!ready) continue;
      const age = (now - s.born) / 1000; let sc = s.scale, dy = 0, rot = s.rot;
      const intro = clamp(age / .45);
      if (s.anim === 'pop') sc *= ease.back(intro);
      if (s.anim === 'bounce') { sc *= ease.back(intro); dy = reduce ? 0 : -Math.abs(Math.sin(age * 3.2)) * 26; }
      if (s.anim === 'float') { sc *= ease.out(intro); dy = reduce ? 0 : Math.sin(age * 1.6) * 12; rot += reduce ? 0 : Math.sin(age * 1.1) * .05; }
      const w = s.size * sc, ar = el.videoHeight ? el.videoHeight / el.videoWidth : el.naturalHeight ? el.naturalHeight / el.naturalWidth : 1, h = w * ar;
      ctx.save(); ctx.translate(s.x, s.y + dy); ctx.rotate(rot); ctx.drawImage(el, -w / 2, -h / 2, w, h);
      if (G.selected === s.id && G.editing) { ctx.setLineDash([8, 6]); ctx.strokeStyle = C.yellow; ctx.lineWidth = 2; ctx.strokeRect(-w / 2 - 6, -h / 2 - 6, w + 12, h + 12); }
      ctx.restore();
    }
  }
  function drawLT(ctx, t, W, H) {
    const lt = G.lt; const d = LT[lt.design] || LT.broadcast;
    if (lt.hold && performance.now() > lt.hold) { lt.hold = 0; lt.target = 0; lt.on = false; }
    lt.p += (lt.target - lt.p) * (reduce ? 1 : .09); if (Math.abs(lt.target - lt.p) < .002) lt.p = lt.target;
    if (lt.p <= .001 || !(lt.title || lt.sub)) return;
    ctx.save(); ctx.textBaseline = 'alphabetic'; d.draw(ctx, lt.p, t, { title: lt.title || '', sub: lt.sub || '', W, H }); ctx.restore();
  }
  function drawOverlays(ctx, t, W, H) {
    const o = G.overlays;
    if (o.logo && mark.complete && mark.naturalWidth) { ctx.save(); ctx.globalAlpha = .9; ctx.drawImage(mark, W - 108, 26, 72, 58); ctx.restore(); }
    if (o.live) {
      ctx.save(); const blink = reduce ? 1 : .6 + .4 * Math.abs(Math.sin(t / 500));
      ctx.fillStyle = C.pink; rr(ctx, 32, 28, 86, 34, 17); ctx.fill(); ctx.fillStyle = C.paper; ctx.globalAlpha = blink; ctx.beginPath(); ctx.arc(52, 45, 6, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
      ctx.font = `800 16px ${M}`; ctx.fillText('LIVE', 66, 51);
      if (G.viewers) { ctx.fillStyle = 'rgba(11,0,26,.7)'; rr(ctx, 126, 28, 74, 34, 17); ctx.fill(); ctx.fillStyle = C.paper; ctx.fillText(`👁 ${G.viewers}`, 138, 51); }
      ctx.restore();
    }
    if (o.clock) { const d = new Date(); ctx.save(); ctx.font = `700 20px ${M}`; ctx.fillStyle = 'rgba(11,0,26,.7)'; rr(ctx, W - 250, 34, 120, 38, 10); ctx.fill(); ctx.fillStyle = C.paper; ctx.fillText(d.toTimeString().slice(0, 8), W - 236, 60); ctx.restore(); }
    if (o.ticker && G.tickerText) {
      ctx.save(); const y = 0; ctx.fillStyle = 'rgba(11,0,26,.78)'; ctx.fillRect(0, y, W, 0); ctx.restore();
      ctx.save(); ctx.fillStyle = 'rgba(11,0,26,.8)'; ctx.fillRect(0, H - 40, W, 40); ctx.font = `600 18px ${B}`; const mw = ctx.measureText(G.tickerText + '   ✦   ').width;
      const off = reduce ? 0 : (t / 14) % mw; ctx.fillStyle = C.paper; for (let x = 20 - off; x < W; x += mw) ctx.fillText(G.tickerText + '   ✦   ', x, H - 14); ctx.restore();
    }
    if (o.nowplaying && G.nowPlaying && !(G.lt.on && G.lt.design === 'nowplaying')) {
      const a = { title: G.nowPlaying.title, sub: G.nowPlaying.sub || '', W, H: 250 };
      ctx.save(); ctx.translate(W - 560, -60); ctx.scale(.8, .8); LT.nowplaying.draw(ctx, 1, t, a); ctx.restore();
    }
  }
  function drawPoll(ctx, t, W) {
    const p = G.poll; if (!p || !G.pollOnStream) return;
    const x = W - 420, y = 110, w = 380, rowH = 48, h = 70 + p.options.length * (rowH + 10);
    ctx.save(); ctx.fillStyle = 'rgba(11,0,26,.86)'; rr(ctx, x, y, w, h, 22); ctx.fill(); ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.stroke();
    ctx.fillStyle = C.yellow; ctx.font = `700 12px ${M}`; ctx.fillText(p.closed ? 'POLL · CLOSED' : 'POLL · VOTE IN CHAT', x + 22, y + 28);
    ctx.fillStyle = C.paper; ctx.font = `800 22px ${D}`; ctx.fillText(p.q.slice(0, 30), x + 22, y + 56);
    const total = p.total || 0; G._pollAnim = G._pollAnim || {};
    p.options.forEach((o, i) => {
      const pct = total ? p.counts[i] / total : 0; const k = p.id + i; const cur = G._pollAnim[k] ?? 0; const v = cur + (pct - cur) * .12; G._pollAnim[k] = v;
      const ry = y + 72 + i * (rowH + 10); ctx.fillStyle = 'rgba(255,255,255,.08)'; rr(ctx, x + 18, ry, w - 36, rowH, 14); ctx.fill();
      ctx.fillStyle = i === 0 ? C.violet : i === 1 ? C.cyan : i === 2 ? C.lime : C.yellow; ctx.globalAlpha = .85; rr(ctx, x + 18, ry, Math.max(14, (w - 36) * v), rowH, 14); ctx.fill(); ctx.globalAlpha = 1;
      ctx.fillStyle = C.paper; ctx.font = `700 17px ${B}`; ctx.fillText(o.slice(0, 26), x + 34, ry + 30); ctx.font = `800 17px ${M}`; ctx.textAlign = 'right'; ctx.fillText(`${Math.round(v * 100)}%`, x + w - 34, ry + 30); ctx.textAlign = 'left';
    });
    ctx.restore();
  }
  function drawParticles(ctx) {
    const now = performance.now();
    G.particles = G.particles.filter((q) => now - q.born < q.life);
    for (const q of G.particles) {
      const age = now - q.born; if (age < 0) continue; const k = age / q.life;
      const x = q.x + q.vx * age + Math.sin(age / 300 + q.sway) * 14, y = q.y + q.vy * age;
      const s = q.s * (age < 220 ? ease.back(age / 220) : 1) * (1 - k * .3);
      ctx.save(); ctx.globalAlpha = k > .7 ? (1 - k) / .3 : 1; ctx.font = `${s}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`; ctx.textAlign = 'center'; ctx.fillText(q.e, x, y); ctx.restore();
    }
  }
  function drawTransition(ctx, t, W, H) {
    const r = G.transition.run; if (!r) return;
    const k = clamp((performance.now() - r.t0) / 650); if (k >= 1) { G.transition.run = null; return; }
    ctx.save();
    if (r.kind === 'fade') { ctx.globalAlpha = 1 - ease.inOut(k); ctx.drawImage(r.snap, 0, 0, W, H); }
    if (r.kind === 'zoom') { const s = 1 + ease.inOut(k) * .35; ctx.globalAlpha = 1 - ease.out(k); ctx.translate(W / 2, H / 2); ctx.scale(s, s); ctx.drawImage(r.snap, -W / 2, -H / 2, W, H); }
    if (r.kind === 'stripe') {
      const e = ease.inOut(k), edge = -H + e * (W + H * 2);
      ctx.beginPath(); ctx.moveTo(edge, 0); ctx.lineTo(W + H, 0); ctx.lineTo(W + H, H); ctx.lineTo(edge - H * .5, H); ctx.closePath(); ctx.save(); ctx.clip(); ctx.drawImage(r.snap, 0, 0, W, H); ctx.restore();
      const g = ctx.createLinearGradient(edge - 80, 0, edge + 40, 0); g.addColorStop(0, C.violet); g.addColorStop(1, C.cyan);
      ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(edge - 70, 0); ctx.lineTo(edge, 0); ctx.lineTo(edge - H * .5, H); ctx.lineTo(edge - H * .5 - 70, H); ctx.fill();
    }
    if (r.kind === 'glitch') {
      const slices = 14, sh = H / slices; for (let i = 0; i < slices; i++) { if (Math.random() < k * 1.3) continue; const off = (Math.random() - .5) * 120 * k; ctx.drawImage(r.snap, 0, i * sh * (r.snap.height / H), r.snap.width, sh * (r.snap.height / H), off, i * sh, W, sh); }
      ctx.globalCompositeOperation = 'screen'; ctx.fillStyle = `rgba(0,229,255,${.25 * (1 - k)})`; ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
  }

  function boot() {
    if (!window.NebuStudio) return setTimeout(boot, 50);
    NebuStudio.addOverlay((ctx, t, W, H) => { drawStickers(ctx, t); drawLT(ctx, t, W, H); drawOverlays(ctx, t, W, H); drawPoll(ctx, t, W); drawParticles(ctx); drawTransition(ctx, t, W, H); });
    // Transition on scene layout change (buttons and keys 1-5)
    document.addEventListener('pointerdown', (e) => { const b = e.target.closest && e.target.closest('.layout'); if (b && b.getAttribute('aria-checked') !== 'true') G.startTransition(); }, true);
    document.addEventListener('keydown', (e) => { if (/^[1-5]$/.test(e.key) && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) G.startTransition(); }, true);
    // Drag stickers on the program canvas while editing
    const cv = document.getElementById('program'); let drag = null;
    const pt = (e) => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) * cv.width / r.width, y: (e.clientY - r.top) * cv.height / r.height }; };
    cv.addEventListener('pointerdown', (e) => {
      if (!G.editing) return; const p = pt(e);
      const hit = [...G.stickers].reverse().find((s) => Math.hypot(s.x - p.x, s.y - p.y) < s.size * s.scale / 2);
      G.selected = hit ? hit.id : null; if (hit) { drag = { s: hit, dx: hit.x - p.x, dy: hit.y - p.y }; cv.setPointerCapture(e.pointerId); }
      window.dispatchEvent(new CustomEvent('nebu:sticker-select'));
    });
    cv.addEventListener('pointermove', (e) => { if (!drag) return; const p = pt(e); drag.s.x = p.x + drag.dx; drag.s.y = p.y + drag.dy; });
    cv.addEventListener('pointerup', () => { drag = null; });
    cv.addEventListener('wheel', (e) => { if (!G.editing) return; const s = G.stickers.find((x) => x.id === G.selected); if (!s) return; e.preventDefault(); if (e.shiftKey) s.rot += e.deltaY * .002; else s.scale = clamp(s.scale * (1 - e.deltaY * .001), .2, 4); }, { passive: false });
  }
  boot();
})();
