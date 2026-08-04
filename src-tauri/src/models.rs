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

/// SSL/TLS 검증 수준. libpq/mysql 규약을 따른다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SslMode {
    Disable,
    Prefer,
    Require,
    VerifyCa,
    VerifyFull,
}

/// DB 연결의 SSL/TLS 옵션.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SslConfig {
    pub mode: SslMode,
    /// CA 인증서 파일 경로(서버 검증용).
    #[serde(default)]
    pub ca_cert: Option<String>,
    /// 클라이언트 인증서 파일 경로(mTLS).
    #[serde(default)]
    pub client_cert: Option<String>,
    /// 클라이언트 개인키 파일 경로(mTLS).
    #[serde(default)]
    pub client_key: Option<String>,
}

/// SSH 터널(bastion 경유) 옵션. OS `ssh` 클라이언트로 로컬 포트포워딩한다(키 기반 인증).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub host: String,
    #[serde(default)]
    pub port: Option<u16>,
    pub user: String,
    /// 개인키 파일 경로. 없으면 ssh-agent/기본 키를 사용한다.
    #[serde(default)]
    pub key_path: Option<String>,
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
    /// SSL/TLS 옵션(없으면 비활성).
    #[serde(default)]
    pub ssl: Option<SslConfig>,
    /// SSH 터널 옵션(없으면 직결).
    #[serde(default)]
    pub ssh: Option<SshConfig>,
    /// 드라이버별 추가 옵션 (application_name, charset 등 자유 key=value).
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
    pub ssl: Option<SslConfig>,
    #[serde(default)]
    pub ssh: Option<SshConfig>,
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
            ssl: self.ssl.clone(),
            ssh: self.ssh.clone(),
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
    /// 다중 DB 지원(SQL Server 3-part, MySQL db.table). None 이면 연결된 DB.
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub schema: Option<String>,
    pub name: String,
}

/// 스크립트(다중 문장) 한 번의 실행 결과.
///
/// 콘솔에 여러 문장을 넣으면 서버는 전부 실행하지만, 결과셋은 문장마다 따로 나온다.
/// **첫 결과셋만 읽고 나머지를 버리면 "일부가 실행되지 않은 것처럼" 보인다** — 실제로는
/// 실행됐는데 화면에 도달하지 못한 것이다. 그래서 결과셋을 전부 담아 올린다.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptResult {
    /// 결과셋들. 행을 돌려주는 문장마다 하나씩, 실행 순서대로.
    pub results: Vec<QueryResult>,
    /// 결과셋을 내지 않은 문장들(DML·DDL)의 영향 행 수 합계.
    #[serde(default)]
    pub rows_affected: u64,
    #[serde(default)]
    pub elapsed_ms: u64,
}

/// 자동완성용 스키마 스냅샷 한 줄 — 테이블 하나와 그 컬럼 이름들.
///
/// `list_columns` 는 테이블당 왕복이 한 번씩이라 자동완성에는 쓸 수 없다(테이블이
/// 백 개면 IPC 가 백 번). 카탈로그를 한 번 훑어 통째로 가져오기 위한 타입이다.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableColumns {
    /// 이 테이블이 속한 DB. 연결 기본 DB 면 None.
    #[serde(default)]
    pub database: Option<String>,
    /// 스키마. 스키마 개념이 없는 DB(SQLite·MySQL)면 None.
    #[serde(default)]
    pub schema: Option<String>,
    pub table: String,
    pub columns: Vec<String>,
}

/// SQL 콘솔이 실행될 컨텍스트(현재 DB·스키마).
///
/// 지정하지 않으면 연결 시 정해진 기본값을 그대로 쓴다. 어떤 항목을 실제로 바꿀 수
/// 있는지는 DB 마다 다르다 — PostgreSQL 은 DB 가 연결 단위라 스키마만 바꿀 수 있다.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecContext {
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub schema: Option<String>,
}

impl ExecContext {
    /// 비어 있지 않은 값만 돌려준다(빈 문자열은 "지정 안 함"과 같게 취급).
    pub fn db(&self) -> Option<&str> {
        self.database.as_deref().filter(|s| !s.trim().is_empty())
    }
    pub fn sch(&self) -> Option<&str> {
        self.schema.as_deref().filter(|s| !s.trim().is_empty())
    }
}

