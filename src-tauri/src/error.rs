//! 애플리케이션 오류 타입.
//!
//! 모든 command 는 `Result<T>` 를 반환하며, 실패는 `AppError` 로 정규화되어
//! `{ kind, message }` 형태로 프론트엔드에 직렬화되어 전달된다.
//! command 경로에서 `unwrap()/expect()` 대신 이 타입으로 `?` 전파한다.

use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("연결 오류: {0}")]
    Connection(String),

    #[error("쿼리 오류: {0}")]
    Query(String),

    #[error("타입 매핑 오류: {0}")]
    #[allow(dead_code)] // 값 변환 실패 보고용(현재는 Null 폴백, 향후 사용)
    Mapping(String),

    #[error("찾을 수 없음: {0}")]
    NotFound(String),

    #[error("검증 오류: {0}")]
    Validation(String),

    #[error("영속화 오류: {0}")]
    Storage(String),

    #[error("내부 오류: {0}")]
    Internal(String),
}

impl AppError {
    /// 실패한 SQL 을 오류에 덧붙인다. WHERE 필터 바처럼 사용자가 작성한 조건이
    /// 섞인 문장은 실제로 전송된 SQL 을 봐야 원인을 알 수 있으므로 진단용으로 보존한다.
    pub fn with_sql(self, sql: &str) -> Self {
        match self {
            AppError::Query(m) => AppError::Query(format!("{m}\n실행한 SQL: {sql}")),
            other => other,
        }
    }

    /// 프론트엔드에서 분기용으로 쓰는 안정적인 오류 종류 문자열.
    pub fn kind(&self) -> &'static str {
        match self {
            AppError::Connection(_) => "connection",
            AppError::Query(_) => "query",
            AppError::Mapping(_) => "mapping",
            AppError::NotFound(_) => "notFound",
            AppError::Validation(_) => "validation",
            AppError::Storage(_) => "storage",
            AppError::Internal(_) => "internal",
        }
    }
}

/// 프론트엔드로는 `{ kind, message }` 구조체로 직렬화한다.
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut st = serializer.serialize_struct("AppError", 2)?;
        st.serialize_field("kind", self.kind())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Internal(format!("JSON 처리 실패: {e}"))
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Storage(format!("파일 입출력 실패: {e}"))
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        match e {
            sqlx::Error::PoolTimedOut | sqlx::Error::PoolClosed => {
                AppError::Connection(e.to_string())
            }
            sqlx::Error::Configuration(_) => AppError::Connection(e.to_string()),
            sqlx::Error::RowNotFound => AppError::NotFound(e.to_string()),
            other => AppError::Query(other.to_string()),
        }
    }
}

impl From<tiberius::error::Error> for AppError {
    fn from(e: tiberius::error::Error) -> Self {
        AppError::Query(e.to_string())
    }
}

impl From<keyring::Error> for AppError {
    fn from(e: keyring::Error) -> Self {
        match e {
            keyring::Error::NoEntry => AppError::NotFound("키체인 항목 없음".into()),
            other => AppError::Storage(format!("키체인 오류: {other}")),
        }
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
