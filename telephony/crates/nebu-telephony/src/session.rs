use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use livekit_api::services::room::RoomClient;
use serde::Serialize;

use crate::config::LiveKitConfig;
use crate::livekit_plane::default_plane;
use crate::pair::{bind_addr_from_env, InviteBroker, InviteTicket, PairServer};
use crate::plane::{
    InputSource, JoinRequest, JoinedRoom, MediaKind, MediaPlane, PlaneError, PlaneEvent,
};
use crate::token::{self, ParticipantRole, TokenError, EXTERNAL_TTL};
use crate::venue::{qualify_room, Venue, VenueBook, VenueError};
use crate::within_latency_budget;

/// Media path budget from the telephony spec.
pub const LATENCY_BUDGET: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFeed {
    pub identity: String,
    pub track_sid: String,
    pub kind: MediaKind,
    pub source: String,
    pub muted: bool,
    pub subscribed: bool,
}

/// Control-page snapshot. No API secret and no room JWT.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicStatus {
    pub configured: bool,
    pub connection: ConnectionState,
    pub room: Option<String>,
    pub identity: Option<String>,
    pub audio_muted: bool,
    pub video_published: bool,
    pub input_source: InputSource,
    pub feeds: Vec<RemoteFeed>,
    pub signal_latency_ms: Option<u64>,
    pub within_latency_budget: bool,
    pub pair_port: Option<u16>,
    pub pair_bind: Option<String>,
    pub livekit_host: Option<String>,
    pub last_error: Option<String>,
    pub venue: Venue,
    pub role: Option<String>,
    pub live: bool,
    pub casa_configured: bool,
    pub nebu_configured: bool,
    pub audio_latency_ms: Option<u64>,
    pub video_latency_ms: Option<u64>,
    pub reservation_ref: Option<String>,
    /// No property-management system is connected. The reference is a desk note.
    pub reservation_book: bool,
    /// No OBS socket is opened from this process.
    pub obs_linked: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("not connected")]
    NotConnected,
    #[error("media runtime unavailable")]
    MediaRuntimeUnavailable,
    #[error("livekit is not configured")]
    NotConfigured,
    #[error("that room belongs to the other venue")]
    WrongVenue,
    #[error("{0}")]
    Token(#[from] TokenError),
    #[error("{0}")]
    Call(String),
}

struct StatusInner {
    generation: u64,
    connection: ConnectionState,
    room: Option<String>,
    identity: Option<String>,
    audio_muted: bool,
    video_published: bool,
    input_source: InputSource,
    feeds: Vec<RemoteFeed>,
    signal_latency_ms: Option<u64>,
    within_latency_budget: bool,
    latency_samples: u32,
    published_at: HashMap<String, Instant>,
    pair_port: Option<u16>,
    pair_bind: Option<String>,
    last_error: Option<String>,
    venue: Venue,
    role: Option<String>,
    audio_latency_ms: Option<u64>,
    video_latency_ms: Option<u64>,
    reservation_ref: Option<String>,
}

impl StatusInner {
    fn new() -> Self {
        Self {
            generation: 0,
            connection: ConnectionState::Disconnected,
            room: None,
            identity: None,
            audio_muted: false,
            video_published: false,
            input_source: InputSource::Program,
            feeds: Vec::new(),
            signal_latency_ms: None,
            within_latency_budget: false,
            latency_samples: 0,
            published_at: HashMap::new(),
            pair_port: None,
            pair_bind: None,
            last_error: None,
            venue: Venue::Nebu,
            role: None,
            audio_latency_ms: None,
            video_latency_ms: None,
            reservation_ref: None,
        }
    }
}

#[async_trait]
pub(crate) trait TrackModerator: Send + Sync {
    async fn mute_published_track(
        &self,
        room: &str,
        identity: &str,
        track_sid: &str,
        muted: bool,
    ) -> Result<(), String>;
}

struct ApiModerator {
    config: LiveKitConfig,
}

#[async_trait]
impl TrackModerator for ApiModerator {
    async fn mute_published_track(
        &self,
        room: &str,
        identity: &str,
        track_sid: &str,
        muted: bool,
    ) -> Result<(), String> {
        let client = RoomClient::with_api_key(
            &self.config.service_host(),
            self.config.api_key(),
            self.config.api_secret(),
        )
        .with_request_timeout(Duration::from_secs(5));
        client
            .mute_published_track(room, identity, track_sid, muted)
            .await
            .map(|_| ())
            .map_err(|err| self.config.redact(&err.to_string()))
    }
}

struct Inner {
    book: VenueBook,
    plane: Mutex<Option<Arc<dyn MediaPlane>>>,
    moderator: Mutex<Option<Arc<dyn TrackModerator>>>,
    broker: InviteBroker,
    status: Mutex<StatusInner>,
    room: Mutex<Option<Arc<dyn JoinedRoom>>>,
    gate: tokio::sync::Mutex<()>,
    pair: tokio::sync::Mutex<Option<PairServer>>,
    secrets: Mutex<Vec<String>>,
    next_generation: AtomicU64,
}

/// Studio telephony session. Cheap to clone: every handle shares one room.
#[derive(Clone)]
pub struct TelephonyNode {
    inner: Arc<Inner>,
}

fn moderator_for(book: &VenueBook, venue: Venue) -> Option<Arc<dyn TrackModerator>> {
    book.get(venue)
        .cloned()
        .map(|config| Arc::new(ApiModerator { config }) as Arc<dyn TrackModerator>)
}

impl TelephonyNode {
    pub fn new(config: Option<LiveKitConfig>) -> Self {
        Self::from_book(VenueBook::nebu_only(config))
    }

