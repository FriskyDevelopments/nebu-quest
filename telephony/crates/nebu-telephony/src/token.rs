use std::time::Duration;

use livekit_api::access_token::{AccessToken, TokenVerifier, VideoGrants};

use crate::config::LiveKitConfig;
use crate::venue::{qualify_room, Venue};

pub const STREAMER_TTL: Duration = Duration::from_secs(60 * 60);
pub const EXTERNAL_TTL: Duration = Duration::from_secs(10 * 60);
pub const HEADLESS_TTL: Duration = Duration::from_secs(60 * 60);

/// Who the room JWT is for. The signed token never leaves this crate's
/// private helpers except into the pair broker, which only the camera redeems.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParticipantRole {
    /// Studio operator. Can publish and subscribe. Not a room admin.
    Streamer {
        identity: String,
        name: String,
        room: String,
    },
    /// Phone or remote camera. Publish camera and microphone only.
    ExternalCamera {
        identity: String,
        name: String,
        room: String,
    },
    /// Hidden subscriber. No publish, no data channel.
    HeadlessSubscriber { identity: String, room: String },
    /// Casa Barra desk. Voice and property video with one guest room. Not an admin.
    Concierge {
        identity: String,
        name: String,
        room: String,
    },
    /// Casa Barra guest. Bidirectional camera and microphone in one room only.
    Guest {
        identity: String,
        name: String,
        room: String,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum TokenError {
    #[error("livekit url is invalid")]
    BadUrl,
    #[error("livekit url must not carry credentials")]
    CredentialsInUrl,
    #[error("livekit credentials are missing")]
    MissingCredentials,
    #[error("livekit token was rejected")]
    Rejected,
}

pub(crate) fn issue(config: &LiveKitConfig, role: &ParticipantRole) -> Result<String, TokenError> {
    issue_with(config, role)
}

fn issue_with(config: &LiveKitConfig, role: &ParticipantRole) -> Result<String, TokenError> {
    let (identity, name, room, grants, ttl) = grants_for(role)?;
    let jwt = AccessToken::with_api_key(config.api_key(), config.api_secret())
        .with_ttl(ttl)
        .with_identity(&identity)
        .with_name(&name)
        .with_grants(grants)
        .to_jwt()
        .map_err(|_| TokenError::Rejected)?;
    let claims = TokenVerifier::with_api_key(config.api_key(), config.api_secret())
        .verify(&jwt)
        .map_err(|_| TokenError::Rejected)?;
    if claims.sub != identity || claims.video.room != room || claims.video.room_admin {
        return Err(TokenError::Rejected);
    }
    Ok(jwt)
}

#[cfg(test)]
pub(crate) fn remaining_ttl(config: &LiveKitConfig, jwt: &str) -> Result<Duration, TokenError> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let claims = TokenVerifier::with_api_key(config.api_key(), config.api_secret())
        .verify(jwt)
        .map_err(|_| TokenError::Rejected)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| TokenError::Rejected)?;
    let exp = Duration::from_secs(claims.exp as u64);
    Ok(exp.saturating_sub(now))
}

