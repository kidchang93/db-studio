//! 스크립트(여러 문장) 텍스트 훑기.
//!
//! SQL Server 전용이다. SSMS·DataGrip 에서 복사해 온 스크립트는 `GO` 로 배치를 나누는데
//! `GO` 는 T-SQL 문장이 아니라 **클라이언트 지시어**라 서버로 그대로 보내면
//! "Could not find stored procedure 'GO'" 로 실패한다. 보내기 전에 우리가 잘라야 한다.
//!
//! 문자열·주석 안의 내용은 절대 해석하지 않는다 — `'GO'` 나 `-- GO` 를 배치 구분자로
//! 오인하면 멀쩡한 스크립트가 쪼개진다.

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

/// 이 배치에 결과셋을 돌려줄 수 있는 문장이 하나라도 있는가.
///
/// 이 판단이 필요한 이유는 tiberius 의 한계다 — `simple_query` 는 결과셋만,
/// `execute` 는 영향 행 수만 준다. 둘을 함께 주는 API 가 없어 배치마다 골라야 한다.
/// **결과셋 쪽으로 치우쳐 판단한다**: 잘못 고르면 영향 행 수를 못 보는 데 그치지만,
/// 반대로 틀리면 사용자가 보려던 결과가 사라진다.
pub fn may_return_rows(batch: &str) -> bool {
    for word in keywords_at_statement_start(batch) {
        if ROW_RETURNING.iter().any(|k| word.eq_ignore_ascii_case(k)) {
            return true;
        }
    }
    false
}

/// 배치 안에서 **문장이 시작되는 자리**의 낱말들. 문자열·주석·괄호 안은 세지 않는다.
///
/// 문장 시작은 배치의 맨 앞과 최상위 `;` 뒤다. 괄호 안(`INSERT … SELECT` 의 서브쿼리,
/// `WHERE x IN (SELECT …)`)은 독립 문장이 아니므로 건너뛴다.
fn keywords_at_statement_start(batch: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut ctx = Ctx::Code;
    let mut depth = 0i32;
    let mut expect_start = true;

    let bytes = batch.as_bytes();
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
                ';' => expect_start = true,
                _ if c.is_ascii_alphabetic() || c == '_' => {
                    let end = batch[i..]
                        .find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_'))
                        .map(|n| i + n)
                        .unwrap_or(batch.len());
                    let word = &batch[i..end];
                    if expect_start && depth == 0 {
                        // `BEGIN`·`IF`·`WHILE` 같은 제어문 뒤에는 다시 문장이 온다.
                        if !matches!(
                            word.to_ascii_lowercase().as_str(),
                            "begin" | "end" | "if" | "else" | "while" | "try" | "catch"
                        ) {
                            out.push(word);
                            expect_start = false;
                        }
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

#[cfg(test)]
mod tests {
    use super::*;

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
