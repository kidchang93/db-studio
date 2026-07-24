import { createContext, useContext, type ReactNode } from "react";

/** 트리 검색·필터 상태. 하위 노드들이 구독한다. */
export interface TreeFilter {
  /** speed-search 문자열 */
  text: string;
  /** 일치하지 않는 항목을 숨길지. false 면 기존처럼 강조만 한다. */
  hideUnmatched: boolean;
  showTables: boolean;
  showViews: boolean;
  /**
   * 연결(프로필)별로 트리에 노출할 최상위 노드(DB 또는 스키마) 이름 목록.
   * 키가 없으면 전체 표시. DataGrip 의 "N of M" 스키마 선택기에 해당한다.
   */
  visibleTop: Record<string, string[]>;
}

export const EMPTY_FILTER: TreeFilter = {
  text: "",
  hideUnmatched: false,
  showTables: true,
  showViews: true,
  visibleTop: {},
};

export const TreeFilterContext = createContext<TreeFilter>(EMPTY_FILTER);

export function useTreeFilter(): TreeFilter {
  return useContext(TreeFilterContext);
}

/** 기본값에서 벗어난 필터가 하나라도 걸려 있는지(뱃지 표시용). */
export function isFilterActive(f: TreeFilter): boolean {
  return f.hideUnmatched || !f.showTables || !f.showViews;
}

/** 트리 경로를 만든다. 이름에 `/` 가 있어도 깨지지 않게 각 조각을 인코딩한다. */
export function joinPath(parent: string, name: string): string {
  return `${parent}/${encodeURIComponent(name)}`;
}

/**
 * 최상위 노드(연결 바로 아래의 DB·스키마)가 선택 목록에 있는지.
 * 최상위가 아닌 경로는 이 필터의 대상이 아니므로 항상 true.
 */
export function inScope(f: TreeFilter, path: string): boolean {
  const parts = path.split("/");
  if (parts.length !== 2) return true;
  const selected = f.visibleTop[parts[0]];
  return !selected || selected.includes(decodeURIComponent(parts[1]));
}

/**
 * 컨테이너(DB·스키마) 노드를 필터 모드에서 보여줄지.
 *
 * 지연 로딩이라 닫힌 노드의 내용은 알 수 없다. 그래서 닫힌 노드는 **이름으로** 판단하고,
 * 열린 노드는 사용자가 명시적으로 펼친 것이자 안에 일치 항목이 있을 수 있으므로 항상 남긴다.
 */
export function showContainer(
  f: TreeFilter,
  name: string,
  open: boolean,
  path: string,
): boolean {
  if (!inScope(f, path)) return false;
  if (!f.hideUnmatched || !f.text || open) return true;
  return matches(name, f.text);
}

/** 검색어 정규화: 소문자 + 공백 제거(오타로 들어간 공백에 관대하게). */
function normalize(filter: string): string {
  return filter.toLowerCase().replace(/\s+/g, "");
}

/**
 * 부분 수열(subsequence) 매칭.
 * 검색어의 각 글자가 **순서대로** 이름 안에 나타나면 일치로 본다.
 * 예) "usrtb" → "user_table" 일치. 연속일 필요 없음.
 */
export function matches(name: string, filter: string): boolean {
  const f = normalize(filter);
  if (!f) return true;
  const n = name.toLowerCase();
  let fi = 0;
  for (let i = 0; i < n.length && fi < f.length; i++) {
    if (n[i] === f[fi]) fi++;
  }
  return fi === f.length;
}

/** 일치한 글자들을 각각 <span class="hl"> 로 강조한 노드를 돌려준다. */
export function highlight(text: string, filter: string): ReactNode {
  const f = normalize(filter);
  if (!f) return text;

  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let buf = "";
  let fi = 0;

  for (let i = 0; i < text.length; i++) {
    if (fi < f.length && lower[i] === f[fi]) {
      if (buf) {
        parts.push(buf);
        buf = "";
      }
      parts.push(
        <span className="hl" key={i}>
          {text[i]}
        </span>,
      );
      fi++;
    } else {
      buf += text[i];
    }
  }
  if (buf) parts.push(buf);

  // 검색어를 끝까지 소비하지 못했으면 일치가 아니므로 원문 그대로.
  if (fi < f.length) return text;
  return <>{parts}</>;
}
