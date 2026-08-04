//! PostgreSQL 드라이버 (sqlx).

use super::sql::{self, Dialect};
use super::value::{self, bind_json};
use super::{group_columns, Driver};
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
        // `pg_stat_activity.application_name` 에서 우리 앱 세션을 구분할 수 있게 한다.
        opts = opts.application_name(
            config
                .params
                .get("application_name")
                .map(String::as_str)
                .unwrap_or("DB Studio"),
        );
        // 풀 크기와 유휴 회수 정책.
        //
        // 커넥션 하나가 서버 세션 하나다. 그리드 조회와 콘솔 실행이 겹쳐도 3이면 충분하고,
        // 그 이상은 서버 세션만 차지한다. 유휴 커넥션은 짧게 끊어 반납한다 — 앱을 켜 둔
        // 채 손을 놓는 시간이 길어서, 그동안 자리를 붙들고 있을 이유가 없다.
        let pool = PgPoolOptions::new()
            .max_connections(3)
            .min_connections(0)
            .idle_timeout(std::time::Duration::from_secs(180))
            .max_lifetime(std::time::Duration::from_secs(1800))
            .connect_with(opts)
            .await?;
        Ok(Self { pool })
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }

    /// 실행 컨텍스트를 **주어진 커넥션에** 적용한다.
    ///
    /// PostgreSQL 은 DB 가 연결 단위라 세션에서 바꿀 수 없다 — 다른 DB 를 고르려면
    /// 연결을 새로 열어야 하므로 여기서는 무시하고, 스키마만 `search_path` 로 맞춘다.
    async fn apply_ctx(
        &self,
        conn: &mut sqlx::pool::PoolConnection<sqlx::Postgres>,
        ctx: &ExecContext,
    ) -> Result<()> {
        if let Some(s) = ctx.sch() {
            let stmt = format!("SET search_path TO {}", DIALECT.quote_ident(s));
            sqlx::query(AssertSqlSafe(stmt))
                .execute(&mut **conn)
                .await?;
        }
        Ok(())
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

    /// `pg_constraint` 로 양방향 FK 를 한 번에 읽는다.
    ///
    /// `information_schema` 보다 이쪽이 **복합 FK 의 컬럼 순서**를 정확히 준다
    /// (`conkey`/`confkey` 배열의 순서가 곧 대응 순서다).
    async fn relations(&self, table: &TableRef) -> Result<TableRelations> {
        let schema = schema_or_default(table);
        let rows = sqlx::query(
            "SELECT c.conname AS name, \
                    (src_ns.nspname = $1 AND src.relname = $2) AS is_outgoing, \
                    src_ns.nspname AS src_schema, src.relname AS src_table, \
                    tgt_ns.nspname AS tgt_schema, tgt.relname AS tgt_table, \
                    ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord) \
                          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum \
                          ORDER BY k.ord) AS src_cols, \
                    ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord) \
                          JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum \
                          ORDER BY k.ord) AS tgt_cols \
             FROM pg_constraint c \
             JOIN pg_class src ON src.oid = c.conrelid \
             JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace \
             JOIN pg_class tgt ON tgt.oid = c.confrelid \
             JOIN pg_namespace tgt_ns ON tgt_ns.oid = tgt.relnamespace \
             WHERE c.contype = 'f' \
               AND ((src_ns.nspname = $1 AND src.relname = $2) \
                 OR (tgt_ns.nspname = $1 AND tgt.relname = $2))",
        )
        .bind(&schema)
        .bind(&table.name)
        .fetch_all(&self.pool)
        .await?;

        let mut out = TableRelations::default();
        for r in &rows {
            let outgoing: bool = r.try_get("is_outgoing").unwrap_or(false);
            let src_cols: Vec<String> = r.try_get("src_cols").unwrap_or_default();
            let tgt_cols: Vec<String> = r.try_get("tgt_cols").unwrap_or_default();
            let name: String = r.try_get("name").unwrap_or_default();
            let other = if outgoing {
                TableRef {
                    database: None,
                    schema: r.try_get("tgt_schema").ok(),
                    name: r.try_get("tgt_table").unwrap_or_default(),
                }
            } else {
                TableRef {
                    database: None,
                    schema: r.try_get("src_schema").ok(),
                    name: r.try_get("src_table").unwrap_or_default(),
                }
            };
            // 들어오는 쪽은 방향이 뒤집힌다 — `columns` 는 언제나 **이 테이블**의 컬럼이다.
            let (columns, ref_columns) = if outgoing {
                (src_cols, tgt_cols)
            } else {
                (tgt_cols, src_cols)
            };
            let fk = ForeignKeyRef {
                name,
                columns,
                table: other,
                ref_columns,
            };
            if outgoing {
                out.outgoing.push(fk);
            } else {
                out.incoming.push(fk);
            }
        }
        Ok(out)
    }

    /// 카탈로그 한 번으로 테이블+컬럼을 모두 가져온다(자동완성용).
    /// 스키마를 지정하지 않으면 **사용자 스키마 전체**를 담는다.
    async fn schema_snapshot(
        &self,
        _database: Option<&str>,
        schema: Option<&str>,
    ) -> Result<Vec<TableColumns>> {
        let rows = sqlx::query(
            "SELECT table_schema, table_name, column_name FROM information_schema.columns \
             WHERE ($1::text IS NULL OR table_schema = $1) \
               AND table_schema NOT IN ('pg_catalog','information_schema') \
             ORDER BY table_schema, table_name, ordinal_position",
        )
        .bind(schema.filter(|s| !s.is_empty()))
        .fetch_all(&self.pool)
        .await?;
        Ok(group_columns(
            None,
            rows.iter().map(|r| {
                (
                    r.try_get::<String, _>("table_schema").ok(),
                    r.try_get::<String, _>("table_name").unwrap_or_default(),
                    r.try_get::<String, _>("column_name").unwrap_or_default(),
                )
            }),
        ))
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

    /// 스크립트(여러 문장)를 실행하고 **결과셋을 전부** 모은다.
    ///
    /// `fetch_many` 는 행과 "문장 완료"를 섞어 흘려 준다. 완료 신호가 곧 결과셋 경계라,
    /// 그때까지 모은 행이 있으면 결과셋 하나로 접고 없으면 영향 행 수로 센다.
    async fn run_script(
        &self,
        sql: &str,
        max_rows: usize,
        ctx: &ExecContext,
    ) -> Result<ScriptResult> {
        use futures_util::StreamExt;
        let start = Instant::now();
        let mut conn = self.pool.acquire().await?;
        self.apply_ctx(&mut conn, ctx).await?;

        let mut out = ScriptResult::default();
        let mut cur: Vec<PgRow> = Vec::new();
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
                        if cur.len() >= max_rows {
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
        out.elapsed_ms = start.elapsed().as_millis() as u64;
        Ok(out)
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
