use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use rand::Rng;
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN: usize = 8;
const REDEEM_LIMIT: usize = 10;
const REDEEM_WINDOW: Duration = Duration::from_secs(60);

/// What the studio UI is allowed to see. The room JWT stays in the broker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteTicket {
    pub code: String,
    pub expires_in_secs: u64,
}

#[derive(PartialEq, Eq)]
pub(crate) struct RedeemedInvite {
    pub url: String,
    pub token: String,
}

struct StoredInvite {
    url: String,
    token: String,
    expires: Instant,
}

#[derive(Clone, Default)]
pub struct InviteBroker {
    inner: std::sync::Arc<Mutex<HashMap<String, StoredInvite>>>,
}

impl std::fmt::Debug for InviteBroker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let pending = self.inner.lock().map(|guard| guard.len()).unwrap_or(0);
        f.debug_struct("InviteBroker")
            .field("pending", &pending)
            .finish()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PairError {
    Invalid,
    Expired,
}

impl InviteBroker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn put(&self, url: &str, token: &str, ttl: Duration) -> InviteTicket {
        loop {
            let code = self.mint_code();
            if let Some(ticket) = self.insert(&code, url, token, ttl) {
                return ticket;
            }
        }
    }

    pub(crate) fn mint_code(&self) -> String {
        let mut rng = rand::rng();
        loop {
            let code: String = (0..CODE_LEN)
                .map(|_| {
                    let idx = rng.random_range(0..ALPHABET.len());
                    ALPHABET[idx] as char
                })
                .collect();
            let guard = self.inner.lock().expect("invite broker");
            if !guard.contains_key(&code) {
                return code;
            }
        }
    }

    pub(crate) fn insert(
        &self,
        code: &str,
        url: &str,
        token: &str,
        ttl: Duration,
    ) -> Option<InviteTicket> {
        let mut guard = self.inner.lock().expect("invite broker");
        if guard.contains_key(code) {
            return None;
        }
        guard.insert(
            code.to_owned(),
            StoredInvite {
                url: url.to_owned(),
                token: token.to_owned(),
                expires: Instant::now() + ttl,
            },
        );
        Some(InviteTicket {
            code: code.to_owned(),
            expires_in_secs: ttl.as_secs(),
        })
    }

    /// Remove the invite. A second redeem of the same code fails.
    pub(crate) fn redeem(&self, code: &str) -> Result<RedeemedInvite, PairError> {
        let mut guard = self.inner.lock().expect("invite broker");
        let Some(stored) = guard.remove(code) else {
            return Err(PairError::Invalid);
        };
        if Instant::now() >= stored.expires {
            return Err(PairError::Expired);
        }
        Ok(RedeemedInvite {
            url: stored.url,
            token: stored.token,
        })
    }

    #[cfg(test)]
    pub(crate) fn peek_token(&self, code: &str) -> Option<String> {
        self.inner
            .lock()
            .expect("invite broker")
            .get(code)
            .map(|stored| stored.token.clone())
    }
}

#[derive(Clone)]
struct AppState {
    broker: InviteBroker,
    hits: std::sync::Arc<Mutex<VecDeque<Instant>>>,
}

#[derive(Deserialize)]
struct PairRequest {
    code: String,
}

#[derive(Serialize)]
struct HealthBody {
    ok: bool,
}

#[derive(Serialize)]
struct RedeemBody {
    url: String,
    token: String,
}

#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
}

pub struct PairServer {
    addr: SocketAddr,
    shutdown: Option<oneshot::Sender<()>>,
}

