//! DB 네이티브 값 ↔ `serde_json::Value` 변환.
//!
//! 드라이버는 컴파일타임에 컬럼 타입을 모르므로, 런타임 타입명으로 분기해
//! 각 셀을 균일한 `serde_json::Value` 로 변환한다. 정밀도 손실 위험 타입
//! (NUMERIC, BIGINT, UUID, 시간대 등)은 **문자열로 보존**한다.

use crate::models::LogicalType;
use serde_json::Value;
use sqlx::{Column, Row, TypeInfo, ValueRef};

// ============================================================
// 논리 타입 매핑 (DB 타입명 → LogicalType)
// ============================================================

pub fn pg_logical(name: &str) -> LogicalType {
    let n = name.to_uppercase();
    if n.ends_with("[]") {
        return LogicalType::Array;
    }
    match n.as_str() {
        "BOOL" => LogicalType::Bool,
        "INT2" | "INT4" | "INT8" | "OID" => LogicalType::Int,
        "FLOAT4" | "FLOAT8" => LogicalType::Float,
        "NUMERIC" | "MONEY" => LogicalType::Decimal,
        "TEXT" | "VARCHAR" | "BPCHAR" | "CHAR" | "NAME" | "CITEXT" => LogicalType::String,
        "UUID" => LogicalType::Uuid,
        "JSON" | "JSONB" => LogicalType::Json,
        "DATE" => LogicalType::Date,
        "TIME" | "TIMETZ" => LogicalType::Time,
        "TIMESTAMP" | "TIMESTAMPTZ" => LogicalType::Datetime,
        "BYTEA" => LogicalType::Bytes,
        _ => LogicalType::Unknown,
    }
}

pub fn mysql_logical(name: &str) -> LogicalType {
    let n = name.to_uppercase();
    let base = n.split_whitespace().next().unwrap_or(&n); // "INT UNSIGNED" → "INT"
    match base {
        "BOOLEAN" | "BOOL" | "BIT" => LogicalType::Bool,
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "INTEGER" | "BIGINT" | "YEAR" => {
            LogicalType::Int
        }
        "FLOAT" | "DOUBLE" => LogicalType::Float,
        "DECIMAL" | "DEC" | "NUMERIC" => LogicalType::Decimal,
        "CHAR" | "VARCHAR" | "TEXT" | "TINYTEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET" => {
            LogicalType::String
        }
        "JSON" => LogicalType::Json,
        "DATE" => LogicalType::Date,
        "TIME" => LogicalType::Time,
        "DATETIME" | "TIMESTAMP" => LogicalType::Datetime,
        "BINARY" | "VARBINARY" | "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" => {
            LogicalType::Bytes
        }
        _ => LogicalType::Unknown,
    }
}

pub fn sqlite_logical(name: &str) -> LogicalType {
    let n = name.to_uppercase();
    // SQLite 는 타입 친화도(affinity) 기반. 부분 문자열로 판정.
    if n.contains("INT") {
        LogicalType::Int
    } else if n.contains("BOOL") {
        LogicalType::Bool
    } else if n.contains("REAL") || n.contains("FLOA") || n.contains("DOUB") {
        LogicalType::Float
    } else if n.contains("NUMERIC") || n.contains("DECIMAL") {
        LogicalType::Decimal
    } else if n.contains("CHAR") || n.contains("CLOB") || n.contains("TEXT") {
        LogicalType::String
    } else if n.contains("BLOB") || n.is_empty() {
        LogicalType::Bytes
    } else if n.contains("DATE") || n.contains("TIME") {
        LogicalType::Datetime
    } else if n.contains("JSON") {
        LogicalType::Json
    } else {
        LogicalType::Unknown
    }
}

