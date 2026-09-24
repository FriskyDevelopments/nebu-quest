/* NEBU.QUEST — Track 4: sections + interactivity.
 *
 * index.html contract (shell owned by the header/hero track):
 *   <main id="main">
 *     ... hero ...
 *     <div class="signal-strip" aria-hidden="true"><!-- mount --></div>
 *     <section id="features" aria-label="The studio"><!-- mount --></section>
 *     <section id="steps" aria-label="Your kind of live"><!-- mount --></section>
 *     <section id="faq" aria-label="Good to know"><!-- mount --></section>
 *   </main>
 *   <footer><!-- mount --></footer>
 *   <script src="app.js" defer></script>
 *
 * Mounting: if the mounts above are already filled (sections inlined at
 * authoring time — the SPEC's preferred path), app.js makes zero network
 * calls and only wires behavior. If a mount is empty, its fragment is loaded
 * from sections.html (same-origin fetch) and placed in document order.
 * A top-level node with class "onair-band" is inserted immediately after #faq.
 *
 * index.html should also carry a <noscript> fallback, e.g.:
 *   <noscript><p>NEBU is a browser studio. Enable JavaScript to browse the
 *   sections, or <a href="https://vc.friskydev.com/">open your studio</a>.</p></noscript>
 *
 * Behavior: accessible feature tabs (aria-selected + arrow/Home/End keys),
 * IntersectionObserver data-reveal animations, smooth anchor scroll, mobile
 * nav toggle. All "Open your studio" links resolve to STUDIO_URL.
 * No dependencies.
 */
