//! SQLite 드라이버 (sqlx). 서버 불필요 — 파일/인메모리.

use super::sql::{self, Dialect};
use super::value::{self, bind_json};
use super::Driver;
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

    fn dialect(&self) -> Dialect {
        DIALECT
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

#[cfg(test)]
mod tests {
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
        let q = d.run_query("SELECT name FROM users", 100).await.unwrap();
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
        let q = d.run_query("SELECT * FROM users", 2).await.unwrap();
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
