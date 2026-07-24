//! SQL 에디터 실행 command.

use crate::error::Result;
use crate::models::*;
use crate::state::AppState;

const DEFAULT_MAX_ROWS: usize = 1000;

#[tauri::command]
pub async fn run_query(
    state: tauri::State<'_, AppState>,
    conn_id: String,
    sql: String,
    max_rows: Option<usize>,
) -> Result<QueryResult> {
    state
        .get(&conn_id)
        .await?
        .as_driver()
        .run_query(&sql, max_rows.unwrap_or(DEFAULT_MAX_ROWS))
        .await
}

#[tauri::command]
pub async fn run_execute(
    state: tauri::State<'_, AppState>,
    conn_id: String,
    sql: String,
) -> Result<ExecResult> {
    state
        .get(&conn_id)
        .await?
        .as_driver()
        .run_execute(&sql)
        .await
}

/// 내보내기 결과를 파일로 저장한다.
///
/// 경로는 프론트가 OS 저장 대화상자로 받아 넘긴다(임의 경로 쓰기를 막기 위해
/// 사용자가 직접 고른 경로만 들어온다).
#[tauri::command]
pub async fn write_text_file(path: String, contents: String) -> Result<()> {
    std::fs::write(&path, contents)
        .map_err(|e| crate::error::AppError::Storage(format!("파일 저장 실패: {e}")))
}
