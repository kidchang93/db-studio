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
