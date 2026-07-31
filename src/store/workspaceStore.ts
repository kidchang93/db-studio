import { create } from "zustand";
import type { FilterSpec, TableRef } from "../types";

export interface TableTab {
  id: string;
  kind: "table";
  connId: string;
  connName: string;
  table: TableRef;
  /**
   * 탭을 열 때 적용할 필터. 관련 레코드 탐색(F4)이 대상 테이블을 걸러진 상태로 여는 데 쓴다.
   *
   * 문자열 WHERE 가 아니라 `FilterSpec` 인 이유는, 이쪽이 백엔드에서 **값 바인딩 + 식별자
   * quoting** 을 거치기 때문이다(`db/sql.rs` 의 `build_where`). 값을 SQL 에 이어 붙이면
   * 이스케이프를 프론트가 떠안고 DB 방언 차이까지 프론트로 새어 나온다.
   */
  initialFilters?: FilterSpec[];
}

export interface QueryTab {
  id: string;
  kind: "query";
  connId: string;
  connName: string;
  title: string;
}

export type Tab = TableTab | QueryTab;

function tableKey(connId: string, table: TableRef): string {
  return `${connId}:${table.database ?? ""}.${table.schema ?? ""}.${table.name}`;
}

interface WorkspaceState {
  tabs: Tab[];
  activeTabId: string | null;
  openTable: (
    connId: string,
    connName: string,
    table: TableRef,
    initialFilters?: FilterSpec[],
  ) => void;
  openQuery: (connId: string, connName: string) => void;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  /** 특정 연결의 탭을 모두 닫는다(연결 해제 시). */
  closeConnectionTabs: (connId: string) => void;
}

let queryCounter = 1;

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => ({
  tabs: [],
  activeTabId: null,

  openTable: (connId, connName, table, initialFilters) => {
    const key = tableKey(connId, table);
    const existing = get().tabs.find(
      (t) => t.kind === "table" && tableKey(t.connId, t.table) === key,
    );
    if (existing) {
      // 이미 열려 있는데 새 조건으로 들어오면(F4 등) 탭을 갈아 끼워 다시 그린다.
      // 같은 탭을 재사용하면서 조건만 바꾸면 그리드가 그것을 알아챌 방법이 없다.
      if (initialFilters !== undefined) {
        const replaced: TableTab = {
          ...(existing as TableTab),
          id: crypto.randomUUID(),
          initialFilters,
        };
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === existing.id ? replaced : t)),
          activeTabId: replaced.id,
        }));
        return;
      }
      set({ activeTabId: existing.id });
      return;
    }
    const tab: TableTab = {
      id: crypto.randomUUID(),
      kind: "table",
      connId,
      connName,
      table,
      initialFilters,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
  },

  openQuery: (connId, connName) => {
    const tab: QueryTab = {
      id: crypto.randomUUID(),
      kind: "query",
      connId,
      connName,
      title: `쿼리 ${queryCounter++}`,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
  },

  closeTab: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      let activeTabId = s.activeTabId;
      if (s.activeTabId === id) {
        const next = tabs[idx] ?? tabs[idx - 1] ?? tabs[tabs.length - 1];
        activeTabId = next ? next.id : null;
      }
      return { tabs, activeTabId };
    }),

  setActive: (id) => set({ activeTabId: id }),

  closeConnectionTabs: (connId) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.connId !== connId);
      const activeTabId =
        tabs.find((t) => t.id === s.activeTabId)?.id ?? tabs[0]?.id ?? null;
      return { tabs, activeTabId };
    }),
}));
