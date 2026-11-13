use std::sync::Arc;

use crate::plane::MediaPlane;

/// Real LiveKit rooms are optional so unit tests do not download libwebrtc.
/// The desktop shell builds this crate with `--features rtc`.
pub fn default_plane() -> Option<Arc<dyn MediaPlane>> {
    #[cfg(feature = "rtc")]
    {
        Some(Arc::new(rtc::LiveKitPlane))
    }
    #[cfg(not(feature = "rtc"))]
    {
        None
    }
}

#[cfg(feature = "rtc")]
mod rtc {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    use async_trait::async_trait;
    use livekit::prelude::{
        ConnectionState as LiveConnection, LocalParticipant, RemoteParticipant, Room, RoomEvent,
        RoomOptions, TrackKind, TrackSource,
    };
    use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};

    use crate::plane::{
        InputSource, JoinRequest, JoinedRoom, MediaKind, MediaPlane, PlaneError, PlaneEvent,
    };
    use crate::session::ConnectionState;

    /// Signal-only room. `auto_subscribe` stays off so this process does not
    /// pull RTP into a software decoder. Apple Silicon stays cooler when the
    /// control app is only muting, unpublishing, and watching track events.
    pub struct LiveKitPlane;

    struct LiveSession {
        room: Room,
        want_mute: Arc<AtomicBool>,
        source: Mutex<InputSource>,
        events: Mutex<Option<UnboundedReceiver<PlaneEvent>>>,
    }

    #[async_trait]
    impl MediaPlane for LiveKitPlane {
        async fn join(&self, request: JoinRequest) -> Result<Box<dyn JoinedRoom>, PlaneError> {
            let mut options = RoomOptions::default();
            options.auto_subscribe = false;
            options.adaptive_stream = false;
            let (room, mut lk_events) = Room::connect(&request.url, &request.token, options)
                .await
                .map_err(|err| PlaneError::Message(err.to_string()))?;
            let (tx, rx) = unbounded_channel();
            let want_mute = Arc::new(AtomicBool::new(false));
            let mute_flag = Arc::clone(&want_mute);
            tokio::spawn(async move {
                while let Some(event) = lk_events.recv().await {
                    if let Some(mapped) = map_event(event, &mute_flag) {
                        if tx.send(mapped).is_err() {
                            break;
                        }
                    }
                }
            });
            Ok(Box::new(LiveSession {
                room,
                want_mute,
                source: Mutex::new(InputSource::Program),
                events: Mutex::new(Some(rx)),
            }))
        }
    }

    #[async_trait]
    impl JoinedRoom for LiveSession {
        async fn set_audio_muted(&self, muted: bool) -> Result<(), PlaneError> {
            self.want_mute.store(muted, Ordering::SeqCst);
            let participant = self.room.local_participant();
            for (_, publication) in participant.track_publications() {
                if publication.kind() == TrackKind::Audio {
                    if muted {
                        publication.mute();
                    } else {
                        publication.unmute();
                    }
                }
            }
            Ok(())
        }

        async fn unpublish_video(&self) -> Result<(), PlaneError> {
            let participant = self.room.local_participant();
            let video: Vec<_> = participant
                .track_publications()
                .into_iter()
                .filter(|(_, publication)| publication.kind() == TrackKind::Video)
                .map(|(sid, _)| sid)
                .collect();
            for sid in video {
                participant
                    .unpublish_track(&sid)
                    .await
                    .map_err(|err| PlaneError::Message(err.to_string()))?;
            }
            Ok(())
        }

        async fn set_input_source(&self, source: InputSource) -> Result<(), PlaneError> {
            // Remember the choice. Opening a camera or screen here would encode
            // on the control process, which is the heat we are avoiding.
            *self.source.lock().expect("input source") = source;
            Ok(())
        }

        async fn close(&self) -> Result<(), PlaneError> {
            self.room
                .close()
                .await
                .map_err(|err| PlaneError::Message(err.to_string()))
        }

        fn take_events(&self) -> Option<UnboundedReceiver<PlaneEvent>> {
            self.events.lock().expect("events").take()
        }
    }

    fn map_event(event: RoomEvent, want_mute: &AtomicBool) -> Option<PlaneEvent> {
        match event {
            // The refreshed JWT must not be copied onto the control channel.
            RoomEvent::TokenRefreshed { .. } => None,
            RoomEvent::ConnectionStateChanged(state) => {
                Some(PlaneEvent::State(map_connection(state)))
            }
            RoomEvent::Disconnected { .. } => {
                Some(PlaneEvent::State(ConnectionState::Disconnected))
            }
            RoomEvent::Reconnecting => Some(PlaneEvent::State(ConnectionState::Reconnecting)),
            RoomEvent::Reconnected => Some(PlaneEvent::State(ConnectionState::Connected)),
            RoomEvent::LocalTrackPublished {
                publication,
                participant,
                ..
            } => {
                if publication.kind() == TrackKind::Audio && want_mute.load(Ordering::SeqCst) {
                    publication.mute();
                }
                Some(local_published(&participant, &publication))
            }
            RoomEvent::TrackPublished {
                publication,
                participant,
            } => Some(remote_published(&participant, &publication)),
            RoomEvent::TrackSubscribed {
                publication,
                participant,
                track: _,
            } => Some(PlaneEvent::TrackSubscribed {
                identity: participant.identity().to_string(),
                track_sid: publication.sid().to_string(),
                kind: map_kind(publication.kind()),
                at: Instant::now(),
            }),
            RoomEvent::TrackUnpublished {
                publication,
                participant,
            } => Some(PlaneEvent::TrackUnpublished {
                identity: participant.identity().to_string(),
                track_sid: publication.sid().to_string(),
            }),
            RoomEvent::TrackMuted {
                participant,
                publication,
            } => Some(PlaneEvent::TrackMuted {
                identity: participant.identity().to_string(),
                track_sid: publication.sid().to_string(),
                muted: true,
            }),
            RoomEvent::TrackUnmuted {
                participant,
                publication,
            } => Some(PlaneEvent::TrackMuted {
                identity: participant.identity().to_string(),
                track_sid: publication.sid().to_string(),
                muted: false,
            }),
            _ => None,
        }
    }

    fn local_published(
        participant: &LocalParticipant,
        publication: &livekit::prelude::LocalTrackPublication,
    ) -> PlaneEvent {
        PlaneEvent::TrackPublished {
            local: true,
            identity: participant.identity().to_string(),
            track_sid: publication.sid().to_string(),
            kind: map_kind(publication.kind()),
            source: map_source(publication.source()),
            at: Instant::now(),
        }
    }

    fn remote_published(
        participant: &RemoteParticipant,
        publication: &livekit::prelude::RemoteTrackPublication,
    ) -> PlaneEvent {
        PlaneEvent::TrackPublished {
            local: false,
            identity: participant.identity().to_string(),
            track_sid: publication.sid().to_string(),
            kind: map_kind(publication.kind()),
            source: map_source(publication.source()),
            at: Instant::now(),
        }
    }

    fn map_connection(state: LiveConnection) -> ConnectionState {
        match state {
            LiveConnection::Connected => ConnectionState::Connected,
            LiveConnection::Reconnecting => ConnectionState::Reconnecting,
            LiveConnection::Disconnected => ConnectionState::Disconnected,
        }
    }

    fn map_kind(kind: TrackKind) -> MediaKind {
        match kind {
            TrackKind::Audio => MediaKind::Audio,
            TrackKind::Video => MediaKind::Video,
        }
    }

    fn map_source(source: TrackSource) -> String {
        match source {
            TrackSource::Camera => "camera",
            TrackSource::Microphone => "microphone",
            TrackSource::Screenshare => "screen",
            TrackSource::ScreenshareAudio => "screen-audio",
            TrackSource::Unknown => "unknown",
        }
        .to_owned()
    }
}
