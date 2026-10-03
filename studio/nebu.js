/* NEBU studio v2 UI: Show panel (graphics, DJ, announce, stickers, packs, account) + chat bubble
 * (room chat, live viewer chat, reactions, song requests, polls). Needs studio.js (NebuStudio) and
 * nebu-gfx.js (NebuGfx). */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const WM = window.NebuBrand || { wordmark: () => '<b>NEBU</b>', mark: () => '<b>NEBU</b>' };
  const SIGNAL = (window.NEBU_SIGNAL || (($('meta[name="nebu-signal"]') || {}).content || '')).replace(/\/$/, '');
  const G = window.NebuGfx;
  const store = { get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } } };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m) => { const t = $('#toast'); if (!t) return; t.textContent = m; t.classList.add('is-on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('is-on'), 2600); };
  const h = (html) => { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; };
  let CFG = {}, session = store.get('nebu:session', null), me = null;
  const api = async (path, opts = {}) => {
    const headers = { ...(opts.body && !(opts.body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}), ...(session ? { Authorization: `Bearer ${session}` } : {}), ...(opts.headers || {}) };
    const r = await fetch(SIGNAL + path, { ...opts, headers, body: opts.body && typeof opts.body === 'object' && !(opts.body instanceof Blob) ? JSON.stringify(opts.body) : opts.body });
    if (opts.raw) return r;
    const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(j.friendly || j.error || `HTTP ${r.status}`), { status: r.status, body: j }); return j;
  };

  // ---------------- Show panel ----------------
  const panel = h(`<section class="panel st-show" id="panel-show" aria-labelledby="show-h" data-panel="show">
    <h2 class="panel-h mono" id="show-h">Show</h2>
    <div class="acc" id="acc">
      <details class="acc-i" open data-acc="gfx"><summary><span>Graphics</span><i>Lower thirds · overlays · transitions</i></summary><div class="acc-b">
        <div class="lt-grid" id="lt-grid" role="radiogroup" aria-label="Lower third design"></div>
        <label class="field"><span class="field-label mono">Name</span><input id="lt-title" maxlength="48" placeholder="Your name" autocomplete="off"></label>
        <label class="field"><span class="field-label mono">Line two</span><input id="lt-sub" maxlength="80" placeholder="What this is about" autocomplete="off"></label>
        <div class="row2"><button class="btn btn-yellow btn-mini" id="lt-show" type="button">Show lower third</button><button class="btn btn-mini" id="lt-flash" type="button">Flash 6s</button></div>
        <p class="sub-h mono">Overlays</p>
        <div class="chips" id="ov-chips"></div>
        <p class="sub-h mono">Transition on scene change</p>
        <div class="chips" id="tr-chips" role="radiogroup" aria-label="Transition"></div>
      </div></details>
      <details class="acc-i" data-acc="dj"><summary><span>DJ</span><i>Two decks · crossfader · BPM</i></summary><div class="acc-b">
        <div class="decks" id="decks"></div>
        <div class="xfade"><span class="mono">A</span><input type="range" id="xf" min="0" max="1" step="0.01" value="0.5" aria-label="Crossfader"><span class="mono">B</span></div>
        <p class="src-note">Local files only. Streaming-service audio isn't captured here: Spotify's terms don't allow recording or restreaming it.</p>
      </div></details>
      <details class="acc-i" data-acc="announce"><summary><span>Announce</span><i>NEBU speaks · music ducks · lower third</i></summary><div class="acc-b">
        <label class="field"><span class="field-label mono">What NEBU says</span><textarea id="an-text" maxlength="240" rows="3" placeholder="Doors open. Requests are on, drop yours in the chat."></textarea></label>
        <div class="row3">
          <label class="mini"><span class="mono">Voice</span><select id="an-lang"><option value="en">English</option><option value="es">Español</option></select></label>
          <label class="mini chk"><input type="checkbox" id="an-sting" checked><span>Stinger first</span></label>
          <label class="mini chk"><input type="checkbox" id="an-pin" checked><span>Pin in live chat</span></label>
        </div>
        <label class="mini"><span class="mono">Duck music to</span><input type="range" id="an-duck" min="0" max="0.8" step="0.05" value="0.2"></label>
        <button class="btn btn-yellow btn-block" id="an-go" type="button"><span>Speak it</span></button>
        <p class="src-note" id="an-note"></p>
        <div class="presets" id="an-presets"></div>
      </div></details>
      <details class="acc-i" data-acc="stickers"><summary><span>Stickers</span><i>Stix Magic · your Telegram sets</i></summary><div class="acc-b">
        <div class="stk-bar"><input id="stk-q" placeholder="Search stickers" aria-label="Search stickers"><select id="stk-anim" aria-label="Animation"><option value="pop">Pop in</option><option value="bounce">Bounce</option><option value="float">Float</option></select></div>
        <div class="stk-sets" id="stk-sets" role="tablist"></div>
        <div class="stk-grid" id="stk-grid"></div>
        <div class="stk-edit" id="stk-edit" hidden><span class="mono">Selected</span><button class="btn btn-mini" data-se="smaller" type="button">−</button><button class="btn btn-mini" data-se="bigger" type="button">+</button><button class="btn btn-mini" data-se="left" type="button">⟲</button><button class="btn btn-mini" data-se="right" type="button">⟳</button><button class="btn btn-mini" data-se="del" type="button">Remove</button></div>
        <label class="mini chk"><input type="checkbox" id="stk-edit-on"><span>Move stickers on the program (drag, wheel to scale, shift+wheel to rotate)</span></label>
        <form class="tg-imp" id="tg-imp"><input id="tg-link" placeholder="t.me/addstickers/…" aria-label="Telegram sticker set link"><button class="btn btn-mini" type="submit">Import</button></form>
        <p class="src-note" id="tg-note">Paste a set link. Bots can't list your saved sets, so the link is how I find it.</p>
      </div></details>
      <details class="acc-i" data-acc="packs"><summary><span>My packs</span><i>Saved on NEBU storage</i></summary><div class="acc-b" id="packs-b"></div></details>
      <details class="acc-i" data-acc="account"><summary><span>Account</span><i id="acct-sum">FRISKY ID</i></summary><div class="acc-b" id="acct-b"></div></details>
      <details class="acc-i" data-acc="vc"><summary><span>VC node</span><i>Your NEBU · Discord · stream · numbers</i></summary><div class="acc-b" id="vc-b"><p class="src-note">Loading…</p></div></details>
    </div>
  </section>`);
  $('.st-side').appendChild(panel);
  const tab = h(`<button type="button" data-tab="show" aria-pressed="false"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3l2.4 5.6L20 11l-5.6 2.4L12 19l-2.4-5.6L4 11l5.6-2.4z" fill="none" stroke="currentColor"/></svg>Show</button>`);
  $('.st-tabs').appendChild(tab);
  tab.addEventListener('click', () => { $$('.st-tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b === tab))); $$('.panel[data-panel]').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === 'show')); });

  // Graphics
  const ltGrid = $('#lt-grid');
  for (const [id, d] of Object.entries(G.LT)) ltGrid.appendChild(h(`<button type="button" role="radio" class="lt-opt" data-lt="${id}" aria-checked="${id === G.lt.design}"><canvas width="240" height="96" aria-hidden="true"></canvas><span>${esc(d.name)}</span></button>`));
  function thumbs(t) {
    for (const b of $$('.lt-opt canvas')) {
      const id = b.parentElement.dataset.lt, ctx = b.getContext('2d'); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, 240, 96);
      const g = ctx.createLinearGradient(0, 0, 240, 96); g.addColorStop(0, '#1b0638'); g.addColorStop(1, '#0B001A'); ctx.fillStyle = g; ctx.fillRect(0, 0, 240, 96);
      ctx.save(); ctx.scale(240 / 1280 * 1.6, 96 / 720 * 4.2); ctx.translate(-10, -(720 - 220));
      try { G.LT[id].draw(ctx, 1, t, { title: $('#lt-title').value || 'FR!SKY', sub: $('#lt-sub').value || 'Live from the studio', W: 800, H: 720 }); } catch { /* */ }
      ctx.restore();
    }
  }
  let thumbT = 0; (function loop(t) { if (t - thumbT > 120 && !$('#panel-show').hidden) { thumbT = t; if ($('[data-acc="gfx"]').open) thumbs(t); } requestAnimationFrame(loop); })(0);
  ltGrid.addEventListener('click', (e) => { const b = e.target.closest('.lt-opt'); if (!b) return; $$('.lt-opt').forEach((x) => x.setAttribute('aria-checked', String(x === b))); G.lt.design = b.dataset.lt; store.set('nebu:lt', G.lt.design); });
  G.lt.design = store.get('nebu:lt', 'broadcast'); $$('.lt-opt').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.lt === G.lt.design)));
  $('#lt-title').value = store.get('nebu:lt-title', ''); $('#lt-sub').value = store.get('nebu:lt-sub', '');
  const syncLT = () => { G.lt.title = $('#lt-title').value; G.lt.sub = $('#lt-sub').value; store.set('nebu:lt-title', G.lt.title); store.set('nebu:lt-sub', G.lt.sub); };
  $('#lt-title').addEventListener('input', syncLT); $('#lt-sub').addEventListener('input', syncLT); syncLT();
  $('#lt-show').addEventListener('click', () => { syncLT(); G.showLT(!G.lt.on); $('#lt-show').textContent = G.lt.on ? 'Hide lower third' : 'Show lower third'; });
  $('#lt-flash').addEventListener('click', () => { syncLT(); G.showLT(true, { holdMs: 6000 }); $('#lt-show').textContent = 'Show lower third'; });
  const OV = { logo: 'NEBU bug', live: 'LIVE + viewers', clock: 'Clock', ticker: 'Chat ticker', nowplaying: 'Now playing' };
  Object.assign(G.overlays, store.get('nebu:ov', {}));
  for (const [k, v] of Object.entries(OV)) $('#ov-chips').appendChild(h(`<button type="button" class="chip" data-ov="${k}" aria-pressed="${!!G.overlays[k]}">${v}</button>`));
  $('#ov-chips').addEventListener('click', (e) => { const b = e.target.closest('[data-ov]'); if (!b) return; G.overlays[b.dataset.ov] = !G.overlays[b.dataset.ov]; b.setAttribute('aria-pressed', String(G.overlays[b.dataset.ov])); store.set('nebu:ov', G.overlays); });
  G.transition.kind = store.get('nebu:tr', 'stripe');
  for (const [k, v] of Object.entries({ ...G.TRANSITIONS, none: 'Cut' })) $('#tr-chips').appendChild(h(`<button type="button" class="chip" role="radio" data-tr="${k}" aria-checked="${k === G.transition.kind}">${v}</button>`));
  $('#tr-chips').addEventListener('click', (e) => { const b = e.target.closest('[data-tr]'); if (!b) return; G.transition.kind = b.dataset.tr; store.set('nebu:tr', b.dataset.tr); $$('#tr-chips .chip').forEach((x) => x.setAttribute('aria-checked', String(x === b))); if (b.dataset.tr !== 'none') G.startTransition(); });

  // ---------------- Audio: DJ bus, ducking, voice ----------------
  let A = null;
  function audio() {
    if (A) return A; const S = NebuStudio.audio(); const ac = S.ac;
    const dj = ac.createGain(), duck = ac.createGain(), hear = ac.createGain(), voice = ac.createGain();
    dj.connect(duck); duck.connect(S.recBus); duck.connect(S.sendBus); duck.connect(hear); hear.connect(ac.destination);
    voice.connect(S.recBus); voice.connect(S.sendBus); voice.connect(ac.destination);
    A = { ...S, dj, duck, hear, voice }; return A;
  }
  function duckTo(level, secs = .25) {
    const a = audio(), now = a.ac.currentTime;
    for (const g of [a.duck.gain, a.channels.video && a.channels.video.input.gain].filter(Boolean)) { g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); g.linearRampToValueAtTime(level, now + secs); }
  }
  function stinger() {
    const a = audio(), ac = a.ac, t = ac.currentTime, len = .7;
    const buf = ac.createBuffer(1, ac.sampleRate * len, ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 1.5);
    const n = ac.createBufferSource(); n.buffer = buf; const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 6; bp.frequency.setValueAtTime(400, t); bp.frequency.exponentialRampToValueAtTime(6000, t + len);
    const o = ac.createOscillator(); o.type = 'triangle'; o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(880, t + len);
    const g = ac.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.35, t + .08); g.gain.exponentialRampToValueAtTime(.001, t + len);
    n.connect(bp); bp.connect(g); o.connect(g); g.connect(a.voice); n.start(t); o.start(t); o.stop(t + len); return len;
  }

  // DJ decks
  const decks = ['A', 'B'].map((id) => ({ id, buf: null, src: null, gain: null, xf: null, an: null, start: 0, off: 0, playing: false, name: '', bpm: null }));
  for (const d of decks) {
    const el = h(`<div class="deck" data-deck="${d.id}">
      <div class="deck-top"><span class="deck-id mono">${d.id}</span><div class="deck-disc" aria-hidden="true"><i></i></div><div class="deck-meta"><b class="deck-name">Load a track</b><span class="deck-bpm mono">— BPM</span></div></div>
      <canvas class="deck-meter" width="200" height="10" aria-hidden="true"></canvas>
      <div class="deck-ctl"><label class="btn btn-mini deck-load">Load<input type="file" accept="audio/*" hidden></label><button class="btn btn-mini deck-play" type="button" disabled>Play</button><input class="deck-vol" type="range" min="0" max="1" step="0.01" value="0.9" aria-label="Deck ${d.id} volume"></div>
    </div>`);
    $('#decks').appendChild(el); d.el = el;
    $('input[type=file]', el).addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return; const a = audio(); stopDeck(d);
      d.name = f.name.replace(/\.[^.]+$/, ''); $('.deck-name', el).textContent = d.name; $('.deck-bpm', el).textContent = 'reading BPM…';
      try { d.buf = await a.ac.decodeAudioData(await f.arrayBuffer()); } catch { toast("That file didn't decode. Try an MP3, M4A or WAV."); return; }
      $('.deck-play', el).disabled = false; d.off = 0;
      import('./vendor/beat-detector.js').then((m) => m.guess(d.buf)).then(({ bpm }) => { d.bpm = Math.round(bpm); $('.deck-bpm', el).textContent = `${d.bpm} BPM`; }).catch(() => { $('.deck-bpm', el).textContent = 'BPM ?'; });
    });
    $('.deck-play', el).addEventListener('click', () => d.playing ? pauseDeck(d) : playDeck(d));
    $('.deck-vol', el).addEventListener('input', (e) => { if (d.gain) d.gain.gain.value = +e.target.value; });
  }
  function ensureDeckNodes(d) { const a = audio(); if (d.gain) return; d.gain = a.ac.createGain(); d.xf = a.ac.createGain(); d.an = a.ac.createAnalyser(); d.an.fftSize = 512; d.gain.connect(d.xf); d.xf.connect(d.an); d.xf.connect(a.dj); d.gain.gain.value = +$('.deck-vol', d.el).value; applyXf(); }
  function playDeck(d) {
    const a = audio(); if (!d.buf) return; ensureDeckNodes(d); a.ac.resume();
    d.src = a.ac.createBufferSource(); d.src.buffer = d.buf; d.src.connect(d.gain); d.src.start(0, d.off % d.buf.duration); d.start = a.ac.currentTime - d.off; d.playing = true;
    d.src.onended = () => { if (d.playing && a.ac.currentTime - d.start >= d.buf.duration - .05) { d.playing = false; d.off = 0; d.el.classList.remove('is-on'); $('.deck-play', d.el).textContent = 'Play'; } };
    d.el.classList.add('is-on'); $('.deck-play', d.el).textContent = 'Pause'; nowPlaying();
  }
  function pauseDeck(d) { const a = audio(); if (!d.src) return; d.playing = false; d.off = a.ac.currentTime - d.start; try { d.src.stop(); } catch { /* */ } d.src = null; d.el.classList.remove('is-on'); $('.deck-play', d.el).textContent = 'Play'; nowPlaying(); }
  function stopDeck(d) { if (d.src) { d.playing = false; try { d.src.stop(); } catch { /* */ } d.src = null; } d.off = 0; d.el.classList.remove('is-on'); $('.deck-play', d.el).textContent = 'Play'; }
  function applyXf() { const x = +$('#xf').value; const [a, b] = decks; if (a.xf) a.xf.gain.value = Math.cos(x * Math.PI / 2); if (b.xf) b.xf.gain.value = Math.sin(x * Math.PI / 2); nowPlaying(); }
  $('#xf').addEventListener('input', applyXf);
  function nowPlaying() {
    const x = +$('#xf').value; const live = decks.filter((d) => d.playing).sort((p, q) => (q.id === 'B' ? x : 1 - x) - (p.id === 'B' ? x : 1 - x))[0];
    G.nowPlaying = live ? { title: live.name.slice(0, 40), sub: live.bpm ? `${live.bpm} BPM · Deck ${live.id}` : `Deck ${live.id}` } : null;
  }
  (function meters() {
    for (const d of decks) { if (!d.an) continue; const arr = new Uint8Array(d.an.fftSize); d.an.getByteTimeDomainData(arr); let pk = 0; for (const v of arr) pk = Math.max(pk, Math.abs(v - 128) / 128); const c = $('.deck-meter', d.el).getContext('2d'); c.clearRect(0, 0, 200, 10); const segs = 20, lit = Math.round(pk * segs * 1.4); for (let i = 0; i < segs; i++) { c.fillStyle = i < lit ? (i > 16 ? '#FF2E88' : i > 12 ? '#FFD100' : '#B7FF2A') : 'rgba(255,255,255,.08)'; c.fillRect(i * 10, 0, 8, 10); } }
    requestAnimationFrame(meters);
  })();

  // ---------------- Announce ----------------
  const PRESETS = ['Doors open. Requests are on, drop yours in the chat.', 'Next track coming up. Vote in the poll.', 'Two minutes left. Thanks for hanging out.', 'Say hi in the chat, I read everything.'];
  for (const p of PRESETS) $('#an-presets').appendChild(h(`<button type="button" class="chip">${esc(p)}</button>`));
  $('#an-presets').addEventListener('click', (e) => { const b = e.target.closest('.chip'); if (b) $('#an-text').value = b.textContent; });
  async function announce(text, { lang = 'en', sting = true, duck = .2, pin = true } = {}) {
    text = String(text || '').trim(); if (text.length < 2) return;
    const note = $('#an-note'); note.textContent = 'NEBU is getting ready…'; $('#an-go').disabled = true;
    try {
      const a = audio(); a.ac.resume();
      let buf = null;
      if (CFG.tts && CFG.tts.enabled) {
        let r = await api('/tts', { method: 'POST', body: { text, lang }, raw: true }); if (r.status >= 500) r = await api('/tts', { method: 'POST', body: { text, lang }, raw: true });
        if (r.ok) { const ab = await r.arrayBuffer(); if (ab.byteLength) buf = await a.ac.decodeAudioData(ab); }
        else note.textContent = r.status === 429 ? 'Slow down a little, NEBU needs a breath.' : 'Voice is unavailable right now. Showing the banner only.';
      }
      duckTo(duck);
      let wait = 0; if (sting) wait = stinger() * 1000 - 150;
      const dur = buf ? buf.duration * 1000 : Math.max(3500, text.length * 65);
      setTimeout(() => {
        if (buf) { const s = a.ac.createBufferSource(); s.buffer = buf; s.connect(a.voice); s.start(); }
        G.showLT(true, { title: 'NEBU', sub: text.length > 70 ? text.slice(0, 68) + '…' : text, holdMs: dur + 600, design: G.lt.design });
        $('#lt-show').textContent = 'Show lower third';
        setTimeout(() => { duckTo(1, .6); G.lt.title = $('#lt-title').value; G.lt.sub = $('#lt-sub').value; }, dur + 700);
      }, wait);
      if (pin) hubSend({ type: 'announce', text }), hubSend({ type: 'pin', text, by: 'nebu' });
      note.textContent = buf ? 'NEBU said it. Music came back up after.' : note.textContent || 'Banner shown.';
    } catch (e) { note.textContent = e.message; duckTo(1); } finally { setTimeout(() => { $('#an-go').disabled = false; }, 1500); }
  }
  $('#an-go').addEventListener('click', () => announce($('#an-text').value, { lang: $('#an-lang').value, sting: $('#an-sting').checked, duck: +$('#an-duck').value, pin: $('#an-pin').checked }));
  window.NebuAnnounce = announce;

  // ---------------- Stickers ----------------
  let sets = [], curSet = null; const favs = new Set(store.get('nebu:stk-fav', []));
  async function loadSets() {
    try { const m = await (await fetch('stickers/manifest.json')).json(); sets = m.sets.map((s) => ({ ...s, items: s.items.map((i) => ({ ...i, url: `stickers/${i.src}`, animUrl: i.anim ? `stickers/${i.anim}` : null })) })); } catch { sets = []; }
    sets.unshift({ id: 'fav', name: '★ Favorites', items: [] });
    for (const s of store.get('nebu:tg-sets', [])) sets.push(s);
    curSet = sets[1] ? sets[1].id : 'fav'; renderSets();
  }
  function renderSets() {
    $('#stk-sets').innerHTML = sets.map((s) => `<button type="button" role="tab" class="chip" data-set="${esc(s.id)}" aria-selected="${s.id === curSet}">${esc(s.name)}</button>`).join('');
    renderStickers();
  }
  function renderStickers() {
    const q = $('#stk-q').value.trim().toLowerCase();
    const all = sets.filter((s) => s.id !== 'fav').flatMap((s) => s.items);
    let items = curSet === 'fav' ? all.filter((i) => favs.has(i.id)) : (sets.find((s) => s.id === curSet) || { items: [] }).items;
    if (q) items = all.filter((i) => `${i.name} ${(i.tags || []).join(' ')} ${i.emoji || ''}`.toLowerCase().includes(q));
    $('#stk-grid').innerHTML = items.slice(0, 120).map((i) => `<button type="button" class="stk" data-id="${esc(i.id)}" title="${esc(i.name)}"><img src="${esc(i.format === 'animated' ? '' : (i.url || ''))}" alt="${esc(i.name)}" loading="lazy">${i.format === 'animated' ? '<span class="stk-tgs mono">TGS</span>' : ''}<i class="stk-fav" data-fav="${esc(i.id)}" aria-label="Favorite">${favs.has(i.id) ? '★' : '☆'}</i></button>`).join('') || `<p class="src-note">${curSet === 'fav' ? 'Tap ☆ on a sticker to keep it here.' : 'Nothing matches.'}</p>`;
  }
  $('#stk-sets').addEventListener('click', (e) => { const b = e.target.closest('[data-set]'); if (!b) return; curSet = b.dataset.set; $('#stk-q').value = ''; renderSets(); });
  $('#stk-q').addEventListener('input', renderStickers);
  $('#stk-grid').addEventListener('click', (e) => {
    const f = e.target.closest('[data-fav]'); const all = sets.flatMap((s) => s.items);
    if (f) { e.stopPropagation(); favs.has(f.dataset.fav) ? favs.delete(f.dataset.fav) : favs.add(f.dataset.fav); store.set('nebu:stk-fav', [...favs]); renderStickers(); return; }
    const b = e.target.closest('.stk'); if (!b) return; const item = all.find((i) => i.id === b.dataset.id); if (!item) return;
    const useAnim = item.animUrl && $('#stk-anim').value !== 'pop';
    G.addSticker(useAnim ? { ...item, url: item.animUrl, format: 'video' } : item, $('#stk-anim').value); $('#stk-edit').hidden = false;
  });
  $('#stk-edit-on').addEventListener('change', (e) => { G.editing = e.target.checked; });
  $('#stk-edit').addEventListener('click', (e) => { const b = e.target.closest('[data-se]'); if (!b) return; const s = G.stickers.find((x) => x.id === G.selected) || G.stickers[G.stickers.length - 1]; if (!s) return;
    ({ smaller: () => { s.scale = Math.max(.2, s.scale * .85); }, bigger: () => { s.scale = Math.min(4, s.scale * 1.15); }, left: () => { s.rot -= .15; }, right: () => { s.rot += .15; }, del: () => { G.stickers = G.stickers.filter((x) => x !== s); if (!G.stickers.length) $('#stk-edit').hidden = true; } })[b.dataset.se](); });
  $('#tg-imp').addEventListener('submit', async (e) => {
    e.preventDefault(); const link = $('#tg-link').value.trim(); if (!link) return; const note = $('#tg-note'); note.textContent = 'Fetching the set from Telegram…';
    try {
      let cursor = 0, set = null, items = [];
      do { const r = await api('/telegram/import', { method: 'POST', body: { set: link, cursor } }); set = r.set; items = items.concat(r.items || []); cursor = r.next; note.textContent = `Imported ${items.length}…`; } while (cursor && items.length < 120);
      const s = { id: `tg:${set.name}`, name: set.title.slice(0, 28), items: items.map((i) => ({ ...i, tags: [i.emoji || '', 'telegram'] })) };
      sets = sets.filter((x) => x.id !== s.id); sets.push(s); store.set('nebu:tg-sets', sets.filter((x) => x.id.startsWith('tg:')).map((x) => ({ ...x, items: x.items.slice(0, 120) })));
      curSet = s.id; renderSets(); note.textContent = `Added “${set.title}” (${items.length}).`; $('#tg-link').value = '';
    } catch (err) { note.textContent = err.status === 401 ? 'Sign in with FRISKY ID to import sets.' : err.status === 404 ? "I couldn't find that set. Check the link." : err.status === 503 ? "Telegram import isn't connected yet." : err.message; }
  });

  // ---------------- Account + packs ----------------
  function renderAccount() {
    const b = $('#acct-b'), f = CFG.friskyId || {};
    if (me) { $('#acct-sum').textContent = me.name || 'Signed in'; b.innerHTML = `<p class="acct-me"><b>${esc(me.name || me.email || me.id)}</b><span class="mono">FRISKY ID</span></p><button class="btn btn-mini" id="acct-out" type="button">Sign out</button>`; $('#acct-out').onclick = () => { session = null; me = null; store.set('nebu:session', null); renderAccount(); renderPacks(); }; return; }
    const provs = (f.providers || []).map((p) => `<button class="btn btn-line btn-block prov" type="button" data-prov="${p.id}" ${p.enabled ? '' : 'disabled'}>${esc(p.label)}${p.enabled ? '' : ' · not connected yet'}</button>`).join('');
    b.innerHTML = `<p class="src-note">Hosts sign in with FRISKY ID. Guests never need an account: they join with your invite link.</p>${f.enabled ? provs : `<p class="quiet">FRISKY ID sign-in isn't connected on this preview yet.</p>${provs}`}`;
    $$('.prov', b).forEach((x) => x.addEventListener('click', () => { const u = new URL(f.start); u.searchParams.set('return_to', location.origin + location.pathname); u.searchParams.set('provider', x.dataset.prov); location.href = u; }));
  }
  async function renderPacks() {
    const b = $('#packs-b');
    if (!me) { b.innerHTML = '<p class="src-note">Sign in to keep your designs: lower thirds, overlays and sticker sets, saved as layered packs. Private unless you share.</p>'; return; }
    b.innerHTML = '<p class="src-note">Loading…</p>';
    try {
      const r = await api('/packs');
      const list = r.packs || [];
      b.innerHTML = `<button class="btn btn-yellow btn-mini" id="pack-save" type="button">Save my current look as a pack</button><ul class="packs">${list.map((p) => `<li><b>${esc(p.name)}</b><span class="mono">${esc(p.kind)}</span><button class="btn btn-mini" data-load="${p.id}" type="button">Load</button></li>`).join('') || '<li class="quiet">No packs yet.</li>'}</ul><p class="src-note mono">${r.usage ? `${Math.round((r.usage.bytes || 0) / 1024)} KB used` : ''}</p>`;
      $('#pack-save').onclick = savePack;
      $$('[data-load]', b).forEach((x) => x.onclick = () => loadPack(x.dataset.load));
      b.insertAdjacentHTML('afterbegin', '<div class="sj" id="sj"></div>'); renderStitch();
    } catch (e) { b.innerHTML = `<p class="src-note">${esc(e.message)}</p>`; }
  }
  // Monthly design: NEBU makes it (engine: Code Pup Design via Hermes/Stitch; not named in UI). One per month per FRISKY ID; refunded if it fails.
  let sjTimer = 0;
  const SJ_LABEL = { queued: 'Queued', designing: `${WM.wordmark('is-sm')} is designing`, saving: 'Saving', ready: 'Ready', failed: 'Failed · refunded' };
  // 3-segment round indicator: done segments fill, the current one shimmers (static under reduced motion).
  const sjRounds = (j) => { const n = j.rounds || 3, r = j.status === 'saving' ? n : (j.status === 'designing' ? (j.round || 1) : 0); return `<div class="sj-rounds" role="progressbar" aria-label="Design rounds" aria-valuemin="0" aria-valuemax="${n}" aria-valuenow="${Math.max(0, r - (j.status === 'saving' ? 0 : 1))}">${Array.from({ length: n }, (_, i) => `<i class="${i + 1 < r || j.status === 'saving' ? 'is-done' : i + 1 === r ? 'is-now' : ''}"></i>`).join('')}</div>`; };
  const sjLabel = (j) => (j.status === 'designing' && j.round ? `${WM.wordmark('is-sm')} is designing · round ${j.round}/${j.rounds || 3}` : SJ_LABEL[j.status] || esc(j.status));
  async function renderStitch() {
    const box = $('#sj'); if (!box || !me) return; clearTimeout(sjTimer);
    let r; try { r = await api('/stitch'); } catch (e) { box.innerHTML = `<p class="src-note">${esc(e.message)}</p>`; return; }
    const jobs = r.jobs || [];
    const form = r.available ? `<form class="sj-form" id="sj-form"><label class="field"><span class="field-label mono">Your monthly design</span><textarea id="sj-prompt" rows="2" maxlength="1500" placeholder="A neon lower third and matching sticker for my late sets"></textarea></label><div class="row3"><label class="mini"><span class="mono">What</span><select id="sj-kind"><option value="element">One element</option><option value="set">A set</option></select></label><label class="mini"><span class="mono">How many</span><select id="sj-count" disabled>${[2, 3, 4, 5].map((n) => `<option ${n === 3 ? 'selected' : ''}>${n}</option>`).join('')}</select></label><button class="btn btn-yellow btn-mini" type="submit">Design it</button></div><label class="mini chk"><input type="checkbox" id="sj-brief"><span>This is already a full brief (skip the brief step)</span></label><p class="src-note">NEBU does three rounds with a review between each, plus one nice touch you didn't ask for.</p></form>` : '<p class="src-note">This month\'s design is used. It resets on the 1st.</p>';
    box.innerHTML = `${form}<ul class="sj-list">${jobs.map((j) => `<li class="sj-job is-${esc(j.status)}"><div class="sj-row"><span class="sj-pill">${sjLabel(j)}</span>${j.status === 'ready' && j.pack ? `<button class="btn btn-mini" data-load="${esc(j.pack)}" type="button">Open</button>` : ''}</div><p class="sj-p" title="${esc(j.prompt)}">${esc(j.prompt)}</p>${['queued', 'designing', 'saving'].includes(j.status) ? sjRounds(j) : ''}${j.status === 'ready' && j.nice_touch ? `<span class="sj-touch"><b>✦ Nice touch</b> ${esc(j.nice_touch)}</span>` : ''}</li>`).join('')}</ul>${r.mode === 'mock' ? '<p class="sj-note">Preview: NEBU&rsquo;s design run is simulated here.</p>' : ''}`;
    const f = $('#sj-form');
    if (f) {
      $('#sj-kind').onchange = (e) => { $('#sj-count').disabled = e.target.value !== 'set'; };
      f.onsubmit = async (e) => { e.preventDefault(); const btn = f.querySelector('button'); btn.disabled = true; try { await api('/stitch', { method: 'POST', body: { prompt: $('#sj-prompt').value, kind: $('#sj-kind').value, count: Number($('#sj-count').value), brief_mode: $('#sj-brief').checked ? 'provided' : 'auto' } }); toast('NEBU is on it.'); } catch (err) { toast(err.message); } renderStitch(); };
    }
    $$('[data-load]', box).forEach((x) => x.onclick = () => loadPack(x.dataset.load));
    if (jobs.some((j) => ['queued', 'designing', 'saving'].includes(j.status))) sjTimer = setTimeout(() => renderStitch().then(() => { if (!jobs.some((j) => j.status === 'ready') && $$('.sj-job.is-ready').length) renderPacks(); }), 2500);
  }
  function layerManifest() {
    return { version: 1, kind: 'look', layers: [
      { id: 'lower-third', type: 'text', design: G.lt.design, title: G.lt.title, sub: G.lt.sub, visible: true, locked: false, opacity: 1, blend: 'normal', anim: 'enter' },
      ...Object.entries(G.overlays).map(([k, v]) => ({ id: `overlay-${k}`, type: 'fx', overlay: k, visible: v, locked: false, opacity: 1, blend: 'normal' })),
      ...G.stickers.map((s) => ({ id: `sticker-${s.id}`, type: 'sticker', src: s.item.id, x: Math.round(s.x), y: Math.round(s.y), scale: +s.scale.toFixed(2), rot: +s.rot.toFixed(2), anim: s.anim, visible: true, locked: false, opacity: 1, blend: 'normal' })),
    ], transition: G.transition.kind };
  }
  async function savePack() { const name = prompt('Name this pack', `${G.lt.title || 'My'} look`); if (!name) return; try { await api('/packs', { method: 'POST', body: { name, kind: 'overlay', manifest: layerManifest() } }); toast('Saved to My packs.'); renderPacks(); } catch (e) { toast(e.message); } }
  async function loadPack(id) {
    try { const { manifest: m } = await api(`/packs/${id}`); const all = sets.flatMap((s) => s.items);
      for (const l of m.layers || []) { if (l.type === 'text') { G.lt.design = l.design; $('#lt-title').value = l.title || ''; $('#lt-sub').value = l.sub || ''; syncLT(); } if (l.type === 'fx') G.overlays[l.overlay] = l.visible; if (l.type === 'sticker') { const it = all.find((i) => i.id === l.src); if (it) Object.assign(G.addSticker(it, l.anim), { x: l.x, y: l.y, scale: l.scale, rot: l.rot }); } if (l.type === 'design' && l.src) G.addSticker({ id: l.id, url: l.src, format: 'static' }, 'pop'); }
      if (m.transition) G.transition.kind = m.transition; toast('Pack loaded.');
    } catch (e) { toast(e.message); }
  }
  async function auth() {
    const m = location.hash.match(/nebu_handoff=([^&]+)/);
    if (m) { history.replaceState(null, '', location.pathname + location.search); try { const r = await api('/auth/exchange', { method: 'POST', body: { token: decodeURIComponent(m[1]) } }); session = r.session; store.set('nebu:session', session); } catch { toast("Sign-in didn't complete. Try again."); } }
    if (session) { try { me = (await api('/auth/me')).user; } catch { session = null; store.set('nebu:session', null); } }
    renderAccount(); renderPacks(); await renderVc();
  }

  // ---------------- Chat bubble ----------------
  const bubble = h(`<div class="nb" id="nb" data-state="closed">
    <button class="nb-btn" type="button" id="nb-btn" aria-label="Open NEBU" aria-expanded="false">${WM.mark('nb-mark')}<b class="nb-badge" id="nb-badge" hidden>0</b></button>
    <div class="nb-panel" id="nb-panel" role="dialog" aria-label="Chat" hidden>
      <header class="nb-head"><span class="nb-grip" aria-hidden="true"></span><b>${WM.wordmark('nb-head-wm')} Chat</b><span class="nb-live mono" id="nb-live">OFF AIR</span>
        <button class="nb-ico" type="button" id="nb-dock" title="Dock as side panel" aria-pressed="false">⇥</button><button class="nb-ico" type="button" id="nb-close" aria-label="Close chat">✕</button></header>
      <nav class="nb-tabs" role="tablist"><button role="tab" data-nt="chat" aria-selected="true">Chat</button><button role="tab" data-nt="req" aria-selected="false">Requests <i id="nb-req-n"></i></button><button role="tab" data-nt="poll" aria-selected="false">Poll</button><button role="tab" data-nt="live" aria-selected="false">Go live</button><button role="tab" data-nt="help" aria-selected="false" id="nb-help-tab" hidden>Help</button></nav>
      <div class="nb-pin" id="nb-pin" hidden></div>
      <section class="nb-view" data-nv="chat"><ol class="nb-msgs" id="nb-msgs" aria-live="polite"></ol>
        <div class="nb-react" id="nb-react"></div>
        <form class="nb-form" id="nb-form"><input id="nb-in" maxlength="300" placeholder="Say something" autocomplete="off" aria-label="Message"><button class="btn btn-yellow btn-mini" type="submit">Send</button></form></section>
      <section class="nb-view" data-nv="req" hidden><ol class="nb-queue" id="nb-queue"></ol><form class="nb-form" id="nb-req-form"><input id="nb-req-in" maxlength="120" placeholder="Add a song" aria-label="Song request"><button class="btn btn-mini" type="submit">Add</button></form></section>
      <section class="nb-view" data-nv="poll" hidden><div id="nb-poll"></div>
        <form class="nb-pollform" id="nb-pollform"><input id="nb-pq" maxlength="120" placeholder="Question"><input class="nb-po" maxlength="60" placeholder="Option 1"><input class="nb-po" maxlength="60" placeholder="Option 2"><input class="nb-po" maxlength="60" placeholder="Option 3 (optional)"><div class="row2"><button class="btn btn-yellow btn-mini" type="submit">Open poll</button><button class="btn btn-mini" type="button" id="nb-pclose">Close poll</button></div><label class="mini chk"><input type="checkbox" id="nb-ponstream" checked><span>Show on stream</span></label></form></section>
      <section class="nb-view" data-nv="live" hidden><div id="nb-livebox"></div></section>
      <section class="nb-view" data-nv="help" hidden><iframe id="nb-help" title="Help" loading="lazy"></iframe></section>
    </div></div>`);
  document.body.appendChild(bubble);
  const REACT = ['🔥', '💜', '👏', '😂', '🎉', '⚡', '🐺', '✨'];
  $('#nb-react').innerHTML = REACT.map((r) => `<button type="button" data-r="${r}" aria-label="React ${r}">${r}</button>`).join('');
  let unread = 0, open = false, docked = false, hub = null, liveInfo = store.get('nebu:live', null), queue = [], poll = null;
  const dockKey = () => `nebu:chat-dock:${me ? me.id : 'anon'}`;
  const isPhone = () => matchMedia('(max-width: 820px)').matches;
  function setOpen(v) {
    open = v; bubble.dataset.state = v ? (docked && !isPhone() ? 'docked' : isPhone() ? 'sheet' : 'open') : 'closed';
    $('#nb-panel').hidden = !v; $('#nb-btn').setAttribute('aria-expanded', String(v)); document.body.classList.toggle('nb-docked', v && docked && !isPhone());
    if (v) { unread = 0; badge(); setTimeout(() => $('#nb-in').focus(), 50); }
  }
  function badge() { const b = $('#nb-badge'); b.hidden = !unread; b.textContent = unread > 9 ? '9+' : unread; }
  function pulse() { if (open) return; unread++; badge(); const btn = $('#nb-btn'); btn.classList.remove('is-pulse'); void btn.offsetWidth; btn.classList.add('is-pulse'); }
  $('#nb-btn').addEventListener('click', () => { if (!dragged) setOpen(!open); });
  $('#nb-close').addEventListener('click', () => setOpen(false));
  $('#nb-dock').addEventListener('click', () => { docked = !docked; store.set(dockKey(), docked); $('#nb-dock').setAttribute('aria-pressed', String(docked)); setOpen(true); });
  $$('.nb-tabs [data-nt]').forEach((b) => b.addEventListener('click', () => { $$('.nb-tabs [data-nt]').forEach((x) => x.setAttribute('aria-selected', String(x === b))); $$('.nb-view').forEach((v) => { v.hidden = v.dataset.nv !== b.dataset.nt; }); if (b.dataset.nt === 'live') renderLive(); }));
  // Draggable bubble, kept clear of the stage controls and mobile tabs
  let dragged = false;
  (() => {
    const btn = $('#nb-btn'); let st = null; const pos = store.get('nebu:nb-pos', null);
    const clampPos = (x, y) => { const pad = 14, bottomSafe = isPhone() ? 96 : 24; return { x: Math.max(pad, Math.min(innerWidth - 72 - pad, x)), y: Math.max(80, Math.min(innerHeight - 72 - bottomSafe, y)) }; };
    const place = (p) => { const c = clampPos(p.x, p.y); bubble.style.left = c.x + 'px'; bubble.style.top = c.y + 'px'; bubble.style.right = 'auto'; bubble.style.bottom = 'auto'; bubble.classList.toggle('nb-left', c.x < innerWidth / 2); return c; };
    if (pos) place(pos);
    btn.addEventListener('pointerdown', (e) => { btn.classList.add('is-tap'); clearTimeout(btn._tap); btn._tap = setTimeout(() => btn.classList.remove('is-tap'), 900); st = { x: e.clientX, y: e.clientY, r: bubble.getBoundingClientRect() }; dragged = false; btn.setPointerCapture(e.pointerId); });
    btn.addEventListener('pointermove', (e) => { if (!st) return; const dx = e.clientX - st.x, dy = e.clientY - st.y; if (!dragged && Math.hypot(dx, dy) < 6) return; dragged = true; bubble.classList.add('is-drag'); place({ x: st.r.left + dx, y: st.r.top + dy }); });
    btn.addEventListener('pointerup', () => { if (!st) return; if (dragged) { const r = bubble.getBoundingClientRect(); const snapX = r.left + r.width / 2 < innerWidth / 2 ? 14 : innerWidth - 86; store.set('nebu:nb-pos', place({ x: snapX, y: r.top })); bubble.classList.remove('is-drag'); setTimeout(() => { dragged = false; }, 0); } st = null; });
    addEventListener('resize', () => { const p = store.get('nebu:nb-pos', null); if (p) place(p); });
  })();

  const tick = [];
  function addMsg(m) {
    const li = document.createElement('li'); li.className = `nb-msg${m.nebu ? ' is-nebu' : ''}${m.mine ? ' is-mine' : ''}`;
    li.innerHTML = `<span class="nb-who">${m.nebu ? `<i class="nb-host">${WM.wordmark('is-sm')}</i>` : ''}${m.host && !m.nebu ? '<i class="nb-hostb">HOST</i>' : ''}${esc(m.name)}<em class="mono">${esc(m.src)}</em></span><span class="nb-text">${esc(m.text)}</span>${m.nebu ? '' : `<button class="nb-pinbtn" type="button" data-pin="${esc(m.text)}" title="Pin for viewers" aria-label="Pin for viewers">📌</button>`}`;
    const ol = $('#nb-msgs'); ol.appendChild(li); while (ol.children.length > 150) ol.firstChild.remove(); ol.scrollTop = ol.scrollHeight;
    tick.push(`${m.name}: ${m.text}`); if (tick.length > 5) tick.shift(); G.tickerText = tick.join('   ✦   ');
    if (!m.mine) pulse();
  }
  $('#nb-msgs').addEventListener('click', (e) => { const b = e.target.closest('[data-pin]'); if (!b) return; if (hubSend({ type: 'pin', text: b.dataset.pin })) toast('Pinned for viewers.'); else toast('Open the live chat first to pin.'); });
  addEventListener('nebu:chat', (e) => { const d = e.detail; const mine = d.from && d.from === NebuStudio.myId(); if (mine && hub && hub.readyState === 1) return; addMsg({ name: mine ? 'You' : (d.name || 'Guest'), text: d.text, src: 'room', mine, host: mine }); });
  $('#nb-form').addEventListener('submit', (e) => {
    e.preventDefault(); const text = $('#nb-in').value.trim(); if (!text) return; $('#nb-in').value = '';
    const sentRoom = NebuStudio.sendChat(text); const sentLive = hubSend({ type: 'chat', text });
    if (!sentRoom && !sentLive) addMsg({ name: 'You', text, src: 'local', mine: true, host: true });
  });
  $('#nb-react').addEventListener('click', (e) => { const b = e.target.closest('[data-r]'); if (!b) return; G.burst(b.dataset.r, 5); hubSend({ type: 'react', emoji: b.dataset.r }); });
  $('#nb-req-form').addEventListener('submit', (e) => { e.preventDefault(); const s = $('#nb-req-in').value.trim(); if (!s) return; $('#nb-req-in').value = ''; if (!hubSend({ type: 'request', song: s })) { queue.push({ id: String(Date.now()), song: s, from: 'You', votes: 1, status: 'queued' }); renderQueue(); } });
  function renderQueue() {
    $('#nb-req-n').textContent = queue.filter((q) => q.status === 'queued').length || '';
    $('#nb-queue').innerHTML = queue.map((q) => `<li class="nb-q is-${esc(q.status)}"><span class="nb-q-v mono">${q.votes}</span><span class="nb-q-s"><b>${esc(q.song)}</b><em>${esc(q.from)}${q.status === 'playing' ? ' · playing' : q.status === 'played' ? ' · played' : ''}</em></span><button class="nb-ico" data-q="${q.id}" data-s="playing" title="Mark playing">▶</button><button class="nb-ico" data-q="${q.id}" data-s="remove" title="Remove">✕</button></li>`).join('') || '<li class="quiet">Song requests from the chat land here.</li>';
  }
  $('#nb-queue').addEventListener('click', (e) => { const b = e.target.closest('[data-q]'); if (!b) return; if (!hubSend({ type: 'queue_set', id: b.dataset.q, status: b.dataset.s })) { if (b.dataset.s === 'remove') queue = queue.filter((q) => q.id !== b.dataset.q); else queue.forEach((q) => { q.status = q.id === b.dataset.q ? 'playing' : q.status === 'playing' ? 'played' : q.status; }); renderQueue(); } const q = queue.find((x) => x.id === b.dataset.q); if (q && b.dataset.s === 'playing') { G.showLT(true, { design: 'nowplaying', title: q.song.slice(0, 40), sub: `Requested by ${q.from}`, holdMs: 7000 }); } });
  function renderPoll() {
    G.poll = poll; const box = $('#nb-poll');
    if (!poll) { box.innerHTML = '<p class="quiet">No poll running. Open one below; viewers vote from the chat.</p>'; return; }
    box.innerHTML = `<div class="nb-pollcard"><b>${esc(poll.q)}</b>${poll.options.map((o, i) => { const pct = poll.total ? Math.round(poll.counts[i] / poll.total * 100) : 0; return `<div class="nb-po-row"><i style="--w:${pct}%"></i><span>${esc(o)}</span><em class="mono">${pct}%</em></div>`; }).join('')}<p class="mono quiet">${poll.total} vote${poll.total === 1 ? '' : 's'}${poll.closed ? ' · closed' : ''}</p></div>`;
  }
  $('#nb-pollform').addEventListener('submit', (e) => { e.preventDefault(); const q = $('#nb-pq').value.trim(), options = $$('.nb-po').map((i) => i.value.trim()).filter(Boolean); if (!q || options.length < 2) { toast('A question and two options.'); return; } if (!hubSend({ type: 'poll_open', q, options })) { poll = { id: String(Date.now()), q, options, counts: options.map(() => 0), total: 0, closed: false }; renderPoll(); } });
  $('#nb-pclose').addEventListener('click', () => { if (!hubSend({ type: 'poll_close' }) && poll) { poll.closed = true; renderPoll(); } });
  $('#nb-ponstream').addEventListener('change', (e) => { G.pollOnStream = e.target.checked; });

  // ---------------- Live viewer chat (host side) ----------------
  function hubSend(m) { if (hub && hub.readyState === 1) { hub.send(JSON.stringify(m)); return true; } return false; }
  function connectHub() {
    if (!liveInfo || !SIGNAL) return;
    const ws = new WebSocket(`${SIGNAL.replace(/^http/, 'ws')}/live/${liveInfo.sid}/ws?t=${encodeURIComponent(liveInfo.hostToken)}`); hub = ws;
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onHub(m); };
    ws.onclose = (e) => { hub = null; $('#nb-live').textContent = 'OFF AIR'; bubble.classList.remove('is-live'); if (e.code === 4000 || e.code === 1008) { liveInfo = null; store.set('nebu:live', null); renderLive(); } else if (liveInfo) setTimeout(connectHub, 2000); };
    ws.onopen = () => { $('#nb-live').textContent = 'LIVE CHAT'; bubble.classList.add('is-live'); G.overlays.live = true; $('[data-ov="live"]')?.setAttribute('aria-pressed', 'true'); };
    setInterval(() => hubSend({ type: 'ping' }), 25000);
  }
  function onHub(m) {
    if (m.type === 'hello') { queue = m.queue || []; poll = m.poll; G.viewers = Math.max(0, (m.viewers || 1) - 1); renderQueue(); renderPoll(); setPin(m.pinned); (m.history || []).forEach((x) => x.type === 'chat' && addMsg({ name: x.from.name, text: x.text, src: x.from.via || 'live', nebu: x.nebu, host: x.from.host, mine: true })); }
    if (m.type === 'chat') addMsg({ name: m.from.name, text: m.text, src: m.from.via === 'telegram' ? 'tg' : m.from.via || 'live', nebu: m.nebu, host: m.from.host, mine: m.from.host });
    if (m.type === 'react') G.burst(m.emoji, 3);
    if (m.type === 'queue') { const before = queue.length; queue = m.queue; renderQueue(); if (queue.length > before) pulse(); }
    if (m.type === 'poll') { poll = m.poll; renderPoll(); }
    if (m.type === 'pinned') setPin(m.pinned);
    if (m.type === 'presence') G.viewers = Math.max(0, m.viewers - 1);
    if (m.type === 'ended') { liveInfo = null; store.set('nebu:live', null); renderLive(); }
  }
  function setPin(p) {
    const el = $('#nb-pin'); const text = p && String(p.text || '').trim();
    if (!text) { el.hidden = true; el.innerHTML = ''; delete el.dataset.text; return; }
    if (el.dataset.text === text && !el.hidden) return;
    el.dataset.text = text; el.innerHTML = `<span class="mono">📌 ${p.by === 'nebu' ? `PINNED BY ${WM.wordmark('is-sm')}` : 'PINNED'}</span><span class="nb-pin-t">${esc(text)}</span><button class="nb-ico nb-unpin" type="button" title="Unpin" aria-label="Unpin">✕</button>`;
    el.hidden = false; el.classList.remove('is-in'); void el.offsetWidth; el.classList.add('is-in');
    el.querySelector('.nb-unpin').onclick = () => hubSend({ type: 'pin', text: '' });
  }
  function renderLive() {
    const box = $('#nb-livebox'), L = CFG.live || {};
    if (!L.enabled) { box.innerHTML = '<p class="quiet">Live viewer chat isn\'t switched on here yet.</p>'; return; }
    if (!liveInfo) { box.innerHTML = `<p class="src-note">Open a live chat for your viewers. People in Telegram tap the link and chat inside Telegram; everyone else gets a web link. No accounts for viewers.</p><button class="btn btn-yellow btn-block" id="lv-start" type="button">Open live chat</button>${!me && !L.anonHosts ? '<p class="quiet">Sign in with FRISKY ID first.</p>' : ''}`; $('#lv-start').onclick = startLive; return; }
    box.innerHTML = `<div class="lv-links">
      ${liveInfo.tgUrl ? `<label class="field-label mono">Telegram Mini App link</label><div class="lv-row"><code>${esc(liveInfo.tgUrl)}</code><button class="btn btn-mini" data-copy="${esc(liveInfo.tgUrl)}" type="button">Copy</button></div>` : '<p class="quiet">Telegram link appears once the bot and Mini App are set up (see the guide).</p>'}
      <label class="field-label mono">Web link</label><div class="lv-row"><code>${esc(liveInfo.webUrl)}</code><button class="btn btn-mini" data-copy="${esc(liveInfo.webUrl)}" type="button">Copy</button></div></div>
      <details class="lv-post"><summary>Post “Join the live chat” in a Telegram group</summary>
        <label class="field"><span class="field-label mono">Group @username or id</span><input id="lv-chat" placeholder="@mygroup"></label>
        <label class="mini chk"><input type="checkbox" id="lv-pin" checked><span>Pin it</span></label>
        <button class="btn btn-mini" id="lv-post" type="button">Post</button><p class="src-note" id="lv-post-note">${me ? 'NEBU posts with its bot. It has to be an admin with “Pin messages” to pin.' : 'Sign in with FRISKY ID to post.'}</p></details>
      <label class="mini"><span class="mono">Slow mode</span><select id="lv-slow"><option value="0">Off</option><option value="5">5 s</option><option value="15">15 s</option><option value="30">30 s</option></select></label>
      <div class="row2"><button class="btn btn-mini" id="lv-rotate" type="button">New link</button><button class="btn btn-mini" id="lv-end" type="button">End live chat</button></div>`;
    $$('[data-copy]', box).forEach((b) => b.onclick = () => navigator.clipboard.writeText(b.dataset.copy).then(() => toast('Copied.')));
    $('#lv-slow').onchange = (e) => hubSend({ type: 'slow', seconds: +e.target.value });
    $('#lv-end').onclick = async () => { try { await api(`/live/${liveInfo.sid}/end`, { method: 'POST', headers: { Authorization: `Bearer ${liveInfo.hostToken}` } }); } catch { /* */ } hub && hub.close(); liveInfo = null; store.set('nebu:live', null); renderLive(); toast('Live chat ended. The links stopped working.'); };
    $('#lv-rotate').onclick = async () => { try { const r = await api(`/live/${liveInfo.sid}/rotate`, { method: 'POST', headers: { Authorization: `Bearer ${liveInfo.hostToken}` } }); hub && hub.close(); liveInfo = r; store.set('nebu:live', r); connectHub(); renderLive(); toast('New link. The old one is dead.'); } catch (e) { toast(e.message); } };
    $('#lv-post').onclick = async () => { const n = $('#lv-post-note'); try { const r = await api('/actions/join-message', { method: 'POST', body: { chat: $('#lv-chat').value.trim(), url: liveInfo.tgUrl || liveInfo.webUrl, pin: $('#lv-pin').checked } }); n.textContent = r.mock ? `Test mode: nothing was posted (message ${r.messageId}${r.pinned ? ', pinned' : ''}).` : 'Posted.'; } catch (e) { n.textContent = e.message; } };
  }
  async function startLive() { try { liveInfo = await api('/live', { method: 'POST' }); store.set('nebu:live', liveInfo); connectHub(); renderLive(); } catch (e) { toast(e.status === 401 ? 'Sign in with FRISKY ID first.' : e.message); } }

  // Help tab (Chatwoot merges here instead of a second bubble, when configured)
  const cw = ($('meta[name="nebu-help"]') || {}).content; if (cw) { $('#nb-help-tab').hidden = false; $('#nb-help').src = cw; }

  // ---------------- VC node ----------------
  let vcId = store.get('nebu:tenant', '');
  const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  async function pkce() {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const verifier = b64url(raw);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return { verifier, challenge: b64url(new Uint8Array(digest)) };
  }
  function oauthBack(provider) {
    const u = new URL(location.href); u.search = ''; u.hash = '';
    return u.toString();
  }
  async function startOAuth(provider) {
    const id = provider === 'spotify' ? (CFG.spotify && CFG.spotify.clientId) : (CFG.google && CFG.google.clientId);
    if (!id) { toast(provider === 'spotify' ? 'Spotify is not connected on this node.' : 'Drive is not connected on this node.'); return; }
    const { verifier, challenge } = await pkce();
    sessionStorage.setItem('nebu:pkce', JSON.stringify({ provider, verifier }));
    const u = new URL(provider === 'spotify' ? 'https://accounts.spotify.com/authorize' : 'https://accounts.google.com/o/oauth2/v2/auth');
    u.searchParams.set('client_id', id);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('redirect_uri', oauthBack());
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('state', provider);
    u.searchParams.set('scope', provider === 'spotify' ? 'user-read-currently-playing user-read-email' : 'openid email');
    location.href = u.toString();
  }
  async function finishOAuth() {
    const q = new URLSearchParams(location.search);
    const code = q.get('code'), state = q.get('state');
    if (!code || (state !== 'spotify' && state !== 'drive')) return '';
    history.replaceState(null, '', location.pathname + location.hash);
    let saved; try { saved = JSON.parse(sessionStorage.getItem('nebu:pkce') || 'null'); } catch { saved = null; }
    sessionStorage.removeItem('nebu:pkce');
    if (!saved || saved.provider !== state) return 'That sign-in did not match this tab.';
    try {
      if (state === 'spotify') {
        if (!CFG.spotify || !CFG.spotify.clientId) return 'Spotify is not connected on this node.';
        const body = new URLSearchParams({ client_id: CFG.spotify.clientId, grant_type: 'authorization_code', code, redirect_uri: oauthBack(), code_verifier: saved.verifier });
        const tok = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
        const tj = await tok.json();
        if (!tok.ok) return tj.error_description || 'Spotify refused the code.';
        const meR = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: `Bearer ${tj.access_token}` } });
        const who = await meR.json();
        const now = await fetch('https://api.spotify.com/v1/me/player/currently-playing', { headers: { Authorization: `Bearer ${tj.access_token}` } });
        let title = '';
        if (now.status === 200) { const n = await now.json(); const t = n.item; if (t) title = `${t.name} — ${(t.artists || []).map((a) => a.name).join(', ')}`; }
        if (session) await api('/connect/spotify', { method: 'PUT', body: { id: who.id || '', name: title || who.display_name || 'Spotify', email: who.email || '' } });
        return title ? `Spotify now playing: ${title}. Audio stays in Spotify. The decks still use local files.` : 'Spotify is linked. Nothing is playing. Audio is not captured.';
      }
      if (!CFG.google || !CFG.google.clientId) return 'Drive is not connected on this node.';
      const body = new URLSearchParams({ client_id: CFG.google.clientId, grant_type: 'authorization_code', code, redirect_uri: oauthBack(), code_verifier: saved.verifier });
      const tok = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      const tj = await tok.json();
      if (!tok.ok) return tj.error_description || 'Google refused the code.';
      const info = await (await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${tj.access_token}` } })).json();
      if (session) await api('/connect/drive', { method: 'PUT', body: { id: info.sub || '', email: info.email || '', name: info.email || 'Google' } });
      return info.email ? `Drive account noted: ${info.email}. Takes still download to this device.` : 'Drive linked.';
    } catch (e) { return e.message || 'Sign-in did not finish.'; }
  }
  async function renderVc() {
    const box = $('#vc-b'); if (!box) return;
    const S = CFG.stage2 || {};
    const modes = S.modes || {};
    if (!me) {
      box.innerHTML = `<p class="src-note">Sign in with FRISKY ID to use the VC node.</p>
        <p class="src-note">Your NEBU on a second Telegram account. A Discord bot you bring. Video chat status (this worker does not join a call). RTMP out, with a real key shown once. A phone number for that second account. Spotify now-playing text and a Drive account link. A Paperclip seat link. Credits in test mode. Vellum stays off, there is no virtual camera, and the extension guide does not click or sign in for you.</p>`;
      return;
    }
    let profile = null, err = '';
    try { profile = await api('/me/nebu'); } catch (e) { err = e.message; }
    const list = (profile && profile.nebu) || [];
    if (!vcId || !list.some((n) => n.id === vcId)) vcId = (list[0] && list[0].id) || '';
    const mine = list.find((n) => n.id === vcId) || null;
    const secrets = (profile && profile.secrets && profile.secrets[vcId]) || {};
    const links = (profile && profile.links) || {};
    box.innerHTML = `
      ${err ? `<p class="src-note">${esc(err)}</p>` : ''}
      <div class="row2">${list.length ? '' : `<button class="btn btn-yellow btn-mini" id="vc-create" type="button">Create my NEBU</button>`}
        ${mine ? `<span class="mono">${esc(mine.name)}</span>` : '<span class="quiet">No NEBU yet.</span>'}</div>
      <p class="src-note">One NEBU per FRISKY ID. It runs on a second Telegram account, not your personal one.</p>
      <p class="sub-h mono">Telegram API app</p>
      <p class="src-note">${secrets.telegram_api ? `Saved · api_id ${esc(secrets.telegram_api.apiId || '')}` : 'Paste api_id and api_hash from my.telegram.org, logged in as the second account.'}</p>
      <div class="row2"><input id="vc-api-id" inputmode="numeric" placeholder="api_id" aria-label="Telegram api_id"><input id="vc-api-hash" placeholder="api_hash" aria-label="Telegram api_hash" autocomplete="off"></div>
      <button class="btn btn-mini" id="vc-api-save" type="button">Save API app</button>
      <p class="sub-h mono">Second account</p>
      <p class="src-note" id="vc-tg-note">${mine && mine.tg_user ? `Connected · @${esc(mine.tg_user.username || mine.tg_user.id)} · ${esc(modes.telegramUser || 'mock')}` : `Not connected · mode ${esc(modes.telegramUser || 'mock')}. Test mode only accepts +99966 and five digits, code 22222.`}</p>
      <div class="row2"><input id="vc-phone" placeholder="+9996612345" aria-label="Phone"><button class="btn btn-mini" id="vc-code" type="button">Send code</button></div>
      <div class="row2"><input id="vc-otp" placeholder="Code" aria-label="Login code"><button class="btn btn-mini" id="vc-signin" type="button">Sign in</button></div>
      <input id="vc-2fa" placeholder="2FA password, if asked" aria-label="2FA password" autocomplete="off">
      <button class="btn btn-mini" id="vc-out" type="button">Log the second account out</button>
      <p class="sub-h mono">Discord bot</p>
      <p class="src-note">${secrets.discord_bot ? `Bot @${esc(secrets.discord_bot.bot || '')} · token ${esc(secrets.discord_bot.token || '')}` : 'Paste the bot token, Application ID, and Public Key. NEBU checks them with Discord before saving.'}</p>
      <input id="vc-d-token" placeholder="Bot token" aria-label="Discord bot token" autocomplete="off">
      <div class="row2"><input id="vc-d-app" placeholder="Application ID" aria-label="Discord application id"><input id="vc-d-key" placeholder="Public key" aria-label="Discord public key"></div>
      <button class="btn btn-mini" id="vc-d-save" type="button">Connect Discord</button>
      <p class="sub-h mono">Video chat</p>
      <p class="src-note">Joining a Telegram call as a participant is not in this worker. The check below reports the real state and will not say you are in the call unless the runtime confirms it.</p>
      <button class="btn btn-mini" id="vc-call" type="button">Check video chat</button>
      <p class="src-note" id="vc-call-note"></p>
      <p class="sub-h mono">RTMP out</p>
      <p class="src-note">Opens a Telegram stream on the second account. Test mode does not return a key. A real key is shown once, then only masked.</p>
      <div class="row2"><input id="vc-peer" placeholder="@group or id" aria-label="Telegram group"><button class="btn btn-yellow btn-mini" id="vc-live" type="button">Open stream</button><button class="btn btn-mini" id="vc-rot" type="button">Rotate key</button></div>
      <p class="src-note" id="vc-rtmp-note"></p>
      <p class="sub-h mono">Phone number</p>
      <p class="src-note">For the second account only. Telegram often rejects VoIP ranges. Buying stays off unless this node enables it. A mock result is labeled and is not a carrier number.</p>
      <div class="row2"><button class="btn btn-mini" id="vc-num-search" type="button">Search numbers</button><button class="btn btn-mini" id="vc-num-code" type="button">Check SMS code</button><button class="btn btn-mini" id="vc-num-drop" type="button">Release</button></div>
      <div id="vc-nums"></div>
      <p class="sub-h mono">Spotify and Drive</p>
      <p class="src-note">${S.spotify ? 'Spotify links now-playing text only. NEBU does not record or restream that audio.' : 'Spotify is not connected on this node.'} ${links.spotify ? `Linked: ${esc(links.spotify.name || '')}` : ''}</p>
      <div class="row2"><button class="btn btn-mini" id="vc-sp" type="button" ${S.spotify ? '' : 'disabled'}>Link Spotify</button><button class="btn btn-mini" id="vc-drive" type="button" ${S.drive ? '' : 'disabled'}>Link Drive</button></div>
      <p class="src-note">${S.drive ? 'Drive stores the account email. Recordings still download to this device.' : 'Drive is not connected on this node.'} ${links.drive ? `Linked: ${esc(links.drive.email || links.drive.name || '')}` : ''}</p>
      <p class="sub-h mono">Paperclip seat</p>
      <p class="src-note">Saves the seat id and a masked suffix, then opens clip.friskydev.com. Budgets stay in Paperclip. ${links.paperclip ? `Linked ${esc(links.paperclip.name || '')}` : ''}</p>
      <div class="row2"><input id="vc-seat" placeholder="FRSKY-PC-…" aria-label="Paperclip seat key"><button class="btn btn-mini" id="vc-seat-save" type="button">Link seat</button><a class="btn btn-mini" href="https://clip.friskydev.com" target="_blank" rel="noopener">Open desk</a></div>
      <p class="sub-h mono">Credits</p>
      <p class="src-note" id="vc-credits">Loading credits…</p>
      <p class="sub-h mono">Assistant, virtual cam, extension</p>
      <p class="src-note">${S.assistant ? 'The assistant flag is on. NEBU does not start a container from this page.' : 'Vellum is switched off.'} A browser cannot expose the program as a camera. Use the clean room feed as an OBS Browser Source. A Chrome guide may point at Telegram Web buttons. It does not click, type, or sign in.</p>`;
    const need = () => { if (!vcId) { toast('Create a NEBU first.'); return false; } return true; };
    const say = (id, text) => { const n = $(id); if (n) n.textContent = text; };
    if ($('#vc-create')) $('#vc-create').onclick = async () => { try { const r = await api('/me/nebu', { method: 'POST', body: { name: 'My NEBU' } }); vcId = r.id; store.set('nebu:tenant', vcId); toast('NEBU created.'); renderVc(); } catch (e) { toast(e.message); } };
    $('#vc-api-save').onclick = async () => { if (!need()) return; try { await api(`/me/nebu/${vcId}/telegram-api`, { method: 'PUT', body: { apiId: $('#vc-api-id').value.trim(), apiHash: $('#vc-api-hash').value.trim() } }); toast('API app saved.'); renderVc(); } catch (e) { toast(e.message); } };
    $('#vc-code').onclick = async () => { if (!need()) return; try { await api(`/me/nebu/${vcId}/tg/send-code`, { method: 'POST', body: { phone: $('#vc-phone').value.trim() } }); say('#vc-tg-note', 'Code sent. Enter it below.'); } catch (e) { say('#vc-tg-note', e.message); } };
    $('#vc-signin').onclick = async () => {
      if (!need()) return;
      try {
        const pw = $('#vc-2fa').value;
        const r = await api(`/me/nebu/${vcId}/tg/${pw ? 'password' : 'sign-in'}`, { method: 'POST', body: pw ? { password: pw } : { code: $('#vc-otp').value.trim() } });
        say('#vc-tg-note', r.step === 'password' ? `Telegram wants the 2FA password${r.hint ? ` (${r.hint})` : ''}.` : 'Second account connected.');
        if (r.step === 'done') renderVc();
      } catch (e) { say('#vc-tg-note', e.message); }
    };
    $('#vc-out').onclick = async () => { if (!need()) return; try { await api(`/me/nebu/${vcId}/tg/logout`, { method: 'POST', body: {} }); toast('Logged out.'); renderVc(); } catch (e) { toast(e.message); } };
    $('#vc-d-save').onclick = async () => { if (!need()) return; try { const r = await api(`/me/nebu/${vcId}/discord`, { method: 'PUT', body: { token: $('#vc-d-token').value.trim(), appId: $('#vc-d-app').value.trim(), publicKey: $('#vc-d-key').value.trim() } }); toast(r.discord ? `Discord @${r.discord.bot} connected.` : 'Discord saved.'); renderVc(); } catch (e) { toast(e.message); } };
    $('#vc-call').onclick = async () => { if (!need()) return; try { const r = await api(`/me/nebu/${vcId}/tg/vc`, { method: 'POST', body: { action: 'status' } }); say('#vc-call-note', r.joined ? 'In the video chat.' : (r.friendly || 'Not in a video chat.')); } catch (e) { say('#vc-call-note', e.message); } };
    const goLive = async (revoke) => {
      if (!need()) return;
      try {
        const r = await api(`/me/nebu/${vcId}/tg/go-live`, { method: 'POST', body: { peer: $('#vc-peer').value.trim(), revoke } });
        if (r.mocked || !r.ok) { say('#vc-rtmp-note', r.friendly || 'No stream.'); return; }
        say('#vc-rtmp-note', `URL ${r.rtmpUrl} · key ${r.streamKey} · copy it now. The next view is masked.`);
      } catch (e) { say('#vc-rtmp-note', e.message); }
    };
    $('#vc-live').onclick = () => goLive(false);
    $('#vc-rot').onclick = () => goLive(true);
    $('#vc-num-search').onclick = async () => {
      if (!need()) return;
      try {
        const r = await api(`/me/nebu/${vcId}/numbers/search`);
        const host = $('#vc-nums');
        host.innerHTML = (r.numbers || []).map((n) => `<div class="row2"><span class="mono">${esc(n.e164)} ${n.mock ? '· mock' : ''}</span><button class="btn btn-mini" type="button" data-buy="${esc(n.e164)}">Buy</button></div>`).join('') || '<p class="quiet">No numbers.</p>';
        if (r.mock) host.insertAdjacentHTML('afterbegin', '<p class="src-note">Mock list. Nothing was bought from a carrier.</p>');
        host.querySelectorAll('[data-buy]').forEach((b) => b.onclick = async () => { try { const out = await api(`/me/nebu/${vcId}/numbers`, { method: 'POST', body: { e164: b.dataset.buy } }); toast(out.number && out.number.mock ? 'Mock number saved. Not a carrier line.' : 'Number saved.'); } catch (e) { toast(e.message); } });
      } catch (e) { toast(e.message); }
    };
    $('#vc-num-code').onclick = async () => { if (!need()) return; try { const r = await api(`/me/nebu/${vcId}/numbers/code`, { method: 'POST', body: {} }); toast(r.code ? `Code ${r.code}` : (r.friendly || 'No code.')); } catch (e) { toast(e.message); } };
    $('#vc-num-drop').onclick = async () => { if (!need()) return; try { await api(`/me/nebu/${vcId}/numbers`, { method: 'DELETE' }); toast('Released.'); } catch (e) { toast(e.message); } };
    $('#vc-sp').onclick = () => startOAuth('spotify');
    $('#vc-drive').onclick = () => startOAuth('drive');
    $('#vc-seat-save').onclick = async () => { try { await api('/connect/paperclip', { method: 'PUT', body: { seat: $('#vc-seat').value.trim() } }); toast('Paperclip seat linked.'); renderVc(); } catch (e) { toast(e.message); } };
    try {
      const bal = await api('/billing/balance');
      const tiers = (bal.catalog && bal.catalog.tiers) || [];
      const c = bal.credits || {};
      $('#vc-credits').textContent = `Credits · extra requests ${c.request || 0}, bigger sets ${c.set_plus || 0}, design systems ${c.design_system || 0}. Checkout is test mode only. ${tiers.map((t) => `${t.label}: ${t.priceLabel}${t.available ? '' : ' (not on sale)'}`).join(' · ') || 'No priced tiers.'}`;
    } catch (e) { $('#vc-credits').textContent = e.message; }
  }

  // ---------------- Boot ----------------
  (async () => {
    try { CFG = await (await fetch(`${SIGNAL}/config`)).json(); } catch { CFG = {}; }
    docked = !!store.get(dockKey(), false); $('#nb-dock').setAttribute('aria-pressed', String(docked));
    await auth();
    const oauthNote = await finishOAuth();
    if (oauthNote) { toast(oauthNote); renderVc(); }
    docked = !!store.get(dockKey(), docked);
    loadSets(); renderQueue(); renderPoll(); renderLive();
    if (liveInfo) connectHub();
    if (isPhone()) $('#nb-dock').hidden = true;
  })();
})();
