// SQL 입력 텍스트 정규화 유틸.

/**
 * macOS 의 스마트 인용부호 자동 변환으로 들어온 유니코드 따옴표를 ASCII 로 되돌린다.
 *
 * WebView 입력창에서 `'` 를 치면 OS 가 `‘`(U+2018)/`’`(U+2019) 로 바꿔버리는데,
 * DB 는 이를 문자열 구분자로 인식하지 못해 구문 오류가 난다.
 * (예: `con_code like ‘A0018%'` → SQL Server 102 구문 오류)
 *
 * 문자열 리터럴 안에서 유니코드 따옴표 자체를 검색하려는 경우는 함께 치환되지만,
 * 그 값은 어차피 SQL 문법을 깨뜨리므로 정규화가 항상 안전한 쪽이다.
 */
/**
 * OS 자동 교정(첫 글자 대문자화·스마트 인용부호)을 끄는 입력 속성 묶음.
 *
 * `index.html` 의 body 에도 지정해 두었지만 `autocorrect` 는 비표준 속성이라
 * 상속이 보장되지 않는다. SQL·식별자가 직접 들어가는 입력에는 이 묶음을 펼쳐 준다.
 */
export const rawTextInputProps = {
  autoCapitalize: "none",
  autoCorrect: "off",
  spellCheck: false,
} as const;

export function normalizeSmartQuotes(input: string): string {
  return input
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"');
}

/** 앞쪽 주석·공백을 걷어낸 첫 키워드(소문자). 없으면 빈 문자열. */
function firstKeyword(sql: string): string {
  let s = sql;
  for (;;) {
    s = s.trimStart();
    if (s.startsWith("--")) {
      const nl = s.indexOf("\n");
      if (nl < 0) return "";
      s = s.slice(nl + 1);
      continue;
    }
    if (s.startsWith("/*")) {
      const end = s.indexOf("*/");
      if (end < 0) return "";
      s = s.slice(end + 2);
      continue;
    }
    break;
  }
  return /^[a-zA-Z_]+/.exec(s)?.[0].toLowerCase() ?? "";
}

/** 결과셋을 돌려주는 문장들. 프로시저 호출은 결과셋이 있을 수 있어 여기에 둔다. */
const ROW_RETURNING = new Set([
  "select",
  "with",
  "show",
  "explain",
  "describe",
  "desc",
  "pragma",
  "values",
  "table",
  "exec",
  "execute",
  "call",
]);

/**
 * 결과셋을 돌려주는 문장인가. 조회 경로(`run_query`)와 실행 경로(`run_execute`) 중
 * 어디로 보낼지 정하는 데 쓴다.
 *
 * **실행해 보고 되돌리는 폴백은 불가능하다** — 이미 나간 INSERT 를 다시 보낼 수는 없으므로
 * 보내기 전에 정해야 한다. 그래서 첫 키워드만 보고 판단하고, 애매하면 조회 쪽에 둔다.
 * 잘못 골라도 데이터가 상하지는 않는다(영향 행 수를 못 볼 뿐).
 */
export function returnsRows(sql: string): boolean {
  return ROW_RETURNING.has(firstKeyword(sql));
}

export interface SqlScan {
  /** `N` 접두사가 없는 비ASCII 문자열 리터럴(중복 제거). */
  unprefixed: string[];
  /** 주석·문자열 밖에 INSERT/UPDATE/MERGE 가 있는가. */
  writes: boolean;
}

/**
 * SQL Server 에서 `N` 접두사가 빠진 비ASCII 리터럴을 찾는다.
 *
 * `'영업부'` 는 **DB 기본 collation 의 코드페이지**로 해석된다. 그 코드페이지에
 * 없는 문자는 서버에 닿기도 전에 `?`(0x3F) 로 바뀌고, **컬럼이 NVARCHAR 라도
 * 이미 늦다**. `N'영업부'` 여야 유니코드로 전달된다.
 *
 * 원문이 남지 않아 되돌릴 수 없는 손실이므로 실행 전에 잡아야 한다.
 * 같은 이유로 조회(SELECT)는 걸러 낼 필요가 없다 — 리터럴이 깨지면 결과가
 * 안 맞을 뿐이고 사용자가 즉시 알아채며, 매 조회마다 묻는 것이 더 해롭다.
 *
 * 주석과 이스케이프된 따옴표(`''`)를 건너뛰며 한 번에 훑는다.
 */
