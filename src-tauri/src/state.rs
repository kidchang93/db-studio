//! 앱 전역 상태: 활성 커넥션 레지스트리.

use crate::db::DbConnection;
use crate::error::{AppError, Result};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct AppState {
    conns: Mutex<HashMap<String, Arc<DbConnection>>>,
    counter: AtomicU64,
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

impl AppState {
    pub fn new() -> Self {
        Self {
            conns: Mutex::new(HashMap::new()),
            counter: AtomicU64::new(1),
        }
    }

    /// 커넥션을 등록하고 발급한 `connId` 를 돌려준다.
    pub async fn insert(&self, conn: DbConnection) -> String {
        let id = format!("conn-{}", self.counter.fetch_add(1, Ordering::Relaxed));
        self.conns.lock().await.insert(id.clone(), Arc::new(conn));
        id
    }

    /// `connId` 로 커넥션을 조회한다. 없으면 NotFound.
    pub async fn get(&self, id: &str) -> Result<Arc<DbConnection>> {
        self.conns
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("활성 연결이 없습니다: {id}")))
    }

    /// 커넥션을 제거하고(있으면) 풀을 닫는다.
    pub async fn remove(&self, id: &str) {
        let conn = self.conns.lock().await.remove(id);
        if let Some(conn) = conn {
            conn.close().await;
        }
    }
}
