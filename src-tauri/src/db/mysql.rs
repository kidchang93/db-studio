//! MySQL / MariaDB 드라이버 (sqlx).
//!
//! MySQL 은 "스키마 == 데이터베이스" 이므로 `list_schemas` 는 비우고,
//! 테이블은 연결된(또는 지정된) 데이터베이스 아래에서 조회한다.

use super::cursor::{self, Cursors};
use super::script;
use super::sql::{self, Dialect};
use super::value::{self, bind_json};
use super::{group_columns, Driver};
use crate::error::{AppError, Result};
use crate::models::*;
use async_trait::async_trait;
use futures_util::TryStreamExt;
use sqlx::mysql::{MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlRow, MySqlSslMode};
use sqlx::AssertSqlSafe;
use sqlx::{Column, Connection as _, Row, TypeInfo};
use std::time::Instant;

const DIALECT: Dialect = Dialect::MYSQL;

pub struct MysqlDriver {
    pool: MySqlPool,
    /// 콘솔 결과를 이어 읽는 전용 연결들(docs/DESIGN.md §6-3).
    cursors: Cursors,
}

impl MysqlDriver {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self> {
        let mut opts = MySqlConnectOptions::new();
        if let Some(h) = &config.host {
            opts = opts.host(h);
        }
        if let Some(p) = config.port {
            opts = opts.port(p);
        }
        if let Some(db) = &config.database {
            opts = opts.database(db);
        }
        if let Some(u) = &config.username {
            opts = opts.username(u);
        }
        if let Some(pw) = &config.password {
            opts = opts.password(pw);
        }
        if let Some(ssl) = &config.ssl {
            opts = opts.ssl_mode(match ssl.mode {
                SslMode::Disable => MySqlSslMode::Disabled,
                SslMode::Prefer => MySqlSslMode::Preferred,
                SslMode::Require => MySqlSslMode::Required,
                SslMode::VerifyCa => MySqlSslMode::VerifyCa,
                SslMode::VerifyFull => MySqlSslMode::VerifyIdentity,
            });
            if let Some(ca) = &ssl.ca_cert {
                opts = opts.ssl_ca(ca);
            }
            if let Some(cert) = &ssl.client_cert {
                opts = opts.ssl_client_cert(cert);
            }
            if let Some(key) = &ssl.client_key {
                opts = opts.ssl_client_key(key);
            }
        }
        // 풀 크기와 유휴 회수 정책.
        //
        // 커넥션 하나가 서버 세션 하나다. 그리드 조회와 콘솔 실행이 겹쳐도 3이면 충분하고,
        // 그 이상은 서버 세션만 차지한다. 유휴 커넥션은 짧게 끊어 반납한다 — 앱을 켜 둔
        // 채 손을 놓는 시간이 길어서, 그동안 자리를 붙들고 있을 이유가 없다.
        let pool = MySqlPoolOptions::new()
            .max_connections(3)
            .min_connections(0)
            .idle_timeout(std::time::Duration::from_secs(180))
            .max_lifetime(std::time::Duration::from_secs(1800))
            .connect_with(opts)
            .await?;
        Ok(Self {
            pool,
            cursors: Cursors::default(),
        })
    }

    pub async fn close(&self) {
        self.cursors.close_all();
        self.pool.close().await;
    }

