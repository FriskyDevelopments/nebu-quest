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

let audioMuted = false;

function showError(error) {
  const text = error instanceof Error ? error.message : String(error ?? "");
  errorOut.hidden = text.length === 0;
  errorOut.textContent = text;
}

function latencyLabel(status) {
  if (status.signalLatencyMs == null) return "not measured";
  const budget = status.withinLatencyBudget ? "within 500ms" : "over the 500ms budget";
  return `${status.signalLatencyMs} ms, ${budget}`;
}

function render(status) {
  audioMuted = Boolean(status.audioMuted);
  connection.textContent = status.connection;
  roomOut.textContent = status.room || "—";
  identityOut.textContent = status.identity || "—";
  hostOut.textContent = status.configured ? status.livekitHost : "not configured";
  audioOut.textContent = status.audioMuted ? "muted" : "open";
  videoOut.textContent = status.videoPublished ? "published" : "no local video";
  sourceOut.textContent = status.inputSource;
  latencyOut.textContent = latencyLabel(status);
  pairOut.textContent = status.pairBind
    ? `${status.pairBind} /v1/pair`
    : "not listening";
  muteButton.textContent = status.audioMuted ? "Unmute audio" : "Mute audio";
  errorOut.hidden = !status.lastError;
  if (status.lastError) errorOut.textContent = status.lastError;
  feedsOut.replaceChildren();
  for (const feed of status.feeds) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    const state = [
      feed.identity,
      feed.kind,
      feed.source,
      feed.subscribed ? "subscribed" : "published",
      feed.muted ? "muted" : "live",
    ].filter(Boolean).join(" · ");
    label.textContent = state;
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

function bind() {
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
}

if (!invoke) {
  shellNote.hidden = false;
  for (const control of document.querySelectorAll("button, input, select")) {
    control.disabled = true;
  }
} else {
  bind();
  refresh().catch(showError);
  setInterval(() => {
    refresh().catch(showError);
  }, 1000);
}
