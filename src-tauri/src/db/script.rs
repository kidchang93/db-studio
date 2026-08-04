//! 스크립트(여러 문장) 텍스트 훑기.
//!
//! SQL Server 전용이다. SSMS·DataGrip 에서 복사해 온 스크립트는 `GO` 로 배치를 나누는데
//! `GO` 는 T-SQL 문장이 아니라 **클라이언트 지시어**라 서버로 그대로 보내면
//! "Could not find stored procedure 'GO'" 로 실패한다. 보내기 전에 우리가 잘라야 한다.
//!
//! 문자열·주석 안의 내용은 절대 해석하지 않는다 — `'GO'` 나 `-- GO` 를 배치 구분자로
//! 오인하면 멀쩡한 스크립트가 쪼개진다.

use crate::models::ColumnMeta;

/// 결과셋을 돌려줄 수 있는 문장 키워드.
///
/// 애매한 것(`EXEC`·`CALL`)은 **여기에 둔다**. 잘못 넣으면 영향 행 수를 못 보는 데 그치지만,
/// 빼면 프로시저가 돌려준 결과셋이 통째로 사라진다.
const ROW_RETURNING: &[&str] = &[
    "select", "with", "exec", "execute", "call", "show", "print", "values", "table", "output",
];

/// 훑는 동안의 위치. 문자열·주석 안이면 구분자를 해석하지 않는다.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Ctx {
    Code,
    /// `'…'` 문자열.
    Quoted,
    /// `[…]` 또는 `"…"` 로 감싼 식별자.
    Bracket(char),
    /// `-- …` 줄 주석.
    LineComment,
    /// `/* … */` 블록 주석. 중첩 깊이를 센다(T-SQL 은 중첩을 허용한다).
    BlockComment(u32),
}

/// 스크립트를 `GO` 기준으로 배치로 나눈다. 빈 배치는 버린다.
///
/// `GO` 는 **줄 전체가** `GO`(뒤에 반복 횟수가 붙을 수 있다)일 때만 구분자다.
/// `GOTO` 같은 것을 자르지 않도록 낱말 경계를 확인한다. 반복 횟수(`GO 5`)는 무시하고
/// 한 번만 실행한다 — 성능 측정용 문법이라 DB 클라이언트에서 반복할 이유가 없고,
/// 조용히 여러 번 실행하는 쪽이 훨씬 위험하다.
pub fn split_batches(sql: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut ctx = Ctx::Code;
    // 지금 줄이 시작한 위치, 그리고 그 줄이 아직 `GO` 만으로 이루어져 있는지.
    let mut line_start = 0usize;

    let bytes = sql.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        let c = bytes[i] as char;
        let next = bytes.get(i + 1).map(|b| *b as char);

        match ctx {
            Ctx::Quoted => {
                if c == '\'' {
                    // `''` 는 이스케이프된 따옴표다.
                    if next == Some('\'') {
                        i += 2;
                        continue;
                    }
                    ctx = Ctx::Code;
                }
            }
            Ctx::Bracket(close) => {
                if c == close {
                    if c == '"' && next == Some('"') || c == ']' && next == Some(']') {
                        i += 2;
                        continue;
                    }
                    ctx = Ctx::Code;
                }
            }
            Ctx::LineComment => {
                if c == '\n' {
                    ctx = Ctx::Code;
                    line_start = i + 1;
                }
            }
            Ctx::BlockComment(depth) => {
                if c == '*' && next == Some('/') {
                    ctx = if depth <= 1 {
                        Ctx::Code
                    } else {
                        Ctx::BlockComment(depth - 1)
                    };
                    i += 2;
                    continue;
                }
                if c == '/' && next == Some('*') {
                    ctx = Ctx::BlockComment(depth + 1);
                    i += 2;
                    continue;
                }
            }
            Ctx::Code => match c {
                '\'' => ctx = Ctx::Quoted,
                '[' => ctx = Ctx::Bracket(']'),
                '"' => ctx = Ctx::Bracket('"'),
                '-' if next == Some('-') => {
                    ctx = Ctx::LineComment;
                    i += 2;
                    continue;
                }
                '/' if next == Some('*') => {
                    ctx = Ctx::BlockComment(1);
                    i += 2;
                    continue;
                }
                '\n' => line_start = i + 1,
                _ => {
                    // 줄 앞 공백만 지나온 자리에서 `GO` 를 만났는지 본다.
                    if (c == 'g' || c == 'G')
                        && sql[line_start..i].trim().is_empty()
                        && is_go_line(&sql[i..])
                    {
                        let end = sql[i..].find('\n').map(|n| i + n).unwrap_or(sql.len());
                        push_batch(&mut out, &sql[start..line_start]);
                        start = (end + 1).min(sql.len());
                        line_start = start;
                        i = start;
                        continue;
                    }
                }
            },
        }
        i += 1;
    }
    push_batch(&mut out, &sql[start..]);
    out
}