    pub fn from_book(book: VenueBook) -> Self {
        let moderator = moderator_for(&book, Venue::Nebu);
        Self {
            inner: Arc::new(Inner {
                book,
                plane: Mutex::new(default_plane()),
                moderator: Mutex::new(moderator),
                broker: InviteBroker::new(),
                status: Mutex::new(StatusInner::new()),
                room: Mutex::new(None),
                gate: tokio::sync::Mutex::new(()),
                pair: tokio::sync::Mutex::new(None),
                secrets: Mutex::new(Vec::new()),
                next_generation: AtomicU64::new(1),
            }),
        }
    }

    pub fn from_env() -> Self {
        match VenueBook::from_env() {
            Ok(book) => Self::from_book(book),
            Err(VenueError::NotIsolated) => {
                let node = Self::from_book(VenueBook::empty());
                node.inner.status.lock().expect("status").last_error =
                    Some("livekit credentials are not isolated".into());
                node
            }
        }
    }

    pub fn with_plane(self, plane: Arc<dyn MediaPlane>) -> Self {
        *self.inner.plane.lock().expect("plane") = Some(plane);
        self
    }

    #[cfg(test)]
    pub(crate) fn with_moderator(self, moderator: Arc<dyn TrackModerator>) -> Self {
        *self.inner.moderator.lock().expect("moderator") = Some(moderator);
        self
    }

    pub fn status(&self) -> PublicStatus {
        let status = self.inner.status.lock().expect("status");
        let mut feeds = status.feeds.clone();
        feeds.sort_by(|a, b| (&a.identity, &a.track_sid).cmp(&(&b.identity, &b.track_sid)));
        let venue = status.venue;
        PublicStatus {
            configured: self.inner.book.configured(venue),
            connection: status.connection,
            room: status.room.clone(),
            identity: status.identity.clone(),
            audio_muted: status.audio_muted,
            video_published: status.video_published,
            input_source: status.input_source,
            feeds,
            signal_latency_ms: status.signal_latency_ms,
            within_latency_budget: status.within_latency_budget,
            pair_port: status.pair_port,
            pair_bind: status.pair_bind.clone(),
            livekit_host: self.inner.book.get(venue).map(|config| config.public_url()),
            last_error: status.last_error.clone(),
            venue,
            role: status.role.clone(),
            live: venue == Venue::Nebu && status.connection == ConnectionState::Connected,
            casa_configured: self.inner.book.configured(Venue::CasaBarra),
            nebu_configured: self.inner.book.configured(Venue::Nebu),
            audio_latency_ms: status.audio_latency_ms,
            video_latency_ms: status.video_latency_ms,
            reservation_ref: status.reservation_ref.clone(),
            reservation_book: false,
            obs_linked: false,
        }
    }

    pub async fn set_venue(&self, venue: Venue) -> Result<(), SessionError> {
        let _gate = self.inner.gate.lock().await;
        if self.active_venue() == venue {
            return Ok(());
        }
        self.drop_room().await;
        let generation = self.inner.next_generation.fetch_add(1, Ordering::SeqCst);
        {
            let mut status = self.inner.status.lock().expect("status");
            status.generation = generation;
            clear_session(&mut status);
            status.venue = venue;
            status.reservation_ref = None;
        }
        *self.inner.moderator.lock().expect("moderator") = moderator_for(&self.inner.book, venue);
        Ok(())
    }

    pub async fn set_reservation_ref(&self, reference: &str) -> Result<(), SessionError> {
        let _gate = self.inner.gate.lock().await;
        if self.active_venue() != Venue::CasaBarra {
            return Err(SessionError::WrongVenue);
        }
        let reference = reference.trim();
        if reference.is_empty() {
            self.inner.status.lock().expect("status").reservation_ref = None;
            return Ok(());
        }
        if reference.len() > 64 || reference.contains(['\n', '\r']) {
            return Err(SessionError::Call("rejected".into()));
        }
        self.reject_if_secret(reference)?;
        self.inner.status.lock().expect("status").reservation_ref = Some(reference.to_owned());
        Ok(())
    }

    pub async fn connect(&self, room: &str, identity: &str) -> Result<(), SessionError> {
        let venue = self.active_venue();
        let room = qualify_room(venue, room).map_err(|_| SessionError::WrongVenue)?;
        let identity = identity.trim().to_owned();
        let role = match venue {
            Venue::Nebu => ParticipantRole::Streamer {
                identity: identity.clone(),
                name: identity,
                room,
            },
            Venue::CasaBarra => ParticipantRole::Concierge {
                identity: identity.clone(),
                name: identity,
                room,
            },
        };
        self.connect_role(role).await
    }

    pub async fn connect_headless(&self, room: &str, identity: &str) -> Result<(), SessionError> {
        if self.active_venue() != Venue::Nebu {
            return Err(SessionError::WrongVenue);
        }
        let room = qualify_room(Venue::Nebu, room).map_err(|_| SessionError::WrongVenue)?;
        self.connect_role(ParticipantRole::HeadlessSubscriber {
            identity: identity.trim().to_owned(),
            room,
        })
        .await
    }

    pub async fn disconnect(&self) -> Result<(), SessionError> {
        let _gate = self.inner.gate.lock().await;
        self.drop_room().await;
        let mut status = self.inner.status.lock().expect("status");
        status.generation = self.inner.next_generation.fetch_add(1, Ordering::SeqCst);
        clear_session(&mut status);
        Ok(())
    }

    pub async fn set_audio_muted(&self, muted: bool) -> Result<(), SessionError> {
        let _gate = self.inner.gate.lock().await;
        let room = self.live_room()?;
        room.set_audio_muted(muted)
            .await
            .map_err(|err| SessionError::Call(self.scrub(&err.to_string())))?;
        self.inner.status.lock().expect("status").audio_muted = muted;
        Ok(())
    }

