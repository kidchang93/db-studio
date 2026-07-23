//! 방언(dialect)별 SQL 생성 헬퍼.
//!
//! 값은 항상 파라미터 바인딩(`params` 로 반환), 식별자는 방언별 quoting.
//! 정렬/필터/페이지네이션과 CRUD 문장 생성을 한 곳에 모아 드라이버 중복을 없앤다.

use crate::error::{AppError, Result};
use crate::models::*;
use serde_json::Value;
use std::collections::BTreeMap;

/// 파라미터 플레이스홀더 스타일.
#[derive(Clone, Copy)]
pub enum Placeholder {
    /// `?` (MySQL, SQLite)
    Question,
    /// `$1`, `$2` … (Postgres) 또는 `@P1` … (SQL Server)
    Numbered(&'static str),
}

/// LIMIT/OFFSET 문법 스타일.
#[derive(Clone, Copy)]
pub enum LimitStyle {
    /// `LIMIT n OFFSET m` (PG/MySQL/SQLite)
    LimitOffset,
    /// `OFFSET m ROWS FETCH NEXT n ROWS ONLY` (SQL Server, ORDER BY 필수)
    OffsetFetch,
}

#[derive(Clone, Copy)]
pub struct Dialect {
    pub quote_open: char,
    pub quote_close: char,
    pub placeholder: Placeholder,
    pub limit_style: LimitStyle,
}

impl Dialect {
    pub const POSTGRES: Dialect = Dialect {
        quote_open: '"',
        quote_close: '"',
        placeholder: Placeholder::Numbered("$"),
        limit_style: LimitStyle::LimitOffset,
    };
    pub const MYSQL: Dialect = Dialect {
        quote_open: '`',
        quote_close: '`',
        placeholder: Placeholder::Question,
        limit_style: LimitStyle::LimitOffset,
    };
    pub const SQLITE: Dialect = Dialect {
        quote_open: '"',
        quote_close: '"',
        placeholder: Placeholder::Question,
        limit_style: LimitStyle::LimitOffset,
    };
    pub const MSSQL: Dialect = Dialect {
        quote_open: '[',
        quote_close: ']',
        placeholder: Placeholder::Numbered("@P"),
        limit_style: LimitStyle::OffsetFetch,
    };

    /// 식별자 quoting. 닫는 따옴표는 두 번 반복해 이스케이프.
    pub fn quote_ident(&self, ident: &str) -> String {
        let esc = ident.replace(self.quote_close, &format!("{0}{0}", self.quote_close));
        format!("{}{}{}", self.quote_open, esc, self.quote_close)
    }

    /// 스키마 한정 테이블명.
    pub fn qualify(&self, t: &TableRef) -> String {
        match &t.schema {
            Some(s) if !s.is_empty() => {
                format!("{}.{}", self.quote_ident(s), self.quote_ident(&t.name))
            }
            _ => self.quote_ident(&t.name),
        }
    }

    fn placeholder(&self, n: usize) -> String {
        match self.placeholder {
            Placeholder::Question => "?".to_string(),
            Placeholder::Numbered(prefix) => format!("{prefix}{n}"),
        }
    }
}

/// 생성된 SQL 과 바인딩 순서대로의 파라미터.
pub struct Built {
    pub sql: String,
    pub params: Vec<Value>,
}

fn cmp_op(op: &str) -> Option<&'static str> {
    match op {
        "=" => Some("="),
        "!=" | "<>" => Some("<>"),
        "<" => Some("<"),
        ">" => Some(">"),
        "<=" => Some("<="),
        ">=" => Some(">="),
        "like" => Some("LIKE"),
        _ => None,
    }
}

