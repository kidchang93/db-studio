//! MySQL / MariaDB 드라이버 (sqlx).
//!
//! MySQL 은 "스키마 == 데이터베이스" 이므로 `list_schemas` 는 비우고,
//! 테이블은 연결된(또는 지정된) 데이터베이스 아래에서 조회한다.

use super::sql::{self, Dialect};
use super::value::{self, bind_json};
use super::{group_columns, Driver};
use crate::error::{AppError, Result};
use crate::models::*;
use async_trait::async_trait;
use futures_util::TryStreamExt;
use sqlx::mysql::{MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlRow, MySqlSslMode};
use sqlx::AssertSqlSafe;
use sqlx::{Column, Row, TypeInfo};
use std::time::Instant;

const DIALECT: Dialect = Dialect::MYSQL;

pub struct MysqlDriver {
    pool: MySqlPool,
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
        let pool = MySqlPoolOptions::new()
            .max_connections(5)
            .connect_with(opts)
            .await?;
        Ok(Self { pool })
    }

    pub async fn close(&self) {
        self.pool.close().await;
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

    fn dialect(&self) -> Dialect {
        DIALECT
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