pub fn mssql_logical(name: &str) -> LogicalType {
    let n = name.to_uppercase();
    match n.as_str() {
        "BIT" => LogicalType::Bool,
        "TINYINT" | "SMALLINT" | "INT" | "BIGINT" => LogicalType::Int,
        "REAL" | "FLOAT" => LogicalType::Float,
        "DECIMAL" | "NUMERIC" | "MONEY" | "SMALLMONEY" => LogicalType::Decimal,
        "CHAR" | "VARCHAR" | "NCHAR" | "NVARCHAR" | "TEXT" | "NTEXT" | "XML" => LogicalType::String,
        "UNIQUEIDENTIFIER" => LogicalType::Uuid,
        "DATE" => LogicalType::Date,
        "TIME" => LogicalType::Time,
        "DATETIME" | "DATETIME2" | "SMALLDATETIME" | "DATETIMEOFFSET" => LogicalType::Datetime,
        "BINARY" | "VARBINARY" | "IMAGE" => LogicalType::Bytes,
        _ => LogicalType::Unknown,
    }
}

// ============================================================
// 셀 디코딩 (Row + index → Value)
// ============================================================

macro_rules! decode {
    // 지정 타입으로 시도하고 실패하면 Null.
    ($row:expr, $i:expr, $ty:ty) => {
        $row.try_get::<$ty, _>($i)
            .ok()
            .map(Value::from)
            .unwrap_or(Value::Null)
    };
    // map 변환(예: to_string) 을 적용.
    ($row:expr, $i:expr, $ty:ty, $f:expr) => {
        $row.try_get::<$ty, _>($i)
            .ok()
            .map($f)
            .unwrap_or(Value::Null)
    };
}

pub fn pg_cell(row: &sqlx::postgres::PgRow, i: usize) -> Value {
    if row.try_get_raw(i).map(|v| v.is_null()).unwrap_or(true) {
        return Value::Null;
    }
    let ty = row.column(i).type_info().name().to_uppercase();
    match ty.as_str() {
        "BOOL" => decode!(row, i, bool),
        "INT2" => decode!(row, i, i16),
        "INT4" | "OID" => decode!(row, i, i32),
        "INT8" => decode!(row, i, i64),
        "FLOAT4" => decode!(row, i, f32),
        "FLOAT8" => decode!(row, i, f64),
        "NUMERIC" => decode!(row, i, rust_decimal::Decimal, |d| Value::String(
            d.to_string()
        )),
        "TEXT" | "VARCHAR" | "BPCHAR" | "CHAR" | "NAME" | "CITEXT" => decode!(row, i, String),
        "UUID" => decode!(row, i, uuid::Uuid, |u| Value::String(u.to_string())),
        "JSON" | "JSONB" => row.try_get::<Value, _>(i).unwrap_or(Value::Null),
        "DATE" => decode!(row, i, chrono::NaiveDate, |d| Value::String(d.to_string())),
        "TIME" => decode!(row, i, chrono::NaiveTime, |t| Value::String(t.to_string())),
        "TIMESTAMP" => {
            decode!(row, i, chrono::NaiveDateTime, |t| Value::String(
                t.to_string()
            ))
        }
        "TIMESTAMPTZ" => decode!(row, i, chrono::DateTime<chrono::Utc>, |t| Value::String(
            t.to_rfc3339()
        )),
        "BYTEA" => decode!(row, i, Vec<u8>, |b| Value::String(hex_preview(&b))),
        _ => string_fallback_pg(row, i),
    }
}

fn string_fallback_pg(row: &sqlx::postgres::PgRow, i: usize) -> Value {
    row.try_get::<String, _>(i)
        .map(Value::String)
        .unwrap_or(Value::Null)
}

