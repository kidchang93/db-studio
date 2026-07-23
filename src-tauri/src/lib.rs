//! DB Studio 백엔드 엔트리.
//!
//! `tauri::Builder` 를 구성하고 상태/command 를 등록한다.

mod commands;
mod db;
mod error;
mod models;
mod profiles;
mod state;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // 자동 업데이트는 데스크톱에서만 동작.
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            Ok(())
        })
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::connection::connect,
            commands::connection::disconnect,
            commands::connection::test_connection,
            commands::connection::list_profiles,
            commands::connection::save_profile,
            commands::connection::delete_profile,
            commands::connection::connect_profile,
            commands::metadata::list_databases,
            commands::metadata::list_schemas,
            commands::metadata::list_tables,
            commands::metadata::list_columns,
            commands::data::fetch_table_page,
            commands::data::apply_changes,
            commands::query::run_query,
            commands::query::run_execute,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
