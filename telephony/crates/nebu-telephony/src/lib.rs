//! Shared LiveKit telephony for Casa Barra (Mariana) and NEBU.
//!
//! One connection engine serves both desks. Each venue has its own URL, API
//! key, and secret. Room JWTs are signed in this process and stay off the
//! control page. A phone or a guest redeems a one-time code from the pair
//! server; that device is the one that joins LiveKit.
//!
//! Casa Barra reads `CASA_BARRA_LIVEKIT_URL`, `CASA_BARRA_LIVEKIT_API_KEY`,
//! and `CASA_BARRA_LIVEKIT_API_SECRET`. NEBU reads `NEBU_LIVEKIT_*`, or the
//! older `LIVEKIT_*` names. The two secrets must differ. Build the desktop
//! shell with `--features rtc` so it opens a real LiveKit room.

mod config;
mod livekit_plane;
mod pair;
mod plane;
mod session;
mod token;
mod venue;

pub use config::LiveKitConfig;
pub use pair::{InviteTicket, PairServer};
pub use plane::{InputSource, MediaKind, PlaneEvent};
pub use session::{
    ConnectionState, PublicStatus, RemoteFeed, SessionError, TelephonyNode, LATENCY_BUDGET,
};
pub use token::{ParticipantRole, TokenError};
pub use venue::{Venue, VenueBook, VenueError};

/// Media path budget from the telephony spec: under 500ms.
pub fn within_latency_budget(latency: std::time::Duration) -> bool {
    latency < LATENCY_BUDGET
}