/// WHERE 절과 파라미터를 만든다. `next` 는 시작 플레이스홀더 인덱스(1-base).
fn build_where(d: &Dialect, filters: &[FilterSpec], next: &mut usize) -> (String, Vec<Value>) {
    let mut clauses = Vec::new();
    let mut params = Vec::new();
    for f in filters {
        let col = d.quote_ident(&f.column);
        match f.op.as_str() {
            "isnull" => clauses.push(format!("{col} IS NULL")),
            "notnull" => clauses.push(format!("{col} IS NOT NULL")),
            other => {
                let sqlop = cmp_op(other).unwrap_or("=");
                let ph = d.placeholder(*next);
                *next += 1;
                clauses.push(format!("{col} {sqlop} {ph}"));
                params.push(f.value.clone());
            }
        }
    }
    if clauses.is_empty() {
        (String::new(), params)
    } else {
        (format!(" WHERE {}", clauses.join(" AND ")), params)
    }
}

/// 페이지 조회 SELECT. LIMIT/OFFSET 값은 서버가 통제하는 정수이므로 리터럴로 인라인한다.
pub fn build_fetch(d: &Dialect, req: &FetchPageRequest) -> Built {
    let table = d.qualify(&req.table);
    let mut next = 1usize;
    let (where_sql, params) = build_where(d, &req.filters, &mut next);

    let mut sql = format!("SELECT * FROM {table}{where_sql}");

    // ORDER BY
    if !req.sort.is_empty() {
        let parts: Vec<String> = req
            .sort
            .iter()
            .map(|s| {
                format!(
                    "{} {}",
                    d.quote_ident(&s.column),
                    if s.descending { "DESC" } else { "ASC" }
                )
            })
            .collect();
        sql.push_str(&format!(" ORDER BY {}", parts.join(", ")));
    } else if matches!(d.limit_style, LimitStyle::OffsetFetch) {
        // SQL Server OFFSET/FETCH 는 ORDER BY 를 요구한다.
        sql.push_str(" ORDER BY (SELECT NULL)");
    }

    // LIMIT/OFFSET
    match d.limit_style {
        LimitStyle::LimitOffset => {
            sql.push_str(&format!(" LIMIT {} OFFSET {}", req.limit, req.offset));
        }
        LimitStyle::OffsetFetch => {
            sql.push_str(&format!(
                " OFFSET {} ROWS FETCH NEXT {} ROWS ONLY",
                req.offset, req.limit
            ));
        }
    }

    Built { sql, params }
}

/// 필터 조건에 맞는 전체 행 수 COUNT.
pub fn build_count(d: &Dialect, req: &FetchPageRequest) -> Built {
    let table = d.qualify(&req.table);
    let mut next = 1usize;
    let (where_sql, params) = build_where(d, &req.filters, &mut next);
    Built {
        sql: format!("SELECT COUNT(*) FROM {table}{where_sql}"),
        params,
    }
}

pub fn build_insert(
    d: &Dialect,
    table: &TableRef,
    values: &BTreeMap<String, Value>,
) -> Result<Built> {
    if values.is_empty() {
        return Err(AppError::Validation("삽입할 값이 없습니다".into()));
    }
    let qtable = d.qualify(table);
    let mut cols = Vec::new();
    let mut phs = Vec::new();
    let mut params = Vec::new();
    for (i, (k, v)) in values.iter().enumerate() {
        cols.push(d.quote_ident(k));
        phs.push(d.placeholder(i + 1));
        params.push(v.clone());
    }
    Ok(Built {
        sql: format!(
            "INSERT INTO {qtable} ({}) VALUES ({})",
            cols.join(", "),
            phs.join(", ")
        ),
        params,
    })
}

pub fn build_update(
    d: &Dialect,
    table: &TableRef,
    pk: &BTreeMap<String, Value>,
    changes: &BTreeMap<String, Value>,
) -> Result<Built> {
    if pk.is_empty() {
        return Err(AppError::Validation(
            "PK 가 없어 UPDATE 를 만들 수 없습니다".into(),
        ));
    }
    if changes.is_empty() {
        return Err(AppError::Validation("변경할 값이 없습니다".into()));
    }
    let qtable = d.qualify(table);
    let mut n = 1usize;
    let mut sets = Vec::new();
    let mut params = Vec::new();
    for (k, v) in changes {
        sets.push(format!("{} = {}", d.quote_ident(k), d.placeholder(n)));
        n += 1;
        params.push(v.clone());
    }
    let where_sql = build_pk_where(d, pk, &mut n, &mut params);
    Ok(Built {
        sql: format!("UPDATE {qtable} SET {} WHERE {where_sql}", sets.join(", ")),
        params,
    })
}

