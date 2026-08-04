//! DB 추상화 계층.
//!
//! 모든 DB 는 [`Driver`] 트레이트로 추상화되고, [`DbConnection`] enum 으로
//! 정적 디스패치된다. 상위 계층(`commands`)은 DB 종류를 구분하지 않는다.

pub mod mssql;
pub mod mysql;
pub mod postgres;
pub mod script;
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

    /// 자동완성용 스키마 스냅샷(테이블 + 컬럼 이름).
    ///
    /// 카탈로그를 **한 번의 쿼리로** 훑어야 한다 — 테이블마다 왕복하면 자동완성에
    /// 쓸 수 없을 만큼 느려진다. 카탈로그 모양이 DB 마다 달라 각 드라이버가 채운다.
    async fn schema_snapshot(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
    ) -> Result<Vec<TableColumns>>;

    /// 관련 레코드 탐색(F4)용 외래키 관계.
    ///
    /// 카탈로그 모양이 DB 마다 달라 기본 구현을 두지 않고 각 드라이버가 채운다.
    /// 지원하지 않으면 빈 값을 돌려주면 되고, 그때 UI 는 "관련 레코드 없음"으로 보인다.
    async fn relations(&self, table: &TableRef) -> Result<TableRelations>;

    // ---- 데이터 ----
    async fn fetch_page(&self, req: &FetchPageRequest) -> Result<TablePage>;
    async fn apply_changes(&self, req: &ApplyChangesRequest) -> Result<ApplyChangesResult>;

    /// 임의 SELECT. `max_rows` 를 초과하면 잘라내고 `truncated=true`.
    ///
    /// `ctx` 는 실행할 DB·스키마다. **반드시 쿼리와 같은 커넥션에서 적용해야 한다** —
    /// 풀에서 따로 꺼낸 커넥션에 `USE` 를 걸면 정작 쿼리는 다른 커넥션에서 돈다.
    async fn run_query(&self, sql: &str, max_rows: usize, ctx: &ExecContext)
        -> Result<QueryResult>;

    /// 임의 DML/DDL. 영향 행 수 반환. `ctx` 의 의미는 [`Driver::run_query`] 와 같다.
    async fn run_execute(&self, sql: &str, ctx: &ExecContext) -> Result<ExecResult>;

    /// 스크립트(여러 문장) 실행. **결과셋을 전부** 담아 돌려준다.
    ///
    /// `run_query` 는 첫 결과셋만 읽어, 여러 문장을 넣으면 나머지가 사라진다.
    /// 콘솔은 이 메서드를 쓴다 — 실행은 다 됐는데 결과가 안 보이면 "일부가 실행되지
    /// 않았다"고 오해하게 된다.
    ///
    /// `opts.capture_changes` 가 켜져 있으면 쓰기 문장에 변경 행 반환 절을 끼워 넣는다
    /// (`db/script.rs`). 고쳐 보낸 SQL 은 `ScriptResult::sql` 로 함께 돌려준다.
    async fn run_script(
        &self,
        sql: &str,
        opts: &ScriptOptions,
        ctx: &ExecContext,
    ) -> Result<ScriptResult>;

    /// 이 드라이버의 SQL 방언. 아래 기본 구현들이 DDL 을 만들 때 쓴다.
    fn dialect(&self) -> sql::Dialect;

    /// 기본 키 지정 계획을 세운다(**실행하지 않는다**).
    ///
    /// 방언으로 DDL 을 만들고, 실제 데이터로 NULL·중복을 미리 검사해 차단 사유를 모은다.
    /// DB 가 뱉는 제약 위반 오류보다 먼저, 사람이 읽을 수 있는 형태로 알려주기 위함이다.
    async fn plan_primary_key(&self, table: &TableRef, columns: &[String]) -> Result<DdlPlan> {
        let d = self.dialect();
        let cols = self.list_columns(table).await?;
        let mut plan = DdlPlan {
            statements: sql::build_set_primary_key(&d, table, columns, &cols)?,
            ..Default::default()
        };

        if d.pk_style == sql::PkStyle::Unsupported {
            plan.blockers.push(
                "이 DB 는 기존 테이블에 기본 키를 추가할 수 없습니다(테이블 재생성이 필요합니다)"
                    .into(),
            );
            return Ok(plan);
        }

        if let Some(existing) = cols.iter().find(|c| c.is_primary_key) {
            plan.blockers.push(format!(
                "이미 기본 키가 있습니다(예: '{}'). 먼저 제거해야 합니다",
                existing.name
            ));
            return Ok(plan);
        }

        // NULL 이 있으면 PK 로 쓸 수 없다. 어떤 컬럼인지 짚어 준다.
        for name in columns {
            let n = self
                .scalar_count(&sql::build_null_count(&d, table, name))
                .await?;
            if n > 0 {
                plan.blockers
                    .push(format!("'{name}' 에 NULL 이 {n}건 있습니다"));
            } else if cols.iter().any(|c| &c.name == name && c.nullable) {
                plan.warnings
                    .push(format!("'{name}' 이 NOT NULL 로 바뀝니다"));
            }
        }

        // 값 조합이 유일해야 한다.
        let dups = self
            .scalar_count(&sql::build_duplicate_count(&d, table, columns))
            .await?;
        if dups > 0 {
            plan.blockers.push(format!(
                "선택한 컬럼 조합이 유일하지 않습니다(중복 {dups}건)"
            ));
        }
        Ok(plan)
    }

    /// 계획을 다시 세워 차단 사유가 없을 때만 DDL 을 실행한다.
    ///
    /// 미리보기 시점과 실행 시점 사이에 데이터가 바뀔 수 있으므로 여기서 한 번 더 검증한다.
    async fn apply_primary_key(&self, table: &TableRef, columns: &[String]) -> Result<DdlPlan> {
        let plan = self.plan_primary_key(table, columns).await?;
        if !plan.blockers.is_empty() {
            return Err(AppError::Validation(plan.blockers.join(" / ")));
        }
        for stmt in &plan.statements {
            self.run_execute(stmt, &ExecContext::default())
                .await
                .map_err(|e| e.with_sql(stmt))?;
        }
        Ok(plan)
    }

    /// 테이블의 CREATE 문(DDL).
    ///
    /// 기본 구현은 컬럼 메타로 조립한 **근사치**다. 네이티브 명령으로 정확한 원문을
    /// 얻을 수 있는 DB(MySQL 의 `SHOW CREATE TABLE`, SQLite 의 `sqlite_master`)는
    /// 이 메서드를 재정의한다. 어느 쪽인지는 [`TableDdl::exact`] 로 알린다.
    async fn table_ddl(&self, table: &TableRef) -> Result<TableDdl> {
        let d = self.dialect();
        let cols = self.list_columns(table).await?;
        if cols.is_empty() {
            return Err(AppError::NotFound(format!(
                "테이블 '{}' 의 컬럼을 찾을 수 없습니다",
                table.name
            )));
        }
        let pks: Vec<String> = cols
            .iter()
            .filter(|c| c.is_primary_key)
            .map(|c| c.name.clone())
            .collect();

        let mut lines: Vec<String> = cols
            .iter()
            .map(|c| {
                let mut s = format!("  {} {}", d.quote_ident(&c.name), c.db_type);
                if !c.nullable {
                    s.push_str(" NOT NULL");
                }
                if let Some(v) = &c.default {
                    s.push_str(&format!(" DEFAULT {v}"));
                }
                s
            })
            .collect();

        if !pks.is_empty() {
            lines.push(format!(
                "  PRIMARY KEY ({})",
                pks.iter()
                    .map(|k| d.quote_ident(k))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }

        Ok(TableDdl {
            sql: format!(
                "CREATE TABLE {} (\n{}\n);",
                d.qualify(table),
                lines.join(",\n")
            ),
            exact: false,
        })
    }

    /// 컬럼의 기본값 제약 이름(SQL Server 처럼 기본값이 명명 제약인 DB 용).
    /// 그 외 DB 는 해당 없음이라 None.
    async fn default_constraint_name(
        &self,
        _table: &TableRef,
        _column: &str,
    ) -> Result<Option<String>> {
        Ok(None)
    }

    /// 컬럼 속성 변경 계획을 세운다(**실행하지 않는다**).
    async fn plan_alter_column(
        &self,
        table: &TableRef,
        column: &str,
        change: &ColumnChange,
    ) -> Result<DdlPlan> {
        let d = self.dialect();
        let cols = self.list_columns(table).await?;
        let cur = cols
            .iter()
            .find(|c| c.name == column)
            .ok_or_else(|| AppError::Validation(format!("컬럼 '{column}' 을 찾을 수 없습니다")))?;

        let mut plan = DdlPlan::default();

        // 이름 변경은 마지막에 한다. 앞선 문장들이 아직 옛 이름을 참조하기 때문.
        let rename = change
            .new_name
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty() && *n != column);
        if let Some(to) = rename {
            if cols.iter().any(|c| c.name == to) {
                plan.blockers.push(format!("'{to}' 컬럼이 이미 있습니다"));
            }
        }

        match sql::build_alter_column(
            &d,
            table,
            cur,
            change,
            self.default_constraint_name(table, column)
                .await?
                .as_deref(),
        ) {
            Ok(stmts) => plan.statements = stmts,
            Err(AppError::Validation(msg)) => plan.blockers.push(msg),
            Err(e) => return Err(e),
        }

        if let Some(to) = rename {
            plan.statements
                .push(sql::build_rename_column(&d, table, column, to));
        }

        // NOT NULL 로 바꾸려면 기존 데이터에 NULL 이 없어야 한다.
        if change.nullable == Some(false) && cur.nullable {
            let n = self
                .scalar_count(&sql::build_null_count(&d, table, column))
                .await?;
            if n > 0 {
                plan.blockers.push(format!(
                    "'{column}' 에 NULL 이 {n}건 있어 NOT NULL 로 바꿀 수 없습니다"
                ));
            }
        }

        if cur.is_primary_key && change.nullable == Some(true) {
            plan.blockers
                .push("기본 키 컬럼은 NULL 을 허용할 수 없습니다".into());
        }

        if change.db_type.as_deref().is_some_and(|t| t != cur.db_type) {
            plan.warnings.push(format!(
                "타입을 {} → {} 로 바꿉니다. 변환할 수 없는 값이 있으면 DB 가 거부합니다",
                cur.db_type,
                change.db_type.as_deref().unwrap_or_default()
            ));
        }

        if plan.statements.is_empty() && plan.blockers.is_empty() {
            plan.blockers.push("변경할 내용이 없습니다".into());
        }
        Ok(plan)
    }

    /// 계획을 다시 세워 차단 사유가 없을 때만 컬럼 변경 DDL 을 실행한다.
    async fn apply_alter_column(
        &self,
        table: &TableRef,
        column: &str,
        change: &ColumnChange,
    ) -> Result<DdlPlan> {
        let plan = self.plan_alter_column(table, column, change).await?;
        if !plan.blockers.is_empty() {
            return Err(AppError::Validation(plan.blockers.join(" / ")));
        }
        for stmt in &plan.statements {
            self.run_execute(stmt, &ExecContext::default())
                .await
                .map_err(|e| e.with_sql(stmt))?;
        }
        Ok(plan)
    }

    /// COUNT(*) 한 건을 정수로 읽는다. 큰 정수는 문자열로 내려올 수 있어 양쪽을 받는다.
    async fn scalar_count(&self, sql: &str) -> Result<u64> {
        let r = self.run_query(sql, 1, &ExecContext::default()).await?;
        let v = r
            .rows
            .first()
            .and_then(|row| row.first())
            .ok_or_else(|| AppError::Internal("COUNT 결과가 비어 있습니다".into()))?;
        v.as_u64()
            .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
            .ok_or_else(|| AppError::Internal(format!("COUNT 값을 해석할 수 없습니다: {v}")))
    }
}

/// `(스키마, 테이블, 컬럼)` 행들을 테이블별로 묶는다. 카탈로그 쿼리가 스키마·테이블·
/// 컬럼 순으로 정렬해 주므로 한 번 훑으며 접으면 된다.
pub fn group_columns(
    database: Option<&str>,
    rows: impl Iterator<Item = (Option<String>, String, String)>,
) -> Vec<TableColumns> {
    let mut out: Vec<TableColumns> = Vec::new();
    for (schema, table, column) in rows {
        match out.last_mut() {
            Some(last) if last.table == table && last.schema == schema => last.columns.push(column),
            _ => out.push(TableColumns {
                database: database.map(str::to_string),
                schema,
                table,
                columns: vec![column],
            }),
        }
    }
    out
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
            // tiberius 의 close 는 self 를 소비하는데 여기서는 Mutex 안이라 꺼낼 수 없다.
            // 대신 이 값이 drop 될 때 TcpStream 이 닫히면서 서버가 세션을 정리한다.
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