    pub async fn unpublish_video(&self) -> Result<(), SessionError> {
        let _gate = self.inner.gate.lock().await;
        let room = self.live_room()?;
        room.unpublish_video()
            .await
            .map_err(|err| SessionError::Call(self.scrub(&err.to_string())))?;
        self.inner.status.lock().expect("status").video_published = false;
        Ok(())
    }

    pub async fn set_input_source(&self, source: InputSource) -> Result<(), SessionError> {
        let _gate = self.inner.gate.lock().await;
        let room = self.live_room()?;
        room.set_input_source(source)
            .await
            .map_err(|err| SessionError::Call(self.scrub(&err.to_string())))?;
        self.inner.status.lock().expect("status").input_source = source;
        Ok(())
    }

    /// Server-side mute. The API secret stays in this process.
    pub async fn mute_remote(
        &self,
        identity: &str,
        track_sid: &str,
        muted: bool,
    ) -> Result<(), SessionError> {
        let _gate = self.inner.gate.lock().await;
        let _room = self.live_room()?;
        let room_name = self
            .inner
            .status
            .lock()
            .expect("status")
            .room
            .clone()
            .ok_or(SessionError::NotConnected)?;
        let moderator = self
            .inner
            .moderator
            .lock()
            .expect("moderator")
            .clone()
            .ok_or(SessionError::NotConfigured)?;
        moderator
            .mute_published_track(&room_name, identity, track_sid, muted)
            .await
            .map_err(|err| SessionError::Call(self.scrub(&err)))?;
        let mut status = self.inner.status.lock().expect("status");
        if let Some(feed) = status
            .feeds
            .iter_mut()
            .find(|feed| feed.identity == identity && feed.track_sid == track_sid)
        {
            feed.muted = muted;
        }
        Ok(())
    }

    /// One-time camera code. The returned ticket has no JWT.
    pub async fn invite_external(
        &self,
        room: &str,
        device_label: &str,
    ) -> Result<InviteTicket, SessionError> {
        let venue = self.active_venue();
        let config = self.active_config().ok_or(SessionError::NotConfigured)?;
        let room = qualify_room(venue, room).map_err(|_| SessionError::WrongVenue)?;
        self.reject_if_secret(&room)?;
        let name = clean_label(device_label)?;
        self.reject_if_secret(&name)?;
        for _ in 0..5 {
            let code = self.inner.broker.mint_code();
            let role = match venue {
                Venue::Nebu => ParticipantRole::ExternalCamera {
                    identity: format!("cam-{code}"),
                    name: name.clone(),
                    room: room.clone(),
                },
                Venue::CasaBarra => ParticipantRole::Guest {
                    identity: format!("guest-{code}"),
                    name: name.clone(),
                    room: room.clone(),
                },
            };
            let jwt = token::issue(&config, &role)?;
            self.note_secret(&jwt);
            if let Some(ticket) =
                self.inner
                    .broker
                    .insert(&code, config.signal_url(), &jwt, EXTERNAL_TTL)
            {
                return Ok(ticket);
            }
        }
        Err(SessionError::Call("could not store invite".into()))
    }

    pub async fn start_pair_server(&self) -> Result<u16, SessionError> {
        let _gate = self.inner.pair.lock().await;
        if let Some(server) = _gate.as_ref() {
            return Ok(server.port());
        }
        drop(_gate);
        let bound = bind_addr_from_env();
        let server = PairServer::bind(self.inner.broker.clone(), &bound)
            .await
            .map_err(|err| SessionError::Call(self.scrub(&err.to_string())))?;
        let port = server.port();
        let bind = server.local_addr().to_string();
        let mut slot = self.inner.pair.lock().await;
        if let Some(existing) = slot.as_ref() {
            return Ok(existing.port());
        }
        *slot = Some(server);
        let mut status = self.inner.status.lock().expect("status");
        status.pair_port = Some(port);
        status.pair_bind = Some(bind);
        Ok(port)
    }

    async fn connect_role(&self, role: ParticipantRole) -> Result<(), SessionError> {
        let _gate = self.inner.gate.lock().await;
        let config = self.active_config().ok_or(SessionError::NotConfigured)?;
        if role_venue(&role) != self.active_venue() {
            return Err(SessionError::WrongVenue);
        }
        let plane = self
            .inner
            .plane
            .lock()
            .expect("plane")
            .clone()
            .ok_or(SessionError::MediaRuntimeUnavailable)?;
        let (identity, room) = match &role {
            ParticipantRole::Streamer { identity, room, .. }
            | ParticipantRole::ExternalCamera { identity, room, .. }
            | ParticipantRole::HeadlessSubscriber { identity, room }
            | ParticipantRole::Concierge { identity, room, .. }
            | ParticipantRole::Guest { identity, room, .. } => (identity.clone(), room.clone()),
        };
        self.reject_if_secret(&identity)?;
        self.reject_if_secret(&room)?;
        let jwt = token::issue(&config, &role)?;
        self.note_secret(&jwt);
        self.drop_room().await;
        let generation = self.inner.next_generation.fetch_add(1, Ordering::SeqCst);
        {
            let mut status = self.inner.status.lock().expect("status");
            status.generation = generation;
            status.connection = ConnectionState::Connecting;
            status.room = Some(room.clone());
            status.identity = Some(identity.clone());
            status.role = Some(role_label(&role).to_owned());
            status.last_error = None;
            status.feeds.clear();
            status.published_at.clear();
            status.signal_latency_ms = None;
            status.audio_latency_ms = None;
            status.video_latency_ms = None;
            status.within_latency_budget = false;
            status.latency_samples = 0;
            status.video_published = false;
        }
        let joined = match plane
            .join(JoinRequest {
                url: config.signal_url().to_owned(),
                token: jwt,
                identity: identity.clone(),
                room: room.clone(),
            })
            .await
        {
            Ok(joined) => joined,
            Err(err) => {
                self.fail_connect(generation, &err.to_string());
                return Err(self.plane_error(err));
            }
        };
        let joined: Arc<dyn JoinedRoom> = Arc::from(joined);
        let events = joined.take_events();
        *self.inner.room.lock().expect("room") = Some(Arc::clone(&joined));
        {
            let mut status = self.inner.status.lock().expect("status");
            if status.generation == generation {
                status.connection = ConnectionState::Connected;
            }
        }
        if let Some(mut events) = events {
            while let Ok(event) = events.try_recv() {
                self.apply(generation, event);
            }
            let node = self.clone();
            tokio::spawn(async move {
                while let Some(event) = events.recv().await {
                    node.apply(generation, event);
                }
            });
        }
        Ok(())
    }

