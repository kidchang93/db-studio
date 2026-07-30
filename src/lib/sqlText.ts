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