/// 외래키 한 건. 관련 레코드 탐색(F4)에 쓴다.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyRef {
    /// 제약 이름. 같은 두 테이블 사이에 FK 가 여럿일 때 구분해 보여준다.
    pub name: String,
    /// 이 테이블 쪽 컬럼.
    pub columns: Vec<String>,
    /// 상대 테이블.
    pub table: TableRef,
    /// 상대 테이블 쪽 컬럼. `columns` 와 **순서가 대응**한다(복합 FK).
    pub ref_columns: Vec<String>,
}

/// 한 테이블을 기준으로 본 외래키 관계.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRelations {
    /// 이 테이블이 **참조하는** 것(나가는 FK). 부모 레코드로 간다.
    pub outgoing: Vec<ForeignKeyRef>,
    /// 이 테이블을 **참조하는** 것(들어오는 FK). 자식 레코드로 간다.
    pub incoming: Vec<ForeignKeyRef>,
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
    /// 사용자가 직접 입력한 WHERE 조건(DataGrip 스타일 필터 바).
    /// 신뢰 경계는 사용자 자신(SQL 에디터와 동일). 비어 있으면 무시.
    #[serde(default)]
    pub filter_sql: Option<String>,
}

/// 기존 테이블에 기본 키를 지정하는 요청.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetPrimaryKeyRequest {
    pub conn_id: String,
    pub table: TableRef,
    /// 기본 키를 구성할 컬럼(순서 유지).
    pub columns: Vec<String>,
}

/// DDL 실행 계획. 실행 전 미리보기와 사전 검증 결과를 함께 담는다.
///
/// DDL 은 되돌리기 어려우므로 사용자에게 `statements` 를 보여주고 확인받은 뒤 실행한다.
/// 기본 키 지정·컬럼 속성 변경 등 구조 변경 기능이 공통으로 쓴다.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DdlPlan {
    /// 실행될 SQL(순서대로). 미리보기 겸 실제 실행 대상.
    pub statements: Vec<String>,
    /// 실행을 막는 사유. 비어 있어야 적용할 수 있다.
    pub blockers: Vec<String>,
    /// 막지는 않지만 알려야 할 사항(예: NOT NULL 로 바뀌는 컬럼).
    pub warnings: Vec<String>,
}

/// 테이블 DDL 조회 결과.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDdl {
    pub sql: String,
    /// DB 가 준 원문인지(true), 컬럼 메타로 조립한 근사치인지(false).
    /// 근사치는 인덱스·외래키·제약이 빠질 수 있어 UI 에서 그 사실을 알린다.
    pub exact: bool,
}

/// 컬럼 속성 변경 내용. `None` 인 항목은 건드리지 않는다.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnChange {
    /// 새 이름(없으면 유지).
    #[serde(default)]
    pub new_name: Option<String>,
    /// 새 DB 타입(없으면 유지).
    #[serde(default)]
    pub db_type: Option<String>,
    /// NULL 허용 여부(없으면 유지).
    #[serde(default)]
    pub nullable: Option<bool>,
    /// 기본값을 건드릴지. false 면 `default` 는 무시된다.
    /// `Option<Option<T>>` 대신 플래그를 두어 "제거"와 "유지"를 구분한다.
    #[serde(default)]
    pub set_default: bool,
    /// `set_default` 가 true 일 때의 값. null 이면 기본값 제거.
    #[serde(default)]
    pub default: Option<String>,
}

/// 컬럼 속성 변경 요청.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlterColumnRequest {
    pub conn_id: String,
    pub table: TableRef,
    /// 변경 대상 컬럼의 현재 이름.
    pub column: String,
    pub change: ColumnChange,
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
    /// 실제로 실행된 문장. 로그 패널이 "커밋이 무엇을 보냈는지" 보여주는 데 쓴다.
    ///
    /// **값은 파라미터로 바인딩되므로 여기에 담기지 않는다** — 문형만 남는다.
    /// 그래야 로그에 자격증명·개인정보가 새지 않는다(`docs/DESIGN.md` §9).
    #[serde(default)]
    pub statements: Vec<String>,
}
