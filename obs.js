/*
 * NEBU — On air / Add to OBS (Track B).
 *
 * One click on #obs-copy-btn copies the Browser Source checklist shown in
 * #obs-config and brings it on screen. The URL itself comes from the studio
 * (Room panel -> "Copy OBS feed link"), because every room has its own
 * receive-only feed: /studio/?room=<id>&view=clean.
 *
 * Clipboard: navigator.clipboard.writeText, then document.execCommand('copy').
 * No dependencies.
 */
(function () {
  'use strict';

  var OBS_CONFIG = [
    '1. Open a room at https://nebu.quest/studio/',
    '2. Room panel -> Copy OBS feed link',
    '3. OBS: Sources + -> Browser, paste the link as the URL',
    'Width: 1920',
    'Height: 1080',
    'FPS: 30',
    'Control audio via OBS: CHECKED',
    'Shutdown source when not visible: UNCHECKED'
  ].join('\n');

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function configNode() {
    return document.getElementById('obs-config');
  }

  function showConfig() {
    var pre = configNode();
    if (!pre) return;
    if (!pre.textContent || !pre.textContent.trim()) pre.textContent = OBS_CONFIG;
    pre.hidden = false;
    pre.classList.add('is-shown');
    var band = pre.closest('.onair-band');
    if (band) band.classList.add('is-shown');
    try {
      pre.scrollIntoView({
        block: 'nearest',
        behavior: prefersReducedMotion() ? 'auto' : 'smooth'
      });
    } catch (err) {
      /* older engines */
    }
  }

  function payload() {
    return OBS_CONFIG;
  }

  function setStatus(label) {
    var status = document.getElementById('obs-copy-status');
    if (status) status.textContent = label;
    return status;
  }

  function confirmCopied(btn, label) {
    setStatus(label);
    if (btn) {
      btn.classList.add('is-copied');
      btn.setAttribute('data-obs-state', label === 'Copied' ? 'copied' : 'failed');
    }
    window.setTimeout(function () {
      if (btn) btn.classList.remove('is-copied');
      var status = document.getElementById('obs-copy-status');
      if (status && status.textContent === label) status.textContent = '';
    }, 2000);
  }

  function legacyCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.setAttribute('aria-hidden', 'true');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '0';
    area.style.width = '1px';
    area.style.height = '1px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.focus();
    area.select();
    try {
      area.setSelectionRange(0, text.length);
    } catch (err) {
      /* some engines reject setSelectionRange on non-text inputs */
    }
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (err) {
      ok = false;
    }
    document.body.removeChild(area);
    return ok;
  }

  function copyText(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text).then(
        function () {
          return true;
        },
        function () {
          return legacyCopy(text);
        }
      );
    }
    return Promise.resolve(legacyCopy(text));
  }

  function onCopy(event) {
    var btn = event.currentTarget;
    showConfig();
    copyText(payload()).then(function (ok) {
      confirmCopied(btn, ok ? 'Copied' : 'Copy failed. Select the checklist and copy it.');
    });
  }

  function wire(root) {
    var scope = root && root.querySelector ? root : document;
    var btn = scope.querySelector ? scope.querySelector('#obs-copy-btn') : null;
    if (!btn && scope.id === 'obs-copy-btn') btn = scope;
    if (!btn || btn.getAttribute('data-obs-wired') === '1') return false;
    btn.setAttribute('data-obs-wired', '1');
    btn.addEventListener('click', onCopy);
    return true;
  }

  function watch() {
    wire(document);
    if (!document.body || typeof MutationObserver !== 'function') return;
    var observer = new MutationObserver(function () {
      if (wire(document)) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', watch, { once: true });
  } else {
    watch();
  }
})();