    /// SELECT 한 문장을 **전용 연결에서 스트리밍으로** 열고 첫 페이지를 읽는다(docs/DESIGN.md §6-3).
    ///
    /// MySQL 에는 일반 쿼리에 쓸 서버 커서가 없다. 결과를 n행씩 읽다 멈춰 두면 서버는 보내다
    /// 기다린다. 문장은 준비된 문장으로 보내 여러 문장이 섞여 있으면 거절된다(일반 실행으로 돌아간다).
    async fn open_cursor(
        &self,
        sql: &str,
        page: usize,
        ctx: &ExecContext,
    ) -> Result<(QueryResult, Option<i64>)> {
        let mut pooled = self.pool.acquire().await?;
        self.apply_ctx(&mut pooled, ctx).await?;
        let mut conn = pooled.detach();
        let sql = sql.to_string();
        let (tx, mut rx) = cursor::channel();
        tokio::spawn(async move {
            let mut finished = false;
            {
                let mut stream = sqlx::query(AssertSqlSafe(sql)).fetch(&mut conn);
                while let Some(req) = rx.recv().await {
                    let n = req.size();
                    let page = cursor::take_rows(&mut stream, n)
                        .await
                        .map(|rows| cursor::page(&rows, n, rows_to_result));
                    finished = matches!(&page, Ok(p) if p.done);
                    if !req.answer(page) {
                        break;
                    }
                }
            }
            // 끝까지 읽었으면 정상 종료한다. 도중에 닫으면 정상 종료가 남은 행을 끝까지 받아
            // 버린 뒤에야 끝나므로, 연결을 끊어 서버 쪽 전송을 멈춘다.
            if finished {
                let _ = conn.close().await;
            } else {
                drop(conn);
            }
        });
        self.cursors.first_page(tx, page).await
    }

    /// 실행 컨텍스트를 **주어진 커넥션에** 적용한다.
    /// MySQL 은 database 와 schema 가 같은 개념이라 어느 쪽이 와도 `USE` 로 처리한다.
    async fn apply_ctx(
        &self,
        conn: &mut sqlx::pool::PoolConnection<sqlx::MySql>,
        ctx: &ExecContext,
    ) -> Result<()> {
        if let Some(db) = ctx.db().or_else(|| ctx.sch()) {
            let stmt = format!("USE {}", DIALECT.quote_ident(db));
            sqlx::query(AssertSqlSafe(stmt))
                .execute(&mut **conn)
                .await?;
        }
        Ok(())
    }

    async fn current_database(&self) -> Result<String> {
        let db: Option<String> = sqlx::query_scalar("SELECT DATABASE()")
            .fetch_one(&self.pool)
            .await?;
        db.ok_or_else(|| AppError::Validation("선택된 데이터베이스가 없습니다".into()))
    }

    async fn resolve_schema(&self, table: &TableRef) -> Result<String> {
        // database(다중 DB 탐색) 우선, 없으면 schema, 그것도 없으면 현재 DB.
        match table.database.as_ref().or(table.schema.as_ref()) {
            Some(s) if !s.is_empty() => Ok(s.clone()),
            _ => self.current_database().await,
        }
    }
}

fn rows_to_result(rows: &[MySqlRow], elapsed_ms: u64, truncated: bool) -> QueryResult {
    let columns = match rows.first() {
        Some(first) => first
            .columns()
            .iter()
            .map(|c| {
                let db_type = c.type_info().name().to_string();
                ColumnMeta {
                    name: c.name().to_string(),
                    logical_type: value::mysql_logical(&db_type),
                    db_type,
                }
            })
            .collect(),
        None => Vec::new(),
    };
    let data = rows
        .iter()
        .map(|r| {
            (0..r.columns().len())
                .map(|i| value::mysql_cell(r, i))
                .collect()
        })
        .collect();
    QueryResult {
        columns,
        rows: data,
        truncated,
        elapsed_ms,
    }
}

#[async_trait]
impl Driver for MysqlDriver {
    fn kind(&self) -> DbKind {
        DbKind::Mysql
    }

    async fn server_version(&self) -> Result<Option<String>> {
        let v: String = sqlx::query_scalar("SELECT VERSION()")
            .fetch_one(&self.pool)
            .await?;
        Ok(Some(format!("MySQL {v}")))
    }

