//! SQL Server 드라이버 (tiberius).
//!
//! tiberius 는 런타임 비의존 + 단일 커넥션이므로 `tokio::sync::Mutex<Client>` 로 감싼다.
//! 파라미터는 `@P1`, `@P2` … 스타일이며 `Value` 를 [`P`] 로 변환해 바인딩한다.
//!
//! 알려진 한계(MVP): DATE/TIME/DATETIME 계열과 XML 은 best-effort(Debug) 문자열로
//! 표시된다. 정밀한 시간대/포맷 처리는 후속 과제.

use super::sql::{self, Dialect};
use super::value::{self};
use super::Driver;
use crate::error::{AppError, Result};
use crate::models::*;
use async_trait::async_trait;
use serde_json::Value;
use std::time::Instant;
use tiberius::{AuthMethod, Client, ColumnData, ColumnType, Config, Row as TdsRow, ToSql};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

const DIALECT: Dialect = Dialect::MSSQL;

type TdsClient = Client<Compat<TcpStream>>;

pub struct MssqlDriver {
    client: Mutex<TdsClient>,
}

/// tiberius 바인딩용 파라미터 래퍼.
enum P {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
}

impl ToSql for P {
    fn to_sql(&self) -> ColumnData<'_> {
        use std::borrow::Cow;
        match self {
            P::Null => ColumnData::String(None),
            P::Bool(b) => ColumnData::Bit(Some(*b)),
            P::Int(i) => ColumnData::I64(Some(*i)),
            P::Float(f) => ColumnData::F64(Some(*f)),
            P::Str(s) => ColumnData::String(Some(Cow::Borrowed(s.as_str()))),
        }
    }
}

