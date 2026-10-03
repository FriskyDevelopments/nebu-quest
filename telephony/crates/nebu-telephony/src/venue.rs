use serde::{Deserialize, Serialize};

use crate::config::LiveKitConfig;

/// Which desk is active. Casa Barra and NEBU never share a LiveKit secret.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Venue {
    CasaBarra,
    Nebu,
}

impl Venue {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CasaBarra => "casa-barra",
            Self::Nebu => "nebu",
        }
    }

    pub fn room_prefix(self) -> &'static str {
        match self {
            Self::CasaBarra => "casa",
            Self::Nebu => "nebu",
        }
    }
}

/// Put a short room name under this venue. A name that already carries the
/// other venue's prefix is rejected so a guest room cannot be opened as a studio.
pub fn qualify_room(venue: Venue, room: &str) -> Result<String, ()> {
    let room = room.trim().trim_matches('/');
    if room.is_empty() || room.len() > 96 {
        return Err(());
    }
    let (prefix, name) = match room.split_once('/') {
        Some((prefix, name)) => (prefix, name),
        None => (venue.room_prefix(), room),
    };
    if prefix != venue.room_prefix()
        || name.is_empty()
        || name.contains('/')
        || name.contains([' ', '\n', '\r'])
    {
        return Err(());
    }
    let qualified = format!("{prefix}/{name}");
    if qualified.len() > 128 {
        return Err(());
    }
    Ok(qualified)
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum VenueError {
    #[error("livekit credentials are not isolated")]
    NotIsolated,
}

/// LiveKit endpoints for both desks. Debug output uses each config's redacted form.
#[derive(Clone, Default)]
pub struct VenueBook {
    casa: Option<LiveKitConfig>,
    nebu: Option<LiveKitConfig>,
}

impl std::fmt::Debug for VenueBook {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VenueBook")
            .field("casa", &self.casa)
            .field("nebu", &self.nebu)
            .finish()
    }
}

impl VenueBook {
    pub fn empty() -> Self {
        Self::default()
    }

    pub fn nebu_only(config: Option<LiveKitConfig>) -> Self {
        Self {
            casa: None,
            nebu: config,
        }
    }

    pub fn new(
        casa: Option<LiveKitConfig>,
        nebu: Option<LiveKitConfig>,
    ) -> Result<Self, VenueError> {
        if let (Some(casa), Some(nebu)) = (&casa, &nebu) {
            if casa.shares_credentials(nebu) {
                return Err(VenueError::NotIsolated);
            }
        }
        Ok(Self { casa, nebu })
    }

    /// Casa Barra reads `CASA_BARRA_LIVEKIT_*`. NEBU reads `NEBU_LIVEKIT_*`,
    /// then the older `LIVEKIT_*` names. Identical keys or secrets are refused.
    pub fn from_env() -> Result<Self, VenueError> {
        let casa = LiveKitConfig::from_prefixed_env("CASA_BARRA").ok();
        let nebu = LiveKitConfig::from_prefixed_env("NEBU")
            .or_else(|_| LiveKitConfig::from_env())
            .ok();
        Self::new(casa, nebu)
    }

    pub fn get(&self, venue: Venue) -> Option<&LiveKitConfig> {
        match venue {
            Venue::CasaBarra => self.casa.as_ref(),
            Venue::Nebu => self.nebu.as_ref(),
        }
    }

    pub fn configured(&self, venue: Venue) -> bool {
        self.get(venue).is_some()
    }

    pub fn redact_all(&self, text: &str) -> String {
        let mut out = text.to_owned();
        for config in self.casa.iter().chain(self.nebu.iter()) {
            out = config.redact(&out);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair() -> (LiveKitConfig, LiveKitConfig) {
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
        (casa, nebu)
    }

    #[test]
    fn rooms_stay_inside_their_venue() {
        assert_eq!(qualify_room(Venue::Nebu, "studio").unwrap(), "nebu/studio");
        assert_eq!(
            qualify_room(Venue::CasaBarra, "villa").unwrap(),
            "casa/villa"
        );
        assert_eq!(
            qualify_room(Venue::Nebu, "nebu/studio").unwrap(),
            "nebu/studio"
        );
        assert!(qualify_room(Venue::Nebu, "casa/villa").is_err());
        assert!(qualify_room(Venue::CasaBarra, "nebu/studio").is_err());
        assert!(qualify_room(Venue::CasaBarra, "villa/west").is_err());
    }

    #[test]
    fn matching_secrets_are_refused() {
        let (casa, nebu) = pair();
        assert!(VenueBook::new(Some(casa.clone()), Some(nebu.clone())).is_ok());
        let shared = LiveKitConfig::new(
            "wss://other.example",
            "other-api-key-9f3a",
            "casa-secret-9f3a-isolated",
        )
        .unwrap();
        assert!(matches!(
            VenueBook::new(Some(casa), Some(shared)),
            Err(VenueError::NotIsolated)
        ));
    }

    #[test]
    fn debug_hides_both_secrets() {
        let (casa, nebu) = pair();
        let book = VenueBook::new(Some(casa), Some(nebu)).unwrap();
        let shown = format!("{book:?}");
        assert!(shown.contains("redacted"));
        assert!(!shown.contains("casa-secret"));
        assert!(!shown.contains("nebu-secret"));
        assert!(!shown.contains("casa-api-key"));
        assert!(!shown.contains("nebu-api-key"));
    }
}