    async fn test(&self) -> Result<()> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        let rows = sqlx::query(
            "SELECT schema_name FROM information_schema.schemata \
             WHERE schema_name NOT IN ('information_schema','mysql','performance_schema','sys') \
             ORDER BY schema_name",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| DatabaseInfo {
                name: r.try_get("schema_name").unwrap_or_default(),
            })
            .collect())
    }

    async fn list_schemas(&self, _database: Option<&str>) -> Result<Vec<SchemaInfo>> {
        // MySQL: 데이터베이스가 곧 스키마이므로 별도 스키마 계층 없음.
        Ok(vec![])
    }

    async fn list_tables(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
    ) -> Result<Vec<TableInfo>> {
        // MySQL 은 데이터베이스가 곧 스키마.
        let schema = match database.or(schema) {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => self.current_database().await?,
        };
        let rows = sqlx::query(
            "SELECT table_name, table_type FROM information_schema.tables \
             WHERE table_schema = ? ORDER BY table_name",
        )
        .bind(&schema)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                let ty: String = r.try_get("table_type").unwrap_or_default();
                TableInfo {
                    name: r.try_get("table_name").unwrap_or_default(),
                    schema: Some(schema.clone()),
                    kind: if ty.contains("VIEW") {
                        TableKind::View
                    } else {
                        TableKind::Table
                    },
                }
            })
            .collect())
    }

    async fn list_columns(&self, table: &TableRef) -> Result<Vec<ColumnInfo>> {
        let schema = self.resolve_schema(table).await?;
        let rows = sqlx::query(
            "SELECT column_name, data_type, column_type, is_nullable, \
                    column_default, ordinal_position, column_key \
             FROM information_schema.columns \
             WHERE table_schema = ? AND table_name = ? \
             ORDER BY ordinal_position",
        )
        .bind(&schema)
        .bind(&table.name)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                let data_type: String = r.try_get("data_type").unwrap_or_default();
                let column_type: String = r.try_get("column_type").unwrap_or_default();
                let is_nullable: String = r.try_get("is_nullable").unwrap_or_default();
                let column_key: String = r.try_get("column_key").unwrap_or_default();
                let ordinal: i64 = r.try_get("ordinal_position").unwrap_or(0);
                ColumnInfo {
                    name: r.try_get("column_name").unwrap_or_default(),
                    logical_type: value::mysql_logical(&data_type),
                    db_type: column_type,
                    nullable: is_nullable == "YES",
                    is_primary_key: column_key == "PRI",
                    default: r
                        .try_get::<Option<String>, _>("column_default")
                        .unwrap_or(None),
                    ordinal: ordinal as i32,
                }
            })
            .collect())
    }

    /// MySQL 은 `key_column_usage` 의 `referenced_*` 컬럼으로 FK 를 표현한다.
    /// 복합 FK 는 `ordinal_position` 순으로 이어 붙여야 컬럼 대응이 맞는다.
    async fn relations(&self, table: &TableRef) -> Result<TableRelations> {
        let schema = self.resolve_schema(table).await?;
        let rows = sqlx::query(
            "SELECT constraint_name, table_schema, table_name, column_name, \
                    referenced_table_schema, referenced_table_name, referenced_column_name, \
                    (table_schema = ? AND table_name = ?) AS is_outgoing \
             FROM information_schema.key_column_usage \
             WHERE referenced_table_name IS NOT NULL \
               AND ((table_schema = ? AND table_name = ?) \
                 OR (referenced_table_schema = ? AND referenced_table_name = ?)) \
             ORDER BY constraint_name, ordinal_position",
        )
        .bind(&schema)
        .bind(&table.name)
        .bind(&schema)
        .bind(&table.name)
        .bind(&schema)
        .bind(&table.name)
        .fetch_all(&self.pool)
        .await?;

        // (제약 이름, 방향)으로 묶어야 자기참조 테이블에서 양방향이 섞이지 않는다.
        let mut acc: std::collections::BTreeMap<(String, bool), ForeignKeyRef> = Default::default();
        for r in &rows {
            let name: String = r.try_get("constraint_name").unwrap_or_default();
            let outgoing: i64 = r.try_get("is_outgoing").unwrap_or(0);
            let outgoing = outgoing != 0;
            let col: String = r.try_get("column_name").unwrap_or_default();
            let ref_col: String = r.try_get("referenced_column_name").unwrap_or_default();
            let other = if outgoing {
                TableRef {
                    database: r.try_get("referenced_table_schema").ok(),
                    schema: None,
                    name: r.try_get("referenced_table_name").unwrap_or_default(),
                }
            } else {
                TableRef {
                    database: r.try_get("table_schema").ok(),
                    schema: None,
                    name: r.try_get("table_name").unwrap_or_default(),
                }
            };
            let e = acc
                .entry((name.clone(), outgoing))
                .or_insert_with(|| ForeignKeyRef {
                    name,
                    columns: Vec::new(),
                    table: other,
                    ref_columns: Vec::new(),
                });
            // 들어오는 쪽은 방향이 뒤집힌다 — `columns` 는 언제나 **이 테이블**의 컬럼이다.
            if outgoing {
                e.columns.push(col);
                e.ref_columns.push(ref_col);
            } else {
                e.columns.push(ref_col);
                e.ref_columns.push(col);
            }
        }

        let mut out = TableRelations::default();
        for ((_, outgoing), fk) in acc {
            if outgoing {
                out.outgoing.push(fk);
            } else {
                out.incoming.push(fk);
            }
        }
        Ok(out)
    }

    /// 카탈로그 한 번으로 테이블+컬럼을 모두 가져온다(자동완성용).
    /// MySQL 은 데이터베이스가 곧 스키마다.
    async fn schema_snapshot(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
    ) -> Result<Vec<TableColumns>> {
        let db = match database.or(schema).filter(|s| !s.is_empty()) {
            Some(s) => s.to_string(),
            None => self.current_database().await?,
        };
        let rows = sqlx::query(
            "SELECT table_name, column_name FROM information_schema.columns \
             WHERE table_schema = ? ORDER BY table_name, ordinal_position",
        )
        .bind(&db)
        .fetch_all(&self.pool)
        .await?;
        Ok(group_columns(
            Some(&db),
            rows.iter().map(|r| {
                (
                    None,
                    r.try_get::<String, _>("table_name").unwrap_or_default(),
                    r.try_get::<String, _>("column_name").unwrap_or_default(),
                )
            }),
        ))
    }

    async fn primary_keys(&self, table: &TableRef) -> Result<Vec<String>> {
        let schema = self.resolve_schema(table).await?;
        let rows = sqlx::query(
            "SELECT column_name FROM information_schema.key_column_usage \
             WHERE table_schema = ? AND table_name = ? AND constraint_name = 'PRIMARY' \
             ORDER BY ordinal_position",
        )
        .bind(&schema)
        .bind(&table.name)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| r.try_get("column_name").unwrap_or_default())
            .collect())
    }

    async fn fetch_page(&self, req: &FetchPageRequest) -> Result<TablePage> {
        let built = sql::build_fetch(&DIALECT, req);
        let mut q = sqlx::query(AssertSqlSafe(built.sql));
        for p in &built.params {
            q = bind_json!(q, p);
        }
        let start = Instant::now();
        let rows = q.fetch_all(&self.pool).await?;
        let result = rows_to_result(&rows, start.elapsed().as_millis() as u64, false);

        let primary_keys = self.primary_keys(&req.table).await.unwrap_or_default();

        let cbuilt = sql::build_count(&DIALECT, req);
        let mut cq = sqlx::query_scalar::<_, i64>(AssertSqlSafe(cbuilt.sql));
        for p in &cbuilt.params {
            cq = bind_json!(cq, p);
        }
        let total_rows = cq.fetch_one(&self.pool).await.ok().map(|c: i64| c as u64);

        Ok(TablePage {
            result,
            primary_keys,
            total_rows,
        })
    }

    async fn apply_changes(&self, req: &ApplyChangesRequest) -> Result<ApplyChangesResult> {
        let mut tx = self.pool.begin().await?;
        let mut res = ApplyChangesResult::default();
        for edit in &req.edits {
            if let RowEdit::Delete { pk } = edit {
                let b = sql::build_delete(&DIALECT, &req.table, pk)?;
                res.statements.push(b.sql.clone());
                let mut q = sqlx::query(AssertSqlSafe(b.sql));
                for p in &b.params {
                    q = bind_json!(q, p);
                }
                let n = q.execute(&mut *tx).await?.rows_affected();
                // 기본 키가 없으면 값 조합으로 행을 찾으므로 여러 행이 걸릴 수 있다.
                // 그때는 `?` 로 빠져나가며 tx 가 drop 되어 통째로 롤백된다.
                sql::ensure_single_row("삭제", n)?;
                res.deleted += n;
            }
        }
        for edit in &req.edits {
            if let RowEdit::Update { pk, changes } = edit {
                let b = sql::build_update(&DIALECT, &req.table, pk, changes)?;
                res.statements.push(b.sql.clone());
                let mut q = sqlx::query(AssertSqlSafe(b.sql));
                for p in &b.params {
                    q = bind_json!(q, p);
                }
                let n = q.execute(&mut *tx).await?.rows_affected();
                // 기본 키가 없으면 값 조합으로 행을 찾으므로 여러 행이 걸릴 수 있다.
                // 그때는 `?` 로 빠져나가며 tx 가 drop 되어 통째로 롤백된다.
                sql::ensure_single_row("수정", n)?;
                res.updated += n;
            }
        }
        for edit in &req.edits {
            if let RowEdit::Insert { values } = edit {
                let b = sql::build_insert(&DIALECT, &req.table, values)?;
                res.statements.push(b.sql.clone());
                let mut q = sqlx::query(AssertSqlSafe(b.sql));
                for p in &b.params {
                    q = bind_json!(q, p);
                }
                res.inserted += q.execute(&mut *tx).await?.rows_affected();
            }
        }
        tx.commit().await?;
        Ok(res)
    }

    async fn run_query(
        &self,
        sql: &str,
        max_rows: usize,
        ctx: &ExecContext,
    ) -> Result<QueryResult> {
        let start = Instant::now();
        // 컨텍스트와 쿼리는 **같은 커넥션**이어야 한다. 풀에서 각자 꺼내면 따로 논다.
        let mut conn = self.pool.acquire().await?;
        self.apply_ctx(&mut conn, ctx).await?;
        let mut stream = sqlx::query(AssertSqlSafe(sql.to_string())).fetch(&mut *conn);
        let mut rows: Vec<MySqlRow> = Vec::new();
        let mut truncated = false;
        while let Some(row) = stream.try_next().await? {
            if rows.len() >= max_rows {
                truncated = true;
                break;
            }
            rows.push(row);
        }
        Ok(rows_to_result(
            &rows,
            start.elapsed().as_millis() as u64,
            truncated,
        ))
    }

    /// MySQL 은 원문 DDL 을 그대로 준다.
    async fn table_ddl(&self, table: &TableRef) -> Result<TableDdl> {
        let sql = format!("SHOW CREATE TABLE {}", DIALECT.qualify(table));
        let row = sqlx::query(AssertSqlSafe(sql))
            .fetch_one(&self.pool)
            .await?;
        // 컬럼명이 테이블/뷰에 따라 다르므로(Create Table / Create View) 위치로 읽는다.
        let ddl: String = row.try_get(1).unwrap_or_default();
        Ok(TableDdl {
            sql: format!("{ddl};"),
            exact: true,
        })
    }

    /// 스크립트(여러 문장)를 실행하고 **결과셋을 전부** 모은다.
    ///
    /// `fetch_many` 는 행과 "문장 완료"를 섞어 흘려 준다. 완료 신호가 곧 결과셋 경계라,
    /// 그때까지 모은 행이 있으면 결과셋 하나로 접고 없으면 영향 행 수로 센다.
    async fn run_script(
        &self,
        sql: &str,
        opts: &ScriptOptions,
        ctx: &ExecContext,
    ) -> Result<ScriptResult> {
        use futures_util::StreamExt;
        let start = Instant::now();
        // MySQL 에는 변경 행을 돌려주는 절이 없다. 옵션이 켜져 있어도 원문 그대로 보낸다.
        let rewritten = opts
            .capture_changes
            .then(|| script::with_change_output(sql, script::ChangeOutput::Unsupported))
            .flatten();
        let sql = rewritten.as_ref().map(|r| r.sql.as_str()).unwrap_or(sql);
        // SELECT 로만 이뤄졌으면 결과마다 전용 연결로 열어 첫 페이지만 받는다 — 나머지는 페이지를
        // 넘길 때 이어 읽는다(docs/DESIGN.md §6-3). 열 수 없으면 아래에서 한 번에 실행한다.
        if !opts.capture_changes {
            let opened = cursor::open_all(&self.cursors, sql, |stmt| {
                Box::pin(self.open_cursor(stmt, opts.max_rows, ctx))
            })
            .await;
            if let Some(res) = opened {
                return Ok(res);
            }
        }
        let mut conn = self.pool.acquire().await?;
        self.apply_ctx(&mut conn, ctx).await?;

        let mut out = ScriptResult::default();
        let mut cur: Vec<MySqlRow> = Vec::new();
        let mut truncated = false;
        {
            let mut stream = sqlx::raw_sql(AssertSqlSafe(sql)).fetch_many(&mut *conn);
            while let Some(item) = stream.next().await {
                match item? {
                    sqlx::Either::Left(done) => {
                        if cur.is_empty() {
                            out.rows_affected += done.rows_affected();
                        } else {
                            out.results.push(rows_to_result(&cur, 0, truncated));
                            cur.clear();
                            truncated = false;
                        }
                    }
                    sqlx::Either::Right(row) => {
                        if cur.len() >= opts.max_rows {
                            truncated = true;
                        } else {
                            cur.push(row);
                        }
                    }
                }
            }
        }
        // 완료 신호 없이 끝나는 드라이버를 대비해 남은 행도 접는다.
        if !cur.is_empty() {
            out.results.push(rows_to_result(&cur, 0, truncated));
        }
        if rewritten.is_some() {
            out.sql.push(sql.to_string());
        }
        out.elapsed_ms = start.elapsed().as_millis() as u64;
        Ok(out)
    }

    fn dialect(&self) -> Dialect {
        DIALECT
    }

    async fn fetch_cursor(&self, cursor: i64, max_rows: usize) -> Result<CursorPage> {
        self.cursors.fetch(cursor, max_rows).await
    }

    async fn close_cursor(&self, cursor: i64) -> Result<()> {
        self.cursors.close(cursor);
        Ok(())
    }

    async fn run_execute(&self, sql: &str, ctx: &ExecContext) -> Result<ExecResult> {
        let start = Instant::now();
        let mut conn = self.pool.acquire().await?;
        self.apply_ctx(&mut conn, ctx).await?;
        let r = sqlx::raw_sql(AssertSqlSafe(sql))
            .execute(&mut *conn)
            .await?;
        Ok(ExecResult {
            rows_affected: r.rows_affected(),
            elapsed_ms: start.elapsed().as_millis() as u64,
        })
    }
}