fn push_batch<'a>(out: &mut Vec<&'a str>, s: &'a str) {
    if !s.trim().is_empty() {
        out.push(s);
    }
}

/// `rest` 가 `GO`(+선택적 반복 횟수)로만 이루어진 줄로 시작하는가.
fn is_go_line(rest: &str) -> bool {
    let line = rest.split('\n').next().unwrap_or(rest);
    let mut w = line.split_whitespace();
    if !w.next().is_some_and(|k| k.eq_ignore_ascii_case("go")) {
        return false;
    }
    match w.next() {
        None => true,
        // `GO 5` 처럼 반복 횟수가 붙는 형태까지만 인정한다.
        Some(n) => n.chars().all(|c| c.is_ascii_digit()) && w.next().is_none(),
    }
}

/// 문장 안에서 만난 낱말 하나.
struct Word<'a> {
    text: &'a str,
    /// 배치 안 바이트 오프셋(낱말 시작).
    at: usize,
    /// 괄호 깊이. 0 이 아니면 서브쿼리·컬럼 목록 안이라 문장 구조로 치지 않는다.
    depth: i32,
    /// 문장이 시작되는 자리인가(배치 맨 앞 또는 최상위 `;` 뒤).
    stmt_start: bool,
}

/// 문자열·주석을 피해 낱말만 훑는다. 아래 판정들이 전부 이 결과 위에 얹힌다.
///
/// 문자열·주석 안을 해석하면 `'DELETE'` 나 `-- OUTPUT` 같은 것이 구조로 오인된다.
fn scan_words(sql: &str) -> Vec<Word<'_>> {
    let mut out = Vec::new();
    let mut ctx = Ctx::Code;
    let mut depth = 0i32;
    let mut stmt_start = true;

    let bytes = sql.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        let c = bytes[i] as char;
        let next = bytes.get(i + 1).map(|b| *b as char);
        match ctx {
            Ctx::Quoted => {
                if c == '\'' {
                    if next == Some('\'') {
                        i += 2;
                        continue;
                    }
                    ctx = Ctx::Code;
                }
            }
            Ctx::Bracket(close) => {
                if c == close {
                    ctx = Ctx::Code;
                }
            }
            Ctx::LineComment => {
                if c == '\n' {
                    ctx = Ctx::Code;
                }
            }
            Ctx::BlockComment(d) => {
                if c == '*' && next == Some('/') {
                    ctx = if d <= 1 {
                        Ctx::Code
                    } else {
                        Ctx::BlockComment(d - 1)
                    };
                    i += 2;
                    continue;
                }
                if c == '/' && next == Some('*') {
                    ctx = Ctx::BlockComment(d + 1);
                    i += 2;
                    continue;
                }
            }
            Ctx::Code => match c {
                '\'' => ctx = Ctx::Quoted,
                '[' => ctx = Ctx::Bracket(']'),
                '"' => ctx = Ctx::Bracket('"'),
                '-' if next == Some('-') => {
                    ctx = Ctx::LineComment;
                    i += 2;
                    continue;
                }
                '/' if next == Some('*') => {
                    ctx = Ctx::BlockComment(1);
                    i += 2;
                    continue;
                }
                '(' => depth += 1,
                ')' => depth = (depth - 1).max(0),
                ';' => stmt_start = true,
                _ if c.is_ascii_alphabetic() || c == '_' || c == '@' => {
                    let end = sql[i..]
                        .find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '@'))
                        .map(|n| i + n)
                        .unwrap_or(sql.len());
                    // `BEGIN`·`IF` 같은 제어문 뒤에는 다시 문장이 온다 — 시작 표시를 유지한다.
                    let is_control = matches!(
                        sql[i..end].to_ascii_lowercase().as_str(),
                        "begin" | "end" | "if" | "else" | "while" | "try" | "catch"
                    );
                    out.push(Word {
                        text: &sql[i..end],
                        at: i,
                        depth,
                        stmt_start: stmt_start && depth == 0 && !is_control,
                    });
                    if !is_control && depth == 0 {
                        stmt_start = false;
                    }
                    i = end;
                    continue;
                }
                _ => {}
            },
        }
        i += 1;
    }
    out
}

