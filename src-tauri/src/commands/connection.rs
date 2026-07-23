//! 연결/해제/테스트 및 프로필 관리 command.

use crate::db;
use crate::error::{AppError, Result};
use crate::models::*;
use crate::profiles::{self, ProfileStore};
use crate::state::AppState;
use tauri::Manager;

fn store(app: &tauri::AppHandle) -> Result<ProfileStore> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Storage(format!("config 디렉토리 확인 실패: {e}")))?;
    Ok(ProfileStore::new(&dir))
}

async fn open(config: &ConnectionConfig, state: &AppState) -> Result<ConnectionHandle> {
    let conn = db::connect(config).await?;
    let kind = conn.as_driver().kind();
    let server_version = conn.as_driver().server_version().await.ok().flatten();
    let conn_id = state.insert(conn).await;
    Ok(ConnectionHandle {
        conn_id,
        kind,
        server_version,
    })
}

#[tauri::command]
pub async fn connect(
    state: tauri::State<'_, AppState>,
    config: ConnectionConfig,
) -> Result<ConnectionHandle> {
    open(&config, state.inner()).await
}

#[tauri::command]
pub async fn disconnect(state: tauri::State<'_, AppState>, conn_id: String) -> Result<()> {
    state.remove(&conn_id).await;
    Ok(())
}

#[tauri::command]
pub async fn test_connection(config: ConnectionConfig) -> Result<Option<String>> {
    let conn = db::connect(&config).await?;
    conn.as_driver().test().await?;
    let version = conn.as_driver().server_version().await.ok().flatten();
    conn.close().await;
    Ok(version)
}

#[tauri::command]
pub async fn list_profiles(app: tauri::AppHandle) -> Result<Vec<ConnectionProfile>> {
    store(&app)?.load()
}

#[tauri::command]
pub async fn save_profile(
    app: tauri::AppHandle,
    profile: ConnectionProfile,
    password: Option<String>,
) -> Result<()> {
    let s = store(&app)?;
    if profile.save_password {
        if let Some(pw) = &password {
            profiles::set_password(&profile.id, pw)?;
        }
    } else {
        // 비밀번호 저장 해제 시 키체인 항목 정리.
        let _ = profiles::delete_password(&profile.id);
    }
    s.upsert(profile)
}

#[tauri::command]
pub async fn delete_profile(app: tauri::AppHandle, id: String) -> Result<()> {
    store(&app)?.remove(&id)
}

#[tauri::command]
pub async fn connect_profile(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    password: Option<String>,
) -> Result<ConnectionHandle> {
    let s = store(&app)?;
    let profile = s
        .load()?
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| AppError::NotFound(format!("프로필을 찾을 수 없습니다: {id}")))?;
    let pw = match password {
        Some(p) => Some(p),
        None => {
            if profile.save_password {
                profiles::get_password(&id)?
            } else {
                None
            }
        }
    };
    let config = profile.to_config(pw);
    open(&config, state.inner()).await
}
