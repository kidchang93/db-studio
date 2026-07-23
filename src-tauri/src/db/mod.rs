//! DB 추상화 계층.
//!
//! 모든 DB 는 [`Driver`] 트레이트로 추상화되고, [`DbConnection`] enum 으로
//! 정적 디스패치된다. 상위 계층(`commands`)은 DB 종류를 구분하지 않는다.

pub mod mssql;
pub mod mysql;
pub mod postgres;
pub mod sql;
pub mod sqlite;
pub mod tunnel;
pub mod value;

use crate::error::{AppError, Result};
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
    async fn list_tables(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
    ) -> Result<Vec<TableInfo>>;
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

/// 드라이버 + (선택적) SSH 터널을 함께 보유하는 관리형 커넥션.
/// 터널은 커넥션 수명 동안 살아 있어야 하므로 여기에 붙잡아 둔다.
pub struct ManagedConnection {
    connection: DbConnection,
    /// Some 이면 SSH 터널을 경유. Drop 시 ssh 프로세스가 종료된다.
    _tunnel: Option<tunnel::SshTunnel>,
}

impl ManagedConnection {
    pub fn as_driver(&self) -> &dyn Driver {
        self.connection.as_driver()
    }

    pub async fn close(&self) {
        self.connection.close().await;
        // _tunnel 은 ManagedConnection 이 drop 될 때 함께 종료된다.
    }
}

fn default_port(kind: DbKind) -> u16 {
    match kind {
        DbKind::Postgres => 5432,
        DbKind::Mysql => 3306,
        DbKind::Mssql => 1433,
        DbKind::Sqlite => 0,
    }
}

/// 드라이버만 생성하는 내부 팩토리.
async fn connect_direct(config: &ConnectionConfig) -> Result<DbConnection> {
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

/// 접속 설정으로부터 커넥션을 생성한다. SSH 터널이 지정되면 먼저 열고,
/// 드라이버는 로컬 포워드 포트(127.0.0.1)로 접속시킨다.
pub async fn connect(config: &ConnectionConfig) -> Result<ManagedConnection> {
    match (&config.ssh, config.kind) {
        (Some(ssh), kind) if kind != DbKind::Sqlite => {
            let host = config.host.clone().ok_or_else(|| {
                AppError::Validation("SSH 터널에는 대상 호스트가 필요합니다".into())
            })?;
            let remote_port = config.port.unwrap_or_else(|| default_port(kind));
            let t = tunnel::SshTunnel::open(ssh, &host, remote_port).await?;

            let mut local = config.clone();
            local.host = Some("127.0.0.1".to_string());
            local.port = Some(t.local_port());
            local.ssh = None;
            // verify-full 은 호스트명 검증 때문에 터널(127.0.0.1)과 충돌 → 호출측에서 조정 권장.
            let connection = connect_direct(&local).await?;
            Ok(ManagedConnection {
                connection,
                _tunnel: Some(t),
            })
        }
        _ => Ok(ManagedConnection {
            connection: connect_direct(config).await?,
            _tunnel: None,
        }),
    }
}
