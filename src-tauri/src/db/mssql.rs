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
        let rows = self.query_rows(&built.sql, &built.params).await?;
        let result = rows_to_result(&rows, start.elapsed().as_millis() as u64, false);

        let primary_keys = self.primary_keys(&req.table).await.unwrap_or_default();

        let cbuilt = sql::build_count(&DIALECT, req);
        let crows = self.query_rows(&cbuilt.sql, &cbuilt.params).await?;
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

        let empty: Vec<&dyn ToSql> = Vec::new();
        let mut guard = self.client.lock().await;
        guard.execute("BEGIN TRANSACTION", &empty).await?;

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
                    let _ = guard.execute("ROLLBACK", &empty).await;
                    return Err(e.into());
                }
            }
        }
        guard.execute("COMMIT", &empty).await?;
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
