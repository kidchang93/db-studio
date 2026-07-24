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

/// macOS 기본 메뉴에서 **"창 닫기"(⌘W)를 뺀** 메뉴를 만든다.
///
/// 기본 메뉴가 ⌘W 를 가로채 창을 통째로 닫아 버려서, 프론트의 "탭 닫기" 로 넘어오지
/// 않았다. 메뉴에서 그 항목만 제거하면 키 이벤트가 WebView 까지 도달한다.
/// 편집 메뉴(복사·붙여넣기 등)는 macOS 에서 이게 없으면 ⌘C/⌘V 가 동작하지 않으므로
/// 반드시 유지한다.
#[cfg(target_os = "macos")]
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, MenuBuilder, SubmenuBuilder};

    let app_menu = SubmenuBuilder::new(app, "DB Studio")
        .about(Some(AboutMetadata::default()))
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "편집")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    // 의도적으로 close_window() 를 넣지 않는다 — ⌘W 는 탭 닫기로 쓴다.
    let window_menu = SubmenuBuilder::new(app, "창")
        .minimize()
        .maximize()
        .separator()
        .fullscreen()
        .build()?;

    MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu, &window_menu])
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // 자동 업데이트는 데스크톱에서만 동작.
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            #[cfg(target_os = "macos")]
            app.set_menu(build_menu(app.handle())?)?;

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
            commands::metadata::plan_primary_key,
            commands::metadata::apply_primary_key,
            commands::metadata::plan_alter_column,
            commands::metadata::apply_alter_column,
            commands::data::fetch_table_page,
            commands::data::apply_changes,
            commands::query::run_query,
            commands::query::run_execute,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
