//! SQLite 드라이버 (sqlx). 서버 불필요 — 파일/인메모리.

use super::script;
use super::sql::{self, Dialect};
use super::value::{self, bind_json};
use super::{group_columns, Driver};
use crate::error::{AppError, Result};
use crate::models::*;
use async_trait::async_trait;
use futures_util::TryStreamExt;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions, SqliteRow};
use sqlx::AssertSqlSafe;
use sqlx::{Column, Row, TypeInfo};
use std::time::Instant;

const DIALECT: Dialect = Dialect::SQLITE;

pub struct SqliteDriver {
    pool: SqlitePool,
}

impl SqliteDriver {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self> {
        let path = config
            .database
            .clone()
            .ok_or_else(|| AppError::Validation("SQLite 파일 경로가 필요합니다".into()))?;
        let opts = if path == ":memory:" {
            SqliteConnectOptions::new().in_memory(true)
        } else {
            SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true)
        };
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(opts)
            .await?;
        Ok(Self { pool })
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }

    #[cfg(test)]
    pub fn from_pool(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

fn rows_to_result(rows: &[SqliteRow], elapsed_ms: u64, truncated: bool) -> QueryResult {
    let columns = match rows.first() {
        Some(first) => first
            .columns()
            .iter()
            .map(|c| {
                let db_type = c.type_info().name().to_string();
                ColumnMeta {
                    name: c.name().to_string(),
                    logical_type: value::sqlite_logical(&db_type),
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
                .map(|i| value::sqlite_cell(r, i))
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
impl Driver for SqliteDriver {
    fn kind(&self) -> DbKind {
        DbKind::Sqlite
    }

    async fn server_version(&self) -> Result<Option<String>> {
        let v: String = sqlx::query_scalar("SELECT sqlite_version()")
            .fetch_one(&self.pool)
            .await?;
        Ok(Some(format!("SQLite {v}")))
    }

    async fn test(&self) -> Result<()> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        Ok(vec![DatabaseInfo {
            name: "main".to_string(),
        }])
    }

    async fn list_schemas(&self, _database: Option<&str>) -> Result<Vec<SchemaInfo>> {
        // SQLite 에는 스키마 개념이 없다.
        Ok(vec![])
    }

    async fn list_tables(
        &self,
        _database: Option<&str>,
        _schema: Option<&str>,
    ) -> Result<Vec<TableInfo>> {
        let rows = sqlx::query(
            "SELECT name, type FROM sqlite_master \
             WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                let name: String = r.try_get("name").unwrap_or_default();
                let ty: String = r.try_get("type").unwrap_or_default();
                TableInfo {
                    name,
                    schema: None,
                    kind: if ty == "view" {
                        TableKind::View
                    } else {
                        TableKind::Table
                    },
                }
            })
            .collect())
    }

    async fn list_columns(&self, table: &TableRef) -> Result<Vec<ColumnInfo>> {
        let sql = format!("PRAGMA table_info({})", DIALECT.quote_ident(&table.name));
        let rows = sqlx::query(AssertSqlSafe(sql))
            .fetch_all(&self.pool)
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                let db_type: String = r.try_get("type").unwrap_or_default();
                let notnull: i64 = r.try_get("notnull").unwrap_or(0);
                let pk: i64 = r.try_get("pk").unwrap_or(0);
                let cid: i64 = r.try_get("cid").unwrap_or(0);
                ColumnInfo {
                    name: r.try_get("name").unwrap_or_default(),
                    logical_type: value::sqlite_logical(&db_type),
                    db_type,
                    nullable: notnull == 0,
                    is_primary_key: pk > 0,
                    default: r.try_get::<Option<String>, _>("dflt_value").unwrap_or(None),
                    ordinal: cid as i32,
                }
            })
            .collect())
    }

    /// SQLite 는 스키마 개념이 없어 전체 테이블을 훑는다.
    /// `pragma_table_info` 테이블 값 함수로 한 번에 조인한다.
    async fn schema_snapshot(
        &self,
        _database: Option<&str>,
        _schema: Option<&str>,
    ) -> Result<Vec<TableColumns>> {
        let rows = sqlx::query(
            "SELECT m.name AS table_name, p.name AS column_name \
             FROM sqlite_master m JOIN pragma_table_info(m.name) p \
             WHERE m.type IN ('table','view') AND m.name NOT LIKE 'sqlite_%' \
             ORDER BY m.name, p.cid",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(group_columns(
            None,
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
        let sql = format!("PRAGMA table_info({})", DIALECT.quote_ident(&table.name));
        let rows = sqlx::query(AssertSqlSafe(sql))
            .fetch_all(&self.pool)
            .await?;
        let mut pks: Vec<(i64, String)> = rows
            .into_iter()
            .filter_map(|r| {
                let pk: i64 = r.try_get("pk").unwrap_or(0);
                if pk > 0 {
                    Some((pk, r.try_get::<String, _>("name").unwrap_or_default()))
                } else {
                    None
                }
            })
            .collect();
        pks.sort_by_key(|(seq, _)| *seq);
        Ok(pks.into_iter().map(|(_, name)| name).collect())
    }

    /// SQLite 는 FK 를 테이블별 PRAGMA 로만 알려준다.
    ///
    /// 나가는 FK 는 대상 테이블 하나만 보면 되지만, **들어오는 FK 는 카탈로그가 없어서**
    /// 모든 테이블의 PRAGMA 를 훑어야 한다. 스키마가 큰 DB 에서는 그만큼 비용이 든다.
    async fn relations(&self, table: &TableRef) -> Result<TableRelations> {
        let mut out = TableRelations::default();

        // 나가는 FK: PRAGMA foreign_key_list(이 테이블)
        let sql = format!(
            "PRAGMA foreign_key_list({})",
            DIALECT.quote_ident(&table.name)
        );
        let rows = sqlx::query(AssertSqlSafe(sql))
            .fetch_all(&self.pool)
            .await?;
        // 복합 FK 는 id 가 같은 여러 행으로 나뉘어 오므로 id 로 묶는다.
        let mut by_id: std::collections::BTreeMap<i64, ForeignKeyRef> = Default::default();
        for r in &rows {
            let id: i64 = r.try_get("id").unwrap_or(0);
            let to_table: String = r.try_get("table").unwrap_or_default();
            let from: String = r.try_get("from").unwrap_or_default();
            let to: String = r.try_get("to").unwrap_or_default();
            let e = by_id.entry(id).or_insert_with(|| ForeignKeyRef {
                name: format!("fk_{}_{}", table.name, id),
                columns: Vec::new(),
                table: TableRef {
                    database: None,
                    schema: None,
                    name: to_table.clone(),
                },
                ref_columns: Vec::new(),
            });
            e.columns.push(from);
            // `to` 가 비면 상대 테이블의 PK 를 가리킨다(SQLite 규칙).
            e.ref_columns.push(to);
        }
        for (_, mut fk) in by_id {
            if fk.ref_columns.iter().any(|c| c.is_empty()) {
                fk.ref_columns = self.primary_keys(&fk.table).await.unwrap_or_default();
            }
            out.outgoing.push(fk);
        }

        // 들어오는 FK: 모든 테이블을 훑어 이 테이블을 가리키는 것을 찾는다.
        for t in self.list_tables(None, None).await.unwrap_or_default() {
            if t.name == table.name {
                continue;
            }
            let sql = format!("PRAGMA foreign_key_list({})", DIALECT.quote_ident(&t.name));
            let Ok(rows) = sqlx::query(AssertSqlSafe(sql)).fetch_all(&self.pool).await else {
                continue; // 뷰 등 PRAGMA 가 통하지 않는 대상은 건너뛴다
            };
            let mut by_id: std::collections::BTreeMap<i64, ForeignKeyRef> = Default::default();
            for r in &rows {
                let to_table: String = r.try_get("table").unwrap_or_default();
                if !to_table.eq_ignore_ascii_case(&table.name) {
                    continue;
                }
                let id: i64 = r.try_get("id").unwrap_or(0);
                let from: String = r.try_get("from").unwrap_or_default();
                let to: String = r.try_get("to").unwrap_or_default();
                let e = by_id.entry(id).or_insert_with(|| ForeignKeyRef {
                    name: format!("fk_{}_{}", t.name, id),
                    columns: Vec::new(),
                    table: TableRef {
                        database: None,
                        schema: None,
                        name: t.name.clone(),
                    },
                    ref_columns: Vec::new(),
                });
                // 들어오는 쪽은 방향이 뒤집힌다 — `columns` 는 **이 테이블(피참조)** 의 컬럼이다.
                e.ref_columns.push(from);
                e.columns.push(to);
            }
            for (_, mut fk) in by_id {
                if fk.columns.iter().any(|c| c.is_empty()) {
                    fk.columns = self.primary_keys(table).await.unwrap_or_default();
                }
                out.incoming.push(fk);
            }
        }
        Ok(out)
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

        // 전체 행 수 (필터 반영)
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

        // 삭제 → 갱신 → 삽입 순.
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

    /// SQLite 는 DB·스키마 개념이 없어 `ctx` 는 무시한다.
    async fn run_query(
        &self,
        sql: &str,
        max_rows: usize,
        _ctx: &ExecContext,
    ) -> Result<QueryResult> {
        let start = Instant::now();
        let mut stream = sqlx::query(AssertSqlSafe(sql.to_string())).fetch(&self.pool);
        let mut rows: Vec<SqliteRow> = Vec::new();
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

    /// SQLite 는 생성 당시의 SQL 원문을 sqlite_master 에 보관한다.
    async fn table_ddl(&self, table: &TableRef) -> Result<TableDdl> {
        let sql: Option<String> =
            sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE name = ?")
                .bind(&table.name)
                .fetch_optional(&self.pool)
                .await?
                .flatten();
        match sql {
            Some(s) => Ok(TableDdl {
                sql: format!("{s};"),
                exact: true,
            }),
            None => Err(AppError::NotFound(format!(
                "'{}' 의 정의를 찾을 수 없습니다",
                table.name
            ))),
        }
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
        // 쓰기 문장에 `RETURNING *` 을 끼워 넣어 변경된 행을 돌려받는다.
        // UPDATE 는 **변경 후 값만** 온다 — 표준에 변경 전을 주는 방법이 없다.
        let rewritten = opts
            .capture_changes
            .then(|| script::with_change_output(sql, script::ChangeOutput::Returning))
            .flatten();
        let sql = rewritten.as_ref().map(|r| r.sql.as_str()).unwrap_or(sql);
        // SQLite 는 DB·스키마 개념이 없어 컨텍스트를 적용할 것이 없다.
        let _ = ctx;
        let mut conn = self.pool.acquire().await?;

        let mut out = ScriptResult::default();
        let mut cur: Vec<SqliteRow> = Vec::new();
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

    async fn run_execute(&self, sql: &str, _ctx: &ExecContext) -> Result<ExecResult> {
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

#[cfg(test)]
mod tests {

    /// 행 수 제한만 지정한 스크립트 옵션(변경 행 보기는 끔).
    fn opts(max_rows: usize) -> ScriptOptions {
        ScriptOptions {
            max_rows,
            capture_changes: false,
        }
    }
    use super::*;
    use serde_json::Value;
    use std::collections::BTreeMap;

    async fn mem_driver() -> SqliteDriver {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER)")
            .execute(&pool)
            .await
            .unwrap();
        SqliteDriver::from_pool(pool)
    }

    fn table() -> TableRef {
        TableRef {
            database: None,
            schema: None,
            name: "users".into(),
        }
    }

    #[tokio::test]
    async fn crud_roundtrip() {
        let d = mem_driver().await;

        // 컬럼/PK 메타
        let cols = d.list_columns(&table()).await.unwrap();
        assert_eq!(cols.len(), 3);
        assert!(cols.iter().any(|c| c.name == "id" && c.is_primary_key));
        assert_eq!(d.primary_keys(&table()).await.unwrap(), vec!["id"]);

        // INSERT
        let mut v1 = BTreeMap::new();
        v1.insert("id".to_string(), Value::from(1));
        v1.insert("name".to_string(), Value::from("alice"));
        v1.insert("age".to_string(), Value::from(30));
        let mut v2 = BTreeMap::new();
        v2.insert("id".to_string(), Value::from(2));
        v2.insert("name".to_string(), Value::from("bob"));
        v2.insert("age".to_string(), Value::from(25));
        let ins = d
            .apply_changes(&ApplyChangesRequest {
                conn_id: "t".into(),
                table: table(),
                edits: vec![
                    RowEdit::Insert { values: v1 },
                    RowEdit::Insert { values: v2 },
                ],
            })
            .await
            .unwrap();
        assert_eq!(ins.inserted, 2);
        // 로그 패널이 "커밋이 무엇을 보냈는지" 보여주려면 실행한 문장이 실려 와야 한다.
        assert_eq!(ins.statements.len(), 2, "실행한 문장이 담기지 않았다");
        assert!(ins.statements[0].starts_with("INSERT INTO"));
        // **값은 절대 담기면 안 된다** — 파라미터 바인딩이라 문형만 남아야 하고,
        // 그래야 로그에 개인정보가 새지 않는다(docs/DESIGN.md §9).
        assert!(
            !ins.statements.iter().any(|s| s.contains("alice")),
            "값이 SQL 에 섞였다: {:?}",
            ins.statements
        );

        // fetch_page + 정렬
        let page = d
            .fetch_page(&FetchPageRequest {
                conn_id: "t".into(),
                filter_sql: None,
                table: table(),
                limit: 100,
                offset: 0,
                sort: vec![SortSpec {
                    column: "id".into(),
                    descending: false,
                }],
                filters: vec![],
            })
            .await
            .unwrap();
        assert_eq!(page.total_rows, Some(2));
        assert_eq!(page.result.rows.len(), 2);
        assert_eq!(page.result.rows[0][1], Value::from("alice"));

        // UPDATE (id=1 name→ALICE)
        let mut pk = BTreeMap::new();
        pk.insert("id".to_string(), Value::from(1));
        let mut ch = BTreeMap::new();
        ch.insert("name".to_string(), Value::from("ALICE"));
        let upd = d
            .apply_changes(&ApplyChangesRequest {
                conn_id: "t".into(),
                table: table(),
                edits: vec![RowEdit::Update { pk, changes: ch }],
            })
            .await
            .unwrap();
        assert_eq!(upd.updated, 1);

        // DELETE (id=2)
        let mut pk2 = BTreeMap::new();
        pk2.insert("id".to_string(), Value::from(2));
        let del = d
            .apply_changes(&ApplyChangesRequest {
                conn_id: "t".into(),
                table: table(),
                edits: vec![RowEdit::Delete { pk: pk2 }],
            })
            .await
            .unwrap();
        assert_eq!(del.deleted, 1);

        // 최종 상태 확인: 1행, name=ALICE
        let q = d
            .run_query("SELECT name FROM users", 100, &ExecContext::default())
            .await
            .unwrap();
        assert_eq!(q.rows.len(), 1);
        assert_eq!(q.rows[0][0], Value::from("ALICE"));
    }

    #[tokio::test]
    async fn filter_and_truncate() {
        let d = mem_driver().await;
        for i in 1..=5 {
            let mut v = BTreeMap::new();
            v.insert("id".to_string(), Value::from(i));
            v.insert("name".to_string(), Value::from(format!("u{i}")));
            v.insert("age".to_string(), Value::from(20 + i));
            d.apply_changes(&ApplyChangesRequest {
                conn_id: "t".into(),
                table: table(),
                edits: vec![RowEdit::Insert { values: v }],
            })
            .await
            .unwrap();
        }
        // 필터 age > 22 → id 3,4,5
        let page = d
            .fetch_page(&FetchPageRequest {
                conn_id: "t".into(),
                filter_sql: None,
                table: table(),
                limit: 100,
                offset: 0,
                sort: vec![],
                filters: vec![FilterSpec {
                    column: "age".into(),
                    op: ">".into(),
                    value: Value::from(22),
                }],
            })
            .await
            .unwrap();
        assert_eq!(page.total_rows, Some(3));

        // truncate: max_rows=2
        let q = d
            .run_query("SELECT * FROM users", 2, &ExecContext::default())
            .await
            .unwrap();
        assert_eq!(q.rows.len(), 2);
        assert!(q.truncated);
    }

    /// WHERE 필터 바(filter_sql)가 실제 DB 조회까지 반영되는지 확인한다.
    /// LIKE 패턴의 `%` 가 그대로 전달되어야 한다.
    #[tokio::test]
    async fn filter_sql_like_pattern() {
        let d = mem_driver().await;
        for (i, code) in ["A0018-1", "A0018-2", "A0019-1"].iter().enumerate() {
            let mut v = BTreeMap::new();
            v.insert("id".to_string(), Value::from(i as i64 + 1));
            v.insert("name".to_string(), Value::from(*code));
            v.insert("age".to_string(), Value::from(30));
            d.apply_changes(&ApplyChangesRequest {
                conn_id: "t".into(),
                table: table(),
                edits: vec![RowEdit::Insert { values: v }],
            })
            .await
            .unwrap();
        }

        let page = d
            .fetch_page(&FetchPageRequest {
                conn_id: "t".into(),
                filter_sql: Some("name like 'A0018%'".into()),
                table: table(),
                limit: 100,
                offset: 0,
                sort: vec![],
                filters: vec![],
            })
            .await
            .unwrap();
        assert_eq!(page.result.rows.len(), 2);
        assert_eq!(page.total_rows, Some(2));
    }

    /// 자동완성용 스냅샷이 테이블별로 컬럼을 **순서대로** 묶는지 확인한다.
    /// 한 번의 쿼리로 접어 담기 때문에 정렬이 어긋나면 컬럼이 엉뚱한 테이블에 붙는다.
    #[tokio::test]
    async fn schema_snapshot_groups_columns() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        for ddl in [
            "CREATE TABLE a (x INTEGER, y TEXT)",
            "CREATE TABLE b (p INTEGER, q TEXT, r REAL)",
            "CREATE VIEW v AS SELECT x FROM a",
        ] {
            sqlx::query(ddl).execute(&pool).await.unwrap();
        }
        let d = SqliteDriver::from_pool(pool);
        let snap = d.schema_snapshot(None, None).await.unwrap();

        let find = |name: &str| {
            snap.iter()
                .find(|t| t.table == name)
                .unwrap_or_else(|| panic!("{name} 이 없다"))
                .columns
                .clone()
        };
        assert_eq!(find("a"), vec!["x", "y"]);
        assert_eq!(find("b"), vec!["p", "q", "r"]);
        // 뷰도 자동완성 대상이다.
        assert_eq!(find("v"), vec!["x"]);
    }

    /// 다중 문장 스크립트가 **결과셋을 모두** 돌려주는지 확인한다.
    ///
    /// 첫 결과셋만 읽으면 서버는 다 실행했는데 화면에는 하나만 와서
    /// "일부가 실행되지 않았다"고 오해하게 된다.
    #[tokio::test]
    async fn run_script_returns_every_result_set() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE t (a INTEGER)")
            .execute(&pool)
            .await
            .unwrap();
        let d = SqliteDriver::from_pool(pool);
        let ctx = ExecContext::default();

        // 결과셋 두 개 + 쓰기 두 개가 섞인 스크립트.
        let script = "INSERT INTO t VALUES (1); INSERT INTO t VALUES (2); \
                      SELECT a FROM t ORDER BY a; SELECT COUNT(*) AS n FROM t;";
        let r = d
            .run_script(script, &opts(100), &ctx)
            .await
            .expect("script");

        assert_eq!(r.results.len(), 2, "결과셋이 둘 다 오지 않았다");
        assert_eq!(r.results[0].rows.len(), 2, "첫 SELECT 가 2행이어야 한다");
        assert_eq!(r.results[1].rows.len(), 1, "두 번째 SELECT 는 1행");
        assert_eq!(r.results[1].columns[0].name, "n");
        // 쓰기 문장은 결과셋 대신 영향 행 수로 센다.
        assert_eq!(r.rows_affected, 2, "INSERT 2건이 세어지지 않았다");
    }

    /// 변경 행 보기: `RETURNING *` 이 끼워져 변경된 행이 돌아오는지.
    ///
    /// RETURNING 은 **변경 후 값만** 준다(표준에 변경 전을 주는 방법이 없다).
    /// SQL Server 의 `OUTPUT` 과 달리 컬럼이 이전/이후로 갈리지 않는다.
    #[tokio::test]
    async fn capture_changes_appends_returning() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE t (id INTEGER, name TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO t VALUES (1, 'a'), (2, 'b')")
            .execute(&pool)
            .await
            .unwrap();
        let d = SqliteDriver::from_pool(pool);
        let capture = ScriptOptions {
            max_rows: 100,
            capture_changes: true,
        };

        let r = d
            .run_script(
                "UPDATE t SET name = 'z' WHERE id = 1",
                &capture,
                &ExecContext::default(),
            )
            .await
            .expect("script");
        assert_eq!(r.results.len(), 1, "변경된 행이 오지 않았다");
        assert_eq!(r.results[0].rows[0][1], serde_json::json!("z"));
        assert_eq!(r.sql.len(), 1, "고쳐 보낸 SQL 이 실려 오지 않았다");
        assert!(r.sql[0].ends_with("RETURNING *"), "{}", r.sql[0]);

        // 꺼져 있으면 원문 그대로 — SQL 을 고쳐 보내지 않았음을 확인한다.
        let r = d
            .run_script(
                "UPDATE t SET name = 'y' WHERE id = 2",
                &opts(100),
                &ExecContext::default(),
            )
            .await
            .expect("script");
        assert!(r.results.is_empty());
        assert!(r.sql.is_empty(), "손대지 않은 SQL 이 실려 왔다");
        assert_eq!(r.rows_affected, 1);
    }

    /// max_rows 를 넘는 결과셋은 잘리고 그 사실이 표시되어야 한다.
    #[tokio::test]
    async fn run_script_truncates_per_result_set() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE t (a INTEGER)")
            .execute(&pool)
            .await
            .unwrap();
        for i in 0..5 {
            sqlx::query("INSERT INTO t VALUES (?)")
                .bind(i)
                .execute(&pool)
                .await
                .unwrap();
        }
        let d = SqliteDriver::from_pool(pool);
        let r = d
            .run_script("SELECT a FROM t;", &opts(2), &ExecContext::default())
            .await
            .expect("script");
        assert_eq!(r.results.len(), 1);
        assert_eq!(r.results[0].rows.len(), 2, "max_rows 만큼만 남아야 한다");
        assert!(r.results[0].truncated, "잘렸다는 표시가 없다");
    }

    /// 외래키 관계를 양방향으로 읽는다.
    ///
    /// 들어오는 FK 는 SQLite 에 카탈로그가 없어 모든 테이블을 훑어 찾는다 — 그 경로가
    /// 실제로 맞는 테이블을 집어내는지, 그리고 `columns` 가 **언제나 기준 테이블 쪽**을
    /// 가리키는지(방향이 뒤집히지 않는지) 고정한다.
    #[tokio::test]
    async fn relations_both_directions() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        for ddl in [
            "CREATE TABLE dept (id INTEGER PRIMARY KEY, name TEXT)",
            "CREATE TABLE emp (id INTEGER PRIMARY KEY, dept_id INTEGER REFERENCES dept(id), \
             mgr_id INTEGER REFERENCES emp(id))",
            "CREATE TABLE unrelated (id INTEGER PRIMARY KEY)",
        ] {
            sqlx::query(ddl).execute(&pool).await.unwrap();
        }
        let d = SqliteDriver::from_pool(pool);
        let t = |name: &str| TableRef {
            database: None,
            schema: None,
            name: name.into(),
        };

        // emp 기준: dept 로 나가고(+ 자기참조), 자기참조로 들어온다.
        let r = d.relations(&t("emp")).await.unwrap();
        let to_dept = r
            .outgoing
            .iter()
            .find(|f| f.table.name == "dept")
            .expect("emp → dept 가 없다");
        assert_eq!(to_dept.columns, vec!["dept_id"]);
        assert_eq!(to_dept.ref_columns, vec!["id"]);

        // dept 기준: 나가는 것은 없고 emp 가 들어온다.
        let r = d.relations(&t("dept")).await.unwrap();
        assert!(r.outgoing.is_empty(), "dept 는 참조하는 것이 없다");
        let from_emp = r
            .incoming
            .iter()
            .find(|f| f.table.name == "emp")
            .expect("dept ← emp 가 없다");
        // 들어오는 쪽도 `columns` 는 기준 테이블(dept)의 컬럼이어야 한다.
        assert_eq!(from_emp.columns, vec!["id"], "방향이 뒤집혔다");
        assert_eq!(from_emp.ref_columns, vec!["dept_id"]);

        // 무관한 테이블은 어느 쪽에도 끼지 않는다.
        assert!(
            !r.incoming.iter().any(|f| f.table.name == "unrelated"),
            "관계없는 테이블이 섞였다"
        );
    }

    /// 기본 키가 없는 테이블도 편집할 수 있다. 행은 **컬럼 값 조합**으로 찾는다.
    ///
    /// 값이 같은 행이 여럿이면 한 번에 다 바뀌므로, 그때는 통째로 롤백되어야 한다.
    /// 되돌릴 수 없는 변경을 막는 유일한 방어선이라 반드시 고정해 둔다.
    #[tokio::test]
    async fn edit_without_primary_key() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        // PK 가 없는 테이블. dup 두 행은 모든 값이 같다.
        sqlx::query("CREATE TABLE nopk (name TEXT, age INTEGER)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO nopk VALUES ('alice', 30), ('dup', 1), ('dup', 1)")
            .execute(&pool)
            .await
            .unwrap();
        let d = SqliteDriver::from_pool(pool);
        let t = TableRef {
            database: None,
            schema: None,
            name: "nopk".into(),
        };
        assert!(
            d.primary_keys(&t).await.unwrap().is_empty(),
            "PK 가 없어야 한다"
        );

        let key = |name: &str, age: i64| {
            let mut m = BTreeMap::new();
            m.insert("name".to_string(), Value::from(name));
            m.insert("age".to_string(), Value::from(age));
            m
        };
        let apply = |edits: Vec<RowEdit>| {
            let t = t.clone();
            let d = &d;
            async move {
                d.apply_changes(&ApplyChangesRequest {
                    conn_id: "t".into(),
                    table: t,
                    edits,
                })
                .await
            }
        };

        // 유일한 행은 값 조합만으로 수정된다.
        let mut ch = BTreeMap::new();
        ch.insert("age".to_string(), Value::from(31));
        let res = apply(vec![RowEdit::Update {
            pk: key("alice", 30),
            changes: ch,
        }])
        .await
        .expect("유일한 행은 수정돼야 한다");
        assert_eq!(res.updated, 1);

        // 값이 같은 행이 둘이면 막고 되돌린다.
        let mut ch = BTreeMap::new();
        ch.insert("age".to_string(), Value::from(99));
        let err = apply(vec![RowEdit::Update {
            pk: key("dup", 1),
            changes: ch,
        }])
        .await
        .expect_err("중복 행은 막아야 한다");
        assert!(err.to_string().contains("2개 행"), "메시지: {err}");

        // 삭제도 마찬가지.
        let err = apply(vec![RowEdit::Delete { pk: key("dup", 1) }])
            .await
            .expect_err("중복 행 삭제는 막아야 한다");
        assert!(err.to_string().contains("2개 행"), "메시지: {err}");

        // 막힌 뒤 데이터가 그대로인지 — 롤백이 실제로 됐는지 확인한다.
        let page = d
            .fetch_page(&FetchPageRequest {
                conn_id: "t".into(),
                table: t.clone(),
                limit: 100,
                offset: 0,
                sort: vec![],
                filters: vec![],
                filter_sql: None,
            })
            .await
            .unwrap();
        assert_eq!(page.total_rows, Some(3), "삭제가 새어 나갔다");
        let ages: Vec<i64> = page
            .result
            .rows
            .iter()
            .map(|r| r[1].as_i64().unwrap_or(-1))
            .collect();
        assert_eq!(
            ages.iter().filter(|a| **a == 1).count(),
            2,
            "dup 행이 바뀌었다"
        );
        assert!(ages.contains(&31), "정상 수정이 반영되지 않았다");

        // 사라진 행을 가리키면 알려 준다(조용히 넘기지 않는다).
        let err = apply(vec![RowEdit::Delete {
            pk: key("ghost", 7),
        }])
        .await
        .expect_err("없는 행은 오류여야 한다");
        assert!(err.to_string().contains("찾지 못했습니다"), "메시지: {err}");
    }
}
