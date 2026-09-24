/*
 * NEBU.QUEST — Track 3: scene module.
 * Dependency-free 2D canvas nebula rendered into #scene-hero: drifting
 * particle field, glowing scene disc, orbit rings, waveform meter.
 * No network, no CDN, no imports — runs offline from file:// and https.
 */
(function () {
  'use strict';

  if (window.__nebuScene) return;

  var NIGHT = '#0B001A';
  var PAPER = '#F7F5F2';
  var VIOLET = [157, 0, 255];
  var CYAN = [0, 229, 255];
  var LIME = [183, 255, 42];
  var MAX_PARTICLES = 600;
  var TAU = Math.PI * 2;
  var DPR_CAP = 2;

  function rgba(c, a) {
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function pickColor(r) {
    if (r < 0.45) return VIOLET;
    if (r < 0.80) return CYAN;
    return LIME;
  }

  var host = null;
  var canvas = null;
  var ctx = null;
  var W = 0;
  var H = 0;
  var S = 0;
  var cx = 0;
  var cy = 0;
  var discR = 0;
  var shade = null;

  var sprites = {};
  var particles = [];
  var blobs = [];
  var sparkles = [];
  var rings = [];

  var running = false;
  var rafId = 0;
  var last = 0;
  var t = 0;

  var userPaused = false;
  var autoPaused = false;
  var inView = true;
  var reduceMotion = false;
  var mq = null;

  var parX = 0;
  var parY = 0;
  var parTX = 0;
  var parTY = 0;
  var dragging = false;
  var lastPX = 0;
  var dragRot = 0;
  var boost = 0;
  var scrollRot = 0;
  var scrollEase = 0;
  var scrollTarget = 0;

  function makeSprite(c) {
    var s = 64;
    var c2 = document.createElement('canvas');
    c2.width = s;
    c2.height = s;
    var g = c2.getContext('2d');
    var grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.22, rgba(c, 0.9));
    grad.addColorStop(0.55, rgba(c, 0.28));
    grad.addColorStop(1, rgba(c, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
    return c2;
  }

  function resolveHost() {
    var el = document.getElementById('scene-hero');
    if (!el) return null;
    if (el instanceof window.HTMLCanvasElement) return { host: el.parentNode || document.body, canvas: el };
    var found = el.querySelector ? el.querySelector('canvas') : null;
    if (found) return { host: el, canvas: found };
    var made = document.createElement('canvas');
    el.insertBefore(made, el.firstChild);
    return { host: el, canvas: made };
  }

  function buildField() {
    var count = Math.round(MAX_PARTICLES * clamp((W * H) / (1280 * 720), 0.35, 1));
    particles = [];
    for (var i = 0; i < count; i++) {
      var dir = Math.random() < 0.72 ? 1 : -1;
      particles.push({
        r: 0.08 + 0.85 * Math.sqrt(Math.random()),
        a: Math.random() * TAU,
        sp: dir * (0.015 + Math.random() * 0.075),
        sz: 1 + Math.random() * 2.4,
        dep: 0.25 + Math.random() * 0.75,
        c: pickColor(Math.random()),
        tw: 0.6 + Math.random() * 2.4,
        ph: Math.random() * TAU,
        front: Math.random() < 0.12
      });
    }
    blobs = [
      { fx: 0.22, fy: 0.30, fr: 0.55, c: VIOLET, a: 0.16, ph: 0.0 },
      { fx: 0.80, fy: 0.62, fr: 0.48, c: CYAN, a: 0.12, ph: 2.1 },
      { fx: 0.58, fy: 0.16, fr: 0.38, c: VIOLET, a: 0.12, ph: 4.2 },
      { fx: 0.15, fy: 0.85, fr: 0.34, c: LIME, a: 0.07, ph: 5.3 }
    ];
    sparkles = [];
    for (var k = 0; k < 6; k++) {
      sparkles.push({
        fx: 0.08 + Math.random() * 0.84,
        fy: 0.08 + Math.random() * 0.84,
        sz: 5 + Math.random() * 9,
        ph: Math.random() * TAU,
        sp: 0.9 + Math.random() * 0.8
      });
    }
    rings = [
      { fr: 1.5, tilt: -0.42, squash: 0.42, sp: 0.34, ph: 0.6, c: CYAN },
      { fr: 1.95, tilt: 0.30, squash: 0.5, sp: -0.22, ph: 2.4, c: VIOLET },
      { fr: 2.45, tilt: -0.18, squash: 0.38, sp: 0.15, ph: 4.1, c: LIME }
    ];
  }

  function resize() {
    if (!host || !canvas) return;
    var w = host.clientWidth || window.innerWidth || 800;
    var h = host.clientHeight || Math.round((window.innerHeight || 600) * 0.8) || 600;
    if (w < 2 || h < 2) return;
    var dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    W = w;
    H = h;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    S = Math.min(W, H);
    cx = W * 0.5;
    cy = H * 0.52;
    discR = Math.max(56, S * 0.15);
    shade = ctx.createLinearGradient(0, 0, 0, H);
    shade.addColorStop(0, 'rgba(11,0,26,0)');
    shade.addColorStop(1, 'rgba(4,0,12,0.55)');
  }

  function drawParticle(p, time) {
    var breathe = 1 + 0.03 * Math.sin(time * 0.3 + p.ph);
    var R = p.r * S * breathe;
    var ang = p.a + time * p.sp + dragRot + scrollRot;
    var x = cx + Math.cos(ang) * R + parX * 34 * p.dep;
    var y = cy + Math.sin(ang) * R * 0.86 + parY * 34 * p.dep - scrollEase * 70 * p.dep;
    var tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(time * p.tw + p.ph));
    var d = p.sz * (0.5 + p.dep) * clamp(S / 700, 0.6, 1.15);
    var key = p.c === VIOLET ? 'v' : p.c === CYAN ? 'c' : 'l';
    ctx.globalAlpha = tw * (0.35 + 0.65 * p.dep);
    ctx.drawImage(sprites[key], x - d * 2, y - d * 2, d * 4, d * 4);
  }

  function drawBlobs(time) {
    for (var i = 0; i < blobs.length; i++) {
      var b = blobs[i];
      var x = b.fx * W + Math.sin(time * 0.07 + b.ph) * S * 0.05 + parX * 14;
      var y = b.fy * H + Math.cos(time * 0.09 + b.ph) * S * 0.05 + parY * 14;
      var r = b.fr * S;
      var g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rgba(b.c, b.a));
      g.addColorStop(1, rgba(b.c, 0));
      ctx.globalAlpha = 1;
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }

  function ringPoint(ring, ang) {
    var R = ring.fr * discR;
    var lx = Math.cos(ang) * R;
    var ly = Math.sin(ang) * R * ring.squash;
    var cos = Math.cos(ring.tilt);
    var sin = Math.sin(ring.tilt);
    return { x: cx + parX * 20 + lx * cos - ly * sin, y: cy + parY * 20 + lx * sin + ly * cos };
  }

  function drawRings(time) {
    for (var i = 0; i < rings.length; i++) {
      var ring = rings[i];
      ctx.save();
      ctx.translate(cx + parX * 20, cy + parY * 20);
      ctx.rotate(ring.tilt);
      ctx.scale(1, ring.squash);
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = rgba(ring.c, 0.55);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(0, 0, ring.fr * discR, 0, TAU);
      ctx.stroke();
      ctx.restore();
      var ang = ring.ph + time * ring.sp + dragRot * (1 + i * 0.15);
      var p = ringPoint(ring, ang);
      var key = ring.c === VIOLET ? 'v' : ring.c === CYAN ? 'c' : 'l';
      ctx.globalAlpha = 0.95;
      var d = 7 + (i === 0 ? 2 : 0);
      ctx.drawImage(sprites[key], p.x - d, p.y - d, d * 2, d * 2);
    }
    ctx.globalAlpha = 1;
  }

  function drawDisc(time) {
    var x = cx + parX * 12;
    var y = cy + parY * 12;
    var float = Math.sin(time * (TAU / 7)) * 4;
    y += float;

    var halo = ctx.createRadialGradient(x, y, discR * 0.4, x, y, discR * 3.1);
    halo.addColorStop(0, rgba(VIOLET, 0.5));
    halo.addColorStop(0.55, rgba(VIOLET, 0.16));
    halo.addColorStop(1, rgba(VIOLET, 0));
    ctx.globalAlpha = 1;
    ctx.fillStyle = halo;
    ctx.fillRect(x - discR * 3.1, y - discR * 3.1, discR * 6.2, discR * 6.2);

    var body = ctx.createRadialGradient(x - discR * 0.3, y - discR * 0.35, discR * 0.1, x, y, discR);
    body.addColorStop(0, '#D9FBFF');
    body.addColorStop(0.45, '#4DEFFF');
    body.addColorStop(1, '#008FA3');
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(x, y, discR, 0, TAU);
    ctx.fill();

    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = PAPER;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, discR + 7, time * 0.25, time * 0.25 + TAU * 0.72);
    ctx.stroke();
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = rgba(LIME, 0.9);
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 9]);
    ctx.lineDashOffset = -time * 14;
    ctx.beginPath();
    ctx.arc(x, y, discR * 0.62, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    var bars = clamp(Math.round(W / 26), 15, 33);
    var bw = Math.min(5, (discR * 1.5) / bars);
    var gap = bw * 0.9;
    var total = bars * (bw + gap) - gap;
    var by = Math.min(y + discR + 36, H - 24);
    var palette = [LIME, CYAN, VIOLET];
    for (var i = 0; i < bars; i++) {
      var env = Math.pow(Math.sin((Math.PI * i) / (bars - 1)), 0.7);
      var pulse = 0.5 + 0.5 * Math.sin(time * (TAU / 1.1) + i * 0.55);
      var h = 4 + 42 * env * (0.25 + 0.75 * pulse);
      var bx = x - total / 2 + i * (bw + gap);
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = rgba(palette[i % 3], 0.95);
      ctx.fillRect(bx, by - h, bw, h);
    }
    ctx.globalAlpha = 1;
    return y;
  }

  function drawSparkles(time) {
    ctx.strokeStyle = PAPER;
    ctx.lineWidth = 1.4;
    ctx.lineCap = 'round';
    for (var i = 0; i < sparkles.length; i++) {
      var s = sparkles[i];
      var tw = 0.5 + 0.5 * Math.sin(time * s.sp * (TAU / 4.5) + s.ph);
      var r = s.sz * (0.4 + 0.6 * tw);
      var x = s.fx * W + parX * 26;
      var y = s.fy * H + parY * 26;
      ctx.globalAlpha = 0.25 + 0.65 * tw;
      ctx.beginPath();
      ctx.moveTo(x - r, y);
      ctx.lineTo(x + r, y);
      ctx.moveTo(x, y - r);
      ctx.lineTo(x, y + r);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function draw(time) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = NIGHT;
    ctx.fillRect(0, 0, W, H);

    ctx.globalCompositeOperation = 'lighter';
    drawBlobs(time);
    var i;
    for (i = 0; i < particles.length; i++) {
      if (!particles[i].front) drawParticle(particles[i], time);
    }
    ctx.globalCompositeOperation = 'source-over';
    drawRings(time);
    drawDisc(time);
    ctx.globalCompositeOperation = 'lighter';
    for (i = 0; i < particles.length; i++) {
      if (particles[i].front) drawParticle(particles[i], time);
    }
    drawSparkles(time);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, W, H);
  }

  function frame(now) {
    if (!running) return;
    rafId = window.requestAnimationFrame(frame);
    var dt = clamp((now - last) / 1000, 0.001, 0.05);
    last = now;
    t += dt;

    var k = Math.min(1, dt * 4);
    parX += (parTX - parX) * k;
    parY += (parTY - parY) * k;
    scrollRot += (scrollTarget * 1.1 - scrollRot) * Math.min(1, dt * 3);
    scrollEase += (scrollTarget - scrollEase) * Math.min(1, dt * 3);
    if (!dragging) {
      dragRot += boost * dt;
      boost *= Math.exp(-2.2 * dt);
      if (Math.abs(boost) < 0.0005) boost = 0;
    }
    draw(t);
  }

  function evaluateAuto() {
    autoPaused = document.hidden || !inView || reduceMotion;
    if (autoPaused) {
      stop();
    } else if (!userPaused) {
      start();
    }
  }

  function start() {
    if (running || userPaused || autoPaused) return;
    running = true;
    last = window.performance ? window.performance.now() : Date.now();
    rafId = window.requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    if (rafId) window.cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function onScroll() {
    var y = window.scrollY || 0;
    scrollTarget = clamp(y / 900, 0, 1);
  }

  function bindPointer() {
    canvas.addEventListener('pointerdown', function (e) {
      dragging = true;
      lastPX = e.clientX;
      boost = 0;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch (err) { /* noop */ }
    });
    canvas.addEventListener('pointermove', function (e) {
      var rect = canvas.getBoundingClientRect();
      parTX = clamp(((e.clientX - rect.left) / rect.width - 0.5) * 2, -1, 1);
      parTY = clamp(((e.clientY - rect.top) / rect.height - 0.5) * 2, -1, 1);
      if (dragging) {
        var dx = e.clientX - lastPX;
        lastPX = e.clientX;
        dragRot += dx * 0.004;
        boost = boost * 0.75 + (dx * 0.004) * 0.25 * 60;
        boost = clamp(boost, -6, 6);
      }
    });
    var end = function () {
      dragging = false;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', function () {
      if (!dragging) {
        parTX = 0;
        parTY = 0;
      }
    });
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  function init() {
    var resolved = resolveHost();
    if (!resolved) return;
    host = resolved.host;
    canvas = resolved.canvas;
    ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.display = 'block';
    if (!(canvas instanceof window.HTMLCanvasElement && canvas.parentNode === host && host.tagName === 'CANVAS')) {
      if (canvas.parentNode === host && host.clientWidth >= 0) {
        canvas.style.width = '100%';
        canvas.style.height = '100%';
      }
    }
    canvas.style.touchAction = 'pan-y';

    sprites = { v: makeSprite(VIOLET), c: makeSprite(CYAN), l: makeSprite(LIME) };
    resize();
    buildField();
    onScroll();

    if (window.matchMedia) {
      mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      reduceMotion = !!mq.matches;
      var onMQ = function (e) {
        reduceMotion = !!e.matches;
        evaluateAuto();
        if (reduceMotion) draw(2.0);
      };
      if (mq.addEventListener) mq.addEventListener('change', onMQ);
      else if (mq.addListener) mq.addListener(onMQ);
    }

    document.addEventListener('visibilitychange', evaluateAuto);
    window.addEventListener('resize', resize);
    if ('ResizeObserver' in window && host) {
      new window.ResizeObserver(function () {
        resize();
      }).observe(host);
    }
    if ('IntersectionObserver' in window) {
      new window.IntersectionObserver(function (entries) {
        inView = entries[0].isIntersecting;
        evaluateAuto();
      }).observe(canvas);
    }

    bindPointer();
    evaluateAuto();
    if (reduceMotion) draw(2.0);
  }

  window.__nebuScene = {
    pause: function () {
      userPaused = true;
      stop();
    },
    resume: function () {
      userPaused = false;
      if (!autoPaused) start();
    },
    isPaused: function () {
      return !running;
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
