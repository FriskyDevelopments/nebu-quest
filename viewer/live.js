/* NEBU live chat for viewers: Telegram Mini App (initData) or plain web (guest name). */
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PREVIEW = /(^|\.)nebu-quest\.pages\.dev$|^localhost$|^127\.0\.0\.1$/.test(location.hostname) && location.hostname !== 'nebu-quest.pages.dev';
  const qs = new URLSearchParams(location.search);
  const SIGNAL = ((PREVIEW && qs.get('signal')) || ($(PREVIEW ? 'meta[name="nebu-signal-preview"]' : 'meta[name="nebu-signal"]') || {}).content || '').replace(/\/$/, '');
  const TG = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData ? window.Telegram.WebApp : null;
  const sid = (TG && (TG.initDataUnsafe.start_param || '')) || location.pathname.split('/').filter(Boolean)[1] || qs.get('s') || '';
  let ws = null, token = null, me = null, mode = 'chat', poll = null, queue = [], myVote = null, reactions = ['🔥', '💜', '👏', '😂', '🎉', '⚡', '🐺', '✨'];

  // Telegram theme -> FR!SKY dark. Keep our palette, borrow only what makes it feel native.
  if (TG) {
    TG.ready(); TG.expand(); try { TG.setHeaderColor('#0B001A'); TG.setBackgroundColor('#0B001A'); } catch { /* older clients */ }
    const tp = TG.themeParams || {}; if (tp.button_color) document.documentElement.style.setProperty('--tg-accent', tp.button_color);
    document.documentElement.classList.add('in-tg');
  }
  const sub = (t) => { $('#lv-sub').textContent = t; };
  if (!sid) { sub('No live chat in this link.'); return; }

  async function auth(body) {
    const r = await fetch(`${SIGNAL}/live/${encodeURIComponent(sid)}/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(j.friendly || j.error || 'error'), { status: r.status }); return j;
  }
  function connect() {
    ws = new WebSocket(`${SIGNAL.replace(/^http/, 'ws')}/live/${encodeURIComponent(sid)}/ws?t=${encodeURIComponent(token)}`);
    ws.onopen = () => sub(me.owner ? 'You are the host' : `Chatting as ${me.name}`);
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } on(m); };
    ws.onclose = (e) => { if (e.code === 4000) return ended(); sub('Reconnecting…'); setTimeout(connect, 1500); };
  }
  const send = (m) => { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(m)); return true; } return false; };
  setInterval(() => send({ type: 'ping' }), 25000);

  function on(m) {
    if (m.type === 'hello') { reactions = m.reactions || reactions; renderReact(); (m.history || []).forEach((x) => x.type === 'chat' && msg(x, true)); pin(m.pinned); poll = m.poll; queue = m.queue || []; count(m.viewers); cards(); }
    if (m.type === 'chat') msg(m);
    if (m.type === 'react') float(m.emoji);
    if (m.type === 'presence') count(m.viewers);
    if (m.type === 'pinned') pin(m.pinned);
    if (m.type === 'poll') { if (!poll || poll.id !== m.poll?.id) myVote = null; poll = m.poll; cards(); }
    if (m.type === 'queue') { queue = m.queue; cards(); }
    if (m.type === 'announce') announce(m.text);
    if (m.type === 'slowmode') sub(m.slow ? `Slow mode: one message every ${m.slow}s` : `Chatting as ${me.name}`);
    if (m.type === 'slow') haptic('warning');
    if (m.type === 'ended') ended();
  }
  function msg(m, quiet) {
    const li = document.createElement('li'); const mine = me && m.from && m.from.uid === me.uid;
    li.className = `lv-msg${m.nebu ? ' is-nebu' : ''}${m.from && m.from.host && !m.nebu ? ' is-host' : ''}${mine ? ' is-mine' : ''}${quiet ? ' is-quiet' : ''}`;
    li.innerHTML = `<span class="lv-who">${m.nebu ? '<i class="b-nebu">NEBU</i>' : m.from.host ? '<i class="b-host">HOST</i>' : ''}${esc(m.from.name)}</span><span class="lv-text">${esc(m.text)}</span>`;
    const ol = $('#lv-msgs'); ol.appendChild(li); while (ol.children.length > 120) ol.firstChild.remove(); ol.scrollTop = ol.scrollHeight;
  }
  // Pinned notice (hidden when empty). Appears with a slide + pin drop; leaves with a quick fold.
  function pin(p) {
    const el = $('#lv-pin'); const text = p && String(p.text || '').trim();
    clearTimeout(pin.t);
    if (!text) { if (el.hidden) return; el.classList.remove('is-in'); el.classList.add('is-out'); pin.t = setTimeout(() => { el.hidden = true; el.classList.remove('is-out'); el.innerHTML = ''; }, 260); return; }
    if (el.dataset.text === text && !el.hidden) return;
    el.dataset.text = text;
    el.innerHTML = `<i class="lv-pin-ico" aria-hidden="true">📌</i><span class="lv-pin-body"><em>Pinned by the host</em><span>${esc(text)}</span></span>`;
    el.hidden = false; el.classList.remove('is-out', 'is-in'); void el.offsetWidth; el.classList.add('is-in');
  }
  function count(n) { const el = $('#lv-count'); el.hidden = !n; el.textContent = `👁 ${Math.max(0, n - 1)}`; }
  function announce(text) { const el = $('#lv-announce'); if (!String(text || '').trim()) return; el.hidden = false; el.classList.remove('is-out'); el.innerHTML = `<i class="b-nebu">NEBU</i><span>${esc(text)}</span>`; el.classList.remove('is-in'); void el.offsetWidth; el.classList.add('is-in'); clearTimeout(announce.t); announce.t = setTimeout(() => { el.classList.remove('is-in'); el.classList.add('is-out'); setTimeout(() => { el.hidden = true; el.classList.remove('is-out'); }, 260); }, 8000); haptic('success'); }
  function cards() {
    const c = $('#lv-cards'); let html = '';
    if (poll) {
      html += `<article class="card card-poll${poll.closed ? ' is-closed' : ''}"><header><span>POLL${poll.closed ? ' · CLOSED' : ''}</span><b>${esc(poll.q)}</b></header>${poll.options.map((o, i) => { const pct = poll.total ? Math.round(poll.counts[i] / poll.total * 100) : 0; return `<button class="opt${myVote === i ? ' is-mine' : ''}" data-vote="${i}" ${poll.closed ? 'disabled' : ''}><i style="--w:${pct}%"></i><span>${esc(o)}</span><em>${pct}%</em></button>`; }).join('')}<footer>${poll.total} vote${poll.total === 1 ? '' : 's'}</footer></article>`;
    }
    const q = queue.filter((x) => x.status !== 'played').slice(0, 5);
    if (q.length) html += `<article class="card card-queue"><header><span>SONG REQUESTS</span><b>Up next</b></header><ol>${q.map((x) => `<li class="${x.status === 'playing' ? 'is-playing' : ''}"><button data-up="${x.id}" aria-label="Upvote">▲<em>${x.votes}</em></button><span><b>${esc(x.song)}</b><i>${x.status === 'playing' ? 'Playing now' : `from ${esc(x.from)}`}</i></span></li>`).join('')}</ol></article>`;
    c.innerHTML = html;
  }
  $('#lv-cards').addEventListener('click', (e) => {
    const v = e.target.closest('[data-vote]'); if (v) { myVote = +v.dataset.vote; send({ type: 'vote', option: myVote }); haptic('light'); cards(); return; }
    const u = e.target.closest('[data-up]'); if (u) { send({ type: 'upvote', id: u.dataset.up }); haptic('light'); }
  });
  function renderReact() { $('#lv-react').innerHTML = reactions.map((r) => `<button type="button" data-r="${r}" aria-label="React ${r}">${r}</button>`).join(''); }
  $('#lv-react').addEventListener('click', (e) => { const b = e.target.closest('[data-r]'); if (!b) return; send({ type: 'react', emoji: b.dataset.r }); float(b.dataset.r, true); haptic('light'); b.classList.remove('is-hit'); void b.offsetWidth; b.classList.add('is-hit'); });
  function float(emoji, mine) {
    const f = document.createElement('span'); f.className = 'fl'; f.textContent = emoji;
    f.style.setProperty('--x', `${(Math.random() - .5) * 60}px`); f.style.setProperty('--r', `${(Math.random() - .5) * 40}deg`); f.style.right = `${mine ? 24 : 14 + Math.random() * 50}px`;
    $('#lv-float').appendChild(f); setTimeout(() => f.remove(), 2600);
  }
  $('#lv-mode').addEventListener('click', () => { mode = mode === 'chat' ? 'request' : 'chat'; $('#lv-mode').textContent = mode === 'chat' ? '💬' : '🎵'; $('#lv-in').placeholder = mode === 'chat' ? 'Say something' : 'Request a song (artist – title)'; $('#lv-in').focus(); });
  $('#lv-form').addEventListener('submit', (e) => { e.preventDefault(); const v = $('#lv-in').value.trim(); if (!v) return; if (send(mode === 'chat' ? { type: 'chat', text: v } : { type: 'request', song: v })) { $('#lv-in').value = ''; if (mode === 'request') { mode = 'chat'; $('#lv-mode').textContent = '💬'; $('#lv-in').placeholder = 'Say something'; } } });
  function haptic(k) { try { if (TG && TG.HapticFeedback) k === 'light' ? TG.HapticFeedback.impactOccurred('light') : TG.HapticFeedback.notificationOccurred(k); } catch { /* */ } }
  function ended() { $('#lv-ended').hidden = false; $('#lv-pill').classList.add('is-off'); sub('Ended'); if (ws) { ws.onclose = null; ws.close(); } }

  (async () => {
    try {
      if (TG) { const r = await auth({ initData: TG.initData }); token = r.token; me = r.me; connect(); return; }
      const saved = sessionStorage.getItem(`nebu:live:${sid}`);
      if (saved) { const s = JSON.parse(saved); token = s.token; me = s.me; connect(); return; }
      const st = await fetch(`${SIGNAL}/live/${encodeURIComponent(sid)}`).then((r) => r.json()).catch(() => ({}));
      if (st.status !== 'live') return ended();
      $('#lv-gate').hidden = false; sub('Pick a name to join');
      $('#lv-join').addEventListener('submit', async (e) => {
        e.preventDefault(); $('#lv-err').textContent = '';
        try { const r = await auth({ guest: $('#lv-name').value }); token = r.token; me = r.me; sessionStorage.setItem(`nebu:live:${sid}`, JSON.stringify(r)); $('#lv-gate').hidden = true; connect(); }
        catch (err) { if (err.status === 410) return ended(); $('#lv-err').textContent = err.status === 429 ? 'Too many tries. Wait a minute.' : err.message; }
      });
    } catch (err) { if (err.status === 410) ended(); else sub(err.message === 'bad_init_data' ? "Telegram didn't vouch for this session. Reopen the link." : "Couldn't join. Try again."); }
  })();
})();