pub fn build_delete(d: &Dialect, table: &TableRef, pk: &BTreeMap<String, Value>) -> Result<Built> {
    if pk.is_empty() {
        return Err(AppError::Validation(
            "PK 가 없어 DELETE 를 만들 수 없습니다".into(),
        ));
    }
    let qtable = d.qualify(table);
    let mut n = 1usize;
    let mut params = Vec::new();
    let where_sql = build_pk_where(d, pk, &mut n, &mut params);
    Ok(Built {
        sql: format!("DELETE FROM {qtable} WHERE {where_sql}"),
        params,
    })
}

fn build_pk_where(
    d: &Dialect,
    pk: &BTreeMap<String, Value>,
    n: &mut usize,
    params: &mut Vec<Value>,
) -> String {
    let mut wheres = Vec::new();
    for (k, v) in pk {
        if v.is_null() {
            wheres.push(format!("{} IS NULL", d.quote_ident(k)));
        } else {
            wheres.push(format!("{} = {}", d.quote_ident(k), d.placeholder(*n)));
            *n += 1;
            params.push(v.clone());
        }
    }
    wheres.join(" AND ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_escapes_closing_char() {
        assert_eq!(Dialect::POSTGRES.quote_ident(r#"we"ird"#), r#""we""ird""#);
        assert_eq!(Dialect::MYSQL.quote_ident("a`b"), "`a``b`");
        assert_eq!(Dialect::MSSQL.quote_ident("a]b"), "[a]]b]");
    }

    #[test]
    fn fetch_pg_uses_numbered_placeholders_and_limit() {
        let req = FetchPageRequest {
            conn_id: "c".into(),
            table: TableRef {
                schema: Some("public".into()),
                name: "users".into(),
            },
            limit: 100,
            offset: 20,
            sort: vec![SortSpec {
                column: "id".into(),
                descending: true,
            }],
            filters: vec![FilterSpec {
                column: "age".into(),
                op: ">".into(),
                value: Value::from(18),
            }],
        };
        let b = build_fetch(&Dialect::POSTGRES, &req);
        assert_eq!(
            b.sql,
            r#"SELECT * FROM "public"."users" WHERE "age" > $1 ORDER BY "id" DESC LIMIT 100 OFFSET 20"#
        );
        assert_eq!(b.params, vec![Value::from(18)]);
    }

    #[test]
    fn mssql_uses_offset_fetch_and_requires_order() {
        let req = FetchPageRequest {
            conn_id: "c".into(),
            table: TableRef {
                schema: Some("dbo".into()),
                name: "t".into(),
            },
            limit: 50,
            offset: 0,
            sort: vec![],
            filters: vec![],
        };
        let b = build_fetch(&Dialect::MSSQL, &req);
        assert!(b.sql.contains("ORDER BY (SELECT NULL)"));
        assert!(b.sql.contains("OFFSET 0 ROWS FETCH NEXT 50 ROWS ONLY"));
    }

    #[test]
    fn update_sets_then_pk() {
        let mut pk = BTreeMap::new();
        pk.insert("id".to_string(), Value::from(7));
        let mut ch = BTreeMap::new();
        ch.insert("name".to_string(), Value::from("kim"));
        let b = build_update(
            &Dialect::SQLITE,
            &TableRef {
                schema: None,
                name: "u".into(),
            },
            &pk,
            &ch,
        )
        .unwrap();
        assert_eq!(b.sql, r#"UPDATE "u" SET "name" = ? WHERE "id" = ?"#);
        assert_eq!(b.params, vec![Value::from("kim"), Value::from(7)]);
    }
}
