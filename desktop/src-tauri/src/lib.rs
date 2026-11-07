mod auth;
mod document;
mod entitlement;
mod export;
mod frames;
mod path;
mod prefs;
mod templates;
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
            let recovery = app
                .path()
                .app_data_dir()
                .map_err(|error| error.to_string())?
                .join("recovery");
            app.manage(document::DocStore::load(recovery));
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
            entitlement::entitlement_check,
            entitlement::entitlement_refresh_key,
            prefs::prefs_get,
            prefs::prefs_put,
            updater::check_for_update,
            updater::install_update,
            updater::set_update_channel,
            document::doc_new,
            document::doc_list,
            document::doc_recovery_report,
            document::doc_get,
            document::doc_close,
            document::doc_delete,
            document::doc_rename,
            document::doc_add_scene,
            document::doc_rename_scene,
            document::doc_remove_scene,
            document::doc_duplicate_scene,
            document::doc_move_scene,
            document::doc_add_layer,
            document::doc_set_layer,
            document::doc_remove_layer,
            document::doc_move_layer,
            document::doc_duplicate_layer,
            document::doc_insert_frame,
            document::doc_keyframe,
            document::doc_remove_frame,
            document::doc_set_tween,
            document::doc_set_label,
            document::doc_draw,
            document::doc_erase,
            document::doc_paint_shape,
            document::doc_replace_shape,
            document::doc_delete_shape,
            document::doc_transform_shapes,
            document::doc_reorder_shapes,
            document::doc_delete_shapes,
            document::doc_set_transform,
            document::doc_undo,
            document::doc_redo,
            document::doc_evaluate,
            frames::doc_insert_frames,
            frames::doc_remove_frames,
            frames::doc_copy_frames,
            frames::doc_paste_frames,
            frames::doc_duplicate_frames,
            frames::doc_move_frames,
            templates::templates_catalog,
            templates::templates_preview,
            templates::templates_open,
            export::export_web,
            app_version
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if window.label() == "main" {
                    window.app_handle().exit(0);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