impl PairServer {
    pub async fn bind(broker: InviteBroker, addr: &str) -> std::io::Result<Self> {
        let listener = TcpListener::bind(addr).await?;
        let bound = listener.local_addr()?;
        let (tx, rx) = oneshot::channel();
        let app = Router::new()
            .route("/v1/health", get(health))
            .route("/v1/pair", get(pair_form).post(redeem))
            .with_state(AppState {
                broker,
                hits: std::sync::Arc::new(Mutex::new(VecDeque::new())),
            });
        tokio::spawn(async move {
            let server = axum::serve(listener, app).with_graceful_shutdown(async move {
                let _ = rx.await;
            });
            if let Err(err) = server.await {
                eprintln!("pair server stopped: {err}");
            }
        });
        Ok(Self {
            addr: bound,
            shutdown: Some(tx),
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    pub fn port(&self) -> u16 {
        self.addr.port()
    }
}

impl Drop for PairServer {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

async fn health() -> Json<HealthBody> {
    Json(HealthBody { ok: true })
}

async fn pair_form() -> Html<&'static str> {
    Html(PAIR_FORM)
}

async fn redeem(State(state): State<AppState>, Json(body): Json<PairRequest>) -> Response {
    if !allow_redeem(&state) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            [(header::CACHE_CONTROL, "no-store")],
            Json(ErrorBody {
                error: "too many attempts",
            }),
        )
            .into_response();
    }
    match state.broker.redeem(body.code.trim()) {
        Ok(invite) => (
            StatusCode::OK,
            [(header::CACHE_CONTROL, "no-store")],
            Json(RedeemBody {
                url: invite.url,
                token: invite.token,
            }),
        )
            .into_response(),
        Err(_) => (
            StatusCode::NOT_FOUND,
            [(header::CACHE_CONTROL, "no-store")],
            Json(ErrorBody {
                error: "invalid or expired",
            }),
        )
            .into_response(),
    }
}

fn allow_redeem(state: &AppState) -> bool {
    let mut hits = state.hits.lock().expect("pair rate");
    let now = Instant::now();
    while hits
        .front()
        .is_some_and(|hit| now.duration_since(*hit) >= REDEEM_WINDOW)
    {
        hits.pop_front();
    }
    if hits.len() >= REDEEM_LIMIT {
        return false;
    }
    hits.push_back(now);
    true
}

const PAIR_FORM: &str = r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NEBU camera pair</title>
<style>
  body { margin: 0; background: #0B001A; color: #F7F5F2; font: 16px/1.4 sans-serif; }
  main { max-width: 28rem; margin: 2rem auto; padding: 1.25rem; background: #F7F5F2; color: #0B001A; }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
  input, button { font: inherit; }
  input { width: 100%; box-sizing: border-box; padding: 0.6rem; letter-spacing: 0.2em; }
  button { margin-top: 0.75rem; background: #FFD100; border: 0; padding: 0.6rem 1rem; }
  #out { white-space: pre-wrap; }
</style>
</head>
<body>
<main>
  <h1>Pair this device</h1>
  <p>Enter the code shown on the Casa Barra desk or the NEBU studio. This page is the device that will join.</p>
  <form id="pair">
    <label>Code <input name="code" autocomplete="off" maxlength="8" required></label>
    <button type="submit">Join</button>
  </form>
  <p id="out"></p>
  <p id="url"></p>
  <textarea id="token" readonly rows="4" hidden></textarea>
</main>
<script>
document.getElementById("pair").addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = new FormData(event.target).get("code");
  const out = document.getElementById("out");
  const response = await fetch("/v1/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code })
  });
  const body = await response.json();
  if (!response.ok) {
    out.textContent = body.error || "could not pair";
    return;
  }
  out.textContent = "Paired on this device. Keep the token here; the studio never receives it.";
  document.getElementById("url").textContent = body.url || "";
  const token = document.getElementById("token");
  token.hidden = false;
  token.value = body.token || "";
});
</script>
</body>
</html>
"#;

pub fn bind_addr_from_env() -> String {
    std::env::var("NEBU_PAIR_BIND").unwrap_or_else(|_| "127.0.0.1:0".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_use_the_unambiguous_alphabet_once() {
        let broker = InviteBroker::new();
        let ticket = broker.put("wss://livekit.example", "jwt-one", Duration::from_secs(60));
        assert_eq!(ticket.code.len(), CODE_LEN);
        assert!(ticket.code.bytes().all(|ch| ALPHABET.contains(&ch)));
        assert!(!format!("{ticket:?}").contains("jwt-one"));
        let json = serde_json::to_string(&ticket).unwrap();
        assert!(!json.contains("token"));
        assert!(!json.contains("jwt-one"));
        let first = broker.redeem(&ticket.code).unwrap();
        assert_eq!(first.token, "jwt-one");
        assert!(matches!(
            broker.redeem(&ticket.code),
            Err(PairError::Invalid)
        ));
    }

    #[test]
    fn expired_and_unknown_codes_fail() {
        let broker = InviteBroker::new();
        let ticket = broker.put("wss://livekit.example", "jwt-old", Duration::ZERO);
        std::thread::sleep(Duration::from_millis(5));
        assert!(matches!(
            broker.redeem(&ticket.code),
            Err(PairError::Expired)
        ));
        assert!(matches!(broker.redeem("ZZZZZZZZ"), Err(PairError::Invalid)));
    }

    #[tokio::test]
    async fn http_redeem_is_one_time_and_health_has_no_token() {
        let broker = InviteBroker::new();
        let ticket = broker.put(
            "wss://livekit.example",
            "camera-jwt-do-not-show-in-health",
            Duration::from_secs(60),
        );
        let server = PairServer::bind(broker, "127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", server.local_addr());
        let client = reqwest::Client::new();
        let health = client
            .get(format!("{base}/v1/health"))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(health.contains("\"ok\":true"));
        assert!(!health.contains("camera-jwt"));
        let page = client
            .get(format!("{base}/v1/pair"))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(!page.contains("camera-jwt"));
        let redeemed: serde_json::Value = client
            .post(format!("{base}/v1/pair"))
            .json(&serde_json::json!({ "code": ticket.code }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(redeemed["token"], "camera-jwt-do-not-show-in-health");
        assert_eq!(redeemed["url"], "wss://livekit.example");
        let again = client
            .post(format!("{base}/v1/pair"))
            .json(&serde_json::json!({ "code": ticket.code }))
            .send()
            .await
            .unwrap();
        assert_eq!(again.status(), reqwest::StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn http_redeem_rate_limit() {
        let broker = InviteBroker::new();
        let server = PairServer::bind(broker, "127.0.0.1:0").await.unwrap();
        let client = reqwest::Client::new();
        let url = format!("http://{}/v1/pair", server.local_addr());
        let mut saw_limit = false;
        for _ in 0..REDEEM_LIMIT + 1 {
            let response = client
                .post(&url)
                .json(&serde_json::json!({ "code": "AAAAAAAA" }))
                .send()
                .await
                .unwrap();
            if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
                saw_limit = true;
            }
        }
        assert!(saw_limit);
    }
}
