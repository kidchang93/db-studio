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
export function normalizeSmartQuotes(input: string): string {
  return input
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"');
}