fn eq(w: &Word<'_>, kw: &str) -> bool {
    w.text.eq_ignore_ascii_case(kw)
}

/// 이 배치에 결과셋을 돌려줄 수 있는 문장이 하나라도 있는가.
///
/// 이 판단이 필요한 이유는 tiberius 의 한계다 — `simple_query` 는 결과셋만,
/// `execute` 는 영향 행 수만 준다. 둘을 함께 주는 API 가 없어 배치마다 골라야 한다.
/// **결과셋 쪽으로 치우쳐 판단한다**: 잘못 고르면 영향 행 수를 못 보는 데 그치지만,
/// 반대로 틀리면 사용자가 보려던 결과가 사라진다.
///
/// 쓰기 문장이라도 `OUTPUT`·`RETURNING` 이 붙어 있으면 결과셋을 돌려준다 —
/// 사용자가 직접 적었든 우리가 끼워 넣었든 그 결과를 놓치면 안 된다.
pub fn may_return_rows(batch: &str) -> bool {
    scan_words(batch).iter().any(|w| {
        (w.stmt_start && ROW_RETURNING.iter().any(|k| eq(w, k)))
            || (w.depth == 0 && (eq(w, "output") || eq(w, "returning")))
    })
}

/// 변경된 행을 돌려받는 절의 방언별 형태.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ChangeOutput {
    /// SQL Server `OUTPUT`. 문장 **중간**(FROM/WHERE 앞)에 들어가야 하고,
    /// UPDATE 는 `deleted.*, inserted.*` 로 **변경 전후를 모두** 받을 수 있다.
    Output,
    /// PostgreSQL·SQLite `RETURNING`. 문장 끝에 붙는다.
    /// UPDATE 는 **변경 후 값만** 준다 — 표준에 변경 전을 주는 방법이 없다.
    Returning,
    /// MySQL — 해당 문법이 없다.
    Unsupported,
}

/// 쓰기 문장에 변경 행 반환 절을 끼워 넣은 결과.
pub struct Rewrite {
    pub sql: String,
    /// 결과셋 순서대로, 그 결과셋이 **변경 전/후 쌍**인지(컬럼이 절반씩 나뉜다).
    pub before_after: Vec<bool>,
}

