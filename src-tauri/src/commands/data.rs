//! 데이터 그리드 조회/편집 command.

use crate::error::Result;
use crate::models::*;
use crate::state::AppState;

#[tauri::command]
pub async fn fetch_table_page(
    state: tauri::State<'_, AppState>,
    req: FetchPageRequest,
) -> Result<TablePage> {
    let conn = state.get(&req.conn_id).await?;
    let driver = conn.as_driver();
    let mut page = driver.fetch_page(&req).await?;

    // 결과가 비어 있으면 행에서 컬럼을 유추할 수 없으므로 스키마 메타로 헤더를 채운다.
    if page.result.columns.is_empty() {
        if let Ok(cols) = driver.list_columns(&req.table).await {
            page.result.columns = cols
                .into_iter()
                .map(|c| ColumnMeta {
                    name: c.name,
                    db_type: c.db_type,
                    logical_type: c.logical_type,
                })
                .collect();
        }
    }
    Ok(page)
}

#[tauri::command]
pub async fn apply_changes(
    state: tauri::State<'_, AppState>,
    req: ApplyChangesRequest,
) -> Result<ApplyChangesResult> {
    state
        .get(&req.conn_id)
        .await?
        .as_driver()
        .apply_changes(&req)
        .await
}