    fn live_room(&self) -> Result<Arc<dyn JoinedRoom>, SessionError> {
        self.inner
            .room
            .lock()
            .expect("room")
            .clone()
            .ok_or(SessionError::NotConnected)
    }

    async fn drop_room(&self) {
        let previous = self.inner.room.lock().expect("room").take();
        if let Some(previous) = previous {
            let _ = previous.close().await;
        }
    }

    fn fail_connect(&self, generation: u64, message: &str) {
        let clean = self.scrub(message);
        let mut status = self.inner.status.lock().expect("status");
        if status.generation != generation {
            return;
        }
        clear_session(&mut status);
        status.last_error = Some(clean);
    }

    fn plane_error(&self, err: PlaneError) -> SessionError {
        match err {
            PlaneError::MediaRuntimeUnavailable => SessionError::MediaRuntimeUnavailable,
            PlaneError::Message(message) => SessionError::Call(self.scrub(&message)),
        }
    }

    fn apply(&self, generation: u64, event: PlaneEvent) {
        let failed = match &event {
            PlaneEvent::Failed(message) => Some(self.scrub(message)),
            _ => None,
        };
        let mut status = self.inner.status.lock().expect("status");
        if status.generation != generation {
            return;
        }
        match event {
            PlaneEvent::State(state) => {
                status.connection = state;
                if matches!(
                    state,
                    ConnectionState::Disconnected | ConnectionState::Failed
                ) {
                    status.feeds.clear();
                }
            }
            PlaneEvent::Failed(_) => {
                status.connection = ConnectionState::Failed;
                status.last_error = failed;
            }
            PlaneEvent::TrackPublished {
                local,
                identity,
                track_sid,
                kind,
                source,
                at,
            } => {
                status.published_at.insert(track_sid.clone(), at);
                if local && kind == MediaKind::Video {
                    status.video_published = true;
                }
                if !local {
                    upsert_feed(
                        &mut status.feeds,
                        RemoteFeed {
                            identity,
                            track_sid,
                            kind,
                            source,
                            muted: false,
                            subscribed: false,
                        },
                    );
                }
            }
            PlaneEvent::TrackSubscribed {
                identity,
                track_sid,
                kind,
                at,
            } => {
                if let Some(published) = status.published_at.get(&track_sid).copied() {
                    let latency = at.saturating_duration_since(published);
                    let ok = within_latency_budget(latency);
                    if status.latency_samples == 0 {
                        status.within_latency_budget = ok;
                    } else if !ok {
                        status.within_latency_budget = false;
                    }
                    status.latency_samples += 1;
                    let millis = u64::try_from(latency.as_millis()).unwrap_or(u64::MAX);
                    status.signal_latency_ms = Some(millis);
                    match kind {
                        MediaKind::Audio => status.audio_latency_ms = Some(millis),
                        MediaKind::Video => status.video_latency_ms = Some(millis),
                    }
                }
                upsert_feed(
                    &mut status.feeds,
                    RemoteFeed {
                        identity,
                        track_sid,
                        kind,
                        source: String::new(),
                        muted: false,
                        subscribed: true,
                    },
                );
            }
            PlaneEvent::TrackUnpublished {
                identity,
                track_sid,
            } => {
                status
                    .feeds
                    .retain(|feed| !(feed.identity == identity && feed.track_sid == track_sid));
            }
            PlaneEvent::TrackMuted {
                identity,
                track_sid,
                muted,
            } => {
                if let Some(feed) = status
                    .feeds
                    .iter_mut()
                    .find(|feed| feed.identity == identity && feed.track_sid == track_sid)
                {
                    feed.muted = muted;
                }
            }
        }
    }

    fn note_secret(&self, secret: &str) {
        if secret.len() < 8 {
            return;
        }
        let mut secrets = self.inner.secrets.lock().expect("secrets");
        secrets.push(secret.to_owned());
        if secrets.len() > 16 {
            let drain = secrets.len() - 16;
            secrets.drain(0..drain);
        }
    }

    fn active_venue(&self) -> Venue {
        self.inner.status.lock().expect("status").venue
    }

    fn active_config(&self) -> Option<LiveKitConfig> {
        let venue = self.active_venue();
        self.inner.book.get(venue).cloned()
    }

    fn scrub(&self, text: &str) -> String {
        let mut out = self.inner.book.redact_all(text);
        let secrets = self.inner.secrets.lock().expect("secrets");
        for secret in secrets.iter() {
            if secret.len() >= 8 {
                out = out.replace(secret.as_str(), "[redacted]");
            }
        }
        out
    }

