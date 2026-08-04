//! SQL 에디터 실행 command.

use crate::error::Result;
use crate::models::*;
use crate::state::AppState;

const DEFAULT_MAX_ROWS: usize = 1000;

/// SQL 콘솔 실행. 문장이 몇 개든 결과셋을 **전부** 담아 돌려준다.
///
/// 조회/실행을 나누지 않는다 — 나누면 다중 문장에서 첫 결과셋만 남고
/// 나머지가 사라져 "일부가 실행되지 않은 것"처럼 보인다.
#[tauri::command]
pub async fn run_script(
    state: tauri::State<'_, AppState>,
    conn_id: String,
    sql: String,
    max_rows: Option<usize>,
    ctx: Option<ExecContext>,
) -> Result<ScriptResult> {
    state
        .get(&conn_id)
        .await?
        .as_driver()
        .run_script(
            &sql,
            max_rows.unwrap_or(DEFAULT_MAX_ROWS),
            &ctx.unwrap_or_default(),
        )
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
