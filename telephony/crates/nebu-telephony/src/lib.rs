//! LiveKit telephony for NEBU.
//!
//! The API key, API secret, and room JWTs stay in this process. Tauri commands
//! and the control page only see connection state, mute, and a one-time invite
//! code. An external camera redeems that code from the pair server, which is
//! the device that will publish, not the studio controls.
//!
//! Set `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` in the
//! environment of the Rust process. Build the desktop shell with
//! `--features rtc` so it opens a real LiveKit room.

mod config;
mod livekit_plane;
mod pair;
mod plane;
mod session;
mod token;

pub use config::LiveKitConfig;
pub use pair::{InviteTicket, PairServer};
pub use plane::{InputSource, MediaKind, PlaneEvent};
pub use session::{
    ConnectionState, PublicStatus, RemoteFeed, SessionError, TelephonyNode, LATENCY_BUDGET,
};
pub use token::{ParticipantRole, TokenError};

/// Media path budget from the telephony spec: under 500ms.
pub fn within_latency_budget(latency: std::time::Duration) -> bool {
    latency < LATENCY_BUDGET
}
