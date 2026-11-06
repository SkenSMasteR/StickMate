mod auth;
mod prefs;
mod tokens;
mod updater;

use std::time::Duration;
use tauri::Manager;

pub const BASE_URL: &str = "https://stickmate.root.sx";

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(tokens::TokenCache::default())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(1800)).await;
                    let cache = handle.state::<tokens::TokenCache>();
                    if let Ok(Some(refresh_token)) =
                        tokens::token_load("refresh".to_string()).await
                    {
                        let _ = tokens::refresh_with(&cache, &refresh_token).await;
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            auth::auth_start,
            auth::auth_poll,
            auth::auth_refresh,
            auth::auth_logout,
            auth::open_url,
            tokens::token_save,
            tokens::token_load,
            tokens::token_clear,
            prefs::prefs_get,
            prefs::prefs_put,
            updater::check_for_update,
            updater::install_update,
            app_version
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
