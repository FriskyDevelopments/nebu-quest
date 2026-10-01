#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use nebu_telephony::{InputSource, PublicStatus, TelephonyNode, Venue};

#[tauri::command]
fn telephony_status(node: tauri::State<'_, TelephonyNode>) -> PublicStatus {
    node.status()
}

#[tauri::command]
async fn telephony_connect(
    node: tauri::State<'_, TelephonyNode>,
    room: String,
    identity: String,
) -> Result<PublicStatus, String> {
    node.connect(&room, &identity)
        .await
        .map_err(|err| err.to_string())?;
    Ok(node.status())
}

#[tauri::command]
async fn telephony_set_venue(
    node: tauri::State<'_, TelephonyNode>,
    venue: Venue,
) -> Result<PublicStatus, String> {
    node.set_venue(venue).await.map_err(|err| err.to_string())?;
    Ok(node.status())
}

#[tauri::command]
async fn telephony_set_reservation(
    node: tauri::State<'_, TelephonyNode>,
    reference: String,
) -> Result<PublicStatus, String> {
    node.set_reservation_ref(&reference)
        .await
        .map_err(|err| err.to_string())?;
    Ok(node.status())
}

#[tauri::command]
async fn telephony_disconnect(
    node: tauri::State<'_, TelephonyNode>,
) -> Result<PublicStatus, String> {
    node.disconnect().await.map_err(|err| err.to_string())?;
    Ok(node.status())
}

#[tauri::command]
async fn telephony_mute(
    node: tauri::State<'_, TelephonyNode>,
    muted: bool,
) -> Result<PublicStatus, String> {
    node.set_audio_muted(muted)
        .await
        .map_err(|err| err.to_string())?;
    Ok(node.status())
}

#[tauri::command]
async fn telephony_unpublish_video(
    node: tauri::State<'_, TelephonyNode>,
) -> Result<PublicStatus, String> {
    node.unpublish_video()
        .await
        .map_err(|err| err.to_string())?;
    Ok(node.status())
}

#[tauri::command]
async fn telephony_set_source(
    node: tauri::State<'_, TelephonyNode>,
    source: InputSource,
) -> Result<PublicStatus, String> {
    node.set_input_source(source)
        .await
        .map_err(|err| err.to_string())?;
    Ok(node.status())
}

#[tauri::command]
async fn telephony_invite(
    node: tauri::State<'_, TelephonyNode>,
    room: String,
    label: String,
) -> Result<nebu_telephony::InviteTicket, String> {
    node.invite_external(&room, &label)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn telephony_mute_remote(
    node: tauri::State<'_, TelephonyNode>,
    identity: String,
    track_sid: String,
    muted: bool,
) -> Result<PublicStatus, String> {
    node.mute_remote(&identity, &track_sid, muted)
        .await
        .map_err(|err| err.to_string())?;
    Ok(node.status())
}

fn main() {
    let node = TelephonyNode::from_env();
    tauri::Builder::default()
        .manage(node)
        .setup(|app| {
            let node = app.state::<TelephonyNode>().inner().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = node.start_pair_server().await {
                    eprintln!("pair server: {err}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            telephony_status,
            telephony_connect,
            telephony_disconnect,
            telephony_set_venue,
            telephony_set_reservation,
            telephony_mute,
            telephony_unpublish_video,
            telephony_set_source,
            telephony_invite,
            telephony_mute_remote
        ])
        .run(tauri::generate_context!())
        .expect("NEBU telephony window failed to start");
}
