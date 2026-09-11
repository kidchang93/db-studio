// 표 레이아웃 계산(순수 함수, docs/DESIGN.md §6-9).
//
// 가상 스크롤로 보이는 행만 그리면 브라우저가 열 폭을 매번 다시 정해 스크롤할 때마다
// 열이 흔들린다. 그래서 데이터로 폭을 한 번 정해 `table-layout: fixed` 로 고정한다.

import type { Cell } from "../types";

/** 셀 글꼴(12px 고정폭)의 한 칸 폭(px). */
const CH = 7.3;
/** 셀 좌우 여백(padding 8px × 2) + 테두리. */
const CELL_PAD = 18;
/** 열 폭 범위. 최대값은 셀의 max-width(360px)와 맞춘다 — 넘치면 말줄임하고 값 보기로 본다. */
const MIN_W = 56;
const MAX_W = 360;
/** 폭을 재는 데 볼 최대 행 수. 결과가 커도 앞부분이면 충분하다. */
const SAMPLE = 2000;
/** 긴 값은 어차피 말줄임되므로 이 길이까지만 센다. */
const CLIP = 64;

/** 글자 칸 수. 한글·한자 같은 넓은 글자는 두 칸으로 친다. */
export function textCells(s: string): number {
  let n = 0;
  for (const ch of s) n += (ch.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1;
  return n;
}

/**
 * 열마다 폭(px)을 정한다. 헤더(이름 + 타입 표기)와 앞 `SAMPLE` 행 중 가장 넓은 것을 따른다.
 * `valueAt(r, c)` 는 c 번째 **표시 열**의 값이다(숨긴 열은 넘기지 않는다).
 */
export function columnWidths(
  cols: { name: string; dbType: string }[],
  rowCount: number,
  valueAt: (row: number, col: number) => Cell,
): number[] {
  // 헤더: 이름(12px) + 타입 표기(11px, 왼쪽 여백 6px) + 정렬 표시(▴▾) 자리
  const cells = cols.map((c) => textCells(c.name) + textCells(c.dbType) * 0.9 + 3);
  const n = Math.min(rowCount, SAMPLE);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < cols.length; c++) {
      const v = valueAt(r, c);
      const s = v === null || v === undefined ? "NULL" : String(v);
      const w = textCells(s.length > CLIP ? s.slice(0, CLIP) : s);
      if (w > cells[c]) cells[c] = w;
    }
  }
  return cells.map((w) => Math.round(Math.min(MAX_W, Math.max(MIN_W, w * CH + CELL_PAD))));
}

/** 행 번호 열 폭 — 가장 큰 번호의 자릿수만큼. */
export function rowNumberWidth(maxRowNo: number): number {
  return Math.round(Math.max(44, String(maxRowNo).length * CH + CELL_PAD));
}
