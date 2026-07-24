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

/// 기존 테이블에 기본 키를 추가하는 방식.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum PkStyle {
    /// `ALTER TABLE t ADD PRIMARY KEY (...)` — NULL 컬럼은 DB 가 알아서 NOT NULL 로 바꾼다.
    /// (PostgreSQL, MySQL)
    AddPrimaryKey,
    /// 컬럼을 먼저 NOT NULL 로 바꾼 뒤 명명된 제약을 추가한다. (SQL Server)
    AlterThenConstraint,
    /// 기존 테이블에 추가할 수 없다(테이블 재생성 필요). (SQLite)
    Unsupported,
}

/// 테이블 한정 방식.
#[derive(Clone, Copy)]
#[allow(clippy::enum_variant_names)] // …Table 접미사는 의도된 것
pub enum Naming {
    /// `"schema"."table"` (PG/SQLite) — database 무시
    SchemaTable,
    /// `[db].[schema].[table]` (SQL Server)
    DbSchemaTable,
    /// `` `db`.`table` `` (MySQL — database 가 곧 스키마)
    DbTable,
}

#[derive(Clone, Copy)]
pub struct Dialect {
    pub quote_open: char,
    pub quote_close: char,
    pub placeholder: Placeholder,
    pub limit_style: LimitStyle,
    pub naming: Naming,
    pub pk_style: PkStyle,
}

impl Dialect {
    pub const POSTGRES: Dialect = Dialect {
        quote_open: '"',
        quote_close: '"',
        placeholder: Placeholder::Numbered("$"),
        limit_style: LimitStyle::LimitOffset,
        naming: Naming::SchemaTable,
        pk_style: PkStyle::AddPrimaryKey,
    };
    pub const MYSQL: Dialect = Dialect {
        quote_open: '`',
        quote_close: '`',
        placeholder: Placeholder::Question,
        limit_style: LimitStyle::LimitOffset,
        naming: Naming::DbTable,
        pk_style: PkStyle::AddPrimaryKey,
    };
    pub const SQLITE: Dialect = Dialect {
        quote_open: '"',
        quote_close: '"',
        placeholder: Placeholder::Question,
        limit_style: LimitStyle::LimitOffset,
        naming: Naming::SchemaTable,
        pk_style: PkStyle::Unsupported,
    };
    pub const MSSQL: Dialect = Dialect {
        quote_open: '[',
        quote_close: ']',
        placeholder: Placeholder::Numbered("@P"),
        limit_style: LimitStyle::OffsetFetch,
        naming: Naming::DbSchemaTable,
        pk_style: PkStyle::AlterThenConstraint,
    };

    /// 식별자 quoting. 닫는 따옴표는 두 번 반복해 이스케이프.
    pub fn quote_ident(&self, ident: &str) -> String {
        let esc = ident.replace(self.quote_close, &format!("{0}{0}", self.quote_close));
        format!("{}{}{}", self.quote_open, esc, self.quote_close)
    }

