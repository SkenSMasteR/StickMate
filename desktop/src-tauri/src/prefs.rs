use serde::Serialize;
use tauri::State;

use crate::tokens::{refresh_access, token_load, TokenCache};
use crate::BASE_URL;

#[derive(Serialize)]
pub struct PrefsGet {
    pub revision: u64,
    pub data: serde_json::Value,
}

#[derive(Serialize)]
pub struct PrefsPut {
    pub conflict: bool,
    pub revision: u64,
}

async fn access_token(cache: &TokenCache) -> Result<String, String> {
    if let Some(token) = cache.get().await {
        return Ok(token);
    }
    match token_load("access".to_string()).await? {
        Some(token) => {
            cache.set(token.clone()).await;
            Ok(token)
        }
        None => Err("not signed in".to_string()),
    }
}

#[tauri::command]
pub async fn prefs_get(cache: State<'_, TokenCache>) -> Result<PrefsGet, String> {
    let client = reqwest::Client::new();
    let token = access_token(&cache).await?;
    let mut resp = client
        .get(format!("{BASE_URL}/preferences"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        let token = refresh_access(&cache).await?;
        resp = client
            .get(format!("{BASE_URL}/preferences"))
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|e| e.to_string())?;
    }
    if !resp.status().is_success() {
        return Err(format!("server returned {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let revision = body
        .get("revision")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "missing revision".to_string())?;
    let data = body.get("data").cloned().unwrap_or(serde_json::Value::Null);
    Ok(PrefsGet { revision, data })
}

#[tauri::command]
pub async fn prefs_put(
    cache: State<'_, TokenCache>,
    base_revision: u64,
    data: serde_json::Value,
) -> Result<PrefsPut, String> {
    let client = reqwest::Client::new();
    let payload = serde_json::json!({
        "base_revision": base_revision,
        "data": data
    });
    let token = access_token(&cache).await?;
    let mut resp = client
        .put(format!("{BASE_URL}/preferences"))
        .bearer_auth(&token)
        .json(&payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        let token = refresh_access(&cache).await?;
        resp = client
            .put(format!("{BASE_URL}/preferences"))
            .bearer_auth(&token)
            .json(&payload)
            .send()
            .await
            .map_err(|e| e.to_string())?;
    }
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if status == reqwest::StatusCode::CONFLICT {
        let revision = body
            .get("revision")
            .and_then(|v| v.as_u64())
            .unwrap_or(base_revision);
        return Ok(PrefsPut {
            conflict: true,
            revision,
        });
    }
    if !status.is_success() {
        return Err(format!("server returned {status}"));
    }
    let revision = body
        .get("revision")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "missing revision".to_string())?;
    Ok(PrefsPut {
        conflict: false,
        revision,
    })
}
