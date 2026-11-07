use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Updater, UpdaterExt};

const STABLE_ENDPOINT: &str =
    "https://github.com/SkenSMasteR/StickMate/releases/latest/download/latest.json";
const NIGHTLY_ENDPOINT: &str =
    "https://github.com/SkenSMasteR/StickMate/releases/download/desktop-nightly/latest.json";

fn endpoint(channel: &str) -> Result<&'static str, String> {
    match channel {
        "stable" => Ok(STABLE_ENDPOINT),
        "nightly" => Ok(NIGHTLY_ENDPOINT),
        _ => Err(format!("unknown update channel {channel}")),
    }
}

fn channel_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("update-channel"))
}

fn current_channel(app: &AppHandle) -> String {
    let stored = channel_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|value| value.trim().to_string());
    match stored.as_deref() {
        Some("nightly") => "nightly".to_string(),
        _ => "stable".to_string(),
    }
}

async fn channel_updater(app: &AppHandle) -> Result<Updater, String> {
    let url = tauri::Url::parse(endpoint(&current_channel(app))?).map_err(|e| e.to_string())?;
    app.updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_update_channel(app: AppHandle, channel: String) -> Result<(), String> {
    endpoint(&channel)?;
    let path = channel_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, channel).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<Option<String>, String> {
    let updater = channel_updater(&app).await?;
    let update = tokio::time::timeout(Duration::from_secs(10), updater.check())
        .await
        .map_err(|_| "update check timed out".to_string())?
        .map_err(|e| e.to_string())?;
    Ok(update.map(|u| u.version))
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let updater = channel_updater(&app).await?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no update available".to_string())?;

    let emitter = app.clone();
    let mut downloaded = 0usize;
    let mut percent = 0u64;
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk;
                if let Some(total) = total.filter(|t| *t > 0) {
                    let next = (downloaded as u64 * 100 / total).min(100);
                    if next != percent {
                        percent = next;
                        let _ = emitter.emit("update-progress", next);
                    }
                }
            },
            || {}
        )
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::endpoint;

    #[test]
    fn stable_uses_the_latest_release_feed() {
        assert_eq!(
            endpoint("stable").unwrap(),
            "https://github.com/SkenSMasteR/StickMate/releases/latest/download/latest.json"
        );
    }

    #[test]
    fn nightly_uses_the_rolling_prerelease_feed() {
        assert_eq!(
            endpoint("nightly").unwrap(),
            "https://github.com/SkenSMasteR/StickMate/releases/download/desktop-nightly/latest.json"
        );
    }

    #[test]
    fn an_unknown_channel_is_rejected() {
        assert!(endpoint("beta").is_err());
        assert!(endpoint("").is_err());
    }
}