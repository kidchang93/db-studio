//! MySQL / MariaDB 드라이버 (sqlx).
//!
//! MySQL 은 "스키마 == 데이터베이스" 이므로 `list_schemas` 는 비우고,
//! 테이블은 연결된(또는 지정된) 데이터베이스 아래에서 조회한다.

use super::sql::{self, Dialect};
use super::value::{self, bind_json};
use super::Driver;
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
                let mut q = sqlx::query(AssertSqlSafe(b.sql));
                for p in &b.params {
                    q = bind_json!(q, p);
                }
                res.deleted += q.execute(&mut *tx).await?.rows_affected();
            }
        }
        for edit in &req.edits {
            if let RowEdit::Update { pk, changes } = edit {
                let b = sql::build_update(&DIALECT, &req.table, pk, changes)?;
                let mut q = sqlx::query(AssertSqlSafe(b.sql));
                for p in &b.params {
                    q = bind_json!(q, p);
                }
                res.updated += q.execute(&mut *tx).await?.rows_affected();
            }
        }
        for edit in &req.edits {
            if let RowEdit::Insert { values } = edit {
                let b = sql::build_insert(&DIALECT, &req.table, values)?;
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

    async fn run_query(&self, sql: &str, max_rows: usize) -> Result<QueryResult> {
        let start = Instant::now();
        let mut stream = sqlx::query(AssertSqlSafe(sql.to_string())).fetch(&self.pool);
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

    async fn run_execute(&self, sql: &str) -> Result<ExecResult> {
        let start = Instant::now();
        let r = sqlx::raw_sql(AssertSqlSafe(sql))
            .execute(&self.pool)
            .await?;
        Ok(ExecResult {
            rows_affected: r.rows_affected(),
            elapsed_ms: start.elapsed().as_millis() as u64,
        })
    }
}