/// 배치의 모든 쓰기 문장에 변경 행 반환 절을 끼워 넣는다. 하나라도 못 하면 `None`.
///
/// **배치 전체가 쓰기일 때만** 손댄다. SELECT 가 섞여 있으면 돌아온 결과셋 중 어느 것이
/// 변경 내역인지 가릴 수 없어, 컬럼 이름을 붙이거나 영향 행 수를 세는 근거가 사라진다.
/// 못 고치는 배치는 그냥 두면 되므로(원래대로 실행된다) 애매하면 포기하는 쪽을 고른다.
///
/// 사용자 SQL 을 고쳐 보내는 일이라 **의미를 바꾸지 않는 절만** 넣는다. 자리를 잘못
/// 잡으면 문장이 구문 오류로 실패할 뿐(아무것도 반영되지 않는다) 데이터가 어긋나지는 않는다.
pub fn with_change_output(batch: &str, style: ChangeOutput) -> Option<Rewrite> {
    if style == ChangeOutput::Unsupported {
        return None;
    }
    let words = scan_words(batch);
    if words.is_empty() {
        return None;
    }
    // 문장별 낱말 구간으로 나눈다.
    let starts: Vec<usize> = words
        .iter()
        .enumerate()
        .filter(|(_, w)| w.stmt_start)
        .map(|(i, _)| i)
        .collect();

    let mut inserts: Vec<(usize, String)> = Vec::new();
    let mut before_after = Vec::new();
    for (n, &s) in starts.iter().enumerate() {
        let e = starts.get(n + 1).copied().unwrap_or(words.len());
        let stmt = &words[s..e];
        let (at, clause, pair) = plan_clause(batch, stmt, style)?;
        inserts.push((at, clause));
        before_after.push(pair);
    }
    if inserts.is_empty() {
        return None;
    }

    // 뒤에서부터 넣어야 앞선 오프셋이 밀리지 않는다.
    let mut sql = batch.to_string();
    for (at, clause) in inserts.iter().rev() {
        sql.insert_str(*at, clause);
    }
    Some(Rewrite { sql, before_after })
}

