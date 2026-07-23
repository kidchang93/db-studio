//! DB 추상화 계층.
//!
//! 모든 DB 는 [`Driver`] 트레이트로 추상화되고, [`DbConnection`] enum 으로
//! 정적 디스패치된다. 상위 계층(`commands`)은 DB 종류를 구분하지 않는다.

pub mod mssql;
pub mod mysql;
pub mod postgres;
pub mod sql;
pub mod sqlite;
pub mod value;

use crate::error::Result;
use crate::models::*;
use async_trait::async_trait;

/// 하나의 DB 연결이 제공하는 능력. 정확한 시그니처는 이 파일이 소스오브트루스.
#[async_trait]
pub trait Driver: Send + Sync {
    fn kind(&self) -> DbKind;

    /// 서버 버전 문자열(있으면).
    async fn server_version(&self) -> Result<Option<String>>;

    /// 연결 검증(ping).
    async fn test(&self) -> Result<()>;

    // ---- 스키마 지연 로딩 ----
    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>>;
    async fn list_schemas(&self, database: Option<&str>) -> Result<Vec<SchemaInfo>>;
    async fn list_tables(&self, schema: Option<&str>) -> Result<Vec<TableInfo>>;
    async fn list_columns(&self, table: &TableRef) -> Result<Vec<ColumnInfo>>;

    /// 편집(UPDATE/DELETE)의 행 식별용 PK 컬럼.
    async fn primary_keys(&self, table: &TableRef) -> Result<Vec<String>>;

    // ---- 데이터 ----
    async fn fetch_page(&self, req: &FetchPageRequest) -> Result<TablePage>;
    async fn apply_changes(&self, req: &ApplyChangesRequest) -> Result<ApplyChangesResult>;

    /// 임의 SELECT. `max_rows` 를 초과하면 잘라내고 `truncated=true`.
    async fn run_query(&self, sql: &str, max_rows: usize) -> Result<QueryResult>;

    /// 임의 DML/DDL. 영향 행 수 반환.
    async fn run_execute(&self, sql: &str) -> Result<ExecResult>;
}

/// 활성 커넥션. 드라이버별 variant 를 보유하고 정적 디스패치한다.
pub enum DbConnection {
    Postgres(postgres::PostgresDriver),
    Mysql(mysql::MysqlDriver),
    Sqlite(sqlite::SqliteDriver),
    // tiberius 클라이언트는 다른 variant(풀 핸들)보다 훨씬 크므로 박싱한다.
    Mssql(Box<mssql::MssqlDriver>),
}

impl DbConnection {
    pub fn as_driver(&self) -> &dyn Driver {
        match self {
            DbConnection::Postgres(d) => d,
            DbConnection::Mysql(d) => d,
            DbConnection::Sqlite(d) => d,
            DbConnection::Mssql(d) => d.as_ref(),
        }
    }

    /// 커넥션 풀을 닫는다(disconnect 시).
    pub async fn close(&self) {
        match self {
            DbConnection::Postgres(d) => d.close().await,
            DbConnection::Mysql(d) => d.close().await,
            DbConnection::Sqlite(d) => d.close().await,
            DbConnection::Mssql(_) => {}
        }
    }
}

/// 접속 설정으로부터 커넥션을 생성한다(팩토리).
pub async fn connect(config: &ConnectionConfig) -> Result<DbConnection> {
    match config.kind {
        DbKind::Postgres => Ok(DbConnection::Postgres(
            postgres::PostgresDriver::connect(config).await?,
        )),
        DbKind::Mysql => Ok(DbConnection::Mysql(
            mysql::MysqlDriver::connect(config).await?,
        )),
        DbKind::Sqlite => Ok(DbConnection::Sqlite(
            sqlite::SqliteDriver::connect(config).await?,
        )),
        DbKind::Mssql => Ok(DbConnection::Mssql(Box::new(
            mssql::MssqlDriver::connect(config).await?,
        ))),
    }
}
