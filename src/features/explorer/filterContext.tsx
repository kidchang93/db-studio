import { createContext, useContext, type ReactNode } from "react";

/** 트리 speed-search 문자열. 하위 노드들이 구독한다. */
export const TreeFilterContext = createContext("");

export function useTreeFilter(): string {
  return useContext(TreeFilterContext);
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
