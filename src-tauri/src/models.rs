//! IPC 경계의 serde 타입 (요청/응답 DTO).
//!
//! 이 파일의 타입은 프론트엔드 `src/types/index.ts` 와 **1:1 로 대응**해야 한다.
//! 필드는 프론트 컨벤션에 맞춰 `camelCase` 로 직렬화된다.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 지원하는 데이터베이스 종류.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DbKind {
    Postgres,
    Mysql,
    Sqlite,
    Mssql,
}

/// 값의 논리 타입. DB 네이티브 타입을 렌더링/편집기 선택용으로 정규화한 집합.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogicalType {
    Null,
    Bool,
    Int,
    Float,
    Decimal,
    String,
    Bytes,
    Date,
    Time,
    Datetime,
    Json,
    Uuid,
    Array,
    Unknown,
}

/// 연결에 필요한 접속 정보 (비밀번호 포함). connect 시점에 사용.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub kind: DbKind,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    /// SQLite 의 경우 파일 경로. 그 외에는 접속할 데이터베이스명.
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    /// 드라이버별 추가 옵션 (sslmode, encrypt, trustCert 등).
    #[serde(default)]
    pub params: std::collections::HashMap<String, String>,
}

/// 영속화되는 연결 프로필. 비밀번호는 포함하지 않는다(키체인에 별도 저장).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub kind: DbKind,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    /// 비밀번호를 OS 키체인에 저장했는지 여부.
    #[serde(default)]
    pub save_password: bool,
    #[serde(default)]
    pub params: std::collections::HashMap<String, String>,
}

impl ConnectionProfile {
    /// 프로필 + (선택적) 비밀번호로 접속 설정을 만든다.
    pub fn to_config(&self, password: Option<String>) -> ConnectionConfig {
        ConnectionConfig {
            kind: self.kind,
            host: self.host.clone(),
            port: self.port,
            database: self.database.clone(),
            username: self.username.clone(),
            password,
            params: self.params.clone(),
        }
    }
}

/// connect 성공 시 반환. 활성 커넥션 핸들 식별자.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionHandle {
    pub conn_id: String,
    pub kind: DbKind,
    /// 접속한 서버가 보고한 버전 문자열(있으면).
    #[serde(default)]
    pub server_version: Option<String>,
}

// ---- 스키마 메타데이터 ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseInfo {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaInfo {
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TableKind {
    Table,
    View,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub name: String,
    #[serde(default)]
    pub schema: Option<String>,
    pub kind: TableKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    /// 원본 DB 타입명 (예: "varchar(255)", "int4").
    pub db_type: String,
    pub logical_type: LogicalType,
    pub nullable: bool,
    pub is_primary_key: bool,
    #[serde(default)]
    pub default: Option<String>,
    pub ordinal: i32,
}

// ---- 쿼리 결과 ----

/// 결과셋 컬럼 메타.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    pub db_type: String,
    pub logical_type: LogicalType,
}

/// SELECT 결과. 셀은 serde_json::Value 로 균일화되어 전달된다.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<Value>>,
    /// 행 수 제한이 적용되어 잘렸는지 여부.
    #[serde(default)]
    pub truncated: bool,
    /// 실행에 걸린 시간(ms).
    #[serde(default)]
    pub elapsed_ms: u64,
}

/// DML/DDL 실행 결과.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub rows_affected: u64,
    #[serde(default)]
    pub elapsed_ms: u64,
}

// ---- 테이블 참조 / 페이지 조회 ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRef {
    #[serde(default)]
    pub schema: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortSpec {
    pub column: String,
    #[serde(default)]
    pub descending: bool,
}

/// 컬럼 단순 필터. op 은 "=", "!=", "<", ">", "<=", ">=", "like", "isnull", "notnull".
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterSpec {
    pub column: String,
    pub op: String,
    #[serde(default)]
    pub value: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchPageRequest {
    pub conn_id: String,
    pub table: TableRef,
    pub limit: u32,
    pub offset: u64,
    #[serde(default)]
    pub sort: Vec<SortSpec>,
    #[serde(default)]
    pub filters: Vec<FilterSpec>,
}

/// 페이지 조회 결과: 데이터 + 편집에 필요한 PK 컬럼 목록.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TablePage {
    pub result: QueryResult,
    /// 편집(UPDATE/DELETE)에 사용할 PK 컬럼명. 비어 있으면 읽기 전용.
    pub primary_keys: Vec<String>,
    /// 전체 행 수(빠르게 알 수 있으면). null 이면 미상.
    #[serde(default)]
    pub total_rows: Option<u64>,
}

// ---- CRUD 편집 ----

/// 그리드에서 발생한 하나의 행 편집.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RowEdit {
    /// 신규 행 삽입.
    Insert {
        values: std::collections::BTreeMap<String, Value>,
    },
    /// PK 로 식별한 행의 일부 컬럼 갱신.
    Update {
        pk: std::collections::BTreeMap<String, Value>,
        changes: std::collections::BTreeMap<String, Value>,
    },
    /// PK 로 식별한 행 삭제.
    Delete {
        pk: std::collections::BTreeMap<String, Value>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyChangesRequest {
    pub conn_id: String,
    pub table: TableRef,
    pub edits: Vec<RowEdit>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApplyChangesResult {
    pub inserted: u64,
    pub updated: u64,
    pub deleted: u64,
}
