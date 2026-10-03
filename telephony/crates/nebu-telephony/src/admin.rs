use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use url::Url;

use crate::session::{InviteKind, PublicStatus, SessionError, TelephonyNode};

const POST_LIMIT: usize = 30;
const POST_WINDOW: Duration = Duration::from_secs(60);
const ADMIN_PAGE: &str = include_str!("../../../ui/casa-admin.html");

/// Desk key for the Casa Barra admin panel. Absent means the panel cannot act.
#[derive(Clone)]
pub(crate) struct AdminConfig {
    token: Option<String>,
    origin: Option<String>,
}

impl AdminConfig {
    pub(crate) fn from_env() -> Self {
        Self {
            token: token_from_env(),
            origin: origin_from_env(),
        }
    }

    pub(crate) fn token(&self) -> Option<&str> {
        self.token.as_deref()
    }

    #[cfg(test)]
    pub(crate) fn for_test(token: Option<&str>, origin: Option<&str>) -> Self {
        Self {
            token: token.map(str::to_owned),
            origin: origin.map(str::to_owned),
        }
    }
}

#[derive(Clone)]
struct AdminState {
    node: TelephonyNode,
    token: Option<String>,
    origin: Option<String>,
    posts: Arc<Mutex<VecDeque<Instant>>>,
}

pub(crate) fn admin_router(node: TelephonyNode, config: AdminConfig) -> Router {
    let state = AdminState {
        node,
        token: config.token,
        origin: config.origin,
        posts: Arc::new(Mutex::new(VecDeque::new())),
    };
    Router::new()
        .route("/v1/admin/casa", get(page).options(preflight))
        .route("/v1/admin/casa/status", get(desk_status).options(preflight))
        .route(
            "/v1/admin/casa/reservation",
            axum::routing::post(reservation).options(preflight),
        )
        .route(
            "/v1/admin/casa/concierge/start",
            axum::routing::post(concierge_start).options(preflight),
        )
        .route(
            "/v1/admin/casa/concierge/advance",
            axum::routing::post(concierge_advance).options(preflight),
        )
        .route(
            "/v1/admin/casa/connect",
            axum::routing::post(connect).options(preflight),
        )
        .route(
            "/v1/admin/casa/disconnect",
            axum::routing::post(disconnect).options(preflight),
        )
        .route(
            "/v1/admin/casa/mute",
            axum::routing::post(mute).options(preflight),
        )
        .route(
            "/v1/admin/casa/invite",
            axum::routing::post(invite).options(preflight),
        )
        .with_state(state)
}

#[derive(Deserialize)]
struct ReservationBody {
    reference: String,
}

#[derive(Deserialize)]
struct ConnectBody {
    room: String,
    identity: String,
}

#[derive(Deserialize)]
struct MuteBody {
    muted: bool,
}

#[derive(Deserialize)]
struct InviteBody {
    room: String,
    label: String,
    kind: InviteKind,
}

async fn page(State(state): State<AdminState>, headers: HeaderMap) -> Response {
    let response = (
        StatusCode::OK,
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
        ],
        ADMIN_PAGE,
    )
        .into_response();
    finish(&state, &headers, response)
}

async fn preflight(State(state): State<AdminState>, headers: HeaderMap) -> Response {
    finish(&state, &headers, StatusCode::NO_CONTENT.into_response())
}

async fn desk_status(State(state): State<AdminState>, headers: HeaderMap) -> Response {
    if let Err(response) = authorize(&state, &headers) {
        return finish(&state, &headers, response);
    }
    finish(&state, &headers, status_json(state.node.status()))
}

async fn reservation(
    State(state): State<AdminState>,
    headers: HeaderMap,
    Json(body): Json<ReservationBody>,
) -> Response {
    run_desk(&state, &headers, |node| async move {
        node.set_reservation_ref(&body.reference).await?;
        Ok(node.status())
    })
    .await
}

async fn concierge_start(State(state): State<AdminState>, headers: HeaderMap) -> Response {
    run_desk(&state, &headers, |node| async move {
        node.start_concierge().await?;
        Ok(node.status())
    })
    .await
}

