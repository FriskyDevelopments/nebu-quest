/*
 * NEBU — On air / Add to OBS (Track B).
 *
 * One click on #obs-copy-btn copies the Browser Source configuration shown
 * in #obs-config (URL plus the four settings) and brings that checklist
 * on screen. The URL is the line you paste into OBS; the rest you match.
 *
 * Clipboard: navigator.clipboard.writeText, then document.execCommand('copy').
 * No dependencies. Does not invent studio query params.
 */
(function () {
  'use strict';

  var OBS_URL = 'https://vc.friskydev.com/studio?obs=1&layout=clean';
  var OBS_CONFIG = [
    'URL: ' + OBS_URL,
    'Width: 1920',
    'Height: 1080',
    'FPS: 30',
    'Shutdown source when not visible: CHECKED',
    'Refresh browser when scene becomes active: UNCHECKED'
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

  function payload(btn) {
    var fromBtn = btn && btn.getAttribute('data-obs-url');
    var url = fromBtn || OBS_URL;
    var pre = configNode();
    var shown = pre && pre.textContent ? pre.textContent.trim() : '';
    if (!shown) shown = OBS_CONFIG;
    if (shown.indexOf(url) === -1) shown = 'URL: ' + url + '\n' + shown;
    return shown;
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
    copyText(payload(btn)).then(function (ok) {
      confirmCopied(btn, ok ? 'Copied' : 'Copy failed — select the checklist and copy it');
    });
  }

  function wire(root) {
    var scope = root && root.querySelector ? root : document;
    var btn = scope.querySelector ? scope.querySelector('#obs-copy-btn') : null;
    if (!btn && scope.id === 'obs-copy-btn') btn = scope;
    if (!btn || btn.getAttribute('data-obs-wired') === '1') return false;
    btn.setAttribute('data-obs-wired', '1');
    if (!btn.getAttribute('data-obs-url')) btn.setAttribute('data-obs-url', OBS_URL);
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
