/* NEBU wordmark + mark, one source for HTML and canvas. Geometry copied from assets/nebu-wordmark-paper.svg:
   letters are 80 units tall; the E is three bars 100 wide x 15 tall at y 0 / 32.5 / 65 (same ratio as the mark). */
(function () {
  const S = 0.1212121;
  const N = 'M57 0V660H270L533 215H540L535 660H693V0H497L217 465H210L215 0Z';
  const B = 'M57 0V660H334Q396 660 444.5 649.5Q493 639 527.5 617.5Q562 596 580.0 563.0Q598 530 598 485Q598 446 581.5 415.5Q565 385 529.0 366.5Q493 348 435 342V329Q533 323 579.0 282.0Q625 241 625 173Q625 115 594.5 77.0Q564 39 505.0 19.5Q446 0 359 0ZM214 129H353Q409 129 437.5 147.0Q466 165 466 201Q466 241 432.5 261.0Q399 281 331 281H214ZM214 384H312Q377 384 408.5 403.5Q440 423 440 461Q440 498 411.0 515.5Q382 533 324 533H214Z';
  const U = 'M345 -14Q285 -14 237.5 -1.5Q190 11 155.5 35.0Q121 59 98.5 93.0Q76 127 65.0 169.5Q54 212 54 261V660H216V267Q216 218 231.0 187.5Q246 157 274.5 143.0Q303 129 344 129Q387 129 415.5 143.0Q444 157 459.0 187.5Q474 218 474 267V660H636V261Q636 131 563.5 58.5Q491 -14 345 -14Z';
  const EX = 95.9091, BX = 205.9091, UX = 290.5455, W = 368, H = 80;
  const BARS = [0, 32.5, 65];
  const inner = `<path transform="translate(0 80) scale(${S} -${S})" d="${N}"/><g transform="translate(${EX} 0)" shape-rendering="crispEdges">${BARS.map((y) => `<rect y="${y}" width="100" height="15"/>`).join('')}</g><path transform="translate(${BX} 80) scale(${S} -${S})" d="${B}"/><path transform="translate(${UX} 80) scale(${S} -${S})" d="${U}"/>`;
  // Inline wordmark: scales with font-size (cap height = 0.72em by default), inherits color.
  function wordmark(cls = '') {
    return `<span class="nebu-wm ${cls}" role="img" aria-label="NEBU"><svg viewBox="0 0 ${W} ${H}" aria-hidden="true" focusable="false" fill="currentColor">${inner}</svg><span class="nebu-vh">NEBU</span></span>`;
  }
  // The three-bar E on its own (NEBU's mark). Each bar is its own element so CSS can animate it.
  function mark(cls = '') {
    return `<svg class="nebu-mark ${cls}" viewBox="0 0 100 80" aria-hidden="true" focusable="false" fill="currentColor">${BARS.map((y, i) => `<rect class="nebu-bar nebu-bar-${i + 1}" x="0" y="${y}" width="100" height="15" rx="0"/>`).join('')}</svg>`;
  }
  // Canvas: draw the wordmark with the current fillStyle; (x, baseline) like fillText; capH = letter height in px.
  let paths = null;
  function drawWordmark(ctx, x, baseline, capH, align = 'left') {
    if (!paths) {
      const m = (tx) => new DOMMatrix([S, 0, 0, -S, tx, 80]);
      const p = new Path2D(); p.addPath(new Path2D(N), m(0)); p.addPath(new Path2D(B), m(BX)); p.addPath(new Path2D(U), m(UX));
      BARS.forEach((y) => p.rect(EX, y, 100, 15)); paths = p;
    }
    const k = capH / H, w = W * k;
    const dx = align === 'center' ? -w / 2 : (align === 'right' || align === 'end') ? -w : 0;
    ctx.save(); ctx.translate(x + dx, baseline - capH); ctx.scale(k, k); ctx.fill(paths); ctx.restore();
    return w;
  }
  const width = (capH) => W * capH / H;
  // Wrap a 2D context so any fillText of exactly "NEBU" / "@NEBU" draws the real wordmark instead.
  function brandText(ctx) {
    if (ctx.__nebuBrand) return ctx; const orig = ctx.fillText.bind(ctx), measure = ctx.measureText.bind(ctx);
    const size = () => { const m = /(\d+(?:\.\d+)?)px/.exec(ctx.font); return m ? +m[1] : 16; };
    ctx.fillText = (t, x, y, mw) => {
      const m = /^(@?)NEBU$/.exec(String(t)); if (!m) return orig(t, x, y, mw);
      const cap = size() * 0.72, at = m[1] ? measure('@').width + cap * 0.08 : 0, total = at + width(cap);
      const a = ctx.textAlign; const x0 = a === 'center' ? x - total / 2 : (a === 'right' || a === 'end') ? x - total : x;
      if (m[1]) { const sa = ctx.textAlign; ctx.textAlign = 'left'; orig('@', x0, y); ctx.textAlign = sa; }
      drawWordmark(ctx, x0 + at, y, cap);
    };
    ctx.measureText = (t) => { const m = /^(@?)NEBU$/.exec(String(t)); if (!m) return measure(t); const cap = size() * 0.72; return { width: (m[1] ? measure('@').width + cap * 0.08 : 0) + width(cap) }; };
    ctx.__nebuBrand = true; return ctx;
  }
  window.NebuBrand = { wordmark, mark, drawWordmark, brandText, width };
})();