    fn reject_if_secret(&self, value: &str) -> Result<(), SessionError> {
        if self.scrub(value) != value {
            return Err(SessionError::Call("rejected".into()));
        }
        Ok(())
    }
}

fn clear_session(status: &mut StatusInner) {
    status.connection = ConnectionState::Disconnected;
    status.room = None;
    status.identity = None;
    status.audio_muted = false;
    status.video_published = false;
    status.feeds.clear();
    status.published_at.clear();
    status.signal_latency_ms = None;
    status.within_latency_budget = false;
    status.latency_samples = 0;
    status.last_error = None;
    status.role = None;
    status.audio_latency_ms = None;
    status.video_latency_ms = None;
}

fn role_venue(role: &ParticipantRole) -> Venue {
    match role {
        ParticipantRole::Streamer { .. }
        | ParticipantRole::ExternalCamera { .. }
        | ParticipantRole::HeadlessSubscriber { .. } => Venue::Nebu,
        ParticipantRole::Concierge { .. } | ParticipantRole::Guest { .. } => Venue::CasaBarra,
    }
}

fn role_label(role: &ParticipantRole) -> &'static str {
    match role {
        ParticipantRole::Streamer { .. } => "streamer",
        ParticipantRole::ExternalCamera { .. } => "camera",
        ParticipantRole::HeadlessSubscriber { .. } => "headless",
        ParticipantRole::Concierge { .. } => "concierge",
        ParticipantRole::Guest { .. } => "guest",
    }
}

fn clean_label(label: &str) -> Result<String, SessionError> {
    let label = label.trim();
    if label.is_empty() {
        return Ok("camera".into());
    }
    if label.len() > 64 || label.contains(['\n', '\r']) {
        return Err(SessionError::Call("rejected".into()));
    }
    Ok(label.to_owned())
}

