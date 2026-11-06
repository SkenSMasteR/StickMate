use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;

use crate::BASE_URL;

const SERVICE: &str = "stickmate";
const KINDS: [&str; 3] = ["access", "refresh", "offline"];

#[derive(Default, Clone)]
pub struct TokenCache {
    inner: Arc<Mutex<Option<String>>>,
}

impl TokenCache {
    pub async fn get(&self) -> Option<String> {
        self.inner.lock().await.clone()
    }

    pub async fn set(&self, value: String) {
        *self.inner.lock().await = Some(value);
    }

    pub async fn clear(&self) {
        *self.inner.lock().await = None;
    }
}

fn check_kind(kind: &str) -> Result<(), String> {
    if KINDS.contains(&kind) {
        Ok(())
    } else {
        Err(format!("unknown token kind: {kind}"))
    }
}

fn entry(kind: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, kind).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn token_save(
    cache: State<'_, TokenCache>,
    kind: String,
    value: String,
) -> Result<(), String> {
    check_kind(&kind)?;
    entry(&kind)?
        .set_password(&value)
        .map_err(|e| e.to_string())?;
    if kind == "access" {
        cache.set(value).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn token_load(kind: String) -> Result<Option<String>, String> {
    check_kind(&kind)?;
    match entry(&kind)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn token_clear(cache: State<'_, TokenCache>) -> Result<(), String> {
    for kind in KINDS {
        match entry(kind)?.delete_credential() {
            Ok(()) => {}
            Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    cache.clear().await;
    Ok(())
}

pub async fn refresh_with(
    cache: &TokenCache,
    refresh_token: &str,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{BASE_URL}/auth/refresh"))
        .json(&serde_json::json!({ "refresh_token": refresh_token }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("refresh failed with {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let access = body
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "no access token in refresh response".to_string())?;
    if let Some(value) = body.get("refresh_token").and_then(|v| v.as_str()) {
        entry("refresh")?
            .set_password(value)
            .map_err(|e| e.to_string())?;
    }
    if let Some(value) = body.get("offline_token").and_then(|v| v.as_str()) {
        entry("offline")?
            .set_password(value)
            .map_err(|e| e.to_string())?;
    }
    entry("access")?
        .set_password(access)
        .map_err(|e| e.to_string())?;
    cache.set(access.to_string()).await;
    Ok(body)
}

pub async fn refresh_access(cache: &TokenCache) -> Result<String, String> {
    let refresh_token = token_load("refresh".to_string())
        .await?
        .ok_or_else(|| "no refresh token stored".to_string())?;
    let body = refresh_with(cache, &refresh_token).await?;
    body.get("access_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "no access token in refresh response".to_string())
}
