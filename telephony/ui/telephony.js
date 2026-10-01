const invoke = window.__TAURI__?.core?.invoke ?? null;

const connection = document.querySelector("#connection");
const roomOut = document.querySelector("#room");
const identityOut = document.querySelector("#identity");
const hostOut = document.querySelector("#host");
const audioOut = document.querySelector("#audio");
const videoOut = document.querySelector("#video");
const sourceOut = document.querySelector("#source");
const latencyOut = document.querySelector("#latency");
const pairOut = document.querySelector("#pair");
const errorOut = document.querySelector("#error");
const feedsOut = document.querySelector("#feeds");
const muteButton = document.querySelector("#mute");
const shellNote = document.querySelector("#shell-note");
const liveBadge = document.querySelector("#live-badge");
const reservationShown = document.querySelector("#reservation-shown");

let audioMuted = false;
let venue = "nebu";

function showError(error) {
  const text = error instanceof Error ? error.message : String(error ?? "");
  errorOut.hidden = text.length === 0;
  errorOut.textContent = text;
}

function latencyLabel(status) {
  if (!status || status.signalLatencyMs == null) return "not measured";
  const parts = [];
  if (status.audioLatencyMs != null) parts.push(`audio ${status.audioLatencyMs} ms`);
  if (status.videoLatencyMs != null) parts.push(`video ${status.videoLatencyMs} ms`);
  const budget = status.withinLatencyBudget ? "within 500ms" : "over the 500ms budget";
  const detail = parts.length ? `${parts.join(", ")}, ` : `${status.signalLatencyMs} ms, `;
  return detail + budget;
}

function applyVenue(next) {
  const normalized = next === "casa-barra" ? "casa-barra" : "nebu";
  const changed = normalized !== venue;
  venue = normalized;
  for (const button of document.querySelectorAll(".venue-switch")) {
    button.classList.toggle("is-selected", button.dataset.venue === venue);
  }
  if (!changed) return;
  const casa = venue === "casa-barra";
  document.body.className = casa ? "venue-casa" : "venue-nebu";
  document.querySelector("#mark").textContent = casa ? "CASA BARRA" : "NEBU";
  document.querySelector("#title").textContent = casa ? "Concierge" : "Studio";
  document.querySelector("#venue-label").textContent = casa ? "Casa Barra" : "NEBU";
  document.querySelector("#status-heading").textContent = casa ? "Call" : "Connection";
  document.querySelector("#controls-heading").textContent = casa ? "Desk" : "Broadcast";
  document.querySelector("#room-label").textContent = casa ? "Property" : "Room";
  document.querySelector("#connect").textContent = casa ? "Start concierge call" : "Go live";
  document.querySelector("#invite-heading").textContent = casa ? "Guest" : "External camera";
  document.querySelector("#label-caption").textContent = casa ? "Guest" : "Device";
  document.querySelector("#invite-button").textContent = casa ? "Create guest code" : "Create invite code";
  document.querySelector("#feeds-heading").textContent = casa ? "Call media" : "Feeds";
  document.querySelector("#label-input").value = casa ? "Guest" : "iPhone";
  document.querySelector("#room-input").value = casa ? "villa" : "studio";
  document.querySelector("#identity-input").value = casa ? "desk" : "host";
}

