/*
 * NEBU Studio. Everything real, nothing faked:
 *  - sources: camera + mic (getUserMedia, device pickers), screen/window/tab
 *    (getDisplayMedia, with tab audio), a local video file, a lower third
 *  - scene: canvas compositor, 5 layouts, 1280x720 @ 30 fps
 *  - mix: Web Audio channel strips (fader, mute, hear) with live meters
 *  - record: MediaRecorder on the program + full mix, download to device
 *  - rooms: WebRTC mesh (up to 4 people), signaling via a small Cloudflare
 *    Durable Object; media flows browser to browser (or via TURN relay)
 *  - clean feed: ?room=ID&view=clean is a receive-only page for OBS
 * No dependencies, no build.
 */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const W = 1280, H = 720, FPS = 30, MAX_PEOPLE = 4;
  const params = new URLSearchParams(location.search);
  // Branch previews and local dev talk to the preview Worker; nebu.quest talks to production.
  const PREVIEW_HOST = /(^|\.)nebu-quest\.pages\.dev$|^localhost$|^127\.0\.0\.1$/.test(location.hostname) && location.hostname !== 'nebu-quest.pages.dev';
  const SIGNAL = window.NEBU_SIGNAL = (new URLSearchParams(location.search).get('signal') && PREVIEW_HOST ? new URLSearchParams(location.search).get('signal') : (($(PREVIEW_HOST ? 'meta[name="nebu-signal-preview"]' : 'meta[name="nebu-signal"]') || $('meta[name="nebu-signal"]') || {}).content || '')).replace(/\/$/, '');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const md = navigator.mediaDevices;
  const canCapture = !!(md && md.getUserMedia);
  const canShare = !!(md && md.getDisplayMedia);
  const canRecord = typeof window.MediaRecorder === 'function' && !!HTMLCanvasElement.prototype.captureStream;
  const store = {
    get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  const COLORS = { night: '#0B001A', violet: '#9D00FF', cyan: '#00E5FF', lime: '#B7FF2A', yellow: '#FFD100', paper: '#F7F5F2', ink: '#121212' };

  const state = {
    started: false,
    cam: null, camId: store.get('nebu:cam'), mirror: false,
    mic: null, micId: store.get('nebu:mic'),
    screen: null,
    mediaUrl: '', mediaName: '',
    layout: 'cam', localLayout: 'cam',
    titleOn: false, title: '', sub: '',
    rec: null,
    takes: [],
    room: null,
  };

  const els = {
    program: $('#program'), programBox: $('#program-box'),
    media: $('#media'),
    toast: $('#toast'),
  };
  const camEl = hiddenVideo();
  const screenEl = hiddenVideo();

  function hiddenVideo() {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.autoplay = true;
    return v;
  }

  /* ------------------------------------------------------------ UI utils */
  let toastTimer = 0;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('is-on'), 2400);
  }
  function note(msg) { $('#stage-note').textContent = msg || ''; }
  function setSwitch(el, on) { el.setAttribute('aria-checked', String(!!on)); }
  function fmtTime(s) { s = Math.max(0, Math.floor(s)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }
  function fmtBytes(b) { return b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB'; }
  function stamp(d = new Date()) { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }
  async function copy(text, okMsg) {
    try { await navigator.clipboard.writeText(text); toast(okMsg || 'Copied'); return true; }
    catch {
      const a = document.createElement('textarea'); a.value = text; a.style.position = 'fixed'; a.style.opacity = '0';
      document.body.append(a); a.select(); let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; }
      a.remove(); toast(ok ? (okMsg || 'Copied') : 'Copy failed. Select the link and copy it.'); return ok;
    }
  }
  function errText(err, what) {
    const n = err && err.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return `${what} access was blocked. Allow it in your browser's site settings, then try again.`;
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return `No ${what.toLowerCase()} found on this device.`;
    if (n === 'NotReadableError' || n === 'AbortError') return `Your ${what.toLowerCase()} is busy in another app. Close it there and try again.`;
    return `${what} could not start${err && err.message ? ': ' + err.message : '.'}`;
  }

  /* ------------------------------------------------------------ audio */
  let ac = null, recBus, sendBus, masterGain, sendMaster, masterAnalyser, recDest, sendDest;
  const channels = {};
  const CHANNEL_DEFS = [
    { key: 'mic', label: 'Mic', sub: 'Your voice', send: true, hear: false },
    { key: 'screen', label: 'Screen', sub: 'Tab audio', send: true, hear: false },
    { key: 'video', label: 'Video', sub: 'File', send: true, hear: true },
    { key: 'room', label: 'Room', sub: 'Your people', send: false, hear: true },
  ];

  function ensureAudio() {
    if (ac) { if (ac.state === 'suspended') ac.resume(); return ac; }
    const AC = window.AudioContext || window.webkitAudioContext;
    ac = new AC({ latencyHint: 'interactive' });
    recBus = ac.createGain(); sendBus = ac.createGain();
    masterGain = ac.createGain(); sendMaster = ac.createGain();
    masterAnalyser = ac.createAnalyser(); masterAnalyser.fftSize = 1024;
    recDest = ac.createMediaStreamDestination(); sendDest = ac.createMediaStreamDestination();
    recBus.connect(masterGain); masterGain.connect(masterAnalyser); masterGain.connect(recDest);
    sendBus.connect(sendMaster); sendMaster.connect(sendDest);
    for (const d of CHANNEL_DEFS) {
      const input = ac.createGain(), fader = ac.createGain(), mute = ac.createGain(), hear = ac.createGain();
      const analyser = ac.createAnalyser(); analyser.fftSize = 1024;
      hear.gain.value = d.hear ? 1 : 0;
      input.connect(fader); fader.connect(mute); mute.connect(analyser);
      mute.connect(recBus); if (d.send) mute.connect(sendBus);
      mute.connect(hear); hear.connect(ac.destination);
      channels[d.key] = { ...d, input, fader, mute, hearGain: hear, analyser, node: null, lvl: 0, pk: 0, pkT: 0, live: false };
    }
    channels.master = { key: 'master', analyser: masterAnalyser, lvl: 0, pk: 0, pkT: 0, live: true };
    buildStrips();
    return ac;
  }

  function attachStream(key, stream) {
    const ch = channels[key];
    if (!ch) return;
    if (ch.node) { try { ch.node.disconnect(); } catch { /* */ } ch.node = null; }
    if (stream && stream.getAudioTracks().length) {
      ch.node = ac.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      ch.node.connect(ch.input);
    }
    setLive(key, !!ch.node);
  }
  function setLive(key, live) {
    const ch = channels[key]; if (!ch) return;
    ch.live = live;
    const strip = $(`.strip[data-ch="${key}"]`);
    if (strip) strip.classList.toggle('is-idle', !live);
  }

  function buildStrips() {
    const host = $('#strips');
    const rows = CHANNEL_DEFS.concat([{ key: 'master', label: 'Master', sub: 'Record mix', master: true }]);
    host.innerHTML = rows.map((d) => `
      <div class="strip${d.master ? ' is-master' : ' is-idle'}" data-ch="${d.key}">
        <span class="strip-name">${d.label}<small>${d.sub}</small></span>
        <div class="meter" role="meter" aria-label="${d.label} level" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i class="meter-fill"></i><i class="meter-peak"></i><i class="meter-ticks"></i></div>
        <div class="strip-btns">
          ${d.master ? '' : `<button type="button" class="tog tog-mute" aria-pressed="false" aria-label="Mute ${d.label}">MUTE</button>
          <button type="button" class="tog tog-hear" aria-pressed="${d.hear ? 'true' : 'false'}" aria-label="Hear ${d.label} on your speakers">HEAR</button>`}
        </div>
        <div class="fader-row"><input class="fader" type="range" min="0" max="150" value="100" aria-label="${d.label} volume"><span class="fader-val">100%</span></div>
      </div>`).join('');
    $$('.strip', host).forEach((strip) => {
      const key = strip.dataset.ch;
      const fader = $('.fader', strip), val = $('.fader-val', strip);
      fader.addEventListener('input', () => {
        const g = fader.value / 100;
        val.textContent = fader.value + '%';
        if (key === 'master') { masterGain.gain.setTargetAtTime(g, ac.currentTime, .02); sendMaster.gain.setTargetAtTime(g, ac.currentTime, .02); }
        else channels[key].fader.gain.setTargetAtTime(g, ac.currentTime, .02);
      });
      const m = $('.tog-mute', strip), h = $('.tog-hear', strip);
      if (m) m.addEventListener('click', () => {
        const on = m.getAttribute('aria-pressed') !== 'true';
        m.setAttribute('aria-pressed', String(on));
        channels[key].mute.gain.setTargetAtTime(on ? 0 : 1, ac.currentTime, .01);
      });
      if (h) h.addEventListener('click', () => {
        const on = h.getAttribute('aria-pressed') !== 'true';
        h.setAttribute('aria-pressed', String(on));
        channels[key].hearGain.gain.setTargetAtTime(on ? 1 : 0, ac.currentTime, .01);
      });
    });
    ['mic', 'screen', 'video', 'room'].forEach((k) => setLive(k, !!(channels[k] && channels[k].node) || (k === 'room' && channels.room.peerNodes && channels.room.peerNodes.size)));
  }

  const buf = new Float32Array(1024);
  function meterLoop(now) {
    if (ac) {
      for (const key of Object.keys(channels)) {
        const ch = channels[key];
        ch.analyser.getFloatTimeDomainData(buf);
        let sum = 0, peak = 0;
        for (let i = 0; i < buf.length; i++) { const v = buf[i]; sum += v * v; const a = v < 0 ? -v : v; if (a > peak) peak = a; }
        const rms = Math.sqrt(sum / buf.length);
        const db = 20 * Math.log10(Math.max(rms, 1e-6));
        const target = Math.min(1, Math.max(0, (db + 60) / 60));
        ch.lvl = target > ch.lvl ? target : ch.lvl + (target - ch.lvl) * 0.18;
        const pdb = 20 * Math.log10(Math.max(peak, 1e-6));
        const p = Math.min(1, Math.max(0, (pdb + 60) / 60));
        if (p >= ch.pk || now - ch.pkT > 1200) { ch.pk = p; ch.pkT = now; }
        const strip = ch.strip || (ch.strip = $(`.strip[data-ch="${key}"]`));
        if (strip) {
          strip.style.setProperty('--lvl', ch.lvl.toFixed(3));
          strip.style.setProperty('--pk', ch.pk.toFixed(3));
          const m = ch.meterEl || (ch.meterEl = $('.meter', strip));
          const n = Math.round(ch.lvl * 100);
          if (m && m._n !== n) { m.setAttribute('aria-valuenow', String(n)); m._n = n; }
        }
      }
    }
    requestAnimationFrame(meterLoop);
  }

  /* ------------------------------------------------------------ devices */
  async function refreshDevices() {
    if (!md || !md.enumerateDevices) return;
    const list = await md.enumerateDevices();
    fillSelect($('#cam-select'), list.filter((d) => d.kind === 'videoinput'), state.cam, 'Camera');
    fillSelect($('#mic-select'), list.filter((d) => d.kind === 'audioinput'), state.mic, 'Microphone');
  }
  function fillSelect(sel, devices, stream, word) {
    const current = stream && stream.getTracks()[0] ? stream.getTracks()[0].getSettings().deviceId : '';
    if (!devices.length) { sel.innerHTML = `<option>No ${word.toLowerCase()} found</option>`; sel.disabled = true; return; }
    sel.innerHTML = devices.map((d, i) => `<option value="${d.deviceId}">${escapeHtml(d.label || `${word} ${i + 1}`)}</option>`).join('');
    sel.disabled = false;
    const want = current || (word === 'Camera' ? state.camId : state.micId);
    if (want && devices.some((d) => d.deviceId === want)) sel.value = want;
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  async function startCam(deviceId) {
    stopCam(true);
    const video = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
    if (deviceId) video.deviceId = { exact: deviceId };
    try {
      state.cam = await md.getUserMedia({ video });
    } catch (err) {
      if (deviceId && err.name === 'OverconstrainedError') return startCam('');
      setSwitch($('#cam-toggle'), false); note(errText(err, 'Camera')); return false;
    }
    useCamStream(state.cam);
    return true;
  }
  function useCamStream(stream) {
    state.cam = stream;
    camEl.srcObject = stream; camEl.play().catch(() => {});
    const t = stream.getVideoTracks()[0];
    state.camId = t.getSettings().deviceId || ''; store.set('nebu:cam', state.camId);
    t.addEventListener('ended', () => { stopCam(); note('Camera disconnected.'); });
    setSwitch($('#cam-toggle'), true);
    $('[data-src="camera"]').classList.add('is-live');
    refreshDevices();
  }
  function stopCam(silent) {
    if (state.cam) state.cam.getTracks().forEach((t) => t.stop());
    state.cam = null; camEl.srcObject = null;
    if (!silent) { setSwitch($('#cam-toggle'), false); $('[data-src="camera"]').classList.remove('is-live'); }
  }

  async function startMic(deviceId) {
    stopMic(true);
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (deviceId) audio.deviceId = { exact: deviceId };
    try {
      state.mic = await md.getUserMedia({ audio });
    } catch (err) {
      if (deviceId && err.name === 'OverconstrainedError') return startMic('');
      setSwitch($('#mic-toggle'), false); note(errText(err, 'Microphone')); return false;
    }
    useMicStream(state.mic);
    return true;
  }
  function useMicStream(stream) {
    state.mic = stream;
    const t = stream.getAudioTracks()[0];
    state.micId = t.getSettings().deviceId || ''; store.set('nebu:mic', state.micId);
    t.addEventListener('ended', () => { stopMic(); note('Microphone disconnected.'); });
    attachStream('mic', stream);
    setSwitch($('#mic-toggle'), true);
    $('[data-src="mic"]').classList.add('is-live');
    refreshDevices();
  }
  function stopMic(silent) {
    if (state.mic) state.mic.getTracks().forEach((t) => t.stop());
    state.mic = null;
    if (ac) attachStream('mic', null);
    if (!silent) { setSwitch($('#mic-toggle'), false); $('[data-src="mic"]').classList.remove('is-live'); }
  }

  async function startScreen() {
    try {
      const s = await md.getDisplayMedia({ video: { frameRate: { ideal: 30 }, width: { ideal: 1920 } }, audio: true, selfBrowserSurface: 'exclude', systemAudio: 'include' });
      stopScreen(true);
      state.screen = s;
      screenEl.srcObject = s; screenEl.play().catch(() => {});
      s.getVideoTracks()[0].addEventListener('ended', () => stopScreen());
      attachStream('screen', s);
      const hasAudio = s.getAudioTracks().length > 0;
      $('#screen-state').textContent = hasAudio ? 'LIVE + AUDIO' : 'LIVE';
      $('#screen-state').classList.add('is-on');
      $('#screen-btn').textContent = 'Stop sharing';
      $('[data-src="screen"]').classList.add('is-live');
      $('#screen-note').textContent = hasAudio ? 'Tab audio is in the mix.' : 'No audio came with this share. Pick a tab and tick "Share tab audio" to add it.';
      if (state.layout === 'cam') selectLayout(state.cam ? 'pip' : 'screen');
    } catch (err) {
      if (err && err.name !== 'NotAllowedError') note(errText(err, 'Screen share'));
    }
  }
  function stopScreen(silent) {
    if (state.screen) state.screen.getTracks().forEach((t) => t.stop());
    state.screen = null; screenEl.srcObject = null;
    if (ac) attachStream('screen', null);
    if (!silent) {
      $('#screen-state').textContent = 'OFF'; $('#screen-state').classList.remove('is-on');
      $('#screen-btn').textContent = 'Share a screen, window or tab';
      $('[data-src="screen"]').classList.remove('is-live');
      $('#screen-note').textContent = 'Pick a tab to bring its audio into the mix.';
    }
  }

  let mediaNode = null;
  function loadMedia(file) {
    if (!file) return;
    ensureAudio();
    const v = els.media;
    if (!mediaNode) { mediaNode = ac.createMediaElementSource(v); mediaNode.connect(channels.video.input); }
    if (state.mediaUrl) URL.revokeObjectURL(state.mediaUrl);
    state.mediaUrl = URL.createObjectURL(file); state.mediaName = file.name;
    v.src = state.mediaUrl; v.loop = $('#video-loop').checked;
    v.play().then(() => { $('#video-play').textContent = 'Pause'; }).catch(() => {});
    channels.video.node = mediaNode; setLive('video', true);
    $('#video-state').textContent = 'READY'; $('#video-state').classList.add('is-on');
    $('#video-controls').hidden = false;
    $('[data-src="video"]').classList.add('is-live');
    $('.file-btn span').textContent = file.name.length > 30 ? file.name.slice(0, 27) + '…' : file.name;
    if (state.layout === 'cam') selectLayout(state.cam ? 'pip' : 'screen');
  }
  function clearMedia() {
    const v = els.media; v.pause(); v.removeAttribute('src'); v.load();
    if (state.mediaUrl) URL.revokeObjectURL(state.mediaUrl);
    state.mediaUrl = ''; state.mediaName = '';
    if (channels.video) { channels.video.node = null; setLive('video', false); }
    $('#video-state').textContent = 'NONE'; $('#video-state').classList.remove('is-on');
    $('#video-controls').hidden = true;
    $('[data-src="video"]').classList.remove('is-live');
    $('.file-btn span').textContent = 'Line up a video file';
    $('#video-file').value = '';
  }

  /* ------------------------------------------------------------ compositor */
  const pctx = els.program.getContext('2d', { alpha: false });
  const scene = document.createElement('canvas'); scene.width = W; scene.height = H;
  const sctx = scene.getContext('2d', { alpha: false });
  const mark = new Image(); mark.src = '../assets/nebu-mark-yellow.svg';

  const ready = (el) => el && el.readyState >= 2 && el.videoWidth > 0;
  const hasCam = () => !!state.cam && ready(camEl);
  const content = () => (state.screen && ready(screenEl) ? screenEl : (state.mediaUrl && ready(els.media) ? els.media : null));

  function cover(ctx, el, x, y, w, h, mirror) {
    const vw = el.videoWidth || el.width, vh = el.videoHeight || el.height;
    const s = Math.max(w / vw, h / vh), sw = w / s, sh = h / s;
    ctx.save();
    if (mirror) { ctx.translate(x + w, y); ctx.scale(-1, 1); x = 0; y = 0; }
    ctx.drawImage(el, (vw - sw) / 2, (vh - sh) / 2, sw, sh, mirror ? 0 : x, mirror ? 0 : y, w, h);
    ctx.restore();
  }
  function contain(ctx, el, x, y, w, h) {
    const vw = el.videoWidth || el.width, vh = el.videoHeight || el.height;
    const s = Math.min(w / vw, h / vh), dw = vw * s, dh = vh * s;
    ctx.drawImage(el, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }
  function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }
  function tile(ctx, draw, x, y, w, h, r = 22) {
    ctx.save();
    ctx.fillStyle = '#000'; rr(ctx, x + 6, y + 8, w, h, r); ctx.fill();
    rr(ctx, x, y, w, h, r); ctx.clip();
    ctx.fillStyle = '#05000D'; ctx.fillRect(x, y, w, h);
    draw(x, y, w, h);
    ctx.restore();
    ctx.save(); ctx.lineWidth = 4; ctx.strokeStyle = COLORS.ink; rr(ctx, x, y, w, h, r); ctx.stroke(); ctx.restore();
  }

  function backdrop(ctx, t) {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#12002A'); g.addColorStop(1, COLORS.night);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    const drift = reduceMotion ? 0 : t / 6000;
    const blob = (cx, cy, r, c, a) => {
      const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      rg.addColorStop(0, `rgba(${c},${a})`); rg.addColorStop(1, `rgba(${c},0)`);
      ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
    };
    blob(W * (.25 + .08 * Math.sin(drift)), H * (.3 + .06 * Math.cos(drift * 1.3)), 520, '157,0,255', .42);
    blob(W * (.8 + .06 * Math.cos(drift * .9)), H * (.78 + .05 * Math.sin(drift)), 420, '0,229,255', .16);
    ctx.fillStyle = 'rgba(255,255,255,.035)';
    for (let x = 0; x < W; x += 64) ctx.fillRect(x, 0, 1, H);
    for (let y = 0; y < H; y += 64) ctx.fillRect(0, y, W, 1);
  }
  function empty(ctx, t, msg) {
    backdrop(ctx, t);
    if (mark.complete && mark.naturalWidth) {
      const bob = reduceMotion ? 0 : Math.sin(t / 900) * 6;
      ctx.drawImage(mark, W / 2 - 90, H / 2 - 120 + bob, 180, 144);
    }
    ctx.fillStyle = COLORS.paper; ctx.textAlign = 'center';
    ctx.font = '800 40px "Bricolage Grotesque", Manrope, sans-serif';
    ctx.fillText(msg || 'Add a source.', W / 2, H / 2 + 80);
    ctx.font = '500 15px Manrope, sans-serif'; ctx.fillStyle = 'rgba(247,245,242,.6)';
    ctx.fillText('Camera, screen or a video file. Everything stays in this tab.', W / 2, H / 2 + 112);
    ctx.textAlign = 'left';
  }

  function drawLocal(ctx, layout, t) {
    const cam = hasCam(), c = content();
    if (layout === 'screen' || layout === 'pip' || layout === 'split') {
      if (!c) layout = 'cam';
    }
    if (layout === 'split' && !cam) layout = 'screen';
    if (layout === 'cam' && !cam) layout = c ? 'screen' : 'none';
    if (layout === 'none') { empty(ctx, t); return; }
    if (layout === 'cam') { cover(ctx, camEl, 0, 0, W, H, state.mirror); return; }
    backdrop(ctx, t);
    if (layout === 'screen') { contain(ctx, c, 0, 0, W, H); return; }
    if (layout === 'pip') {
      contain(ctx, c, 0, 0, W, H);
      if (cam) {
        const w = 336, h = 189, x = W - w - 36, y = H - h - 40;
        tile(ctx, (x, y, w, h) => cover(ctx, camEl, x, y, w, h, state.mirror), x, y, w, h, 20);
      }
      return;
    }
    if (layout === 'split') {
      const g = 40, w = (W - g * 3) / 2, h = w * 9 / 16, y = (H - h) / 2;
      tile(ctx, (x, y, w, h) => cover(ctx, camEl, x, y, w, h, state.mirror), g, y, w, h);
      tile(ctx, (x, y, w, h) => contain(ctx, c, x, y, w, h), g * 2 + w, y, w, h);
    }
  }

  function drawTitle(ctx, t) {
    if (!state.titleOn || !(state.title || state.sub)) return;
    const x = 48, y = H - 150;
    ctx.save();
    ctx.font = '800 38px "Bricolage Grotesque", Manrope, sans-serif';
    const tw = ctx.measureText(state.title || ' ').width;
    ctx.font = '600 18px Manrope, sans-serif';
    const sw = ctx.measureText(state.sub || '').width;
    const w = Math.max(tw, sw) + 56;
    const hasSub = !!state.sub;
    ctx.fillStyle = '#000'; rr(ctx, x + 6, y + 7, w, hasSub ? 98 : 64, 14); ctx.fill();
    ctx.fillStyle = COLORS.yellow; rr(ctx, x, y, w, hasSub ? 98 : 64, 14); ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = COLORS.ink; ctx.stroke();
    ctx.fillStyle = COLORS.ink; ctx.font = '800 38px "Bricolage Grotesque", Manrope, sans-serif';
    ctx.fillText(state.title, x + 28, y + 45);
    if (hasSub) { ctx.font = '600 18px Manrope, sans-serif'; ctx.fillStyle = 'rgba(18,18,18,.78)'; ctx.fillText(state.sub, x + 28, y + 78); }
    ctx.restore();
  }

  function drawRoom(ctx, t) {
    backdrop(ctx, t);
    const tiles = [{ el: scene, name: (state.room && state.room.name) || 'You', you: true }];
    if (state.room) for (const p of state.room.peers.values()) if (p.video && ready(p.video)) tiles.push({ el: p.video, name: p.name });
    const n = tiles.length, cols = n <= 1 ? 1 : n <= 4 ? 2 : 3, rows = Math.ceil(n / cols);
    const g = 28, cw = (W - g * (cols + 1)) / cols, ch = (H - g * (rows + 1)) / rows;
    let w = cw, h = cw * 9 / 16; if (h > ch) { h = ch; w = h * 16 / 9; }
    tiles.forEach((tl, i) => {
      const r = Math.floor(i / cols), c = i % cols;
      const inRow = Math.min(cols, n - r * cols);
      const rowW = inRow * w + (inRow - 1) * g;
      const x = (W - rowW) / 2 + c * (w + g);
      const y = (H - (rows * h + (rows - 1) * g)) / 2 + r * (h + g);
      tile(ctx, (x, y, w, h) => cover(ctx, tl.el, x, y, w, h, false), x, y, w, h, 18);
      ctx.save();
      ctx.font = '700 15px Manrope, sans-serif';
      const lw = ctx.measureText(tl.name).width + 22;
      ctx.fillStyle = tl.you ? COLORS.yellow : COLORS.paper; rr(ctx, x + 14, y + h - 44, lw, 30, 15); ctx.fill();
      ctx.fillStyle = COLORS.ink; ctx.fillText(tl.name, x + 25, y + h - 23);
      ctx.restore();
    });
    if (n === 1) {
      ctx.save(); ctx.fillStyle = 'rgba(247,245,242,.7)'; ctx.font = '600 16px Manrope, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(state.room ? 'Waiting for your people. Send them the invite link.' : 'Open a room to bring people into the grid.', W / 2, H - 28);
      ctx.restore();
    }
  }

  // Extension points for nebu.js (overlays, announcement banners, TTS in the mix, chat bubble).
  const overlayHooks = [];
  window.NebuStudio = {
    size: () => ({ W, H }),
    addOverlay(fn) { overlayHooks.push(fn); },
    audio() { ensureAudio(); return { ac, recBus, sendBus, channels }; },
    sendChat(text) { const room = state.room; if (room && room.ws && room.ws.readyState === 1) { room.ws.send(JSON.stringify({ type: 'chat', text })); return true; } return false; },
    inRoom: () => Boolean(state.room),
    myId: () => (state.room && state.room.me && state.room.me.id) || null,
  };
  function render(t) {
    drawLocal(sctx, state.localLayout, t);
    drawTitle(sctx, t);
    for (const fn of overlayHooks) { try { sctx.save(); fn(sctx, t, W, H); } catch { /* keep rendering */ } finally { sctx.restore(); } }
    if (state.layout === 'room') drawRoom(pctx, t);
    else pctx.drawImage(scene, 0, 0);
  }

  // A worker-driven clock keeps the scene (and recordings) moving when the
  // tab is in the background, where requestAnimationFrame stops.
  function startClock() {
    const tick = () => render(performance.now());
    try {
      const src = `let id=setInterval(()=>postMessage(0),${Math.round(1000 / FPS)});onmessage=e=>{if(e.data==='stop')clearInterval(id)}`;
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      w.onmessage = tick;
    } catch {
      setInterval(tick, 1000 / FPS);
    }
  }

  /* ------------------------------------------------------------ layouts */
  function selectLayout(layout) {
    state.layout = layout;
    if (layout !== 'room') state.localLayout = layout;
    $$('.layout').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.layout === layout)));
    const cam = hasCam() || !!state.cam, c = !!(state.screen || state.mediaUrl);
    const tips = {
      cam: cam ? '' : 'Turn on your camera to fill this layout.',
      screen: c ? '' : 'Share a screen or line up a video for this layout.',
      pip: c && cam ? '' : 'Screen + cam needs a screen or video plus your camera.',
      split: c && cam ? '' : 'Side by side needs your camera plus a screen or video.',
      room: state.room ? 'Room grid is for you. Your people receive your scene, not the grid.' : 'Open a room to bring people into the grid.',
    };
    note(tips[layout]);
  }

  /* ------------------------------------------------------------ recording */
  function pickMime() {
    const list = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4'];
    return list.find((m) => MediaRecorder.isTypeSupported(m)) || '';
  }
  let programStream = null;
  function startRecording() {
    ensureAudio();
    if (!programStream) programStream = els.program.captureStream(FPS);
    const stream = new MediaStream([...programStream.getVideoTracks(), ...recDest.stream.getAudioTracks()]);
    const mimeType = pickMime();
    let rec;
    try { rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 160_000 }); }
    catch (err) { toast('Recording is not available in this browser.'); return; }
    const chunks = [];
    const started = performance.now();
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      const type = rec.mimeType || mimeType || 'video/webm';
      const blob = new Blob(chunks, { type });
      const dur = (performance.now() - started) / 1000;
      addTake(blob, dur, type);
    };
    rec.start(1000);
    state.rec = { rec, started, timer: setInterval(() => { $('#rec-time').textContent = fmtTime((performance.now() - started) / 1000); }, 250) };
    $('#rec-btn').setAttribute('aria-pressed', 'true');
    $('#rec-btn .rec-label').textContent = 'Stop';
    $('#rec-time').textContent = '00:00';
    els.programBox.classList.add('is-recording');
    $('#program-tag').textContent = 'REC';
    if (state.room && state.room.peers.size) toast('Recording. Let your room know.');
  }
  function stopRecording() {
    if (!state.rec) return;
    clearInterval(state.rec.timer);
    state.rec.rec.stop();
    state.rec = null;
    $('#rec-btn').setAttribute('aria-pressed', 'false');
    $('#rec-btn .rec-label').textContent = 'Record';
    els.programBox.classList.remove('is-recording');
    $('#program-tag').textContent = 'PROGRAM';
  }
  function addTake(blob, dur, type) {
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const name = `nebu-take-${stamp()}.${ext}`;
    const url = URL.createObjectURL(blob);
    state.takes.unshift({ url, name, size: blob.size, dur });
    const li = document.createElement('li');
    li.className = 'take';
    li.innerHTML = `<video src="${url}" controls playsinline preload="metadata"></video>
      <div class="take-meta"><span>${fmtTime(dur)}</span><span>${fmtBytes(blob.size)} · ${ext.toUpperCase()}</span></div>
      <div class="take-actions"><a class="btn btn-yellow btn-mini" href="${url}" download="${name}">Download</a><button type="button" class="btn btn-mini btn-quiet">Discard</button></div>`;
    $('button', li).addEventListener('click', () => { URL.revokeObjectURL(url); li.remove(); $('#takes-empty').hidden = !!$('#takes').children.length; });
    $('#takes').prepend(li);
    $('#takes-empty').hidden = true;
    toast(`Take saved: ${fmtTime(dur)}, ${fmtBytes(blob.size)}`);
    if (matchMedia('(max-width: 820px)').matches) showTab('takes');
  }

  /* ------------------------------------------------------------ rooms */
  const STUN = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
  function newRoomId() {
    const a = 'abcdefghjkmnpqrstuvwxyz23456789';
    const r = crypto.getRandomValues(new Uint8Array(12));
    const s = [...r].map((n) => a[n % a.length]).join('');
    return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
  }
  const inviteUrl = (id) => `${location.origin}${location.pathname.replace(/index\.html$/, '')}?room=${id}`;

  class Room {
    constructor(id, { name, role, onChange }) {
      this.id = id; this.name = name || 'Guest'; this.role = role || 'guest';
      this.peers = new Map(); this.onChange = onChange || (() => {});
      this.ws = null; this.me = null; this.closed = false; this.ice = STUN; this.turn = false;
      this.retries = 0;
    }
    async connect() {
      if (!SIGNAL) throw new Error('Rooms are not configured on this site.');
      // ICE (incl. short-lived TURN) arrives over the room WebSocket; /ice is retired.
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${SIGNAL.replace(/^http/, 'ws')}/rooms/${encodeURIComponent(this.id)}/ws?name=${encodeURIComponent(this.name)}&role=${this.role}`);
        this.ws = ws;
        let settled = false;
        ws.onmessage = (e) => {
          let msg; try { msg = JSON.parse(e.data); } catch { return; }
          if (msg.type === 'chat') window.dispatchEvent(new CustomEvent('nebu:chat', { detail: msg }));
          if ((msg.type === 'welcome' || msg.type === 'ice-servers') && Array.isArray(msg.iceServers)) { this.ice = msg.iceServers; this.turn = !!msg.turn; }
          if (msg.type === 'welcome' && !settled) { settled = true; resolve(); }
          if (msg.type === 'full' && !settled) { settled = true; reject(new Error(`This room is full (${msg.max} connections).`)); }
          this.handle(msg);
        };
        ws.onerror = () => { if (!settled) { settled = true; reject(new Error('Could not reach the room service.')); } };
        ws.onclose = () => {
          clearInterval(this.ping);
          if (!settled) { settled = true; reject(new Error('The room service closed the connection.')); }
          if (!this.closed) { this.onChange('lost'); this.reconnect(); }
        };
        this.ping = setInterval(() => { if (ws.readyState === 1) ws.send('{"type":"ping"}'); }, 25000);
      });
    }
    reconnect() {
      if (this.closed || this.retries > 5) { this.onChange('error'); return; }
      this.retries++;
      for (const id of [...this.peers.keys()]) this.drop(id);
      setTimeout(() => this.connect().then(() => { this.retries = 0; this.onChange(); }).catch(() => this.reconnect()), 800 * this.retries);
    }
    send(to, type, data) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ to, type, data })); }
    async handle(msg) {
      switch (msg.type) {
        case 'welcome': {
          this.me = msg.you;
          const senders = msg.peers.filter((p) => p.role !== 'viewer').length + (this.role !== 'viewer' ? 1 : 0);
          if (this.role !== 'viewer' && senders > MAX_PEOPLE) {
            this.onChange('full'); this.leave(); return;
          }
          for (const p of msg.peers) this.call(p);
          this.onChange();
          break;
        }
        case 'peer-joined': this.ensure(msg.peer); this.onChange(); break;
        case 'peer-left': this.drop(msg.id); this.onChange(); break;
        case 'offer': {
          const p = this.ensure({ id: msg.from });
          await p.pc.setRemoteDescription(msg.data);
          await p.flush();
          const answer = await p.pc.createAnswer();
          await p.pc.setLocalDescription(answer);
          this.send(msg.from, 'answer', p.pc.localDescription);
          break;
        }
        case 'answer': {
          const p = this.peers.get(msg.from);
          if (p) { await p.pc.setRemoteDescription(msg.data); await p.flush(); }
          break;
        }
        case 'ice': {
          const p = this.peers.get(msg.from);
          if (!p || !msg.data) break;
          if (p.pc.remoteDescription) { try { await p.pc.addIceCandidate(msg.data); } catch { /* stale */ } } else p.pending.push(msg.data);
          break;
        }
        case 'meta': { const p = this.peers.get(msg.from); if (p && msg.data && msg.data.name) { p.name = String(msg.data.name).slice(0, 32); this.onChange(); } break; }
        default: break;
      }
    }
    ensure(info) {
      let p = this.peers.get(info.id);
      if (p) { if (info.name && p.name === 'Guest') p.name = info.name; return p; }
      const pc = new RTCPeerConnection({ iceServers: this.ice });
      p = { id: info.id, name: info.name || 'Guest', role: info.role || 'guest', pc, pending: [], stream: null, video: null, audioNode: null, audioEl: null };
      p.flush = async () => { const q = p.pending.splice(0); for (const c of q) { try { await pc.addIceCandidate(c); } catch { /* */ } } };
      const out = this.role === 'viewer' ? null : outboundStream();
      if (out) out.getTracks().forEach((t) => pc.addTrack(t, out));
      pc.onicecandidate = (e) => { if (e.candidate) this.send(p.id, 'ice', e.candidate); };
      pc.ontrack = (e) => {
        const s = e.streams[0] || p.stream || new MediaStream();
        if (!e.streams[0]) s.addTrack(e.track);
        p.stream = s;
        onRemoteStream(this, p);
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' && p.initiator) { try { pc.restartIce(); this.offer(p, true); } catch { /* */ } }
        this.onChange();
      };
      this.peers.set(p.id, p);
      return p;
    }
    async call(info) {
      const p = this.ensure(info);
      p.initiator = true;
      if (this.role === 'viewer') { p.pc.addTransceiver('video', { direction: 'recvonly' }); p.pc.addTransceiver('audio', { direction: 'recvonly' }); }
      await this.offer(p);
      this.send(p.id, 'meta', { name: this.name });
    }
    async offer(p, restart) {
      const o = await p.pc.createOffer(restart ? { iceRestart: true } : undefined);
      await p.pc.setLocalDescription(o);
      this.send(p.id, 'offer', p.pc.localDescription);
    }
    drop(id) {
      const p = this.peers.get(id); if (!p) return;
      try { p.pc.close(); } catch { /* */ }
      if (p.audioNode) { try { p.audioNode.disconnect(); } catch { /* */ } if (channels.room && channels.room.peerNodes) channels.room.peerNodes.delete(id); }
      if (p.audioEl) { p.audioEl.srcObject = null; p.audioEl.remove(); }
      if (p.video) { p.video.srcObject = null; }
      this.peers.delete(id);
      if (channels.room) setLive('room', !!(channels.room.peerNodes && channels.room.peerNodes.size));
    }
    leave() {
      this.closed = true; clearInterval(this.ping);
      for (const id of [...this.peers.keys()]) this.drop(id);
      try { this.ws && this.ws.close(1000, 'bye'); } catch { /* */ }
    }
  }

  let outStream = null;
  function outboundStream() {
    if (outStream) return outStream;
    ensureAudio();
    const v = scene.captureStream(FPS).getVideoTracks();
    outStream = new MediaStream([...v, ...sendDest.stream.getAudioTracks()]);
    return outStream;
  }

  function onRemoteStream(room, p) {
    if (!p.video) { p.video = document.createElement('video'); p.video.playsInline = true; p.video.autoplay = true; p.video.muted = true; }
    if (p.video.srcObject !== p.stream) { p.video.srcObject = p.stream; p.video.play().catch(() => {}); }
    if (isFeed) { renderFeed(); return; }
    if (p.stream.getAudioTracks().length && ac && !p.audioNode) {
      // Chrome only feeds remote WebRTC audio into Web Audio when the stream
      // is also attached to a (muted) media element.
      p.audioEl = new Audio(); p.audioEl.muted = true; p.audioEl.srcObject = p.stream; p.audioEl.play().catch(() => {});
      p.audioNode = ac.createMediaStreamSource(p.stream);
      p.audioNode.connect(channels.room.input);
      (channels.room.peerNodes || (channels.room.peerNodes = new Map())).set(p.id, p.audioNode);
      setLive('room', true);
    }
    renderPeople();
  }

  function renderPeople() {
    const ul = $('#people'); if (!ul) return;
    const r = state.room;
    if (!r) { ul.innerHTML = ''; return; }
    const people = [...r.peers.values()];
    const senders = people.filter((p) => p.role !== 'viewer');
    const viewers = people.length - senders.length;
    ul.replaceChildren();
    const you = document.createElement('li'); you.className = 'person is-you';
    const yv = document.createElement('canvas'); yv.width = 320; yv.height = 180; yv.style.width = '100%'; yv.style.height = '100%';
    you.append(yv);
    you.insertAdjacentHTML('beforeend', `<div class="person-tag"><span>${escapeHtml(r.name)} (you)</span><span class="person-state">SENDING</span></div>`);
    ul.append(you);
    youThumb = yv.getContext('2d');
    for (const p of senders) {
      const li = document.createElement('li'); li.className = 'person'; li.dataset.state = p.pc.connectionState;
      if (p.video) li.append(p.video); else li.insertAdjacentHTML('beforeend', '<span class="person-empty">CONNECTING</span>');
      const st = { connected: 'LIVE', connecting: 'JOINING', new: 'JOINING', failed: 'NO PATH', disconnected: 'RECONNECTING', closed: 'LEFT' }[p.pc.connectionState] || '';
      li.insertAdjacentHTML('beforeend', `<div class="person-tag"><span>${escapeHtml(p.name)}</span><span class="person-state">${st}</span></div>`);
      ul.append(li);
      if (p.video && p.video.paused) p.video.play().catch(() => {});
    }
    const count = senders.length + 1;
    let status = `${count} of ${MAX_PEOPLE} in the room`;
    if (viewers) status += ` · ${viewers} feed${viewers > 1 ? 's' : ''} watching`;
    if (senders.some((p) => p.pc.connectionState === 'failed')) status += r.turn ? '. One connection could not be made.' : '. One connection found no direct path (no relay on this deployment).';
    $('#room-status').textContent = status;
    setPill('on', `Room ${r.id} · ${count}`);
  }
  let youThumb = null;
  setInterval(() => { if (youThumb) youThumb.drawImage(scene, 0, 0, 320, 180); }, 200);

  function setPill(stateName, text) {
    const pill = $('#room-pill'); pill.dataset.state = stateName; $('span', pill).textContent = text;
    const meta = $('#meta-room'); if (meta) meta.textContent = stateName === 'off' ? 'Off' : text;
  }

  async function openRoom(id) {
    if (state.room) return;
    const name = ($('#my-name').value || $('#gate-name').value || '').trim() || 'Host';
    store.set('nebu:name', name);
    $('#my-name').value = name;
    const roomId = id || newRoomId();
    setPill('connecting', 'Connecting…');
    $('#room-open').disabled = true;
    const room = new Room(roomId, {
      name, role: 'guest',
      onChange: (why) => {
        if (why === 'full') { toast(`This room already has ${MAX_PEOPLE} people.`); closeRoom(); return; }
        if (why === 'lost') { setPill('connecting', 'Reconnecting…'); return; }
        if (why === 'error') { setPill('error', 'Room lost'); $('#room-status').textContent = 'Lost the connection to the room service.'; return; }
        renderPeople();
      },
    });
    state.room = room;
    try {
      await room.connect();
      if (state.room !== room) return;
    } catch (err) {
      state.room = null; room.leave();
      setPill('error', 'Room unavailable');
      $('#room-status').textContent = err.message;
      $('#room-open').disabled = false;
      return;
    }
    const url = inviteUrl(roomId);
    history.replaceState(null, '', `?room=${roomId}`);
    $('#invite-url').textContent = url;
    $('#room-off').hidden = true; $('#room-on').hidden = false;
    $('#top-invite').hidden = false;
    $('#room-open').disabled = false;
    renderPeople();
    toast(id ? 'You joined the room.' : 'Room open. Send the link.');
  }
  function closeRoom() {
    if (!state.room) return;
    state.room.leave(); state.room = null; youThumb = null;
    history.replaceState(null, '', location.pathname);
    $('#room-off').hidden = false; $('#room-on').hidden = true; $('#top-invite').hidden = true;
    $('#people').innerHTML = ''; $('#room-status').textContent = '';
    setPill('off', 'No room');
    if (state.layout === 'room') selectLayout(state.localLayout);
  }

  function icsFile(url) {
    const when = $('#cal-when').value ? new Date($('#cal-when').value) : new Date(Date.now() + 3600e3);
    const len = Math.max(5, Math.min(480, Number($('#cal-len').value) || 30));
    const end = new Date(when.getTime() + len * 60e3);
    const z = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const body = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//NEBU//Studio//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'BEGIN:VEVENT', `UID:${state.room.id}-${Date.now()}@nebu.quest`, `DTSTAMP:${z(new Date())}`, `DTSTART:${z(when)}`, `DTEND:${z(end)}`,
      'SUMMARY:NEBU room', `DESCRIPTION:Join from your browser: ${url}`, `URL:${url}`, `LOCATION:${url}`, 'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([body], { type: 'text/calendar' }));
    a.download = `nebu-room-${state.room.id}.ics`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  /* ------------------------------------------------------------ clean feed */
  const isFeed = params.get('view') === 'clean' && !!params.get('room');
  let feedRoom = null;
  function renderFeed() {
    const grid = $('#feed-grid');
    const vids = [...feedRoom.peers.values()].filter((p) => p.video && p.role !== 'viewer');
    grid.style.setProperty('--cols', vids.length <= 1 ? 1 : 2);
    grid.replaceChildren(...vids.map((p) => { p.video.muted = false; p.video.play().catch(() => { $('#feed-unmute').hidden = false; }); return p.video; }));
    $('#feed-wait').hidden = vids.length > 0;
  }
  async function startFeed() {
    document.body.classList.add('is-feed');
    $('#feed').hidden = false;
    feedRoom = new Room(params.get('room').toLowerCase(), { name: 'OBS feed', role: 'viewer', onChange: renderFeed });
    try { await feedRoom.connect(); } catch (err) { $('#feed-wait').textContent = err.message; }
    $('#feed-unmute').addEventListener('click', () => { $('#feed-unmute').hidden = true; renderFeed(); });
  }

  /* ------------------------------------------------------------ tabs (mobile) */
  function showTab(name) {
    $$('.st-tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === name)));
    $$('.panel[data-panel]').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === name));
  }

  /* ------------------------------------------------------------ boot */
  async function start(withDevices) {
    ensureAudio();
    const err = $('#gate-error'); err.textContent = '';
    if (withDevices) {
      if (!canCapture) { err.textContent = window.isSecureContext ? 'This browser cannot open a camera or microphone.' : 'Camera and mic need a secure (https) page.'; return; }
      $('#gate-go').disabled = true;
      let got = false;
      try {
        const s = await md.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, deviceId: state.camId ? { ideal: state.camId } : undefined },
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, deviceId: state.micId ? { ideal: state.micId } : undefined },
        });
        useCamStream(new MediaStream(s.getVideoTracks()));
        useMicStream(new MediaStream(s.getAudioTracks()));
        got = true;
      } catch (e1) {
        // Maybe only one of them exists or is allowed; try each on its own.
        const c = await startCam(''), m = await startMic('');
        got = c || m;
        if (!got) { err.textContent = errText(e1, 'Camera and microphone'); $('#gate-go').disabled = false; return; }
        note('');
      }
    }
    state.started = true;
    $('#gate').classList.add('is-gone');
    $('#gate').setAttribute('aria-hidden', 'true');
    $('#rec-btn').disabled = !canRecord;
    if (canRecord) { const m = pickMime(); $('#meta-format').textContent = m ? m.replace('video/', '').replace(';codecs=', ' · ').toUpperCase() : 'BROWSER DEFAULT'; }
    else $('#meta-format').textContent = 'NOT SUPPORTED HERE';
    if (!canRecord) $('#rec-btn').title = 'Recording is not supported in this browser.';
    await refreshDevices();
    if (params.get('room')) {
      const name = ($('#gate-name').value || '').trim();
      if (name) $('#my-name').value = name;
      openRoom(params.get('room').toLowerCase());
    }
    if (!state.cam && !state.mic) note('Add a source on the left to start building your scene.');
  }

  function wire() {
    $('#gate-go').addEventListener('click', () => start(true));
    $('#gate-skip').addEventListener('click', () => start(false));

    $('#cam-toggle').addEventListener('click', async () => {
      ensureAudio();
      if (state.cam) { stopCam(); return; }
      if (!canCapture) { note('This browser cannot open a camera.'); return; }
      setSwitch($('#cam-toggle'), true);
      await startCam($('#cam-select').disabled ? state.camId : $('#cam-select').value);
    });
    $('#cam-select').addEventListener('change', (e) => startCam(e.target.value));
    $('#cam-mirror').addEventListener('change', (e) => { state.mirror = e.target.checked; });

    $('#mic-toggle').addEventListener('click', async () => {
      ensureAudio();
      if (state.mic) { stopMic(); return; }
      if (!canCapture) { note('This browser cannot open a microphone.'); return; }
      setSwitch($('#mic-toggle'), true);
      await startMic($('#mic-select').disabled ? state.micId : $('#mic-select').value);
    });
    $('#mic-select').addEventListener('change', (e) => startMic(e.target.value));

    if (!canShare) {
      $('#screen-btn').disabled = true;
      $('#screen-btn').textContent = 'Screen share not available here';
      $('#screen-note').textContent = 'This browser (most phones) cannot share a screen. A video file works everywhere.';
    }
    $('#screen-btn').addEventListener('click', () => { ensureAudio(); state.screen ? stopScreen() : startScreen(); });

    $('#video-file').addEventListener('change', (e) => loadMedia(e.target.files && e.target.files[0]));
    $('#video-play').addEventListener('click', () => {
      const v = els.media;
      if (v.paused) v.play().then(() => { $('#video-play').textContent = 'Pause'; }).catch(() => {});
      else { v.pause(); $('#video-play').textContent = 'Play'; }
    });
    els.media.addEventListener('ended', () => { $('#video-play').textContent = 'Play'; });
    els.media.addEventListener('playing', () => { $('#video-state').textContent = 'PLAYING'; });
    els.media.addEventListener('pause', () => { if (state.mediaUrl) $('#video-state').textContent = 'PAUSED'; });
    $('#video-restart').addEventListener('click', () => { els.media.currentTime = 0; els.media.play().then(() => { $('#video-play').textContent = 'Pause'; }).catch(() => {}); });
    $('#video-loop').addEventListener('change', (e) => { els.media.loop = e.target.checked; });
    $('#video-clear').addEventListener('click', clearMedia);

    const updTitle = () => { state.title = $('#title-text').value.trim(); state.sub = $('#title-sub').value.trim(); };
    $('#title-text').addEventListener('input', updTitle);
    $('#title-sub').addEventListener('input', updTitle);
    $('#title-toggle').addEventListener('click', () => {
      updTitle();
      state.titleOn = !state.titleOn; setSwitch($('#title-toggle'), state.titleOn);
      if (state.titleOn && !state.title && !state.sub) { $('#title-text').focus(); note('Type a headline to show the lower third.'); }
    });

    $$('.layout').forEach((b) => b.addEventListener('click', () => selectLayout(b.dataset.layout)));
    $('.layouts').addEventListener('keydown', (e) => {
      const btns = $$('.layout'); const i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      let n = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % btns.length;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i - 1 + btns.length) % btns.length;
      if (n === null) return;
      e.preventDefault(); btns[n].focus(); selectLayout(btns[n].dataset.layout);
    });

    $('#rec-btn').addEventListener('click', () => (state.rec ? stopRecording() : startRecording()));

    $('#room-open').addEventListener('click', () => openRoom());
    $('#room-leave').addEventListener('click', closeRoom);
    $('#invite-copy').addEventListener('click', () => copy(inviteUrl(state.room.id), 'Invite link copied'));
    $('#top-invite').addEventListener('click', () => copy(inviteUrl(state.room.id), 'Invite link copied'));
    $('#feed-copy').addEventListener('click', () => copy(inviteUrl(state.room.id) + '&view=clean', 'OBS feed link copied'));
    if (navigator.share) {
      $('#invite-share').hidden = false;
      $('#invite-share').addEventListener('click', () => navigator.share({ title: 'Join my NEBU room', url: inviteUrl(state.room.id) }).catch(() => {}));
    }
    $('#cal-dl').addEventListener('click', () => icsFile(inviteUrl(state.room.id)));
    const next = new Date(Math.ceil(Date.now() / 1800e3) * 1800e3);
    const off = next.getTimezoneOffset() * 60e3;
    $('#cal-when').value = new Date(next - off).toISOString().slice(0, 16);

    $$('.st-tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
    showTab('sources');

    document.addEventListener('keydown', (e) => {
      if (!state.started || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target.closest('input, select, textarea, [contenteditable]')) return;
      const map = { 1: 'cam', 2: 'screen', 3: 'pip', 4: 'split', 5: 'room' };
      if (map[e.key]) { selectLayout(map[e.key]); e.preventDefault(); }
      if ((e.key === 'r' || e.key === 'R') && canRecord) { state.rec ? stopRecording() : startRecording(); e.preventDefault(); }
    });

    if (md && md.addEventListener) md.addEventListener('devicechange', refreshDevices);
    window.addEventListener('beforeunload', (e) => { if (state.rec || state.takes.length) { e.preventDefault(); e.returnValue = ''; } });
    window.addEventListener('pagehide', () => { if (state.room) state.room.leave(); });

    const saved = store.get('nebu:name');
    $('#my-name').value = saved; $('#gate-name').value = saved;

    if (params.get('room')) {
      const id = params.get('room').toLowerCase();
      $('#gate-eyebrow').textContent = `YOU'RE INVITED / ROOM ${id.toUpperCase()}`;
      $('#gate-h').innerHTML = 'Come on<br><span>in.</span>';
      $('#gate-lead').textContent = 'Someone opened a NEBU room for you. Turn on your camera and mic, check your frame, and you join straight away. Audio and video go browser to browser.';
      $('#gate-name-wrap').hidden = false;
      $('#gate-go span').textContent = 'Camera & mic, then join';
      $('#gate-skip').textContent = 'Join without them';
    }
    if (!canCapture) {
      $('#gate-error').textContent = window.isSecureContext ? 'This browser cannot open a camera or microphone. You can still use a video file.' : 'Camera and mic need a secure (https) page.';
      $('#gate-go').disabled = true;
    }
    setTimeout(() => $('#gate-go').focus({ preventScroll: true }), 50);
  }

  if (isFeed) { startFeed(); return; }
  wire();
  startClock();
  requestAnimationFrame(meterLoop);
  window.__nebu = { state, channels: () => channels, selectLayout, startRecording, stopRecording, openRoom, closeRoom, loadMedia };
})();