    /// database/schema 를 반영한 한정 테이블명.
    pub fn qualify(&self, t: &TableRef) -> String {
        let db = t.database.as_deref().filter(|s| !s.is_empty());
        let schema = t.schema.as_deref().filter(|s| !s.is_empty());
        let name = self.quote_ident(&t.name);
        match self.naming {
            Naming::DbSchemaTable => match (db, schema) {
                (Some(d), Some(s)) => {
                    format!("{}.{}.{}", self.quote_ident(d), self.quote_ident(s), name)
                }
                (Some(d), None) => {
                    format!(
                        "{}.{}.{}",
                        self.quote_ident(d),
                        self.quote_ident("dbo"),
                        name
                    )
                }
                (None, Some(s)) => format!("{}.{}", self.quote_ident(s), name),
                (None, None) => name,
            },
            Naming::DbTable => match db.or(schema) {
                Some(d) => format!("{}.{}", self.quote_ident(d), name),
                None => name,
            },
            Naming::SchemaTable => match schema {
                Some(s) => format!("{}.{}", self.quote_ident(s), name),
                None => name,
            },
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
/// `raw` 는 사용자가 직접 입력한 조건식(그대로 삽입).
fn build_where(
    d: &Dialect,
    filters: &[FilterSpec],
    raw: Option<&str>,
    next: &mut usize,
) -> (String, Vec<Value>) {
    let mut clauses = Vec::new();
    let mut params = Vec::new();
    if let Some(r) = raw.map(str::trim).filter(|r| !r.is_empty()) {
        clauses.push(format!("({r})"));
    }
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
    let (where_sql, params) = build_where(d, &req.filters, req.filter_sql.as_deref(), &mut next);

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

/// 기본 키 추가 DDL. 방언별 차이는 [`PkStyle`] 에 가둬 둔다.
///
/// `cols` 는 대상 테이블의 컬럼 메타(NOT NULL 변환에 원본 타입이 필요한 방언이 있다).
/// 지원하지 않는 방언이면 빈 목록을 돌려주고, 사유는 호출부가 [`PkStyle`] 로 판단한다.
pub fn build_set_primary_key(
    d: &Dialect,
    table: &TableRef,
    columns: &[String],
    cols: &[ColumnInfo],
) -> Result<Vec<String>> {
    if columns.is_empty() {
        return Err(AppError::Validation(
            "기본 키로 지정할 컬럼을 선택하세요".into(),
        ));
    }
    let qtable = d.qualify(table);
    let cols_sql = columns
        .iter()
        .map(|c| d.quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ");

    Ok(match d.pk_style {
        PkStyle::Unsupported => Vec::new(),
        PkStyle::AddPrimaryKey => {
            vec![format!("ALTER TABLE {qtable} ADD PRIMARY KEY ({cols_sql})")]
        }
        PkStyle::AlterThenConstraint => {
            // SQL Server 는 PK 컬럼이 이미 NOT NULL 이어야 하므로 먼저 바꾼다.
            let mut out = Vec::new();
            for name in columns {
                let meta = cols.iter().find(|c| &c.name == name).ok_or_else(|| {
                    AppError::Validation(format!("컬럼 '{name}' 을 찾을 수 없습니다"))
                })?;
                if meta.nullable {
                    out.push(format!(
                        "ALTER TABLE {qtable} ALTER COLUMN {} {} NOT NULL",
                        d.quote_ident(name),
                        meta.db_type
                    ));
                }
            }
            // 제약 이름은 테이블명 기반으로 만든다(식별자 규칙상 quoting 필요).
            let pk_name = d.quote_ident(&format!("PK_{}", table.name));
            out.push(format!(
                "ALTER TABLE {qtable} ADD CONSTRAINT {pk_name} PRIMARY KEY ({cols_sql})"
            ));
            out
        }
    })
}

/// PK 후보 컬럼에 NULL 이 몇 건 있는지 세는 SELECT.
pub fn build_null_count(d: &Dialect, table: &TableRef, column: &str) -> String {
    format!(
        "SELECT COUNT(*) FROM {} WHERE {} IS NULL",
        d.qualify(table),
        d.quote_ident(column)
    )
}

/// PK 후보 조합이 중복되는 그룹 수를 세는 SELECT(0 이어야 PK 로 쓸 수 있다).
pub fn build_duplicate_count(d: &Dialect, table: &TableRef, columns: &[String]) -> String {
    let cols_sql = columns
        .iter()
        .map(|c| d.quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "SELECT COUNT(*) FROM (SELECT {cols_sql} FROM {} GROUP BY {cols_sql} HAVING COUNT(*) > 1) AS dup_check",
        d.qualify(table)
    )
}

/// 필터 조건에 맞는 전체 행 수 COUNT.
pub fn build_count(d: &Dialect, req: &FetchPageRequest) -> Built {
    let table = d.qualify(&req.table);
    let mut next = 1usize;
    let (where_sql, params) = build_where(d, &req.filters, req.filter_sql.as_deref(), &mut next);
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
            filter_sql: None,
            table: TableRef {
                database: None,
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
            filter_sql: None,
            table: TableRef {
                database: None,
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
    fn filter_sql_is_inlined_as_written() {
        let req = FetchPageRequest {
            conn_id: "c".into(),
            filter_sql: Some("con_code like 'A0018%'".into()),
            table: TableRef {
                database: None,
                schema: Some("public".into()),
                name: "contract".into(),
            },
            limit: 100,
            offset: 0,
            sort: vec![],
            filters: vec![],
        };
        let b = build_fetch(&Dialect::POSTGRES, &req);
        assert_eq!(
            b.sql,
            r#"SELECT * FROM "public"."contract" WHERE (con_code like 'A0018%') LIMIT 100 OFFSET 0"#
        );
        assert!(b.params.is_empty());

        let c = build_count(&Dialect::POSTGRES, &req);
        assert_eq!(
            c.sql,
            r#"SELECT COUNT(*) FROM "public"."contract" WHERE (con_code like 'A0018%')"#
        );

        // 방언별로도 WHERE 본문은 손대지 않는다.
        for d in [Dialect::MYSQL, Dialect::SQLITE, Dialect::MSSQL] {
            assert!(build_fetch(&d, &req)
                .sql
                .contains("(con_code like 'A0018%')"));
        }
    }

    fn col(name: &str, ty: &str, nullable: bool) -> ColumnInfo {
        ColumnInfo {
            name: name.into(),
            db_type: ty.into(),
            logical_type: LogicalType::Int,
            nullable,
            is_primary_key: false,
            default: None,
            ordinal: 1,
        }
    }

    fn t(name: &str) -> TableRef {
        TableRef {
            database: None,
            schema: Some("dbo".into()),
            name: name.into(),
        }
    }

    #[test]
    fn pk_ddl_per_dialect() {
        let cols = vec![col("id", "INT", true), col("sub", "INT", false)];
        let want = vec!["id".to_string()];

        // PG/MySQL: 한 문장. NULL 은 DB 가 알아서 NOT NULL 로 바꾼다.
        let pg = build_set_primary_key(&Dialect::POSTGRES, &t("u"), &want, &cols).unwrap();
        assert_eq!(pg, vec![r#"ALTER TABLE "dbo"."u" ADD PRIMARY KEY ("id")"#]);

        // SQL Server: nullable 컬럼을 먼저 NOT NULL 로 바꾸고 명명 제약을 붙인다.
        let ms = build_set_primary_key(&Dialect::MSSQL, &t("u"), &want, &cols).unwrap();
        assert_eq!(
            ms,
            vec![
                "ALTER TABLE [dbo].[u] ALTER COLUMN [id] INT NOT NULL".to_string(),
                "ALTER TABLE [dbo].[u] ADD CONSTRAINT [PK_u] PRIMARY KEY ([id])".to_string(),
            ]
        );

        // 이미 NOT NULL 인 컬럼은 ALTER COLUMN 을 만들지 않는다.
        let ms2 =
            build_set_primary_key(&Dialect::MSSQL, &t("u"), &["sub".to_string()], &cols).unwrap();
        assert_eq!(ms2.len(), 1, "불필요한 ALTER COLUMN 이 섞였다: {ms2:?}");

        // SQLite 는 지원하지 않으므로 빈 목록.
        assert!(
            build_set_primary_key(&Dialect::SQLITE, &t("u"), &want, &cols)
                .unwrap()
                .is_empty()
        );

        // 컬럼 미선택은 검증 오류.
        assert!(build_set_primary_key(&Dialect::POSTGRES, &t("u"), &[], &cols).is_err());
    }

    #[test]
    fn pk_ddl_composite_and_quoting() {
        let cols = vec![col("a", "INT", false), col(r#"we"ird"#, "INT", false)];
        let want = vec!["a".to_string(), r#"we"ird"#.to_string()];
        let pg = build_set_primary_key(&Dialect::POSTGRES, &t("u"), &want, &cols).unwrap();
        assert_eq!(
            pg,
            vec![r#"ALTER TABLE "dbo"."u" ADD PRIMARY KEY ("a", "we""ird")"#]
        );
    }

    #[test]
    fn pk_validation_queries() {
        assert_eq!(
            build_null_count(&Dialect::POSTGRES, &t("u"), "id"),
            r#"SELECT COUNT(*) FROM "dbo"."u" WHERE "id" IS NULL"#
        );
        // 중복 검사는 서브쿼리 별칭이 있어야 MySQL/SQL Server 에서 동작한다.
        let dup = build_duplicate_count(&Dialect::MYSQL, &t("u"), &["a".into(), "b".into()]);
        assert!(dup.contains("GROUP BY `a`, `b`"), "{dup}");
        assert!(dup.contains("AS dup_check"), "{dup}");
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
                database: None,
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
