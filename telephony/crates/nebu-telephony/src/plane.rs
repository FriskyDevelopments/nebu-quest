use std::fmt;
use std::time::Instant;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc::UnboundedReceiver;

use crate::session::ConnectionState;

/// Which input the studio is using. Switching this does not open a camera
/// inside the control process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InputSource {
    Program,
    Camera,
    Screen,
    External,
}

impl InputSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Program => "program",
            Self::Camera => "camera",
            Self::Screen => "screen",
            Self::External => "external",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Audio,
    Video,
}

#[derive(Debug, Clone)]
pub enum PlaneEvent {
    State(ConnectionState),
    TrackPublished {
        local: bool,
        identity: String,
        track_sid: String,
        kind: MediaKind,
        source: String,
        at: Instant,
    },
    TrackSubscribed {
        identity: String,
        track_sid: String,
        kind: MediaKind,
        at: Instant,
    },
    TrackUnpublished {
        identity: String,
        track_sid: String,
    },
    TrackMuted {
        identity: String,
        track_sid: String,
        muted: bool,
    },
    Failed(String),
}

/// Join parameters. Debug output keeps the room JWT out of logs.
pub struct JoinRequest {
    pub url: String,
    pub token: String,
    pub identity: String,
    pub room: String,
}

impl fmt::Debug for JoinRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("JoinRequest")
            .field("url", &self.url)
            .field("identity", &self.identity)
            .field("room", &self.room)
            .field("token", &"redacted")
            .finish()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PlaneError {
    #[error("media runtime unavailable")]
    MediaRuntimeUnavailable,
    #[error("{0}")]
    Message(String),
}

#[async_trait]
pub trait JoinedRoom: Send + Sync {
    async fn set_audio_muted(&self, muted: bool) -> Result<(), PlaneError>;
    async fn unpublish_video(&self) -> Result<(), PlaneError>;
    async fn set_input_source(&self, source: InputSource) -> Result<(), PlaneError>;
    async fn close(&self) -> Result<(), PlaneError>;
    fn take_events(&self) -> Option<UnboundedReceiver<PlaneEvent>>;
}

#[async_trait]
pub trait MediaPlane: Send + Sync {
    async fn join(&self, request: JoinRequest) -> Result<Box<dyn JoinedRoom>, PlaneError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_request_debug_hides_the_token() {
        let request = JoinRequest {
            url: "wss://livekit.example".into(),
            token: "eyJhbGciOiJIUzI1NiJ9.payload.sig".into(),
            identity: "host".into(),
            room: "studio".into(),
        };
        let shown = format!("{request:?}");
        assert!(shown.contains("redacted"));
        assert!(!shown.contains("eyJ"));
        assert!(!shown.contains("payload"));
    }
}