pub fn mysql_cell(row: &sqlx::mysql::MySqlRow, i: usize) -> Value {
    if row.try_get_raw(i).map(|v| v.is_null()).unwrap_or(true) {
        return Value::Null;
    }
    let raw = row.column(i).type_info().name().to_uppercase();
    let base = raw.split_whitespace().next().unwrap_or(&raw);
    match base {
        "BOOLEAN" | "BOOL" => decode!(row, i, bool),
        "TINYINT" => decode!(row, i, i8),
        "SMALLINT" => decode!(row, i, i16),
        "INT" | "INTEGER" | "MEDIUMINT" | "YEAR" => decode!(row, i, i32),
        "BIGINT" => decode!(row, i, i64),
        "FLOAT" => decode!(row, i, f32),
        "DOUBLE" => decode!(row, i, f64),
        "DECIMAL" | "DEC" | "NUMERIC" => {
            decode!(row, i, rust_decimal::Decimal, |d| Value::String(
                d.to_string()
            ))
        }
        "CHAR" | "VARCHAR" | "TEXT" | "TINYTEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET" => {
            decode!(row, i, String)
        }
        "JSON" => row.try_get::<Value, _>(i).unwrap_or(Value::Null),
        "DATE" => decode!(row, i, chrono::NaiveDate, |d| Value::String(d.to_string())),
        "TIME" => decode!(row, i, chrono::NaiveTime, |t| Value::String(t.to_string())),
        "DATETIME" | "TIMESTAMP" => {
            decode!(row, i, chrono::NaiveDateTime, |t| Value::String(
                t.to_string()
            ))
        }
        "BINARY" | "VARBINARY" | "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "BIT" => {
            decode!(row, i, Vec<u8>, |b| Value::String(hex_preview(&b)))
        }
        _ => row
            .try_get::<String, _>(i)
            .map(Value::String)
            .unwrap_or(Value::Null),
    }
}

pub fn sqlite_cell(row: &sqlx::sqlite::SqliteRow, i: usize) -> Value {
    if row.try_get_raw(i).map(|v| v.is_null()).unwrap_or(true) {
        return Value::Null;
    }
    let name = row.column(i).type_info().name().to_uppercase();
    match sqlite_logical(&name) {
        LogicalType::Int | LogicalType::Bool => row
            .try_get::<i64, _>(i)
            .map(Value::from)
            .or_else(|_| row.try_get::<f64, _>(i).map(Value::from))
            .or_else(|_| row.try_get::<String, _>(i).map(Value::String))
            .unwrap_or(Value::Null),
        LogicalType::Float => decode!(row, i, f64),
        LogicalType::Bytes => row
            .try_get::<Vec<u8>, _>(i)
            .map(|b| Value::String(hex_preview(&b)))
            .or_else(|_| row.try_get::<String, _>(i).map(Value::String))
            .unwrap_or(Value::Null),
        _ => row
            .try_get::<String, _>(i)
            .map(Value::String)
            .or_else(|_| row.try_get::<i64, _>(i).map(Value::from))
            .or_else(|_| row.try_get::<f64, _>(i).map(Value::from))
            .unwrap_or(Value::Null),
    }
}

/// 바이너리는 그리드 표시를 위해 hex 프리뷰 문자열로 변환한다(대용량은 잘라냄).
pub(crate) fn hex_preview(bytes: &[u8]) -> String {
    const MAX: usize = 64;
    let shown: String = bytes.iter().take(MAX).map(|b| format!("{b:02x}")).collect();
    if bytes.len() > MAX {
        format!("0x{shown}… ({} bytes)", bytes.len())
    } else {
        format!("0x{shown}")
    }
}

// ============================================================
// serde_json::Value → sqlx 바인딩
// ============================================================
//
// 구체 DB 타입(PgArguments 등)이 필요한 trait bound 문제를 피하기 위해
// 제네릭 함수 대신 매크로로 각 드라이버의 구체 컨텍스트에서 확장한다.
// JSON 타입 기반 best-effort 바인딩: 컬럼의 실제 타입과 다르면 DB가 오류를
// 반환할 수 있으며(특히 Postgres), 이는 사용자에게 그대로 전달된다.

/// `bind_json!(query, &value)` — query 에 value 를 바인딩해 반환.
macro_rules! bind_json {
    ($q:expr, $v:expr) => {{
        match $v {
            serde_json::Value::Null => $q.bind(Option::<String>::None),
            serde_json::Value::Bool(b) => $q.bind(*b),
            serde_json::Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    $q.bind(i)
                } else if let Some(u) = n.as_u64() {
                    $q.bind(u as i64)
                } else {
                    $q.bind(n.as_f64().unwrap_or(0.0))
                }
            }
            serde_json::Value::String(s) => $q.bind(s.clone()),
            other => $q.bind(other.to_string()),
        }
    }};
}

pub(crate) use bind_json;
