/*
 * NEBU — Boom support (Track C).
 *
 * Wires the "Copy Boom checklist" button on .boom-card. The card itself
 * lives in sections.html (inside Track B's .onair-band when that band
 * exists, otherwise before the footer). Sections are fetched after
 * DOMContentLoaded, so this script waits for the button to mount.
 *
 * Clipboard: navigator.clipboard.writeText, then a textarea +
 * document.execCommand("copy") fallback — same path as the room widget.
 * Vanilla JS, no dependencies. Never claims Boom is part of NEBU.
 */
(function () {
  "use strict";

  var BUTTON_ID = "boom-copy-btn";
  var RESET_MS = 1600;

  function stepsText(card) {
    var items = card.querySelectorAll(".boom-steps > li");
    var lines = [];
    for (var i = 0; i < items.length; i++) {
      var clone = items[i].cloneNode(true);
      var index = clone.querySelector(".boom-step-index");
      if (index) index.remove();
      var text = (clone.textContent || "").replace(/\s+/g, " ").trim();
      var link = items[i].querySelector("a[href]");
      var href = link ? link.href : "";
      var line = i + 1 + ". " + text;
      if (href && line.indexOf(href) === -1) line += " " + href;
      lines.push(line);
    }
    return lines.join("\n");
  }

  function setStatus(card, message) {
    var status = card.querySelector("[data-boom-status]");
    if (status) status.textContent = message;
  }

  function copyText(text, btn, card) {
    var original = btn.textContent;
    var done = function (label, message) {
      btn.textContent = label;
      setStatus(card, message);
      window.setTimeout(function () {
        if (btn.textContent === label) btn.textContent = original;
      }, RESET_MS);
    };
    var legacyCopy = function () {
      var area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.top = "0";
      area.style.left = "0";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.focus();
      area.select();
      var ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (err) {
        ok = false;
      }
      document.body.removeChild(area);
      if (ok) {
        done("Copied", "Boom checklist copied.");
      } else {
        done("Copy failed", "Copy failed. Select the three steps and copy them manually.");
      }
    };
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(text).then(
        function () {
          done("Copied", "Boom checklist copied.");
        },
        legacyCopy
      );
    } else {
      legacyCopy();
    }
  }

  function wire(button) {
    if (!button || button.getAttribute("data-boom-wired") === "1") return;
    var card = button.closest(".boom-card");
    if (!card) return;
    button.setAttribute("data-boom-wired", "1");
    button.addEventListener("click", function () {
      var text = stepsText(card);
      if (!text) {
        setStatus(card, "Copy failed. The checklist steps are not on the page.");
        return;
      }
      copyText(text, button, card);
    });
  }

  function scan() {
    wire(document.getElementById(BUTTON_ID));
  }

  function boot() {
    scan();
    if (document.getElementById(BUTTON_ID)) return;
    var observer = new MutationObserver(function () {
      if (!document.getElementById(BUTTON_ID)) return;
      scan();
      observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
