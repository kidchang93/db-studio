// 콘솔 결과를 **받아 둔 행 안에서** 좁히고 정렬하는 순수 함수(docs/DESIGN.md §6-3 "결과 그리드").
//
// 서버에 다시 묻지 않는다 — 정렬하려고 사용자 SQL 을 다시 실행하면 쓰기 문장이 한 번 더
// 실행될 수 있다. 화면 컴포넌트와 떼어 두어 서버 없이 검사할 수 있게 한다.

import type { Cell, ColumnMeta } from "../types";

export interface ResultSort {
  /** 컬럼 위치(이름은 결과셋 안에서 겹칠 수 있어 위치로 가리킨다). */
  col: number;
  desc: boolean;
}

/** 수로 비교할 논리 타입. DECIMAL·BIGINT 는 정밀도 보존 때문에 문자열로 온다(DESIGN §4). */
const NUMERIC = new Set(["int", "float", "decimal"]);
const INTEGER = /^-?\d+$/;

/**
 * 두 셀 비교(NULL 은 호출하는 쪽이 따로 처리한다).
 * 숫자 컬럼은 문자열로 와도 수로 비교한다 — 사전순이면 "10" 이 "9" 앞에 온다.
 */
export function compareCells(a: Cell, b: Cell, col: ColumnMeta): number {
  if (NUMERIC.has(col.logicalType)) {
    // 2^53 을 넘는 정수는 Number 로 바꾸면 서로 같아질 수 있어 BigInt 로 본다.
    if (typeof a === "string" && typeof b === "string" && INTEGER.test(a) && INTEGER.test(b)) {
      const x = BigInt(a);
      const y = BigInt(b);
      return x === y ? 0 : x < y ? -1 : 1;
    }
    const x = Number(a);
    const y = Number(b);
    if (Number.isFinite(x) && Number.isFinite(y)) return x === y ? 0 : x < y ? -1 : 1;
  }
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

/**
 * 화면에 보일 행들의 **원래 인덱스**(필터 → 정렬 순).
 *
 * - 필터: 값에 검색어가 들어간 행만(대소문자 무시). NULL 셀은 "null" 이라는 글자로 치지 않는다.
 * - 정렬: NULL 은 방향과 무관하게 맨 뒤. 같은 값은 원래 순서를 지킨다(안정 정렬).
 */
export function visibleRows(
  rows: Cell[][],
  cols: ColumnMeta[],
  filter: string,
  sort: ResultSort | null,
): number[] {
  const needle = filter.trim().toLowerCase();
  let idx = rows.map((_, i) => i);
  if (needle) {
    idx = idx.filter((i) =>
      rows[i].some((v) => v !== null && v !== undefined && String(v).toLowerCase().includes(needle)),
    );
  }
  if (sort && cols[sort.col]) {
    const col = cols[sort.col];
    idx.sort((i, j) => {
      const a = rows[i][sort.col];
      const b = rows[j][sort.col];
      const an = a === null || a === undefined;
      const bn = b === null || b === undefined;
      if (an || bn) return an === bn ? i - j : an ? 1 : -1;
      const c = compareCells(a, b, col);
      return (sort.desc ? -c : c) || i - j;
    });
  }
  return idx;
}
