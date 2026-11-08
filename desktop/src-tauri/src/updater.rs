use semver::Version;
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

fn nightly_date(version: &Version) -> Option<u64> {
    version
        .pre
        .as_str()
        .strip_prefix("nightly.")
        .and_then(|rest| rest.parse().ok())
}

fn base(version: &Version) -> (u64, u64, u64) {
    (version.major, version.minor, version.patch)
}

pub fn is_upgrade(channel: &str, current: &Version, remote: &Version) -> bool {
    if channel != "nightly" {
        return remote > current;
    }
    if base(remote) != base(current) {
        return base(remote) > base(current);
    }
    match (nightly_date(current), nightly_date(remote)) {
        (Some(old), Some(new)) => new > old,
        (None, Some(_)) | (Some(_), None) => true,
        (None, None) => false,
    }
}

async fn channel_updater(app: &AppHandle) -> Result<Updater, String> {
    let channel = current_channel(app);
    let url = tauri::Url::parse(endpoint(&channel)?).map_err(|e| e.to_string())?;
    app.updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .version_comparator(move |current, remote| {
            is_upgrade(&channel, &current, &remote.version)
        })
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
    use super::{endpoint, is_upgrade};
    use semver::Version;

    fn version(value: &str) -> Version {
        Version::parse(value).unwrap()
    }

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

    #[test]
    fn stable_channel_keeps_semver_ordering() {
        assert!(is_upgrade("stable", &version("0.1.8"), &version("0.1.9")));
        assert!(!is_upgrade("stable", &version("0.1.8"), &version("0.1.8")));
        assert!(!is_upgrade(
            "stable",
            &version("0.1.8"),
            &version("0.1.8-nightly.20261108")
        ));
    }

    #[test]
    fn nightly_replaces_a_stable_build_of_the_same_base() {
        assert!(is_upgrade(
            "nightly",
            &version("0.1.8"),
            &version("0.1.8-nightly.20261108")
        ));
    }

    #[test]
    fn nightlies_order_by_their_build_date() {
        assert!(is_upgrade(
            "nightly",
            &version("0.1.8-nightly.20261107"),
            &version("0.1.8-nightly.20261108")
        ));
        assert!(!is_upgrade(
            "nightly",
            &version("0.1.8-nightly.20261108"),
            &version("0.1.8-nightly.20261108")
        ));
        assert!(!is_upgrade(
            "nightly",
            &version("0.1.8-nightly.20261108"),
            &version("0.1.8-nightly.20261107")
        ));
    }

    #[test]
    fn a_stable_release_supersedes_its_own_nightly() {
        assert!(is_upgrade(
            "nightly",
            &version("0.1.8-nightly.20261108"),
            &version("0.1.8")
        ));
    }

    #[test]
    fn nightly_channel_still_follows_the_base_version() {
        assert!(!is_upgrade(
            "nightly",
            &version("0.1.9"),
            &version("0.1.8-nightly.20261108")
        ));
        assert!(is_upgrade("nightly", &version("0.1.8"), &version("0.2.0")));
    }
}