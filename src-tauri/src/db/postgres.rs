//! PostgreSQL 드라이버 (sqlx).

use super::sql::{self, Dialect};
use super::value::{self, bind_json};
use super::Driver;
use crate::error::Result;
use crate::models::*;
use async_trait::async_trait;
use futures_util::TryStreamExt;
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgRow, PgSslMode};
use sqlx::AssertSqlSafe;
use sqlx::{Column, Row, TypeInfo};
use std::time::Instant;

const DIALECT: Dialect = Dialect::POSTGRES;

pub struct PostgresDriver {
    pool: PgPool,
}

impl PostgresDriver {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self> {
        let mut opts = PgConnectOptions::new();
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
                SslMode::Disable => PgSslMode::Disable,
                SslMode::Prefer => PgSslMode::Prefer,
                SslMode::Require => PgSslMode::Require,
                SslMode::VerifyCa => PgSslMode::VerifyCa,
                SslMode::VerifyFull => PgSslMode::VerifyFull,
            });
            if let Some(ca) = &ssl.ca_cert {
                opts = opts.ssl_root_cert(ca);
            }
            if let Some(cert) = &ssl.client_cert {
                opts = opts.ssl_client_cert(cert);
            }
            if let Some(key) = &ssl.client_key {
                opts = opts.ssl_client_key(key);
            }
        }
        if let Some(app) = config.params.get("application_name") {
            opts = opts.application_name(app);
        }
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect_with(opts)
            .await?;
        Ok(Self { pool })
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }
}

fn schema_or_default(table: &TableRef) -> String {
    table.schema.clone().unwrap_or_else(|| "public".to_string())
}

fn rows_to_result(rows: &[PgRow], elapsed_ms: u64, truncated: bool) -> QueryResult {
    let columns = match rows.first() {
        Some(first) => first
            .columns()
            .iter()
            .map(|c| {
                let db_type = c.type_info().name().to_string();
                ColumnMeta {
                    name: c.name().to_string(),
                    logical_type: value::pg_logical(&db_type),
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
                .map(|i| value::pg_cell(r, i))
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
impl Driver for PostgresDriver {
    fn kind(&self) -> DbKind {
        DbKind::Postgres
    }

    async fn server_version(&self) -> Result<Option<String>> {
        let v: String = sqlx::query_scalar("SELECT version()")
            .fetch_one(&self.pool)
            .await?;
        Ok(Some(v))
    }

    async fn test(&self) -> Result<()> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        let rows = sqlx::query(
            "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| DatabaseInfo {
                name: r.try_get("datname").unwrap_or_default(),
            })
            .collect())
    }

    async fn list_schemas(&self, _database: Option<&str>) -> Result<Vec<SchemaInfo>> {
        let rows = sqlx::query(
            "SELECT schema_name FROM information_schema.schemata \
             WHERE schema_name NOT IN ('pg_catalog','information_schema') \
             AND schema_name NOT LIKE 'pg_%' ORDER BY schema_name",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| SchemaInfo {
                name: r.try_get("schema_name").unwrap_or_default(),
            })
            .collect())
    }

    async fn list_tables(
        &self,
        _database: Option<&str>,
        schema: Option<&str>,
    ) -> Result<Vec<TableInfo>> {
        // PostgreSQL 은 연결당 1 DB 라 database 는 무시(스키마 기준).
        let schema = schema.unwrap_or("public").to_string();
        let rows = sqlx::query(
            "SELECT table_name, table_type FROM information_schema.tables \
             WHERE table_schema = $1 ORDER BY table_name",
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
        let schema = schema_or_default(table);
        let rows = sqlx::query(
            "SELECT c.column_name, c.data_type, c.udt_name, c.is_nullable, \
                    c.column_default, c.ordinal_position, \
                    (pk.column_name IS NOT NULL) AS is_pk \
             FROM information_schema.columns c \
             LEFT JOIN ( \
                SELECT kcu.column_name \
                FROM information_schema.table_constraints tc \
                JOIN information_schema.key_column_usage kcu \
                  ON tc.constraint_name = kcu.constraint_name \
                 AND tc.table_schema = kcu.table_schema \
                WHERE tc.constraint_type = 'PRIMARY KEY' \
                  AND tc.table_schema = $1 AND tc.table_name = $2 \
             ) pk ON pk.column_name = c.column_name \
             WHERE c.table_schema = $1 AND c.table_name = $2 \
             ORDER BY c.ordinal_position",
        )
        .bind(&schema)
        .bind(&table.name)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                let udt: String = r.try_get("udt_name").unwrap_or_default();
                let data_type: String = r.try_get("data_type").unwrap_or_default();
                let is_nullable: String = r.try_get("is_nullable").unwrap_or_default();
                let ordinal: i32 = r.try_get("ordinal_position").unwrap_or(0);
                ColumnInfo {
                    name: r.try_get("column_name").unwrap_or_default(),
                    logical_type: value::pg_logical(&udt),
                    db_type: data_type,
                    nullable: is_nullable == "YES",
                    is_primary_key: r.try_get("is_pk").unwrap_or(false),
                    default: r
                        .try_get::<Option<String>, _>("column_default")
                        .unwrap_or(None),
                    ordinal,
                }
            })
            .collect())
    }

    async fn primary_keys(&self, table: &TableRef) -> Result<Vec<String>> {
        let schema = schema_or_default(table);
        let rows = sqlx::query(
            "SELECT kcu.column_name \
             FROM information_schema.table_constraints tc \
             JOIN information_schema.key_column_usage kcu \
               ON tc.constraint_name = kcu.constraint_name \
              AND tc.table_schema = kcu.table_schema \
             WHERE tc.constraint_type = 'PRIMARY KEY' \
               AND tc.table_schema = $1 AND tc.table_name = $2 \
             ORDER BY kcu.ordinal_position",
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
        let mut rows: Vec<PgRow> = Vec::new();
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
