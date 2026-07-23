import { createContext, useContext, type ReactNode } from "react";

/** 트리 speed-search 문자열. 하위 노드들이 구독한다. */
export const TreeFilterContext = createContext("");

export function useTreeFilter(): string {
  return useContext(TreeFilterContext);
}

/** 대소문자 무시 부분 일치. filter 가 비면 항상 true. */
export function matches(name: string, filter: string): boolean {
  return !filter || name.toLowerCase().includes(filter.toLowerCase());
}

/** 일치 구간을 <mark> 로 강조한 노드를 돌려준다. */
export function highlight(text: string, filter: string): ReactNode {
  if (!filter) return text;
  const idx = text.toLowerCase().indexOf(filter.toLowerCase());
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <span className="hl">{text.slice(idx, idx + filter.length)}</span>
      {text.slice(idx + filter.length)}
    </>
  );
}
