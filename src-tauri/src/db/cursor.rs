//! 전용 연결로 콘솔 결과를 **이어 읽는** 커서 — PostgreSQL · MySQL · SQLite (docs/DESIGN.md §6-3).
//!
//! SQL Server 는 API 서버 커서가 세션에 남아 연결을 붙잡지 않지만(`mssql.rs`), 이 셋은 결과를
//! 열어 둔 동안 연결 하나를 쥐고 있어야 한다. 그래서 열린 결과마다 작업(task) 하나가 풀에서 떼어 낸
//! 전용 연결을 쥐고 "다음 n행" 요청에 답한다. 떼어 내는 이유는 그리드 조회용 풀(최대 3개)의 자리를
//! 차지하지 않기 위해서다. 커서를 닫으면(송신자가 사라지면) 작업이 끝나며 연결도 정리된다.
//!
//! DB 마다 읽는 방식은 드라이버가 정한다 — PostgreSQL 은 서버 커서(`DECLARE` → `FETCH n`),
//! MySQL · SQLite 는 스트림을 n행씩 읽다 멈춰 둔다. 여기서는 그 공통 틀만 둔다.

use super::script;
use crate::error::{AppError, Result};
use crate::models::{CursorPage, QueryResult, ScriptResult};
use futures_util::future::BoxFuture;
use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;
use std::time::Instant;
use tokio::sync::{mpsc, oneshot};

/// 연결(프로필) 하나에 동시에 열어 둘 수 있는 결과 수. 넘으면 행 제한 방식으로 받는다.
///
/// 열린 결과마다 서버 세션이 하나씩 더 붙으므로 끝없이 늘리지 않는다.
pub const MAX_OPEN: usize = 3;

/// "다음 n행" 요청.
pub struct PageRequest {
    n: usize,
    reply: oneshot::Sender<Result<CursorPage>>,
}

impl PageRequest {
    /// 읽을 행 수.
    pub fn size(&self) -> usize {
        self.n
    }

    /// 답하고, 작업을 계속할지 돌려준다 — 끝까지 읽었거나 실패하면 `false`(연결을 정리할 때다).
    ///
    /// 요청 루프를 공통 함수(async 클로저를 받는)로 두지 않은 이유: 연결·스트림을 빌린 async
    /// 클로저는 `tokio::spawn` 이 요구하는 Send 를 모든 수명에 대해 증명하지 못해 컴파일되지 않는다.
    /// 그래서 루프는 드라이버의 작업 안에 두고 여기서는 답만 한다.
    pub fn answer(self, page: Result<CursorPage>) -> bool {
        let keep = matches!(&page, Ok(p) if !p.done);
        let _ = self.reply.send(page);
        keep
    }
}

/// 읽은 행으로 페이지를 만든다. 요청(`n`)보다 적게 왔으면 끝이다.
pub fn page<R>(rows: &[R], n: usize, to_result: fn(&[R], u64, bool) -> QueryResult) -> CursorPage {
    let done = rows.len() < n;
    CursorPage {
        result: to_result(rows, 0, !done),
        done,
    }
}

/// 새 커서 작업의 채널. 작업은 수신자에서 요청을 받아 [`PageRequest::answer`] 로 답한다.
pub fn channel() -> (mpsc::Sender<PageRequest>, mpsc::Receiver<PageRequest>) {
    mpsc::channel(1)
}

/// 드라이버가 쥐는 열린 커서 목록.
#[derive(Default)]
pub struct Cursors {
    next: AtomicI64,
    open: Mutex<HashMap<i64, mpsc::Sender<PageRequest>>>,
}

impl Cursors {
    fn len(&self) -> usize {
        self.open.lock().map(|m| m.len()).unwrap_or(MAX_OPEN)
    }