async fn concierge_advance(State(state): State<AdminState>, headers: HeaderMap) -> Response {
    run_desk(&state, &headers, |node| async move {
        node.advance_concierge().await?;
        Ok(node.status())
    })
    .await
}

async fn connect(
    State(state): State<AdminState>,
    headers: HeaderMap,
    Json(body): Json<ConnectBody>,
) -> Response {
    run_desk(&state, &headers, |node| async move {
        node.connect(&body.room, &body.identity).await?;
        Ok(node.status())
    })
    .await
}

async fn disconnect(State(state): State<AdminState>, headers: HeaderMap) -> Response {
    run_desk(&state, &headers, |node| async move {
        node.disconnect().await?;
        Ok(node.status())
    })
    .await
}

async fn mute(
    State(state): State<AdminState>,
    headers: HeaderMap,
    Json(body): Json<MuteBody>,
) -> Response {
    run_desk(&state, &headers, |node| async move {
        node.set_audio_muted(body.muted).await?;
        Ok(node.status())
    })
    .await
}

async fn invite(
    State(state): State<AdminState>,
    headers: HeaderMap,
    Json(body): Json<InviteBody>,
) -> Response {
    if let Err(response) = authorize(&state, &headers) {
        return finish(&state, &headers, response);
    }
    if !allow_post(&state) {
        return finish(
            &state,
            &headers,
            error_json(StatusCode::TOO_MANY_REQUESTS, "too many attempts"),
        );
    }
    if !matches!(body.kind, InviteKind::Guest | InviteKind::Property) {
        return finish(
            &state,
            &headers,
            error_json(StatusCode::CONFLICT, "that invite belongs to the studio"),
        );
    }
    if let Err(err) = state.node.engage_casa_desk().await {
        return finish(&state, &headers, session_json(err));
    }
    let response = match state
        .node
        .invite_as(&body.room, &body.label, body.kind)
        .await
    {
        Ok(ticket) => (
            StatusCode::OK,
            [(header::CACHE_CONTROL, "no-store")],
            Json(ticket),
        )
            .into_response(),
        Err(err) => session_json(err),
    };
    finish(&state, &headers, response)
}

async fn run_desk<F, Fut>(state: &AdminState, headers: &HeaderMap, action: F) -> Response
where
    F: FnOnce(TelephonyNode) -> Fut,
    Fut: std::future::Future<Output = Result<PublicStatus, SessionError>>,
{
    if let Err(response) = authorize(state, headers) {
        return finish(state, headers, response);
    }
    if !allow_post(state) {
        return finish(
            state,
            headers,
            error_json(StatusCode::TOO_MANY_REQUESTS, "too many attempts"),
        );
    }
    if let Err(err) = state.node.engage_casa_desk().await {
        return finish(state, headers, session_json(err));
    }
    let response = match action(state.node.clone()).await {
        Ok(status) => status_json(status),
        Err(err) => session_json(err),
    };
    finish(state, headers, response)
}

fn authorize(state: &AdminState, headers: &HeaderMap) -> Result<(), Response> {
    let Some(expected) = state.token.as_deref() else {
        return Err(error_json(
            StatusCode::SERVICE_UNAVAILABLE,
            "admin control is not configured",
        ));
    };
    if !tokens_match(expected, bearer(headers)) {
        return Err(error_json(StatusCode::UNAUTHORIZED, "unauthorized"));
    }
    Ok(())
}

fn bearer(headers: &HeaderMap) -> &str {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .unwrap_or("")
}

fn allow_post(state: &AdminState) -> bool {
    let mut hits = state.posts.lock().expect("admin rate");
    let now = Instant::now();
    while hits
        .front()
        .is_some_and(|hit| now.duration_since(*hit) >= POST_WINDOW)
    {
        hits.pop_front();
    }
    if hits.len() >= POST_LIMIT {
        return false;
    }
    hits.push_back(now);
    true
}

fn tokens_match(expected: &str, given: &str) -> bool {
    let expected = expected.as_bytes();
    let given = given.as_bytes();
    let mut diff = expected.len() ^ given.len();
    for index in 0..expected.len().max(given.len()) {
        let left = expected.get(index).copied().unwrap_or(0);
        let right = given.get(index).copied().unwrap_or(0);
        diff |= usize::from(left ^ right);
    }
    diff == 0
}