/// 실제 서버가 필요한 테스트. `#[ignore]` 로 두고 로컬 컨테이너로 돌린다:
/// `docker run -d --name dbstudio-mysql -e MYSQL_ROOT_PASSWORD='DbStudio!Test123' -e MYSQL_DATABASE=dbstudio -p 13306:3306 mysql:8.0`
/// → `cargo test --lib mysql -- --ignored`
#[cfg(test)]
mod tests {
    use super::*;

    fn opts(max_rows: usize) -> ScriptOptions {
        ScriptOptions {
            max_rows,
            capture_changes: false,
        }
    }

    fn test_config() -> ConnectionConfig {
        ConnectionConfig {
            kind: DbKind::Mysql,
            host: Some("localhost".into()),
            port: Some(
                std::env::var("MYSQL_PORT")
                    .ok()
                    .and_then(|p| p.parse().ok())
                    .unwrap_or(13306),
            ),
            database: Some("dbstudio".into()),
            username: Some("root".into()),
            password: Some("DbStudio!Test123".into()),
            // MySQL 8 기본 인증(caching_sha2_password)은 TLS 없이 접속하려면 sqlx 의 RSA 기능이
            // 필요한데 켜져 있지 않다. 테스트는 TLS 로 접속한다.
            ssl: Some(SslConfig {
                mode: SslMode::Require,
                ca_cert: None,
                client_cert: None,
                client_key: None,
            }),
            ssh: None,
            params: Default::default(),
        }
    }

