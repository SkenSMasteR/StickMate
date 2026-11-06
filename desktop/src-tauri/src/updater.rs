use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<Option<String>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = tokio::time::timeout(Duration::from_secs(10), updater.check())
        .await
        .map_err(|_| "update check timed out".to_string())?
        .map_err(|e| e.to_string())?;
    Ok(update.map(|u| u.version))
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
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