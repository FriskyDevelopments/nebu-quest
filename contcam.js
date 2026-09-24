/*
 * NEBU — Continuity Camera support.
 *
 * Wires the "Copy Continuity checklist" button on .contcam-card. The card
 * lives in sections.html (inside .onair-band after the Boom card). Sections
 * are fetched after DOMContentLoaded, so this script waits for the button
 * to mount.
 *
 * Clipboard: navigator.clipboard.writeText, then a textarea +
 * document.execCommand("copy") fallback — same path as boom.js.
 * Vanilla JS, no dependencies. Never claims Apple features are part of NEBU.
 */
(function () {
  "use strict";

  var BUTTON_ID = "contcam-copy-btn";
  var RESET_MS = 1600;

  function stepsText(card) {
    var items = card.querySelectorAll(".contcam-steps > li");
    var lines = [];
    for (var i = 0; i < items.length; i++) {
      var clone = items[i].cloneNode(true);
      var index = clone.querySelector(".contcam-step-index");
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
    var status = card.querySelector("[data-contcam-status]");
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
        done("Copied", "Continuity checklist copied.");
      } else {
        done("Copy failed", "Copy failed. Select the three steps and copy them manually.");
      }
    };
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(text).then(
        function () {
          done("Copied", "Continuity checklist copied.");
        },
        legacyCopy
      );
    } else {
      legacyCopy();
    }
  }

  function wire(button) {
    if (!button || button.getAttribute("data-contcam-wired") === "1") return;
    var card = button.closest(".contcam-card");
    if (!card) return;
    button.setAttribute("data-contcam-wired", "1");
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