fn upsert_feed(feeds: &mut Vec<RemoteFeed>, incoming: RemoteFeed) {
    if let Some(feed) = feeds
        .iter_mut()
        .find(|feed| feed.identity == incoming.identity && feed.track_sid == incoming.track_sid)
    {
        if !incoming.source.is_empty() {
            feed.source = incoming.source;
        }
        feed.kind = incoming.kind;
        feed.muted = incoming.muted || feed.muted;
        feed.subscribed = incoming.subscribed || feed.subscribed;
        return;
    }
    feeds.push(incoming);
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use livekit_api::access_token::TokenVerifier;
    use tokio::sync::mpsc::unbounded_channel;

    fn config() -> LiveKitConfig {
        LiveKitConfig::new(
            "wss://livekit.example",
            "APItestkey9f3a",
            "lk-test-secret-9f3a",
        )
        .unwrap()
    }

    struct Scripted {
        events: Mutex<Vec<PlaneEvent>>,
        log: Arc<Mutex<Vec<String>>>,
        echo_token: bool,
        fail_mute: bool,
        captured: Arc<Mutex<Option<String>>>,
    }

    struct ScriptedJoined {
        log: Arc<Mutex<Vec<String>>>,
        fail_mute: bool,
        events: Mutex<Option<tokio::sync::mpsc::UnboundedReceiver<PlaneEvent>>>,
    }

    #[async_trait]
    impl MediaPlane for Scripted {
        async fn join(&self, request: JoinRequest) -> Result<Box<dyn JoinedRoom>, PlaneError> {
            *self.captured.lock().unwrap() = Some(request.token.clone());
            if self.echo_token {
                return Err(PlaneError::Message(format!(
                    "connect failed lk-test-secret-9f3a {}",
                    request.token
                )));
            }
            let (tx, rx) = unbounded_channel();
            for event in self.events.lock().unwrap().drain(..) {
                let _ = tx.send(event);
            }
            Ok(Box::new(ScriptedJoined {
                log: Arc::clone(&self.log),
                fail_mute: self.fail_mute,
                events: Mutex::new(Some(rx)),
            }))
        }
    }

    #[async_trait]
    impl JoinedRoom for ScriptedJoined {
        async fn set_audio_muted(&self, muted: bool) -> Result<(), PlaneError> {
            if self.fail_mute {
                return Err(PlaneError::Message("mute failed".into()));
            }
            self.log.lock().unwrap().push(format!("mute:{muted}"));
            Ok(())
        }

        async fn unpublish_video(&self) -> Result<(), PlaneError> {
            self.log.lock().unwrap().push("unpublish".into());
            Ok(())
        }

        async fn set_input_source(&self, source: InputSource) -> Result<(), PlaneError> {
            self.log
                .lock()
                .unwrap()
                .push(format!("source:{}", source.as_str()));
            Ok(())
        }

        async fn close(&self) -> Result<(), PlaneError> {
            self.log.lock().unwrap().push("close".into());
            Ok(())
        }

        fn take_events(&self) -> Option<tokio::sync::mpsc::UnboundedReceiver<PlaneEvent>> {
            self.events.lock().unwrap().take()
        }
    }

    struct FakeMod {
        fail: bool,
        calls: Arc<Mutex<Vec<(String, String, bool)>>>,
    }

    #[async_trait]
    impl TrackModerator for FakeMod {
        async fn mute_published_track(
            &self,
            _room: &str,
            identity: &str,
            track_sid: &str,
            muted: bool,
        ) -> Result<(), String> {
            if self.fail {
                return Err("lk-test-secret-9f3a leaked".into());
            }
            self.calls
                .lock()
                .unwrap()
                .push((identity.to_owned(), track_sid.to_owned(), muted));
            Ok(())
        }
    }

    fn scripted(events: Vec<PlaneEvent>) -> Arc<Scripted> {
        Arc::new(Scripted {
            events: Mutex::new(events),
            log: Arc::new(Mutex::new(Vec::new())),
            echo_token: false,
            fail_mute: false,
            captured: Arc::new(Mutex::new(None)),
        })
    }

    fn published(at: Instant) -> PlaneEvent {
        PlaneEvent::TrackPublished {
            local: false,
            identity: "cam-iphone".into(),
            track_sid: "TR_cam".into(),
            kind: MediaKind::Video,
            source: "camera".into(),
            at,
        }
    }

    fn subscribed(at: Instant) -> PlaneEvent {
        PlaneEvent::TrackSubscribed {
            identity: "cam-iphone".into(),
            track_sid: "TR_cam".into(),
            kind: MediaKind::Video,
            at,
        }
    }

    #[tokio::test]
    async fn connect_without_a_media_plane_stays_disconnected() {
        let node = TelephonyNode::new(Some(config()));
        let err = node.connect("studio", "host").await.unwrap_err();
        assert!(matches!(err, SessionError::MediaRuntimeUnavailable));
        assert_eq!(node.status().connection, ConnectionState::Disconnected);
        assert!(node.status().room.is_none());
    }

    #[tokio::test]
    async fn unconfigured_node_does_not_invent_a_room() {
        let node = TelephonyNode::new(None);
        let err = node.connect("studio", "host").await.unwrap_err();
        assert!(matches!(err, SessionError::NotConfigured));
        assert_eq!(node.status().connection, ConnectionState::Disconnected);
        assert!(!node.status().configured);
    }

    #[tokio::test]
    async fn mute_unpublish_and_source_follow_the_plane() {
        let plane = scripted(vec![PlaneEvent::TrackPublished {
            local: true,
            identity: "host".into(),
            track_sid: "TR_local".into(),
            kind: MediaKind::Video,
            source: "camera".into(),
            at: Instant::now(),
        }]);
        let node = TelephonyNode::new(Some(config()))
            .with_plane(Arc::clone(&plane) as Arc<dyn MediaPlane>);
        node.connect("studio", "host").await.unwrap();
        assert!(node.status().video_published);
        node.set_audio_muted(true).await.unwrap();
        node.unpublish_video().await.unwrap();
        node.set_input_source(InputSource::External).await.unwrap();
        let status = node.status();
        assert!(status.audio_muted);
        assert!(!status.video_published);
        assert_eq!(status.input_source, InputSource::External);
        assert_eq!(
            plane.log.lock().unwrap().as_slice(),
            [
                "mute:true".to_string(),
                "unpublish".into(),
                "source:external".into()
            ]
        );
        let shown = serde_json::to_string(&status).unwrap();
        assert!(!shown.contains("lk-test-secret-9f3a"));
        assert!(!shown.contains("eyJ"));
        let captured = plane.captured.lock().unwrap().clone().unwrap();
        assert!(captured.starts_with("eyJ"));
        assert!(!shown.contains(&captured));
    }

    #[tokio::test]
    async fn failed_mute_does_not_stick() {
        let plane = scripted(Vec::new());
        // rebuild with fail_mute
        let plane = Arc::new(Scripted {
            events: Mutex::new(Vec::new()),
            log: Arc::clone(&plane.log),
            echo_token: false,
            fail_mute: true,
            captured: Arc::clone(&plane.captured),
        });
        let node = TelephonyNode::new(Some(config())).with_plane(plane);
        node.connect("studio", "host").await.unwrap();
        let err = node.set_audio_muted(true).await.unwrap_err();
        assert!(err.to_string().contains("mute failed"));
        assert!(!node.status().audio_muted);
        let disconnected = TelephonyNode::new(Some(config())).with_plane(scripted(Vec::new()));
        let err = disconnected.set_audio_muted(true).await.unwrap_err();
        assert!(matches!(err, SessionError::NotConnected));
    }

    #[tokio::test]
    async fn latency_budget_follows_publish_then_subscribe() {
        let start = Instant::now();
        let fast = scripted(vec![
            published(start),
            subscribed(start + Duration::from_millis(120)),
        ]);
        let node = TelephonyNode::new(Some(config())).with_plane(fast);
        node.connect("studio", "host").await.unwrap();
        let status = node.status();
        assert_eq!(status.signal_latency_ms, Some(120));
        assert_eq!(status.video_latency_ms, Some(120));
        assert!(status.audio_latency_ms.is_none());
        assert!(status.within_latency_budget);
        assert!(status.live);
        assert_eq!(status.role.as_deref(), Some("streamer"));
        assert_eq!(status.room.as_deref(), Some("nebu/studio"));
        assert!(status.feeds[0].subscribed);

        let slow = scripted(vec![
            published(start),
            subscribed(start + Duration::from_millis(500)),
        ]);
        let node = TelephonyNode::new(Some(config())).with_plane(slow);
        node.connect("studio", "host").await.unwrap();
        let status = node.status();
        assert_eq!(status.signal_latency_ms, Some(500));
        assert_eq!(status.video_latency_ms, Some(500));
        assert!(!status.within_latency_budget);

        let both = scripted(vec![
            PlaneEvent::TrackPublished {
                local: false,
                identity: "cam-iphone".into(),
                track_sid: "TR_mic".into(),
                kind: MediaKind::Audio,
                source: "microphone".into(),
                at: start,
            },
            PlaneEvent::TrackSubscribed {
                identity: "cam-iphone".into(),
                track_sid: "TR_mic".into(),
                kind: MediaKind::Audio,
                at: start + Duration::from_millis(80),
            },
            published(start),
            subscribed(start + Duration::from_millis(500)),
        ]);
        let node = TelephonyNode::new(Some(config())).with_plane(both);
        node.connect("studio", "host").await.unwrap();
        let status = node.status();
        assert_eq!(status.audio_latency_ms, Some(80));
        assert_eq!(status.video_latency_ms, Some(500));
        assert!(!status.within_latency_budget);
    }

    #[tokio::test]
    async fn plane_errors_redact_secrets_and_leave_the_node_disconnected() {
        let secret = "lk-test-secret-9f3a";
        let plane = Arc::new(Scripted {
            events: Mutex::new(Vec::new()),
            log: Arc::new(Mutex::new(Vec::new())),
            echo_token: true,
            fail_mute: false,
            captured: Arc::new(Mutex::new(None)),
        });
        let node = TelephonyNode::new(Some(config())).with_plane(plane);
        let err = node.connect("studio", "host").await.unwrap_err();
        let shown = err.to_string();
        assert!(!shown.contains(secret));
        assert!(!shown.contains("eyJ"));
        assert!(shown.contains("[redacted]"));
        let status = node.status();
        assert_eq!(status.connection, ConnectionState::Disconnected);
        let json = serde_json::to_string(&status).unwrap();
        assert!(!json.contains(secret));
        assert!(!json.contains("eyJ"));
    }

    #[tokio::test]
    async fn headless_join_hides_the_subscriber_token() {
        let plane = scripted(Vec::new());
        let node = TelephonyNode::new(Some(config()))
            .with_plane(Arc::clone(&plane) as Arc<dyn MediaPlane>);
        node.connect_headless("studio", "studio-sub").await.unwrap();
        let jwt = plane.captured.lock().unwrap().clone().unwrap();
        let claims = TokenVerifier::with_api_key("APItestkey9f3a", "lk-test-secret-9f3a")
            .verify(&jwt)
            .unwrap();
        assert!(claims.video.hidden);
        assert_eq!(claims.video.can_publish, Some(false));
        assert!(!claims.video.room_admin);
        let json = serde_json::to_string(&node.status()).unwrap();
        assert!(!json.contains(&jwt));
        assert!(!json.contains("lk-test-secret-9f3a"));
        assert_eq!(node.status().connection, ConnectionState::Connected);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_invites_issue_distinct_camera_tokens() {
        let node = TelephonyNode::new(Some(config()));
        let mut tasks = tokio::task::JoinSet::new();
        for index in 0..32 {
            let node = node.clone();
            tasks.spawn(async move {
                node.invite_external("studio", &format!("phone{index}"))
                    .await
                    .unwrap()
            });
        }
        let mut codes = std::collections::HashSet::new();
        while let Some(joined) = tasks.join_next().await {
            let ticket = joined.unwrap();
            let ticket_json = serde_json::to_string(&ticket).unwrap();
            assert!(!ticket_json.contains("eyJ"));
            assert!(!ticket_json.contains("token"));
            assert!(codes.insert(ticket.code.clone()));
            let jwt = node.inner.broker.peek_token(&ticket.code).unwrap();
            let claims = TokenVerifier::with_api_key("APItestkey9f3a", "lk-test-secret-9f3a")
                .verify(&jwt)
                .unwrap();
            assert!(!claims.video.room_admin);
            assert_eq!(claims.video.can_subscribe, Some(false));
            assert_eq!(claims.video.can_publish_data, Some(false));
            assert_eq!(
                claims.video.can_publish_sources,
                vec!["camera".to_string(), "microphone".to_string()]
            );
        }
        assert_eq!(codes.len(), 32);
        let status = serde_json::to_string(&node.status()).unwrap();
        assert!(!status.contains("eyJ"));
        assert!(!status.contains("lk-test-secret-9f3a"));
        let debug = format!("{:?}", node.inner.broker);
        assert!(!debug.contains("eyJ"));
    }

    #[tokio::test]
    async fn pair_server_redeems_an_invite_once() {
        let node = TelephonyNode::new(Some(config()));
        let port = node.start_pair_server().await.unwrap();
        let ticket = node.invite_external("studio", "iPhone").await.unwrap();
        let client = reqwest::Client::new();
        let health = client
            .get(format!("http://127.0.0.1:{port}/v1/health"))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(!health.contains("eyJ"));
        let redeemed: serde_json::Value = client
            .post(format!("http://127.0.0.1:{port}/v1/pair"))
            .json(&serde_json::json!({ "code": ticket.code }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let jwt = redeemed["token"].as_str().unwrap();
        let claims = TokenVerifier::with_api_key("APItestkey9f3a", "lk-test-secret-9f3a")
            .verify(jwt)
            .unwrap();
        assert_eq!(claims.video.room, "nebu/studio");
        assert!(!claims.video.room_admin);
        let again = client
            .post(format!("http://127.0.0.1:{port}/v1/pair"))
            .json(&serde_json::json!({ "code": ticket.code }))
            .send()
            .await
            .unwrap();
        assert_eq!(again.status(), reqwest::StatusCode::NOT_FOUND);
        let status = serde_json::to_string(&node.status()).unwrap();
        assert!(!status.contains(jwt));
    }

    #[tokio::test]
    async fn remote_mute_uses_the_moderator_and_hides_secret_on_failure() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let start = Instant::now();
        let node = TelephonyNode::new(Some(config()))
            .with_plane(scripted(vec![published(start)]))
            .with_moderator(Arc::new(FakeMod {
                fail: false,
                calls: Arc::clone(&calls),
            }));
        node.connect("studio", "host").await.unwrap();
        node.mute_remote("cam-iphone", "TR_cam", true)
            .await
            .unwrap();
        assert!(node.status().feeds[0].muted);
        assert_eq!(
            calls.lock().unwrap().as_slice(),
            [("cam-iphone".into(), "TR_cam".into(), true)]
        );

        let node = TelephonyNode::new(Some(config()))
            .with_plane(scripted(vec![published(start)]))
            .with_moderator(Arc::new(FakeMod {
                fail: true,
                calls: Arc::new(Mutex::new(Vec::new())),
            }));
        node.connect("studio", "host").await.unwrap();
        let err = node
            .mute_remote("cam-iphone", "TR_cam", true)
            .await
            .unwrap_err();
        assert!(!err.to_string().contains("lk-test-secret-9f3a"));
        assert!(!node.status().feeds[0].muted);
    }

    #[test]
    fn config_debug_and_public_url_hide_credentials() {
        let config = config();
        let shown = format!("{config:?}");
        assert!(shown.contains("redacted"));
        assert!(!shown.contains("lk-test-secret-9f3a"));
        assert!(!shown.contains("APItestkey9f3a"));
        assert_eq!(config.public_url(), "wss://livekit.example");
        assert_eq!(config.service_host(), "https://livekit.example");
        let local = LiveKitConfig::new("ws://127.0.0.1:7880", "key", "secretsecret").unwrap();
        assert_eq!(local.service_host(), "http://127.0.0.1:7880");
        assert!(LiveKitConfig::new("wss://a:b@livekit.example", "key", "secretsecret").is_err());
        assert!(LiveKitConfig::new("ftp://livekit.example", "key", "secretsecret").is_err());
        assert!(LiveKitConfig::new("wss://livekit.example", "key", " ").is_err());
    }

    #[tokio::test]
    async fn venues_keep_separate_secrets_rooms_and_roles() {
        let casa = LiveKitConfig::new(
            "wss://casa.example",
            "casa-api-key-9f3a",
            "casa-secret-9f3a-isolated",
        )
        .unwrap();
        let book = VenueBook::new(Some(casa), Some(config())).unwrap();
        let plane = scripted(Vec::new());
        let node =
            TelephonyNode::from_book(book).with_plane(Arc::clone(&plane) as Arc<dyn MediaPlane>);

        let err = node
            .invite_external("casa/villa", "phone")
            .await
            .unwrap_err();
        assert!(matches!(err, SessionError::WrongVenue));

        node.connect("studio", "host").await.unwrap();
        assert!(node.status().live);
        assert_eq!(
            node.status().livekit_host.as_deref(),
            Some("wss://livekit.example")
        );
        let nebu_jwt = plane.captured.lock().unwrap().clone().unwrap();
        assert!(
            TokenVerifier::with_api_key("casa-api-key-9f3a", "casa-secret-9f3a-isolated")
                .verify(&nebu_jwt)
                .is_err()
        );

        node.set_venue(Venue::CasaBarra).await.unwrap();
        let status = node.status();
        assert_eq!(status.connection, ConnectionState::Disconnected);
        assert!(!status.live);
        assert_eq!(status.livekit_host.as_deref(), Some("wss://casa.example"));
        assert!(!status.obs_linked);
        assert!(!status.reservation_book);

        node.set_reservation_ref("HB-1042").await.unwrap();
        assert_eq!(node.status().reservation_ref.as_deref(), Some("HB-1042"));
        let err = node
            .set_reservation_ref("casa-secret-9f3a-isolated")
            .await
            .unwrap_err();
        assert!(!err.to_string().contains("casa-secret"));
        assert_eq!(node.status().reservation_ref.as_deref(), Some("HB-1042"));

        node.connect("villa", "desk").await.unwrap();
        let casa_jwt = plane.captured.lock().unwrap().clone().unwrap();
        let claims = TokenVerifier::with_api_key("casa-api-key-9f3a", "casa-secret-9f3a-isolated")
            .verify(&casa_jwt)
            .unwrap();
        assert_eq!(claims.video.room, "casa/villa");
        assert_eq!(claims.video.can_subscribe, Some(true));
        assert_eq!(claims.video.can_publish_data, Some(false));
        assert!(!claims.video.room_admin);
        assert!(
            TokenVerifier::with_api_key("APItestkey9f3a", "lk-test-secret-9f3a")
                .verify(&casa_jwt)
                .is_err()
        );
        let status = node.status();
        assert_eq!(status.role.as_deref(), Some("concierge"));
        assert!(!status.live);

        let ticket = node.invite_external("villa", "Ana").await.unwrap();
        let guest = node.inner.broker.peek_token(&ticket.code).unwrap();
        let guest_claims =
            TokenVerifier::with_api_key("casa-api-key-9f3a", "casa-secret-9f3a-isolated")
                .verify(&guest)
                .unwrap();
        assert!(guest_claims.sub.starts_with("guest-"));
        assert_eq!(guest_claims.video.room, "casa/villa");
        assert_eq!(guest_claims.video.can_subscribe, Some(true));
        assert!(
            TokenVerifier::with_api_key("APItestkey9f3a", "lk-test-secret-9f3a")
                .verify(&guest)
                .is_err()
        );

        let json = serde_json::to_string(&node.status()).unwrap();
        assert!(!json.contains("lk-test-secret"));
        assert!(!json.contains("casa-secret"));
        assert!(!json.contains(&casa_jwt));
        assert!(!json.contains(&guest));
        assert!(!json.contains("wss://livekit.example"));

        node.set_venue(Venue::Nebu).await.unwrap();
        assert!(node.status().reservation_ref.is_none());
        let err = node.set_reservation_ref("HB-1").await.unwrap_err();
        assert!(matches!(err, SessionError::WrongVenue));
    }

    #[test]
    fn latency_budget_is_strict() {
        assert!(crate::within_latency_budget(Duration::from_millis(499)));
        assert!(!crate::within_latency_budget(LATENCY_BUDGET));
        assert!(!crate::within_latency_budget(Duration::from_millis(500)));
    }
}