/// 문장 하나에 넣을 절과 그 위치를 정한다. 쓰기 문장이 아니면 `None`.
fn plan_clause(
    batch: &str,
    stmt: &[Word<'_>],
    style: ChangeOutput,
) -> Option<(usize, String, bool)> {
    let head = stmt.first()?;
    // 이미 절이 있으면 건드리지 않는다 — 사용자가 원하는 컬럼을 고른 것이다.
    if stmt
        .iter()
        .any(|w| w.depth == 0 && (eq(w, "output") || eq(w, "returning")))
    {
        return None;
    }

    let kind = if eq(head, "update") {
        "update"
    } else if eq(head, "delete") {
        "delete"
    } else if eq(head, "insert") {
        "insert"
    } else {
        // MERGE·DDL·CTE 등은 자리 규칙이 달라 손대지 않는다.
        return None;
    };

    match style {
        ChangeOutput::Returning => {
            let at = statement_end(batch, stmt);
            Some((at, " RETURNING *".to_string(), false))
        }
        ChangeOutput::Output => {
            let (clause, pair) = match kind {
                "update" => ("OUTPUT deleted.*, inserted.*", true),
                "delete" => ("OUTPUT deleted.*", false),
                _ => ("OUTPUT inserted.*", false),
            };
            let (at, before_keyword) = output_slot(batch, stmt, kind)?;
            // 절 키워드 앞이면 뒤에, 문장 끝이면 앞에 공백을 준다 — 어느 쪽이든
            // 원문 낱말과 붙어 버리면 다른 식별자가 된다.
            let padded = if before_keyword {
                format!("{clause} ")
            } else {
                format!(" {clause}")
            };
            Some((at, padded, pair))
        }
        ChangeOutput::Unsupported => None,
    }
}

/// SQL Server `OUTPUT` 이 들어갈 자리(바이트 오프셋).
///
/// 절 순서가 정해져 있어 끝에 붙일 수 없다 — `UPDATE t SET a=1 OUTPUT … WHERE …` 처럼
/// FROM/WHERE **앞**이어야 한다.
fn output_slot(batch: &str, stmt: &[Word<'_>], kind: &str) -> Option<(usize, bool)> {
    // 어디서부터 절 키워드를 찾을지. DELETE 는 대상 앞의 FROM 을 건너뛴다
    // (`DELETE FROM t WHERE …` 의 FROM 은 절이 아니라 대상 표기다).
    let from_idx = match kind {
        "update" => stmt.iter().position(|w| w.depth == 0 && eq(w, "set"))? + 1,
        "delete" if stmt.len() > 1 && eq(&stmt[1], "from") => 2,
        "delete" => 1,
        _ => 1,
    };

    let stop: &[&str] = match kind {
        "insert" => &["values", "select", "exec", "execute", "default"],
        _ => &["from", "where", "option"],
    };
    let hit = stmt[from_idx..]
        .iter()
        .find(|w| w.depth == 0 && stop.iter().any(|k| eq(w, k)));

    match hit {
        Some(w) => Some((w.at, true)),
        // INSERT 는 값 절을 반드시 찾아야 한다. 못 찾으면 자리를 모른다.
        None if kind == "insert" => None,
        None => Some((statement_end(batch, stmt), false)),
    }
}

/// 문장의 끝(마지막 낱말 뒤) 오프셋.
fn statement_end(batch: &str, stmt: &[Word<'_>]) -> usize {
    let last = match stmt.last() {
        Some(w) => w,
        None => return batch.len(),
    };
    let mut at = last.at + last.text.len();
    // 닫는 괄호·따옴표가 뒤따를 수 있으니 `;` 나 끝까지 밀어 준다.
    let rest = &batch[at..];
    if let Some(n) = rest.find(';') {
        at += n;
    } else {
        at = batch.len();
    }
    at
}

/// `deleted.*, inserted.*` 결과셋의 컬럼 이름을 변경 전/후로 갈라 붙인다.
///
/// 두 쪽은 **같은 컬럼 집합**이라 이름이 그대로 겹친다(`id, name, id, name`).
/// 어느 쪽이 전인지 알 수 없으면 값을 봐도 소용이 없으므로 앞 절반에 `이전.`,
/// 뒤 절반에 `이후.` 를 붙인다.
pub fn label_before_after(columns: &mut [ColumnMeta]) {
    let n = columns.len();
    if n < 2 || !n.is_multiple_of(2) {
        return;
    }
    let half = n / 2;
    if (0..half).any(|i| columns[i].name != columns[half + i].name) {
        return;
    }
    for (i, c) in columns.iter_mut().enumerate() {
        c.name = if i < half {
            format!("이전.{}", c.name)
        } else {
            format!("이후.{}", c.name)
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::LogicalType;

    /// 넣은 절이 없으면 원문 그대로여야 한다.
    fn out(sql: &str) -> Option<String> {
        with_change_output(sql, ChangeOutput::Output).map(|r| r.sql)
    }
    fn ret(sql: &str) -> Option<String> {
        with_change_output(sql, ChangeOutput::Returning).map(|r| r.sql)
    }

    #[test]
    fn output_goes_before_where_not_at_the_end() {
        // 끝에 붙이면 구문 오류다 — WHERE 앞이어야 한다.
        assert_eq!(
            out("UPDATE t SET a = 1 WHERE id = 2").unwrap(),
            "UPDATE t SET a = 1 OUTPUT deleted.*, inserted.* WHERE id = 2"
        );
        assert_eq!(
            out("DELETE FROM t WHERE id = 2").unwrap(),
            "DELETE FROM t OUTPUT deleted.* WHERE id = 2"
        );
    }

    #[test]
    fn output_handles_join_forms() {
        // `DELETE t FROM t JOIN u` 의 FROM 은 대상 표기가 아니라 절이다.
        assert_eq!(
            out("DELETE t FROM t JOIN u ON u.id = t.id").unwrap(),
            "DELETE t OUTPUT deleted.* FROM t JOIN u ON u.id = t.id"
        );
        assert_eq!(
            out("UPDATE t SET a = 1 FROM t JOIN u ON u.id = t.id").unwrap(),
            "UPDATE t SET a = 1 OUTPUT deleted.*, inserted.* FROM t JOIN u ON u.id = t.id"
        );
    }

    #[test]
    fn output_goes_before_the_value_clause_on_insert() {
        assert_eq!(
            out("INSERT INTO t (a, b) VALUES (1, 2)").unwrap(),
            "INSERT INTO t (a, b) OUTPUT inserted.* VALUES (1, 2)"
        );
        assert_eq!(
            out("INSERT INTO t SELECT * FROM u").unwrap(),
            "INSERT INTO t OUTPUT inserted.* SELECT * FROM u"
        );
    }

    #[test]
    fn no_where_clause_puts_output_at_the_end() {
        assert_eq!(
            out("UPDATE t SET a = 1").unwrap(),
            "UPDATE t SET a = 1 OUTPUT deleted.*, inserted.*"
        );
        assert_eq!(
            out("UPDATE t SET a = 1;").unwrap(),
            "UPDATE t SET a = 1 OUTPUT deleted.*, inserted.*;"
        );
    }

    #[test]
    fn only_all_write_batches_are_rewritten() {
        // SELECT 가 섞이면 어느 결과셋이 변경 내역인지 가릴 수 없다 — 손대지 않는다.
        assert!(out("UPDATE t SET a = 1; SELECT * FROM t").is_none());
        assert!(out("ALTER TABLE t ALTER COLUMN a INT").is_none());
        assert!(out("MERGE t USING u ON u.id = t.id WHEN MATCHED THEN UPDATE SET a = 1").is_none());
    }

    #[test]
    fn existing_clause_is_left_alone() {
        assert!(out("UPDATE t SET a = 1 OUTPUT inserted.a WHERE id = 2").is_none());
        assert!(ret("UPDATE t SET a = 1 RETURNING a").is_none());
    }

    #[test]
    fn every_statement_in_the_batch_gets_a_clause() {
        let r = with_change_output(
            "UPDATE t SET a = 1 WHERE id = 1; DELETE FROM t WHERE id = 2",
            ChangeOutput::Output,
        )
        .unwrap();
        assert_eq!(
            r.sql,
            "UPDATE t SET a = 1 OUTPUT deleted.*, inserted.* WHERE id = 1; \
DELETE FROM t OUTPUT deleted.* WHERE id = 2"
        );
        // UPDATE 만 변경 전/후 쌍이다.
        assert_eq!(r.before_after, vec![true, false]);
    }

    #[test]
    fn returning_goes_at_the_end() {
        assert_eq!(
            ret("UPDATE t SET a = 1 WHERE id = 2").unwrap(),
            "UPDATE t SET a = 1 WHERE id = 2 RETURNING *"
        );
        assert_eq!(
            ret("DELETE FROM t WHERE id = 2;").unwrap(),
            "DELETE FROM t WHERE id = 2 RETURNING *;"
        );
        // RETURNING 은 변경 후 값만 준다.
        assert!(
            with_change_output("UPDATE t SET a = 1", ChangeOutput::Returning)
                .unwrap()
                .before_after
                .iter()
                .all(|x| !x)
        );
    }

    #[test]
    fn mysql_has_no_such_clause() {
        assert!(with_change_output("UPDATE t SET a = 1", ChangeOutput::Unsupported).is_none());
    }

    #[test]
    fn strings_and_comments_never_look_like_structure() {
        // 문자열 안의 WHERE 를 절로 오인하면 절이 엉뚱한 자리에 들어간다.
        assert_eq!(
            out("UPDATE t SET a = 'where x' WHERE id = 2").unwrap(),
            "UPDATE t SET a = 'where x' OUTPUT deleted.*, inserted.* WHERE id = 2"
        );
        assert_eq!(
            out("UPDATE t SET a = 1 -- where\nWHERE id = 2").unwrap(),
            "UPDATE t SET a = 1 -- where\nOUTPUT deleted.*, inserted.* WHERE id = 2"
        );
    }

    #[test]
    fn writes_with_output_are_routed_to_the_result_path() {
        // 사용자가 직접 적은 OUTPUT/RETURNING 도 결과셋을 돌려준다.
        assert!(may_return_rows(
            "UPDATE t SET a = 1 OUTPUT inserted.* WHERE id = 2"
        ));
        assert!(may_return_rows("DELETE FROM t RETURNING *"));
        assert!(!may_return_rows("UPDATE t SET a = 1 WHERE id = 2"));
    }

    #[test]
    fn labels_halves_only_when_they_match() {
        let meta = |n: &str| ColumnMeta {
            name: n.to_string(),
            db_type: "int".into(),
            logical_type: LogicalType::Int,
        };
        let mut cols = vec![meta("id"), meta("name"), meta("id"), meta("name")];
        label_before_after(&mut cols);
        let names: Vec<_> = cols.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["이전.id", "이전.name", "이후.id", "이후.name"]);

        // 절반이 맞아떨어지지 않으면 손대지 않는다.
        let mut other = vec![meta("id"), meta("name"), meta("id"), meta("age")];
        label_before_after(&mut other);
        assert_eq!(other[0].name, "id");
    }

    #[test]
    fn splits_on_go_lines() {
        let s = "SELECT 1\nGO\nSELECT 2\ngo\nSELECT 3";
        let b = split_batches(s);
        assert_eq!(b.len(), 3);
        assert_eq!(b[0].trim(), "SELECT 1");
        assert_eq!(b[2].trim(), "SELECT 3");
    }

    #[test]
    fn keeps_go_inside_strings_and_comments() {
        // 문자열·주석 안의 GO 와 GOTO 는 구분자가 아니다.
        let s = "SELECT 'GO'\n-- GO\n/*\nGO\n*/\nSELECT [GO]\nGOTO x";
        assert_eq!(split_batches(s).len(), 1);
    }

    #[test]
    fn go_with_repeat_count_is_a_separator() {
        assert_eq!(split_batches("SELECT 1\nGO 5\nSELECT 2").len(), 2);
        // 반복 횟수가 아닌 것이 붙으면 구분자가 아니다.
        assert_eq!(split_batches("SELECT 1\nGO foo\nSELECT 2").len(), 1);
    }

    #[test]
    fn go_with_trailing_spaces_and_no_final_newline() {
        assert_eq!(split_batches("SELECT 1\n  GO  \nSELECT 2\nGO").len(), 2);
    }

    #[test]
    fn detects_row_returning_statements() {
        assert!(may_return_rows("SELECT 1"));
        assert!(may_return_rows("UPDATE t SET a = 1;\nSELECT * FROM t"));
        assert!(may_return_rows("EXEC dbo.some_proc"));
        assert!(!may_return_rows(
            "UPDATE t SET a = 1; DELETE FROM t WHERE a = 2"
        ));
        assert!(!may_return_rows(
            "ALTER TABLE t ALTER COLUMN c NVARCHAR(50) NULL"
        ));
    }

    #[test]
    fn subquery_select_is_not_a_statement_start() {
        assert!(!may_return_rows(
            "INSERT INTO t (a) SELECT a FROM u WHERE a IN (SELECT a FROM v)"
        ));
        assert!(!may_return_rows(
            "DELETE FROM t WHERE id IN (SELECT id FROM u)"
        ));
    }

    #[test]
    fn ignores_keywords_inside_strings_and_comments() {
        assert!(!may_return_rows("UPDATE t SET a = 'select 1' -- select 2"));
        assert!(!may_return_rows("/* select */ UPDATE t SET a = 1"));
    }

    #[test]
    fn looks_past_control_flow_keywords() {
        assert!(may_return_rows("BEGIN SELECT 1 END"));
        assert!(!may_return_rows("BEGIN UPDATE t SET a = 1 END"));
    }
}