fn status_json(status: PublicStatus) -> Response {
    (
        StatusCode::OK,
        [(header::CACHE_CONTROL, "no-store")],
        Json(status),
    )
        .into_response()
}

fn session_json(err: SessionError) -> Response {
    let code = match err {
        SessionError::NotConfigured | SessionError::MediaRuntimeUnavailable => {
            StatusCode::SERVICE_UNAVAILABLE
        }
        SessionError::StudioLive | SessionError::WrongVenue | SessionError::NotConnected => {
            StatusCode::CONFLICT
        }
        SessionError::Token(_) | SessionError::Call(_) => StatusCode::BAD_REQUEST,
    };
    error_json(code, error_text(err))
}

fn error_text(err: SessionError) -> &'static str {
    match err {
        SessionError::NotConnected => "not connected",
        SessionError::MediaRuntimeUnavailable => "media runtime unavailable",
        SessionError::NotConfigured => "livekit is not configured",
        SessionError::WrongVenue => "that room belongs to the other venue",
        SessionError::StudioLive => "the NEBU studio is connected",
        SessionError::Token(_) => "livekit token was rejected",
        SessionError::Call(_) => "rejected",
    }
}

fn error_json(code: StatusCode, error: &'static str) -> Response {
    (
        code,
        [(header::CACHE_CONTROL, "no-store")],
        Json(serde_json::json!({ "error": error })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admin_origin_accepts_https_and_local_http_only() {
        assert_eq!(
            parse_admin_origin("https://admin.casabarra.test"),
            Some("https://admin.casabarra.test".into())
        );
        assert_eq!(
            parse_admin_origin("http://127.0.0.1:4173"),
            Some("http://127.0.0.1:4173".into())
        );
        assert!(parse_admin_origin("http://admin.casabarra.test").is_none());
        assert!(parse_admin_origin("https://user:secret@admin.casabarra.test").is_none());
        assert!(parse_admin_origin("https://admin.casabarra.test/panel").is_none());
    }

    #[test]
    fn short_desk_keys_do_not_match() {
        assert!(tokens_match(
            "casa-admin-token-9f3a",
            "casa-admin-token-9f3a"
        ));
        assert!(!tokens_match(
            "casa-admin-token-9f3a",
            "casa-admin-token-9f3b"
        ));
        assert!(!tokens_match("casa-admin-token-9f3a", ""));
        assert!(!tokens_match(
            "casa-admin-token-9f3a",
            "casa-admin-token-9f3a-extra"
        ));
    }
}

fn finish(state: &AdminState, headers: &HeaderMap, mut response: Response) -> Response {
    let Some(allowed) = state.origin.as_deref() else {
        return response;
    };
    let Some(request_origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    else {
        return response;
    };
    if request_origin != allowed {
        return response;
    }
    let headers = response.headers_mut();
    if let Ok(origin) = request_origin.parse() {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    }
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        "authorization,content-type".parse().expect("cors headers"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        "GET,POST,OPTIONS".parse().expect("cors methods"),
    );
    headers.insert(header::VARY, "origin".parse().expect("vary"));
    response
}

fn token_from_env() -> Option<String> {
    let value = std::env::var("CASA_BARRA_ADMIN_TOKEN").ok()?;
    let value = value.trim();
    if value.len() < 16 || value.contains([' ', '\n', '\r']) {
        return None;
    }
    Some(value.to_owned())
}

fn origin_from_env() -> Option<String> {
    let raw = std::env::var("CASA_BARRA_ADMIN_ORIGIN").ok()?;
    parse_admin_origin(raw.trim())
}

fn parse_admin_origin(raw: &str) -> Option<String> {
    let url = Url::parse(raw).ok()?;
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    if url.path() != "/" && !url.path().is_empty() {
        return None;
    }
    if url.query().is_some() || url.fragment().is_some() {
        return None;
    }
    let local = url.host_str() == Some("localhost") || url.host_str() == Some("127.0.0.1");
    match url.scheme() {
        "https" => {}
        "http" if local => {}
        _ => return None,
    }
    Some(url.origin().ascii_serialization())
}