export function scanSqlText(sql: string): SqlScan {
  const literals: string[] = [];
  /** 문자열·주석을 걷어낸 나머지. 키워드는 여기서만 찾는다. */
  let bare = "";
  let i = 0;

  while (i < sql.length) {
    // 줄 주석
    if (sql[i] === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl + 1;
      continue;
    }
    // 블록 주석
    if (sql[i] === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
      continue;
    }
    // 대괄호 식별자([부서명] 처럼 한글이 들어가도 리터럴이 아니다)
    if (sql[i] === "[") {
      const end = sql.indexOf("]", i + 1);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql[i] === "'") {
      const open = i;
      let body = "";
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            body += "'";
            i += 2;
            continue;
          }
          break;
        }
        body += sql[i];
        i++;
      }
      i++; // 닫는 따옴표
      // 여는 따옴표 바로 앞 글자가 N 이어야 유니코드 리터럴이다(사이 공백은 문법 오류).
      const prefixed = open > 0 && (sql[open - 1] === "N" || sql[open - 1] === "n");
      // eslint-disable-next-line no-control-regex
      if (!prefixed && /[^\x00-\x7F]/.test(body)) literals.push(body);
      continue;
    }
    bare += sql[i];
    i++;
  }

  return {
    unprefixed: [...new Set(literals)],
    writes: /\b(insert|update|merge)\b/i.test(bare),
  };
}

export interface SqlErrorSpot {
  /** SQL 문자열 안의 0-based 오프셋. */
  offset: number;
  /** 사람이 읽는 1-based 위치. */
  line: number;
  col: number;
  /** 강조 길이(토큰을 찾은 경우). 없으면 1. */
  length: number;
}

/** 1-based 오프셋을 줄·열로 바꾼다. */
function spotAt(sql: string, offset: number, length: number): SqlErrorSpot {
  const clamped = Math.max(0, Math.min(offset, Math.max(0, sql.length - 1)));
  const before = sql.slice(0, clamped);
  const line = before.split("\n").length;
  const col = clamped - (before.lastIndexOf("\n") + 1) + 1;
  return { offset: clamped, line, col, length };
}

/**
 * DB 오류 메시지에서 **구문 오류 지점**을 찾아낸다.
 *
 * DB 마다 주는 정보가 달라 있는 것부터 차례로 본다.
 * - PostgreSQL: 문자 위치를 별도 필드로 준다(`error.rs` 가 "위치: N" 으로 붙여 둔다) — 가장 정확
 * - SQL Server: 줄 번호만 준다(`on line N`)
 * - MySQL·SQLite: 위치가 없고 `near '토큰'` 만 있어, 그 토큰을 본문에서 찾아 짚는다
 *
 * 어느 것도 못 찾으면 null 이고, 그때 화면은 메시지만 보여 준다 —
 * **틀린 자리를 짚느니 안 짚는 편이 낫다.**
 */
export function findErrorSpot(sql: string, message: string): SqlErrorSpot | null {
  // 1) PostgreSQL: 1-based 문자 위치
  const pos = /위치:\s*(\d+)/.exec(message) ?? /\bPosition:\s*(\d+)/i.exec(message);
  if (pos) {
    const n = Number(pos[1]);
    if (Number.isFinite(n) && n >= 1) {
      const spot = spotAt(sql, n - 1, 1);
      // 위치에 걸린 단어가 있으면 그 길이만큼 짚는다.
      const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(spot.offset));
      return word ? { ...spot, length: word[0].length } : spot;
    }
  }

  // 2) near '토큰' / near "토큰" — 본문에서 그 토큰을 찾는다.
  const near = /near\s+['"]([^'"]+)['"]/i.exec(message);
  if (near) {
    const token = near[1];
    const at = sql.indexOf(token);
    if (at >= 0) return spotAt(sql, at, token.length);
  }

  // 3) SQL Server: 줄 번호만. 그 줄의 첫 글자를 짚는다.
  const line = /\bline\s+(\d+)/i.exec(message);
  if (line) {
    const n = Number(line[1]);
    if (Number.isFinite(n) && n >= 1) {
      const lines = sql.split("\n");
      if (n <= lines.length) {
        const offset = lines.slice(0, n - 1).reduce((acc, l) => acc + l.length + 1, 0);
        // 들여쓰기를 건너뛰어 실제 내용이 시작하는 곳을 짚는다.
        const indent = /^\s*/.exec(lines[n - 1])?.[0].length ?? 0;
        return spotAt(sql, offset + indent, Math.max(1, lines[n - 1].trim().length));
      }
    }
  }
  return null;
}