fn grants_for(
    role: &ParticipantRole,
) -> Result<(String, String, String, VideoGrants, Duration), TokenError> {
    let grants = match role {
        ParticipantRole::Streamer {
            identity,
            name,
            room,
        } => {
            check_id(identity)?;
            bound_room(Venue::Nebu, room)?;
            (
                identity.clone(),
                name.clone(),
                room.clone(),
                VideoGrants {
                    room_join: true,
                    room: room.clone(),
                    room_admin: false,
                    can_publish: Some(true),
                    can_subscribe: Some(true),
                    can_publish_data: Some(true),
                    hidden: false,
                    ..VideoGrants::default()
                },
                STREAMER_TTL,
            )
        }
        ParticipantRole::ExternalCamera {
            identity,
            name,
            room,
        } => {
            check_id(identity)?;
            bound_room(Venue::Nebu, room)?;
            (
                identity.clone(),
                name.clone(),
                room.clone(),
                VideoGrants {
                    room_join: true,
                    room: room.clone(),
                    room_admin: false,
                    can_publish: Some(true),
                    can_subscribe: Some(false),
                    can_publish_data: Some(false),
                    can_publish_sources: vec!["camera".into(), "microphone".into()],
                    hidden: false,
                    ..VideoGrants::default()
                },
                EXTERNAL_TTL,
            )
        }
        ParticipantRole::HeadlessSubscriber { identity, room } => {
            check_id(identity)?;
            bound_room(Venue::Nebu, room)?;
            (
                identity.clone(),
                identity.clone(),
                room.clone(),
                VideoGrants {
                    room_join: true,
                    room: room.clone(),
                    room_admin: false,
                    can_publish: Some(false),
                    can_subscribe: Some(true),
                    can_publish_data: Some(false),
                    hidden: true,
                    ..VideoGrants::default()
                },
                HEADLESS_TTL,
            )
        }
        ParticipantRole::Concierge {
            identity,
            name,
            room,
        } => {
            check_id(identity)?;
            bound_room(Venue::CasaBarra, room)?;
            (
                identity.clone(),
                name.clone(),
                room.clone(),
                VideoGrants {
                    room_join: true,
                    room: room.clone(),
                    room_admin: false,
                    can_publish: Some(true),
                    can_subscribe: Some(true),
                    can_publish_data: Some(false),
                    can_publish_sources: vec!["camera".into(), "microphone".into()],
                    hidden: false,
                    ..VideoGrants::default()
                },
                STREAMER_TTL,
            )
        }
        ParticipantRole::Guest {
            identity,
            name,
            room,
        } => {
            check_id(identity)?;
            bound_room(Venue::CasaBarra, room)?;
            (
                identity.clone(),
                name.clone(),
                room.clone(),
                VideoGrants {
                    room_join: true,
                    room: room.clone(),
                    room_admin: false,
                    can_publish: Some(true),
                    can_subscribe: Some(true),
                    can_publish_data: Some(false),
                    can_publish_sources: vec!["camera".into(), "microphone".into()],
                    hidden: false,
                    ..VideoGrants::default()
                },
                EXTERNAL_TTL,
            )
        }
    };
    Ok(grants)
}

fn bound_room(venue: Venue, room: &str) -> Result<(), TokenError> {
    match qualify_room(venue, room) {
        Ok(qualified) if qualified == room => Ok(()),
        _ => Err(TokenError::Rejected),
    }
}

