use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::pkcs8::DecodePublicKey;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::BASE_URL;

#[derive(Default, Serialize)]
pub struct EntitlementStatus {
    pub valid: bool,
    pub account_id: Option<u64>,
    pub expires_at: Option<u64>,
}

pub fn verify_offline(token: &str, public_pem: &str, now: u64) -> EntitlementStatus {
    let key = match VerifyingKey::from_public_key_pem(public_pem) {
        Ok(key) => key,
        Err(_) => return EntitlementStatus::default(),
    };
    let (body_part, sig_part) = match token.split_once('.') {
        Some(parts) => parts,
        None => return EntitlementStatus::default(),
    };
    let body = match URL_SAFE_NO_PAD.decode(body_part) {
        Ok(body) => body,
        Err(_) => return EntitlementStatus::default(),
    };
    let sig_bytes = match URL_SAFE_NO_PAD.decode(sig_part) {
        Ok(bytes) => bytes,
        Err(_) => return EntitlementStatus::default(),
    };
    let signature = match Signature::from_slice(&sig_bytes) {
        Ok(signature) => signature,
        Err(_) => return EntitlementStatus::default(),
    };
    if key.verify(&body, &signature).is_err() {
        return EntitlementStatus::default();
    }
    let payload: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(payload) => payload,
        Err(_) => return EntitlementStatus::default(),
    };
    if payload.get("type").and_then(|v| v.as_str()) != Some("offline") {
        return EntitlementStatus::default();
    }
    let exp = match payload.get("exp").and_then(|v| v.as_u64()) {
        Some(exp) => exp,
        None => return EntitlementStatus::default(),
    };
    if exp <= now {
        return EntitlementStatus::default();
    }
    EntitlementStatus {
        valid: true,
        account_id: payload.get("account_id").and_then(|v| v.as_u64()),
        expires_at: Some(exp),
    }
}

fn key_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("offline-public-key"))
}

pub async fn cache_public_key(app: &AppHandle) -> Result<(), String> {
    let resp = reqwest::Client::new()
        .get(format!("{BASE_URL}/auth/public-key"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("public key request failed with {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let pem = body
        .get("public_key")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "no public key in response".to_string())?;
    VerifyingKey::from_public_key_pem(pem).map_err(|e| e.to_string())?;
    let path = key_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, pem).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn entitlement_refresh_key(app: AppHandle) -> Result<(), String> {
    cache_public_key(&app).await
}

#[tauri::command]
pub async fn entitlement_check(app: AppHandle) -> EntitlementStatus {
    let token = match crate::tokens::token_load("offline".to_string()).await {
        Ok(Some(value)) => value,
        _ => return EntitlementStatus::default(),
    };
    let pem = match key_path(&app)
        .and_then(|path| std::fs::read_to_string(path).map_err(|e| e.to_string()))
    {
        Ok(pem) => pem,
        Err(_) => return EntitlementStatus::default(),
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(u64::MAX);
    verify_offline(&token, &pem, now)
}

#[cfg(test)]
mod tests {
    use super::verify_offline;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use ed25519_dalek::pkcs8::spki::der::pem::LineEnding;
    use ed25519_dalek::pkcs8::EncodePublicKey;
    use ed25519_dalek::{Signer, SigningKey};

    const NOW: u64 = 1_800_000_000;

    fn key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    fn pem(key: &SigningKey) -> String {
        key.verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap()
    }

    fn mint(key: &SigningKey, kind: &str, exp: u64) -> String {
        let body = serde_json::json!({
            "account_id": 7,
            "type": kind,
            "iat": NOW - 60,
            "exp": exp
        })
        .to_string();
        let signature = key.sign(body.as_bytes());
        format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(body.as_bytes()),
            URL_SAFE_NO_PAD.encode(signature.to_bytes())
        )
    }

    #[test]
    fn a_signed_unexpired_offline_token_is_valid() {
        let k = key(1);
        let status = verify_offline(&mint(&k, "offline", NOW + 86400), &pem(&k), NOW);
        assert!(status.valid);
        assert_eq!(status.account_id, Some(7));
        assert_eq!(status.expires_at, Some(NOW + 86400));
    }

    #[test]
    fn an_expired_token_is_rejected() {
        let k = key(2);
        assert!(!verify_offline(&mint(&k, "offline", NOW - 1), &pem(&k), NOW).valid);
        assert!(!verify_offline(&mint(&k, "offline", NOW), &pem(&k), NOW).valid);
    }

    #[test]
    fn an_access_token_is_not_an_offline_entitlement() {
        let k = key(3);
        assert!(!verify_offline(&mint(&k, "access", NOW + 3600), &pem(&k), NOW).valid);
    }

    #[test]
    fn a_tampered_body_is_rejected() {
        let k = key(4);
        let good = mint(&k, "offline", NOW + 86400);
        let (body_part, sig_part) = good.split_once('.').unwrap();
        let mut body = URL_SAFE_NO_PAD.decode(body_part).unwrap();
        let at = body.iter().position(|b| *b == b'7').unwrap();
        body[at] = b'8';
        let tampered = format!("{}.{}", URL_SAFE_NO_PAD.encode(&body), sig_part);
        assert!(!verify_offline(&tampered, &pem(&k), NOW).valid);
    }

    #[test]
    fn a_tampered_signature_is_rejected() {
        let k = key(5);
        let good = mint(&k, "offline", NOW + 86400);
        let (body_part, sig_part) = good.split_once('.').unwrap();
        let mut sig = URL_SAFE_NO_PAD.decode(sig_part).unwrap();
        sig[0] ^= 0xff;
        let tampered = format!("{}.{}", body_part, URL_SAFE_NO_PAD.encode(&sig));
        assert!(!verify_offline(&tampered, &pem(&k), NOW).valid);
    }

    #[test]
    fn a_signature_from_another_key_is_rejected() {
        let k = key(6);
        let other = key(7);
        assert!(!verify_offline(&mint(&other, "offline", NOW + 86400), &pem(&k), NOW).valid);
    }

    #[test]
    fn a_missing_public_key_rejects_the_token() {
        let k = key(8);
        assert!(!verify_offline(&mint(&k, "offline", NOW + 86400), "", NOW).valid);
    }

    #[test]
    fn malformed_base64_is_rejected() {
        let k = key(9);
        let good = mint(&k, "offline", NOW + 86400);
        let (body_part, sig_part) = good.split_once('.').unwrap();
        assert!(!verify_offline(&format!("!!!.{sig_part}"), &pem(&k), NOW).valid);
        assert!(!verify_offline(&format!("{body_part}.!!!"), &pem(&k), NOW).valid);
    }

    #[test]
    fn garbage_is_rejected() {
        let p = pem(&key(10));
        for value in ["", "garbage", "a.b", "....", "eyJ0eXBlIjoib2ZmbGluZSJ9"] {
            assert!(!verify_offline(value, &p, NOW).valid);
        }
    }

    #[test]
    fn the_exact_signed_bytes_are_verified_without_reserialization() {
        let k = key(11);
        let body = format!(
            "{{ \"type\" : \"offline\", \"exp\" : {}, \"account_id\" : 7, \"iat\" : {} }}",
            NOW + 86400,
            NOW - 60
        );
        let signature = k.sign(body.as_bytes());
        let token = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(body.as_bytes()),
            URL_SAFE_NO_PAD.encode(signature.to_bytes())
        );
        assert!(verify_offline(&token, &pem(&k), NOW).valid);
    }
}