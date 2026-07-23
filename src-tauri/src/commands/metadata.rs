//! 스키마 메타데이터 조회 command (지연 로딩).

use crate::error::Result;
use crate::models::*;
use crate::state::AppState;

#[tauri::command]
pub async fn list_databases(
    state: tauri::State<'_, AppState>,
    conn_id: String,
) -> Result<Vec<DatabaseInfo>> {
    state
        .get(&conn_id)
        .await?
        .as_driver()
        .list_databases()
        .await
}

#[tauri::command]
pub async fn list_schemas(
    state: tauri::State<'_, AppState>,
    conn_id: String,
    database: Option<String>,
) -> Result<Vec<SchemaInfo>> {
    state
        .get(&conn_id)
        .await?
        .as_driver()
        .list_schemas(database.as_deref())
        .await
}

#[tauri::command]
pub async fn list_tables(
    state: tauri::State<'_, AppState>,
    conn_id: String,
    database: Option<String>,
    schema: Option<String>,
) -> Result<Vec<TableInfo>> {
    state
        .get(&conn_id)
        .await?
        .as_driver()
        .list_tables(database.as_deref(), schema.as_deref())
        .await
}

#[tauri::command]
pub async fn list_columns(
    state: tauri::State<'_, AppState>,
    conn_id: String,
    table: TableRef,
) -> Result<Vec<ColumnInfo>> {
    state
        .get(&conn_id)
        .await?
        .as_driver()
        .list_columns(&table)
        .await
}