fn check_id(value: &str) -> Result<(), TokenError> {
    let value = value.trim();
    if value.is_empty() || value.len() > 128 || value.contains([' ', '\n', '\r']) {
        return Err(TokenError::Rejected);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> LiveKitConfig {
        LiveKitConfig::new(
            "wss://livekit.example",
            "APItestkey9f3a",
            "lk-test-secret-9f3a",
        )
        .unwrap()
    }

    fn claims(role: ParticipantRole) -> livekit_api::access_token::Claims {
        let config = config();
        let jwt = issue(&config, &role).unwrap();
        assert!(!jwt.is_empty());
        TokenVerifier::with_api_key(config.api_key(), config.api_secret())
            .verify(&jwt)
            .unwrap()
    }

    #[test]
    fn streamer_is_not_room_admin() {
        let claims = claims(ParticipantRole::Streamer {
            identity: "host".into(),
            name: "Host".into(),
            room: "nebu/studio".into(),
        });
        assert_eq!(claims.sub, "host");
        assert!(claims.video.room_join);
        assert!(!claims.video.room_admin);
        assert_eq!(claims.video.room, "nebu/studio");
        assert_eq!(claims.video.can_publish, Some(true));
        assert_eq!(claims.video.can_subscribe, Some(true));
        assert_eq!(claims.video.can_publish_data, Some(true));
        assert!(!claims.video.hidden);
        assert!(claims.video.can_publish_sources.is_empty());
    }

    #[test]
    fn external_camera_publishes_camera_and_mic_only() {
        let claims = claims(ParticipantRole::ExternalCamera {
            identity: "cam-1".into(),
            name: "iPhone".into(),
            room: "nebu/studio".into(),
        });
        assert!(!claims.video.room_admin);
        assert_eq!(claims.video.can_publish, Some(true));
        assert_eq!(claims.video.can_subscribe, Some(false));
        assert_eq!(claims.video.can_publish_data, Some(false));
        assert!(!claims.video.can_subscribe());
        assert!(!claims.video.can_publish_data());
        assert_eq!(
            claims.video.can_publish_sources,
            vec!["camera".to_string(), "microphone".to_string()]
        );
        assert!(!claims.video.hidden);
    }

    #[test]
    fn headless_subscriber_is_hidden_and_cannot_publish() {
        let claims = claims(ParticipantRole::HeadlessSubscriber {
            identity: "studio-sub".into(),
            room: "nebu/studio".into(),
        });
        assert!(!claims.video.room_admin);
        assert_eq!(claims.video.can_publish, Some(false));
        assert!(!claims.video.can_publish());
        assert_eq!(claims.video.can_subscribe, Some(true));
        assert_eq!(claims.video.can_publish_data, Some(false));
        assert!(claims.video.hidden);
    }

    #[test]
    fn ttl_matches_the_role() {
        let config = config();
        let streamer = issue(
            &config,
            &ParticipantRole::Streamer {
                identity: "host".into(),
                name: "Host".into(),
                room: "nebu/studio".into(),
            },
        )
        .unwrap();
        let external = issue(
            &config,
            &ParticipantRole::ExternalCamera {
                identity: "cam-1".into(),
                name: "iPhone".into(),
                room: "nebu/studio".into(),
            },
        )
        .unwrap();
        let streamer_left = remaining_ttl(&config, &streamer).unwrap();
        let external_left = remaining_ttl(&config, &external).unwrap();
        assert!(streamer_left > Duration::from_secs(59 * 60));
        assert!(streamer_left <= STREAMER_TTL);
        assert!(external_left > Duration::from_secs(9 * 60));
        assert!(external_left <= EXTERNAL_TTL);
    }

    #[test]
    fn wrong_secret_rejects_the_token() {
        let config = config();
        let jwt = issue(
            &config,
            &ParticipantRole::Streamer {
                identity: "host".into(),
                name: "Host".into(),
                room: "nebu/studio".into(),
            },
        )
        .unwrap();
        let err = TokenVerifier::with_api_key(config.api_key(), "other-secret")
            .verify(&jwt)
            .unwrap_err();
        let shown = err.to_string();
        assert!(!shown.contains("lk-test-secret-9f3a"));
        assert!(!shown.contains("other-secret"));
    }

    #[test]
    fn empty_room_is_rejected() {
        let config = config();
        let err = issue(
            &config,
            &ParticipantRole::Streamer {
                identity: "host".into(),
                name: "Host".into(),
                room: " ".into(),
            },
        )
        .unwrap_err();
        assert!(matches!(err, TokenError::Rejected));
    }

    #[test]
    fn a_nebu_role_cannot_enter_a_casa_room() {
        let config = config();
        let err = issue(
            &config,
            &ParticipantRole::Streamer {
                identity: "host".into(),
                name: "Host".into(),
                room: "casa/villa".into(),
            },
        )
        .unwrap_err();
        assert!(matches!(err, TokenError::Rejected));
    }

    #[test]
    fn concierge_and_guest_are_bidirectional_and_not_admins() {
        let concierge = claims(ParticipantRole::Concierge {
            identity: "desk".into(),
            name: "Mariana".into(),
            room: "casa/villa".into(),
        });
        assert!(!concierge.video.room_admin);
        assert_eq!(concierge.video.room, "casa/villa");
        assert_eq!(concierge.video.can_publish, Some(true));
        assert_eq!(concierge.video.can_subscribe, Some(true));
        assert_eq!(concierge.video.can_publish_data, Some(false));
        assert_eq!(
            concierge.video.can_publish_sources,
            vec!["camera".to_string(), "microphone".to_string()]
        );

        let guest = claims(ParticipantRole::Guest {
            identity: "guest-1".into(),
            name: "Ana".into(),
            room: "casa/villa".into(),
        });
        assert!(!guest.video.room_admin);
        assert_eq!(guest.video.can_subscribe, Some(true));
        assert_eq!(guest.video.can_publish_data, Some(false));
        assert!(!guest.video.hidden);
    }

    #[test]
    fn casa_token_does_not_verify_with_the_nebu_secret() {
        let casa = LiveKitConfig::new(
            "wss://casa.example",
            "casa-api-key-9f3a",
            "casa-secret-9f3a-isolated",
        )
        .unwrap();
        let nebu = LiveKitConfig::new(
            "wss://livekit.example",
            "nebu-api-key-9f3a",
            "nebu-secret-9f3a-isolated",
        )
        .unwrap();
        let jwt = issue(
            &casa,
            &ParticipantRole::Guest {
                identity: "guest-1".into(),
                name: "Ana".into(),
                room: "casa/villa".into(),
            },
        )
        .unwrap();
        assert!(
            TokenVerifier::with_api_key(nebu.api_key(), nebu.api_secret())
                .verify(&jwt)
                .is_err()
        );
        assert!(
            TokenVerifier::with_api_key(casa.api_key(), casa.api_secret())
                .verify(&jwt)
                .is_ok()
        );
    }
}