fn to_param(v: &Value) -> P {
    match v {
        Value::Null => P::Null,
        Value::Bool(b) => P::Bool(*b),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                P::Int(i)
            } else {
                P::Float(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(s) => P::Str(s.clone()),
        other => P::Str(other.to_string()),
    }
}

fn coltype_logical(ct: ColumnType) -> LogicalType {
    match ct {
        ColumnType::Bit | ColumnType::Bitn => LogicalType::Bool,
        ColumnType::Int1
        | ColumnType::Int2
        | ColumnType::Int4
        | ColumnType::Int8
        | ColumnType::Intn => LogicalType::Int,
        ColumnType::Float4 | ColumnType::Float8 | ColumnType::Floatn => LogicalType::Float,
        ColumnType::Money | ColumnType::Money4 | ColumnType::Decimaln | ColumnType::Numericn => {
            LogicalType::Decimal
        }
        ColumnType::BigVarChar
        | ColumnType::BigChar
        | ColumnType::NVarchar
        | ColumnType::NChar
        | ColumnType::Text
        | ColumnType::NText
        | ColumnType::Xml => LogicalType::String,
        ColumnType::Guid => LogicalType::Uuid,
        ColumnType::Daten => LogicalType::Date,
        ColumnType::Timen => LogicalType::Time,
        ColumnType::Datetime
        | ColumnType::Datetime4
        | ColumnType::Datetimen
        | ColumnType::Datetime2
        | ColumnType::DatetimeOffsetn => LogicalType::Datetime,
        ColumnType::BigVarBin | ColumnType::BigBinary | ColumnType::Image => LogicalType::Bytes,
        _ => LogicalType::Unknown,
    }
}

fn cell_to_json(d: &ColumnData) -> Value {
    match d {
        ColumnData::U8(v) => (*v).map(Value::from).unwrap_or(Value::Null),
        ColumnData::I16(v) => (*v).map(Value::from).unwrap_or(Value::Null),
        ColumnData::I32(v) => (*v).map(Value::from).unwrap_or(Value::Null),
        ColumnData::I64(v) => (*v).map(Value::from).unwrap_or(Value::Null),
        ColumnData::F32(v) => (*v).map(Value::from).unwrap_or(Value::Null),
        ColumnData::F64(v) => (*v).map(Value::from).unwrap_or(Value::Null),
        ColumnData::Bit(v) => (*v).map(Value::from).unwrap_or(Value::Null),
        ColumnData::String(v) => v
            .as_ref()
            .map(|s| Value::String(s.to_string()))
            .unwrap_or(Value::Null),
        ColumnData::Guid(v) => v
            .as_ref()
            .map(|u| Value::String(u.to_string()))
            .unwrap_or(Value::Null),
        ColumnData::Numeric(v) => v
            .as_ref()
            .map(|n| Value::String(n.to_string()))
            .unwrap_or(Value::Null),
        ColumnData::Binary(v) => v
            .as_ref()
            .map(|b| Value::String(value::hex_preview(b)))
            .unwrap_or(Value::Null),
        // 날짜/시간은 rows_to_result 에서 chrono 로 별도 디코딩한다(여기 오면 미지원 타입).
        other => Value::String(format!("{other:?}")),
    }
}

/// 날짜/시간 컬럼은 ColumnData 를 직접 읽으면 내부 표현이 노출되므로
/// chrono 타입으로 변환해 사람이 읽을 수 있는 문자열로 만든다.
fn datetime_cell(row: &TdsRow, idx: usize, ct: ColumnType) -> Option<Value> {
    let v = match ct {
        ColumnType::Datetime
        | ColumnType::Datetime2
        | ColumnType::Datetimen
        | ColumnType::Datetime4 => row
            .try_get::<chrono::NaiveDateTime, _>(idx)
            .ok()
            .flatten()
            .map(|d| Value::String(d.to_string())),
        ColumnType::Daten => row
            .try_get::<chrono::NaiveDate, _>(idx)
            .ok()
            .flatten()
            .map(|d| Value::String(d.to_string())),
        ColumnType::Timen => row
            .try_get::<chrono::NaiveTime, _>(idx)
            .ok()
            .flatten()
            .map(|t| Value::String(t.to_string())),
        ColumnType::DatetimeOffsetn => row
            .try_get::<chrono::DateTime<chrono::Utc>, _>(idx)
            .ok()
            .flatten()
            .map(|t| Value::String(t.to_rfc3339())),
        _ => return None, // 날짜/시간 계열이 아님
    };
    // 날짜 계열이지만 NULL 이면 Null.
    Some(v.unwrap_or(Value::Null))
}

fn rows_to_result(rows: &[TdsRow], elapsed_ms: u64, truncated: bool) -> QueryResult {
    let columns = match rows.first() {
        Some(first) => first
            .columns()
            .iter()
            .map(|c| {
                let ct = c.column_type();
                ColumnMeta {
                    name: c.name().to_string(),
                    db_type: format!("{ct:?}"),
                    logical_type: coltype_logical(ct),
                }
            })
            .collect(),
        None => Vec::new(),
    };
    let data = rows
        .iter()
        .map(|r| {
            r.cells()
                .enumerate()
                .map(|(i, (col, d))| {
                    datetime_cell(r, i, col.column_type()).unwrap_or_else(|| cell_to_json(d))
                })
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

fn schema_or_default(table: &TableRef) -> String {
    table.schema.clone().unwrap_or_else(|| "dbo".to_string())
}

impl MssqlDriver {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self> {
        let host = config
            .host
            .clone()
            .ok_or_else(|| AppError::Validation("SQL Server 호스트가 필요합니다".into()))?;
        let username = config
            .username
            .clone()
            .ok_or_else(|| AppError::Validation("SQL Server 사용자명이 필요합니다".into()))?;
        let password = config.password.clone().unwrap_or_default();

        let mut cfg = Config::new();
        cfg.host(&host);
        cfg.port(config.port.unwrap_or(1433));
        if let Some(db) = &config.database {
            cfg.database(db);
        }
        cfg.authentication(AuthMethod::sql_server(&username, &password));
        if let Some(app) = config.params.get("application_name") {
            cfg.application_name(app);
        }

        // SSL/TLS: 지정이 있으면 그에 따르고, 없으면 사내망 편의를 위해 서버 인증서를 신뢰.
        match &config.ssl {
            Some(ssl) => {
                cfg.encryption(match ssl.mode {
                    SslMode::Disable => tiberius::EncryptionLevel::NotSupported,
                    _ => tiberius::EncryptionLevel::Required,
                });
                match ssl.mode {
                    SslMode::VerifyCa | SslMode::VerifyFull => {
                        // CA 지정 시 해당 CA 로 검증, 없으면 시스템 신뢰 저장소로 검증.
                        if let Some(ca) = &ssl.ca_cert {
                            cfg.trust_cert_ca(ca);
                        }
                    }
                    _ => cfg.trust_cert(),
                }
            }
            None => cfg.trust_cert(),
        }

        let tcp = TcpStream::connect(cfg.get_addr()).await?;
        tcp.set_nodelay(true)?;
        let client = Client::connect(cfg, tcp.compat_write()).await?;
        Ok(Self {
            client: Mutex::new(client),
        })
    }

    async fn query_rows(&self, sql: &str, params: &[Value]) -> Result<Vec<TdsRow>> {
        let pv: Vec<P> = params.iter().map(to_param).collect();
        let refs: Vec<&dyn ToSql> = pv.iter().map(|p| p as &dyn ToSql).collect();
        let mut guard = self.client.lock().await;
        let rows = guard.query(sql, &refs).await?.into_first_result().await?;
        Ok(rows)
    }

    async fn simple_rows(&self, sql: &str) -> Result<Vec<TdsRow>> {
        let mut guard = self.client.lock().await;
        let rows = guard.simple_query(sql).await?.into_first_result().await?;
        Ok(rows)
    }
}

fn get_str(row: &TdsRow, col: &str) -> String {
    row.try_get::<&str, _>(col)
        .ok()
        .flatten()
        .unwrap_or("")
        .to_string()
}

/// 다른 DB 의 카탈로그를 3-part 로 조회하기 위한 `[db].` 접두사. database 는 quoting 됨.
fn db_prefix(database: Option<&str>) -> String {
    match database {
        Some(db) if !db.is_empty() => format!("{}.", DIALECT.quote_ident(db)),
        _ => String::new(),
    }
}

#[async_trait]
impl Driver for MssqlDriver {
    fn kind(&self) -> DbKind {
        DbKind::Mssql
    }

    async fn server_version(&self) -> Result<Option<String>> {
        let rows = self.simple_rows("SELECT @@VERSION AS v").await?;
        Ok(rows.first().map(|r| get_str(r, "v")))
    }

    async fn test(&self) -> Result<()> {
        self.simple_rows("SELECT 1 AS one").await?;
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        let rows = self
            .simple_rows("SELECT name FROM sys.databases WHERE database_id > 4 ORDER BY name")
            .await?;
        Ok(rows
            .iter()
            .map(|r| DatabaseInfo {
                name: get_str(r, "name"),
            })
            .collect())
    }

    async fn list_schemas(&self, database: Option<&str>) -> Result<Vec<SchemaInfo>> {
        let prefix = db_prefix(database);
        let sql = format!(
            "SELECT s.name AS schema_name FROM {prefix}sys.schemas s \
             WHERE s.name NOT IN ('sys','INFORMATION_SCHEMA','guest', \
               'db_owner','db_accessadmin','db_securityadmin','db_ddladmin', \
               'db_backupoperator','db_datareader','db_datawriter', \
               'db_denydatareader','db_denydatawriter') \
             ORDER BY s.name"
        );
        let rows = self.simple_rows(&sql).await?;
        Ok(rows
            .iter()
            .map(|r| SchemaInfo {
                name: get_str(r, "schema_name"),
            })
            .collect())
    }

    async fn list_tables(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
    ) -> Result<Vec<TableInfo>> {
        let schema = schema.unwrap_or("dbo").to_string();
        let prefix = db_prefix(database);
        let sql = format!(
            "SELECT TABLE_NAME, TABLE_TYPE FROM {prefix}INFORMATION_SCHEMA.TABLES \
             WHERE TABLE_SCHEMA = @P1 ORDER BY TABLE_NAME"
        );
        let rows = self
            .query_rows(&sql, &[Value::String(schema.clone())])
            .await?;
        Ok(rows
            .iter()
            .map(|r| {
                let ty = get_str(r, "TABLE_TYPE");
                TableInfo {
                    name: get_str(r, "TABLE_NAME"),
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
        let p = db_prefix(table.database.as_deref());
        let sql = format!(
            "SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT, \
                    c.ORDINAL_POSITION, \
                    CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS is_pk \
             FROM {p}INFORMATION_SCHEMA.COLUMNS c \
             LEFT JOIN ( \
                SELECT kcu.COLUMN_NAME \
                FROM {p}INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc \
                JOIN {p}INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu \
                  ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME \
                WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' \
                  AND tc.TABLE_SCHEMA = @P1 AND tc.TABLE_NAME = @P2 \
             ) pk ON pk.COLUMN_NAME = c.COLUMN_NAME \
             WHERE c.TABLE_SCHEMA = @P3 AND c.TABLE_NAME = @P4 \
             ORDER BY c.ORDINAL_POSITION"
        );
        let rows = self
            .query_rows(
                &sql,
                &[
                    Value::String(schema.clone()),
                    Value::String(table.name.clone()),
                    Value::String(schema.clone()),
                    Value::String(table.name.clone()),
                ],
            )
            .await?;
        Ok(rows
            .iter()
            .map(|r| {
                let data_type = get_str(r, "DATA_TYPE");
                let is_nullable = get_str(r, "IS_NULLABLE");
                let is_pk = r.try_get::<i32, _>("is_pk").ok().flatten().unwrap_or(0);
                let ordinal = r
                    .try_get::<i32, _>("ORDINAL_POSITION")
                    .ok()
                    .flatten()
                    .unwrap_or(0);
                let default = r
                    .try_get::<&str, _>("COLUMN_DEFAULT")
                    .ok()
                    .flatten()
                    .map(|s| s.to_string());
                ColumnInfo {
                    name: get_str(r, "COLUMN_NAME"),
                    logical_type: value::mssql_logical(&data_type),
                    db_type: data_type,
                    nullable: is_nullable == "YES",
                    is_primary_key: is_pk == 1,
                    default,
                    ordinal,
                }
            })
            .collect())
    }

    async fn primary_keys(&self, table: &TableRef) -> Result<Vec<String>> {
        let schema = schema_or_default(table);
        let p = db_prefix(table.database.as_deref());
        let sql = format!(
            "SELECT kcu.COLUMN_NAME \
             FROM {p}INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc \
             JOIN {p}INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu \
               ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME \
             WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' \
               AND tc.TABLE_SCHEMA = @P1 AND tc.TABLE_NAME = @P2 \
             ORDER BY kcu.ORDINAL_POSITION"
        );
        let rows = self
            .query_rows(
                &sql,
                &[Value::String(schema), Value::String(table.name.clone())],
            )
            .await?;
        Ok(rows.iter().map(|r| get_str(r, "COLUMN_NAME")).collect())
    }

    async fn fetch_page(&self, req: &FetchPageRequest) -> Result<TablePage> {
        let built = sql::build_fetch(&DIALECT, req);
        let start = Instant::now();
        let rows = self
            .query_rows(&built.sql, &built.params)
            .await
            .map_err(|e| e.with_sql(&built.sql))?;
        let result = rows_to_result(&rows, start.elapsed().as_millis() as u64, false);

        let primary_keys = self.primary_keys(&req.table).await.unwrap_or_default();

        let cbuilt = sql::build_count(&DIALECT, req);
        let crows = self
            .query_rows(&cbuilt.sql, &cbuilt.params)
            .await
            .map_err(|e| e.with_sql(&cbuilt.sql))?;
        let total_rows = crows
            .first()
            .and_then(|r| r.try_get::<i32, _>(0).ok().flatten())
            .map(|c| c as u64);

        Ok(TablePage {
            result,
            primary_keys,
            total_rows,
        })
    }

    async fn apply_changes(&self, req: &ApplyChangesRequest) -> Result<ApplyChangesResult> {
        // 트랜잭션 시작 전에 모든 문장을 미리 만들어 검증 오류를 걸러낸다.
        let mut ops: Vec<(char, sql::Built)> = Vec::new();
        for edit in &req.edits {
            if let RowEdit::Delete { pk } = edit {
                ops.push(('d', sql::build_delete(&DIALECT, &req.table, pk)?));
            }
        }
        for edit in &req.edits {
            if let RowEdit::Update { pk, changes } = edit {
                ops.push(('u', sql::build_update(&DIALECT, &req.table, pk, changes)?));
            }
        }
        for edit in &req.edits {
            if let RowEdit::Insert { values } = edit {
                ops.push(('i', sql::build_insert(&DIALECT, &req.table, values)?));
            }
        }

        let mut guard = self.client.lock().await;
        // 트랜잭션 제어문은 반드시 배치로 직접 보낸다. tiberius 의 `execute` 는 sp_executesql
        // 로 감싸 실행하는데, 그 안에서 BEGIN TRANSACTION 을 하면 프로시저 스코프를 벗어날 때
        // @@TRANCOUNT 가 어긋나 오류 266 이 난다(그리고 트랜잭션이 세션에 남는다).
        // DML 은 값 바인딩이 필요하므로 sp_executesql 경로를 그대로 쓴다 — 바깥 트랜잭션에 참여한다.
        guard
            .simple_query("BEGIN TRANSACTION")
            .await?
            .into_results()
            .await?;

        let mut res = ApplyChangesResult::default();
        for (kind, b) in &ops {
            let pv: Vec<P> = b.params.iter().map(to_param).collect();
            let refs: Vec<&dyn ToSql> = pv.iter().map(|p| p as &dyn ToSql).collect();
            match guard.execute(b.sql.as_str(), &refs).await {
                Ok(er) => {
                    let n = er.total();
                    match kind {
                        'd' => res.deleted += n,
                        'u' => res.updated += n,
                        _ => res.inserted += n,
                    }
                }
                Err(e) => {
                    // 롤백도 배치로. 실패하더라도 원래 오류를 그대로 올린다.
                    if let Ok(s) = guard.simple_query("ROLLBACK").await {
                        let _ = s.into_results().await;
                    }
                    return Err(e.into());
                }
            }
        }
        guard.simple_query("COMMIT").await?.into_results().await?;
        Ok(res)
    }

    async fn run_query(&self, sql: &str, max_rows: usize) -> Result<QueryResult> {
        let start = Instant::now();
        let mut rows = self.simple_rows(sql).await?;
        let truncated = rows.len() > max_rows;
        if truncated {
            rows.truncate(max_rows);
        }
        Ok(rows_to_result(
            &rows,
            start.elapsed().as_millis() as u64,
            truncated,
        ))
    }

    /// SQL Server 는 기본값이 명명 제약이라, 바꾸려면 기존 제약 이름을 알아야 한다.
    async fn default_constraint_name(
        &self,
        table: &TableRef,
        column: &str,
    ) -> Result<Option<String>> {
        let sql = format!(
            "SELECT dc.name AS n FROM {}sys.default_constraints dc \
             JOIN sys.columns c ON c.object_id = dc.parent_object_id \
             AND c.column_id = dc.parent_column_id \
             WHERE dc.parent_object_id = OBJECT_ID(@P1) AND c.name = @P2",
            db_prefix(table.database.as_deref())
        );
        let qualified = format!("{}.{}", schema_or_default(table), table.name);
        let rows = self
            .query_rows(
                &sql,
                &[Value::String(qualified), Value::String(column.to_string())],
            )
            .await?;
        Ok(rows
            .first()
            .map(|r| get_str(r, "n"))
            .filter(|s| !s.is_empty()))
    }

    fn dialect(&self) -> Dialect {
        DIALECT
    }

    async fn run_execute(&self, sql: &str) -> Result<ExecResult> {
        let start = Instant::now();
        let empty: Vec<&dyn ToSql> = Vec::new();
        let mut guard = self.client.lock().await;
        let er = guard.execute(sql, &empty).await?;
        Ok(ExecResult {
            rows_affected: er.total(),
            elapsed_ms: start.elapsed().as_millis() as u64,
        })
    }
}

/// SQL Server 실동작 테스트. 실제 서버가 필요하므로 `#[ignore]` 로 두고,
/// `DBSTUDIO_MSSQL_TEST=1 cargo test --lib mssql -- --ignored --nocapture` 로 실행한다.
#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn test_config() -> ConnectionConfig {
        ConnectionConfig {
            kind: DbKind::Mssql,
            host: Some(std::env::var("MSSQL_HOST").unwrap_or_else(|_| "localhost".into())),
            port: Some(
                std::env::var("MSSQL_PORT")
                    .ok()
                    .and_then(|p| p.parse().ok())
                    .unwrap_or(14333),
            ),
            database: Some("master".into()),
            username: Some("sa".into()),
            password: Some(
                std::env::var("MSSQL_PASSWORD").unwrap_or_else(|_| "DbStudio!Test123".into()),
            ),
            ssl: Some(SslConfig {
                mode: SslMode::Disable,
                ca_cert: None,
                client_cert: None,
                client_key: None,
            }),
            ssh: None,
            params: Default::default(),
        }
    }

    /// WHERE 필터 바처럼 문자열 리터럴이 인라인된 SQL 이
    /// 두 실행 경로(`simple_query` / `sp_executesql`)에서 각각 어떻게 동작하는지 비교한다.
    #[tokio::test]
    #[ignore]
    async fn where_filter_string_literal_both_paths() {
        let d = MssqlDriver::connect(&test_config()).await.expect("연결");

        d.simple_rows("IF OBJECT_ID('dbo.con_test') IS NOT NULL DROP TABLE dbo.con_test")
            .await
            .expect("drop");
        d.simple_rows("CREATE TABLE dbo.con_test (id INT PRIMARY KEY, con_code NVARCHAR(50))")
            .await
            .expect("create");
        d.simple_rows("INSERT INTO dbo.con_test VALUES (1,'A0018-1'),(2,'A0018-2'),(3,'A0019-1')")
            .await
            .expect("insert");

        let sql = "SELECT * FROM [master].[dbo].[con_test] WHERE (con_code like 'A0018%') \
                   ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 200 ROWS ONLY";

        // (1) 배치 직접 실행 — SSMS 와 같은 경로
        let simple = d.simple_rows(sql).await;
        println!("[simple_query] {:?}", simple.as_ref().map(|r| r.len()));

        // (2) sp_executesql RPC — 파라미터 없이 감싸는 기존 경로
        {
            let mut guard = d.client.lock().await;
            let empty: Vec<&dyn ToSql> = Vec::new();
            let rpc = match guard.query(sql, &empty).await {
                Ok(s) => s
                    .into_first_result()
                    .await
                    .map(|r| r.len())
                    .map_err(|e| e.to_string()),
                Err(e) => Err(e.to_string()),
            };
            println!("[sp_executesql] {rpc:?}");
        }

        // (3) 실제 앱 경로 — fetch_page(WHERE 필터 바)
        let page = d
            .fetch_page(&FetchPageRequest {
                conn_id: "t".into(),
                filter_sql: Some("con_code like 'A0018%'".into()),
                table: TableRef {
                    database: Some("master".into()),
                    schema: Some("dbo".into()),
                    name: "con_test".into(),
                },
                limit: 200,
                offset: 0,
                sort: vec![],
                filters: vec![],
            })
            .await;
        println!(
            "[fetch_page] {:?}",
            page.as_ref().map(|p| (p.result.rows.len(), p.total_rows))
        );

        assert_eq!(page.expect("fetch_page 성공").result.rows.len(), 2);
    }

    /// 커밋(apply_changes)이 트랜잭션을 세션에 남기지 않는지 확인한다.
    /// 트랜잭션 제어문을 sp_executesql 로 보내면 @@TRANCOUNT 가 어긋나 오류 266 이 났었다.
    #[tokio::test]
    #[ignore]
    async fn apply_changes_commits_without_leaking_transaction() {
        let d = MssqlDriver::connect(&test_config()).await.expect("연결");
        d.simple_rows("IF OBJECT_ID('dbo.tx_test') IS NOT NULL DROP TABLE dbo.tx_test")
            .await
            .expect("drop");
        d.simple_rows("CREATE TABLE dbo.tx_test (id INT PRIMARY KEY, name NVARCHAR(50))")
            .await
            .expect("create");

        let table = TableRef {
            database: Some("master".into()),
            schema: Some("dbo".into()),
            name: "tx_test".into(),
        };

        // 같은 커넥션에서 두 번 연속 커밋해야 트랜잭션 누수를 잡을 수 있다.
        for i in 1..=2 {
            let mut values = BTreeMap::new();
            values.insert("id".to_string(), Value::from(i));
            values.insert("name".to_string(), Value::from(format!("row{i}")));
            let res = d
                .apply_changes(&ApplyChangesRequest {
                    conn_id: "t".into(),
                    table: table.clone(),
                    edits: vec![RowEdit::Insert { values }],
                })
                .await
                .unwrap_or_else(|e| panic!("{i}번째 커밋 실패: {e}"));
            assert_eq!(res.inserted, 1);

            let trancount = d
                .simple_rows("SELECT @@TRANCOUNT AS n")
                .await
                .expect("trancount");
            let n: i32 = trancount[0].try_get::<i32, _>("n").unwrap().unwrap();
            assert_eq!(n, 0, "{i}번째 커밋 후 트랜잭션이 남아 있다");
        }

        let rows = d
            .simple_rows("SELECT COUNT(*) AS c FROM dbo.tx_test")
            .await
            .unwrap();
        assert_eq!(rows[0].try_get::<i32, _>("c").unwrap().unwrap(), 2);
    }

    /// PK 가 없는 테이블에 기본 키를 지정한다.
    /// SQL Server 는 PK 컬럼이 NOT NULL 이어야 하므로 ALTER COLUMN 이 선행되어야 한다.
    #[tokio::test]
    #[ignore]
    async fn set_primary_key_on_table_without_pk() {
        let d = MssqlDriver::connect(&test_config()).await.expect("연결");
        d.simple_rows("IF OBJECT_ID('dbo.pk_test') IS NOT NULL DROP TABLE dbo.pk_test")
            .await
            .expect("drop");
        // 일부러 nullable 로 만든다 — ALTER COLUMN 경로를 타는지 보기 위함.
        d.simple_rows("CREATE TABLE dbo.pk_test (id INT NULL, name NVARCHAR(50) NULL)")
            .await
            .expect("create");
        d.simple_rows("INSERT INTO dbo.pk_test VALUES (1,'a'),(2,'b')")
            .await
            .expect("insert");

        let table = TableRef {
            database: Some("master".into()),
            schema: Some("dbo".into()),
            name: "pk_test".into(),
        };
        let cols = vec!["id".to_string()];

        // 계획: 차단 사유 없이 NOT NULL 경고가 붙어야 한다.
        let plan = d.plan_primary_key(&table, &cols).await.expect("plan");
        println!("[plan] {:?}", plan.statements);
        assert!(plan.blockers.is_empty(), "차단됨: {:?}", plan.blockers);
        assert!(!plan.warnings.is_empty(), "NOT NULL 경고가 없다");

        d.apply_primary_key(&table, &cols).await.expect("apply");
        assert_eq!(d.primary_keys(&table).await.unwrap(), vec!["id"]);

        // 이미 PK 가 있으면 막아야 한다.
        let again = d.plan_primary_key(&table, &cols).await.expect("replan");
        assert!(!again.blockers.is_empty(), "기존 PK 를 감지하지 못했다");
        println!("[재지정 차단] {:?}", again.blockers);
    }

    /// NULL·중복이 있으면 DDL 을 실행하기 전에 막아야 한다.
    #[tokio::test]
    #[ignore]
    async fn primary_key_blocked_by_data() {
        let d = MssqlDriver::connect(&test_config()).await.expect("연결");
        d.simple_rows("IF OBJECT_ID('dbo.pk_bad') IS NOT NULL DROP TABLE dbo.pk_bad")
            .await
            .expect("drop");
        d.simple_rows("CREATE TABLE dbo.pk_bad (id INT NULL, dup INT NULL)")
            .await
            .expect("create");
        d.simple_rows("INSERT INTO dbo.pk_bad VALUES (NULL,7),(1,7)")
            .await
            .expect("insert");

        let table = TableRef {
            database: Some("master".into()),
            schema: Some("dbo".into()),
            name: "pk_bad".into(),
        };

        let null_plan = d
            .plan_primary_key(&table, &["id".to_string()])
            .await
            .expect("plan");
        println!("[NULL] {:?}", null_plan.blockers);
        assert!(null_plan.blockers.iter().any(|b| b.contains("NULL")));

        let dup_plan = d
            .plan_primary_key(&table, &["dup".to_string()])
            .await
            .expect("plan");
        println!("[중복] {:?}", dup_plan.blockers);
        assert!(dup_plan.blockers.iter().any(|b| b.contains("유일")));

        // 차단 상태에서 적용하면 DDL 이 실행되지 않아야 한다.
        assert!(d
            .apply_primary_key(&table, &["id".to_string()])
            .await
            .is_err());
        assert!(d.primary_keys(&table).await.unwrap().is_empty());
    }

    /// macOS 스마트 인용부호(U+2018)가 섞인 조건은 SQL Server 가 구문 오류(102)로 거부한다.
    /// 프론트(`src/lib/sqlText.ts`)에서 ASCII 따옴표로 정규화하는 이유를 고정한다.
    #[tokio::test]
    #[ignore]
    async fn smart_quote_breaks_query() {
        let d = MssqlDriver::connect(&test_config()).await.expect("연결");
        d.simple_rows("IF OBJECT_ID('dbo.con_test2') IS NOT NULL DROP TABLE dbo.con_test2")
            .await
            .expect("drop");
        d.simple_rows("CREATE TABLE dbo.con_test2 (con_code NVARCHAR(50))")
            .await
            .expect("create");
        d.simple_rows("INSERT INTO dbo.con_test2 VALUES ('A0018-1')")
            .await
            .expect("insert");

        // 여는 따옴표만 U+2018 로 바뀐 상태 — 실제 사용자 입력에서 관측된 형태.
        let broken = d
            .fetch_page(&FetchPageRequest {
                conn_id: "t".into(),
                filter_sql: Some("con_code like \u{2018}A0018%'".into()),
                table: TableRef {
                    database: Some("master".into()),
                    schema: Some("dbo".into()),
                    name: "con_test2".into(),
                },
                limit: 200,
                offset: 0,
                sort: vec![],
                filters: vec![],
            })
            .await;
        let msg = broken
            .expect_err("스마트 따옴표는 실패해야 한다")
            .to_string();
        println!("[smart quote] {msg}");
        assert!(msg.contains("102"), "구문 오류(102)가 아님: {msg}");

        // 같은 조건을 ASCII 따옴표로 정규화하면 정상 조회된다.
        let fixed = d
            .fetch_page(&FetchPageRequest {
                conn_id: "t".into(),
                filter_sql: Some("con_code like 'A0018%'".into()),
                table: TableRef {
                    database: Some("master".into()),
                    schema: Some("dbo".into()),
                    name: "con_test2".into(),
                },
                limit: 200,
                offset: 0,
                sort: vec![],
                filters: vec![],
            })
            .await
            .expect("정규화 후에는 성공");
        assert_eq!(fixed.result.rows.len(), 1);
    }
}