    /// 첫 페이지를 받는다. 더 남았으면 등록해 id 를, 한 페이지로 끝났으면 `None` 을 돌려준다.
    pub async fn first_page(
        &self,
        tx: mpsc::Sender<PageRequest>,
        n: usize,
    ) -> Result<(QueryResult, Option<i64>)> {
        let page = request(&tx, n).await?;
        if page.done {
            return Ok((page.result, None));
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.open
            .lock()
            .map_err(|_| AppError::Internal("커서 목록을 잠글 수 없습니다".into()))?
            .insert(id, tx);
        Ok((page.result, Some(id)))
    }

    /// 다음 페이지. 끝까지 읽었거나 실패하면 목록에서 뺀다 — 작업은 이미 끝났다.
    pub async fn fetch(&self, id: i64, n: usize) -> Result<CursorPage> {
        let tx = self
            .open
            .lock()
            .map_err(|_| AppError::Internal("커서 목록을 잠글 수 없습니다".into()))?
            .get(&id)
            .cloned()
            .ok_or_else(|| AppError::NotFound("열어 둔 결과가 없습니다. 다시 실행하세요".into()))?;
        let page = request(&tx, n).await;
        if !matches!(&page, Ok(p) if !p.done) {
            self.close(id);
        }
        page
    }

    /// 닫는다. 송신자가 사라지면 작업이 끝나며 연결을 정리한다.
    pub fn close(&self, id: i64) {
        if let Ok(mut m) = self.open.lock() {
            m.remove(&id);
        }
    }

    /// 전부 닫는다(연결 해제 · 앱 종료).
    pub fn close_all(&self) {
        if let Ok(mut m) = self.open.lock() {
            m.clear();
        }
    }
}

async fn request(tx: &mpsc::Sender<PageRequest>, n: usize) -> Result<CursorPage> {
    let closed = || AppError::Connection("열어 둔 결과가 닫혔습니다. 다시 실행하세요".into());
    let (reply, rx) = oneshot::channel();
    tx.send(PageRequest { n, reply })
        .await
        .map_err(|_| closed())?;
    rx.await.map_err(|_| closed())?
}

/// 스트림에서 최대 n행을 읽는다. 스트림이 끝났으면 n 보다 적게 온다.
pub async fn take_rows<S, R>(stream: &mut S, n: usize) -> Result<Vec<R>>
where
    S: futures_util::TryStream<Ok = R, Error = sqlx::Error> + Unpin,
{
    use futures_util::TryStreamExt;
    let mut rows = Vec::with_capacity(n.min(1024));
    while rows.len() < n {
        match stream.try_next().await? {
            Some(r) => rows.push(r),
            None => break,
        }
    }
    Ok(rows)
}

/// SELECT 로만 이뤄진 스크립트를 **문장마다** 커서로 연다(`open` 은 드라이버의 커서 열기).
///
/// 열 수 없으면 `None` — 다른 문장이 섞였거나(`script::split_selects`), 동시에 열 자리가 없거나,
/// 하나라도 열다 실패했을 때다. 실패하면 이미 연 커서를 닫는다. 그러면 호출 쪽이 스크립트를
/// 한 번에 실행한다 — 조회뿐이라 다시 돌려도 결과는 같다.
///
/// `open` 이 async 클로저가 아니라 `BoxFuture` 를 돌려주는 이유: `&str` 을 받는 async 클로저를
/// `async_trait` 메서드(`run_script`) 안에서 쓰면 모든 수명에 대해 Send 를 증명하지 못해 컴파일되지
/// 않는다. 문장은 모두 `sql` 의 조각이라 수명 하나(`'s`)로 묶는다.
pub async fn open_all<'s>(
    cursors: &Cursors,
    sql: &'s str,
    mut open: impl FnMut(&'s str) -> BoxFuture<'s, Result<(QueryResult, Option<i64>)>>,
) -> Option<ScriptResult> {
    let stmts = script::split_selects(sql)?;
    if cursors.len() + stmts.len() > MAX_OPEN {
        return None;
    }
    let start = Instant::now();
    let mut out = ScriptResult::default();
    for stmt in stmts {
        match open(stmt).await {
            Ok((result, cursor)) => {
                out.results.push(result);
                out.cursors.push(cursor);
            }
            Err(_) => {
                for c in out.cursors.iter().flatten() {
                    cursors.close(*c);
                }
                return None;
            }
        }
    }
    out.elapsed_ms = start.elapsed().as_millis() as u64;
    Some(out)
}