    /// 콘솔 결과 페이징: 전용 연결로 이어 읽는다(docs/DESIGN.md §6-3).
    #[tokio::test]
    #[ignore]
    async fn select_pages_through_dedicated_connection() {
        let d = MysqlDriver::connect(&test_config()).await.expect("연결");
        let ctx = ExecContext::default();
        d.run_script(
            "DROP TABLE IF EXISTS page_t; \
             CREATE TABLE page_t (id INT PRIMARY KEY, v VARCHAR(10)); \
             INSERT INTO page_t VALUES (1,'a'),(2,'b'),(3,'c'),(4,'d'),(5,'e'),(6,'f'),(7,'g')",
            &opts(10),
            &ctx,
        )
        .await
        .expect("준비");
        let ids = |r: &QueryResult| -> Vec<i64> {
            r.rows
                .iter()
                .map(|row| row[0].as_i64().expect("id"))
                .collect()
        };

        // 첫 페이지만 받고 커서가 열린다. 다음 페이지는 이어 읽는다.
        let r = d
            .run_script("SELECT id, v FROM page_t ORDER BY id", &opts(3), &ctx)
            .await
            .expect("열기");
        let cur = r.cursors[0].expect("커서가 열려야 한다");
        assert_eq!(ids(&r.results[0]), vec![1, 2, 3]);
        assert!(r.results[0].truncated);
        // 커서가 열려 있어도 그리드 조회는 풀에서 따로 돈다.
        d.run_query("SELECT COUNT(*) AS n FROM page_t", 1, &ctx)
            .await
            .expect("다른 조회");
        let p2 = d.fetch_cursor(cur, 3).await.expect("2쪽");
        assert_eq!(ids(&p2.result), vec![4, 5, 6]);
        assert!(!p2.done);
        let p3 = d.fetch_cursor(cur, 3).await.expect("3쪽");
        assert_eq!(ids(&p3.result), vec![7]);
        assert!(p3.done, "모자라게 오면 끝이다");
        assert!(
            d.fetch_cursor(cur, 3).await.is_err(),
            "끝까지 읽은 커서를 다시 읽었다"
        );

        // SELECT 로만 이뤄진 스크립트는 결과마다 커서를 연다.
        let two = d
            .run_script(
                "SELECT id FROM page_t ORDER BY id; SELECT v FROM page_t ORDER BY id",
                &opts(3),
                &ctx,
            )
            .await
            .expect("두 SELECT");
        assert_eq!(two.results.len(), 2);
        let c1 = two.cursors[0].expect("첫 결과의 커서");
        let c2 = two.cursors[1].expect("둘째 결과의 커서");
        assert_eq!(
            ids(&d.fetch_cursor(c1, 3).await.expect("첫 결과 2쪽").result),
            vec![4, 5, 6]
        );
        let v2 = d.fetch_cursor(c2, 3).await.expect("둘째 결과 2쪽");
        assert_eq!(v2.result.rows[0][0], serde_json::json!("d"));
        d.close_cursor(c1).await.expect("닫기");
        d.close_cursor(c2).await.expect("닫기");
        assert!(d.fetch_cursor(c1, 3).await.is_err(), "닫은 커서를 읽었다");

        // 동시에 열 수 있는 결과는 MAX_OPEN 개 — 넘으면 커서 없이 행 제한으로 받는다.
        let mut open = Vec::new();
        for _ in 0..cursor::MAX_OPEN {
            let r = d
                .run_script("SELECT id FROM page_t ORDER BY id", &opts(2), &ctx)
                .await
                .expect("열기");
            open.push(r.cursors[0].expect("커서"));
        }
        let over = d
            .run_script("SELECT id FROM page_t ORDER BY id", &opts(2), &ctx)
            .await
            .expect("자리 없음");
        assert!(
            over.cursors.iter().all(Option::is_none),
            "자리가 없는데 커서를 열었다"
        );
        assert!(over.results[0].truncated);
        for c in open {
            d.close_cursor(c).await.expect("닫기");
        }

        // 다른 문장이 섞이면 한 번에 실행한다.
        let mixed = d
            .run_script(
                "SET @x = 2; SELECT id FROM page_t WHERE id > @x ORDER BY id",
                &opts(3),
                &ctx,
            )
            .await
            .expect("섞인 스크립트");
        assert!(
            mixed.cursors.iter().all(Option::is_none),
            "섞인 스크립트에서 커서를 열었다"
        );

        d.close().await;
    }
}