function render(status) {
  applyVenue(status.venue);
  audioMuted = Boolean(status.audioMuted);
  connection.textContent = status.connection;
  liveBadge.classList.toggle("is-live", Boolean(status.live));
  document.querySelector("#role").textContent = status.role || "—";
  roomOut.textContent = status.room || "—";
  identityOut.textContent = status.identity || "—";
  const configured = status.venue === "casa-barra" ? status.casaConfigured : status.nebuConfigured;
  hostOut.textContent = configured ? status.livekitHost : "not configured";
  audioOut.textContent = status.audioMuted ? "muted" : "open";
  videoOut.textContent = status.videoPublished ? "published" : "no local video";
  sourceOut.textContent = status.inputSource;
  latencyOut.textContent = latencyLabel(status);
  pairOut.textContent = status.pairBind ? `${status.pairBind} /v1/pair` : "not listening";
  document.querySelector("#obs").textContent = status.obsLinked ? "linked" : "not connected";
  reservationShown.textContent = status.reservationRef
    ? `Desk reference ${status.reservationRef}`
    : "No reservation book is connected.";
  muteButton.textContent = status.audioMuted ? "Unmute audio" : "Mute audio";
  errorOut.hidden = !status.lastError;
  if (status.lastError) errorOut.textContent = status.lastError;
  feedsOut.replaceChildren();
  for (const feed of status.feeds) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = [
      feed.identity,
      feed.kind,
      feed.source,
      feed.subscribed ? "subscribed" : "published",
      feed.muted ? "muted" : "live",
    ].filter(Boolean).join(" · ");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = feed.muted ? "Unmute feed" : "Mute feed";
    button.addEventListener("click", async () => {
      try {
        render(await invoke("telephony_mute_remote", {
          identity: feed.identity,
          trackSid: feed.trackSid,
          muted: !feed.muted,
        }));
        showError("");
      } catch (error) {
        showError(error);
      }
    });
    item.append(label, button);
    feedsOut.append(item);
  }
}

async function refresh() {
  render(await invoke("telephony_status"));
}

function bindVenue(handler) {
  for (const button of document.querySelectorAll(".venue-switch")) {
    button.addEventListener("click", () => handler(button.dataset.venue));
  }
}

function bindSession() {
  document.querySelector("#join").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      render(await invoke("telephony_connect", {
        room: document.querySelector("#room-input").value,
        identity: document.querySelector("#identity-input").value,
      }));
      showError("");
    } catch (error) {
      showError(error);
    }
  });

  document.querySelector("#disconnect").addEventListener("click", async () => {
    try {
      render(await invoke("telephony_disconnect"));
      showError("");
    } catch (error) {
      showError(error);
    }
  });

  muteButton.addEventListener("click", async () => {
    try {
      render(await invoke("telephony_mute", { muted: !audioMuted }));
      showError("");
    } catch (error) {
      showError(error);
    }
  });

  document.querySelector("#unpublish").addEventListener("click", async () => {
    try {
      render(await invoke("telephony_unpublish_video"));
      showError("");
    } catch (error) {
      showError(error);
    }
  });

  document.querySelector("#source-select").addEventListener("change", async (event) => {
    try {
      render(await invoke("telephony_set_source", { source: event.target.value }));
      showError("");
    } catch (error) {
      showError(error);
    }
  });

  document.querySelector("#invite").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const ticket = await invoke("telephony_invite", {
        room: document.querySelector("#room-input").value,
        label: document.querySelector("#label-input").value,
      });
      document.querySelector("#code").textContent = ticket.code;
      showError("");
    } catch (error) {
      showError(error);
    }
  });

  document.querySelector("#reservation").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      render(await invoke("telephony_set_reservation", {
        reference: document.querySelector("#reservation-input").value,
      }));
      showError("");
    } catch (error) {
      showError(error);
    }
  });
}

applyVenue("nebu");

if (!invoke) {
  shellNote.hidden = false;
  for (const control of document.querySelectorAll("button, input, select")) {
    if (!control.classList.contains("venue-switch")) control.disabled = true;
  }
  bindVenue((next) => {
    applyVenue(next);
    document.querySelector("#code").textContent = "";
  });
} else {
  bindVenue(async (next) => {
    try {
      render(await invoke("telephony_set_venue", { venue: next }));
      document.querySelector("#code").textContent = "";
      showError("");
    } catch (error) {
      showError(error);
    }
  });
  bindSession();
  refresh().catch(showError);
  setInterval(() => {
    refresh().catch(showError);
  }, 1000);
}