(() => {
  'use strict';
  document.documentElement.classList.add('js');

  const STUDIO_URL = 'https://vc.friskydev.com/';
  const SECTIONS_URL = 'sections.html';

  const FEATURES = {
    picture: {
      kicker: 'PICTURE / FIND YOUR FRAME',
      title: 'You call\nthe shots.',
      description: 'Choose your camera, share your screen, or line up a video. Preview your scene before it reaches the room.',
      points: ['Camera and microphone setup', 'Screen sharing and video rundown', 'Local preview before sharing'],
      label: '01 — PICTURE',
      bottom: 'Prepare → Preview → Share'
    },
    sound: {
      kicker: 'SOUND / SET THE MOOD',
      title: 'Find your\nfrequency.',
      description: 'Keep your voice and your video in balance. Adjust their audio independently while you prepare your scene.',
      points: ['Choose your microphone', 'Adjust microphone and video volume', 'Prepare audio before sharing'],
      label: '02 — SOUND',
      bottom: 'Your voice. Your video. Your mix.'
    },
    people: {
      kicker: 'PEOPLE / MAKE SOME ROOM',
      title: 'A link.\nYour people.',
      description: 'Give your next conversation a place to happen. Open a room and invite a small group to join you.',
      points: ['Create or join a video room', 'Copy and share a room invitation', 'Add the room to your calendar'],
      label: '03 — PEOPLE',
      bottom: 'Open a room → Share the invitation'
    },
    record: {
      kicker: 'RECORD / KEEP THE GOOD BITS',
      title: 'Worth making.\nWorth keeping.',
      description: 'Capture the output you choose and save the recording to your device. A take to keep, revisit or share later.',
      points: ['Record your selected output', 'Start and stop from the studio', 'Download to your device'],
      label: '04 — RECORD',
      bottom: 'Record → Download → Keep'
    }
  };

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function wireStudioLinks(root) {
    root.querySelectorAll('a[href*="vc.friskydev.com"], a[data-studio]').forEach((a) => {
      if (a.getAttribute('href') !== STUDIO_URL) a.setAttribute('href', STUDIO_URL);
    });
  }

  function applyFeature(tabs, panel, tab) {
    const feature = FEATURES[tab.dataset.feature];
    if (!feature) return;
    tabs.forEach((item) => {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
    });
    panel.dataset.mode = tab.dataset.feature;
    panel.setAttribute('aria-labelledby', tab.id);
    const set = (sel, text) => {
      const el = panel.querySelector(sel);
      if (el) el.textContent = text;
    };
    set('#feature-kicker', feature.kicker);
    const title = panel.querySelector('#feature-title');
    if (title) {
      title.replaceChildren();
      feature.title.split('\n').forEach((line, i) => {
        if (i) title.append(document.createElement('br'));
        title.append(document.createTextNode(line));
      });
    }
    set('#feature-description', feature.description);
    const points = panel.querySelector('#feature-points');
    if (points) {
      points.replaceChildren(...feature.points.map((text) => {
        const li = document.createElement('li');
        li.textContent = text;
        return li;
      }));
    }
    set('#preview-label', feature.label);
    set('#preview-bottom', feature.bottom);
  }

  function wireTabs(root) {
    const tabs = [...root.querySelectorAll('[data-feature]')];
    const panel = root.querySelector('#feature-panel');
    if (!tabs.length || !panel) return;
    let busy = false;

    const select = (tab) => {
      if (!tab || tab.getAttribute('aria-selected') === 'true' || busy) return;
      if (reduceMotion) {
        applyFeature(tabs, panel, tab);
        return;
      }
      busy = true;
      panel.classList.remove('is-ready');
      panel.classList.add('is-fading');
      window.setTimeout(() => {
        applyFeature(tabs, panel, tab);
        panel.classList.remove('is-fading');
        panel.classList.add('is-entering');
        void panel.offsetWidth;
        panel.classList.remove('is-entering');
        panel.classList.add('is-ready');
        busy = false;
      }, 280);
    };

    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => select(tab));
      tab.addEventListener('keydown', (event) => {
        let next;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        else return;
        event.preventDefault();
        tabs[next].focus();
        select(tabs[next]);
      });
    });
    panel.classList.add('is-ready');
  }

  function wireReveals(root) {
    const nodes = [...root.querySelectorAll('[data-reveal]')];
    if (!nodes.length) return;
    if (reduceMotion || !('IntersectionObserver' in window)) {
      nodes.forEach((node) => node.classList.add('is-visible'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        io.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
    nodes.forEach((node) => io.observe(node));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      nodes.forEach((node) => {
        const r = node.getBoundingClientRect();
        if (r.top < window.innerHeight && r.bottom > 0) node.classList.add('is-visible');
      });
    }));
  }

  function wireMenu() {
    const button = document.querySelector('.menu-toggle');
    const nav = document.querySelector('#navigation');
    if (!button || !nav) return;
    const close = () => {
      button.setAttribute('aria-expanded', 'false');
      nav.classList.remove('is-open');
    };
    button.addEventListener('click', () => {
      const open = button.getAttribute('aria-expanded') !== 'true';
      button.setAttribute('aria-expanded', String(open));
      nav.classList.toggle('is-open', open);
    });
    nav.addEventListener('click', (event) => {
      if (event.target.closest('a')) close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && nav.classList.contains('is-open')) {
        close();
        button.focus();
      }
    });
  }

  function wireSmoothAnchors() {
    document.addEventListener('click', (event) => {
      const anchor = event.target.closest('a[href^="#"]');
      if (!anchor) return;
      const hash = anchor.getAttribute('href');
      if (hash.length < 2) return;
      const target = document.querySelector(hash);
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      history.replaceState(null, '', hash);
    });
  }

  function wireAll(root) {
    wireTabs(root);
    wireReveals(root);
    wireStudioLinks(root);
  }

  function isEmptyMount(el) {
    return el && !el.querySelector('*');
  }

  /* Place fetched fragments into the index.html mounts, preserving the
   * sections.html document order. Mounted sections merge their classes onto
   * the placeholder; unmounted top-level sections (workflow, closing) are
   * inserted after the previously placed node. Missing SVG symbols are
   * merged into the existing defs block so ids never collide. */
  function mountSections(html) {
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    const nodes = [...template.content.children];
    if (!nodes.length) return false;

    const main = document.querySelector('main#main, #main');
    let anchor = null;

    const fillSectionMount = (id) => {
      let src = nodes.find((n) => n.id === id);
      const dst = document.getElementById(id);
      if (!src || !dst) return null;
      if (!isEmptyMount(dst)) return dst;
      // Absorb following sibling sections that belong to this mount's band:
      // #steps owns the your-scene band (use-cases live inside #steps itself,
      // workflow + product-shot follow as siblings until #faq).
      if (id === 'steps') {
        const frag = document.createDocumentFragment();
        let next = src.nextElementSibling;
        while (next && next.id !== 'faq' && next.id !== 'onair' && !(next.classList && next.classList.contains('onair-band')) && next.tagName !== 'footer' && !(next.classList && next.classList.contains('closing'))) {
          const take = next;
          next = next.nextElementSibling;
          frag.append(take);
        }
        if (src.className) dst.className = src.className;
        const labelledby = src.getAttribute('aria-labelledby');
        if (labelledby) dst.setAttribute('aria-labelledby', labelledby);
        dst.replaceChildren(...src.childNodes);
        dst.append(frag);
        src.remove();
        return dst;
      }
      if (src.className) dst.className = src.className;
      const labelledby = src.getAttribute('aria-labelledby');
      if (labelledby) dst.setAttribute('aria-labelledby', labelledby);
      dst.replaceChildren(...src.childNodes);
      src.remove();
      return dst;
    };

    for (const node of [...nodes]) {
      if (node.tagName === 'svg' && node.classList.contains('svg-defs')) {
        const existing = document.querySelector('svg.svg-defs');
        if (!existing) {
          document.body.prepend(node);
        } else {
          const defs = existing.querySelector('defs') || existing;
          [...node.querySelectorAll('symbol[id]')].forEach((sym) => {
            if (!document.getElementById(sym.id)) defs.append(sym.cloneNode(true));
          });
        }
        continue;
      }
      if (node.classList && node.classList.contains('signal-strip')) {
        const dst = document.querySelector('.signal-strip');
        if (dst && isEmptyMount(dst)) dst.replaceChildren(...node.childNodes);
        anchor = dst || anchor;
        continue;
      }
      if (node.id === 'features' || node.id === 'steps' || node.id === 'faq') {
        anchor = fillSectionMount(node.id) || anchor;
        continue;
      }
      if (node.getAttribute && node.getAttribute('data-mount') === 'before-live-room') {
        const liveRoom = main
          ? main.querySelector('[data-nebu-live-room]')
          : document.querySelector('[data-nebu-live-room]');
        if (liveRoom) {
          liveRoom.parentNode.insertBefore(node, liveRoom);
        } else if (main) {
          main.append(node);
        }
        anchor = node;
        continue;
      }
      if (node.classList && (node.classList.contains('your-scene') || node.classList.contains('workflow-section'))) {
        const steps = document.getElementById('steps');
        if (steps && steps.parentNode) {
          steps.after(node);
          anchor = node;
        } else if (anchor && anchor.parentNode) {
          anchor.after(node);
          anchor = node;
        } else if (main) {
          main.append(node);
          anchor = node;
        }
        continue;
      }
      if (node.classList && node.classList.contains('onair-band')) {
        const faq = document.getElementById('faq');
        if (faq && faq.parentNode) {
          faq.after(node);
        } else if (anchor && anchor.parentNode) {
          anchor.after(node);
          anchor = node;
        } else if (main) {
          main.append(node);
          anchor = node;
        }
        continue;
      }
      if (node.tagName === 'footer') {
        const dst = document.querySelector('body > footer, footer');
        if (dst && isEmptyMount(dst)) {
          if (node.className) dst.className = node.className;
          dst.replaceChildren(...node.childNodes);
        } else if (main && !document.querySelector('footer.footer')) {
          main.after(node);
        }
        anchor = document.querySelector('footer') || anchor;
        continue;
      }
      if (node.tagName === 'section' || node.tagName === 'div') {
        if (anchor && anchor.parentNode) {
          anchor.after(node);
          anchor = node;
        } else if (main) {
          main.append(node);
          anchor = node;
        }
      }
    }
    return true;
  }

  function mountsComplete() {
    return ['features', 'steps', 'faq'].every((id) => {
      const el = document.getElementById(id);
      return el && !isEmptyMount(el);
    }) && !!document.querySelector('.feature-tabs, .faq-list');
  }

  var sectionsPromise = null;
  function loadSections() {
    if (!sectionsPromise) {
      sectionsPromise = fetch(SECTIONS_URL, { credentials: 'same-origin' })
        .then((res) => {
          if (!res.ok) throw new Error(`sections fetch ${res.status}`);
          return res.text();
        })
        .then((html) => {
          if (!mountSections(html)) throw new Error('sections parse empty');
          return true;
        });
    }
    return sectionsPromise;
  }

  function boot() {
    wireMenu();
    wireSmoothAnchors();
    const main = document.querySelector('main#main, #main');
    if (!main || mountsComplete()) {
      wireAll(document);
      return;
    }
    loadSections()
      .then(() => {
        wireAll(document);
      })
      .catch(() => {
        const fallback = document.createElement('div');
        fallback.className = 'container section';
        fallback.innerHTML = '<p class="eyebrow">NEBU</p><p>Sections could not load. '
          + 'You can still <a href="' + STUDIO_URL + '">open your studio</a>.</p>';
        main.append(fallback);
        wireStudioLinks(main);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
