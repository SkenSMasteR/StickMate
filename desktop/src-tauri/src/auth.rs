use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::tokens::{refresh_with, TokenCache};
use crate::BASE_URL;

#[derive(Serialize, Deserialize)]
pub struct DeviceStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u64,
    pub expires_in: u64,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().build().map_err(|e| e.to_string())
}

async fn send_json(
    url: String,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let resp = client()?
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("server returned {}", resp.status()));
    }
    resp.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn auth_start() -> Result<DeviceStart, String> {
    let value = send_json(
        format!("{BASE_URL}/auth/device/start"),
        serde_json::json!({}),
    )
    .await?;
    serde_json::from_value(value).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn auth_poll(device_code: String) -> Result<serde_json::Value, String> {
    send_json(
        format!("{BASE_URL}/auth/device/poll"),
        serde_json::json!({ "device_code": device_code }),
    )
    .await
}

#[tauri::command]
pub async fn auth_refresh(
    cache: State<'_, TokenCache>,
    refresh_token: String,
) -> Result<serde_json::Value, String> {
    refresh_with(&cache, &refresh_token).await
}

#[tauri::command]
pub async fn auth_logout(
    cache: State<'_, TokenCache>,
    refresh_token: String,
) -> Result<serde_json::Value, String> {
    let value = send_json(
        format!("{BASE_URL}/auth/logout"),
        serde_json::json!({ "refresh_token": refresh_token }),
    )
    .await?;
    cache.clear().await;
    Ok(value)
}

#[tauri::command]
pub async fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}
