import { create } from "zustand";
import type { FilterSpec, TableRef } from "../types";
import { connIdForProfile, useConnectionStore, type ActiveConnection } from "./connectionStore";
import { loadWorkspace, pruneDrafts, saveWorkspace, type SavedTab } from "./workspacePersist";

export interface TableTab {
  id: string;
  kind: "table";
  /** 지금 붙어 있는 연결. 연결되지 않았으면 빈 문자열이다(프로필이 연결되면 다시 채워진다). */
  connId: string;
  /** 이 탭이 속한 저장 프로필. 있으면 재시작 뒤에도 복원된다. 임시 연결이면 없다. */
  profileId?: string;
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
  profileId?: string;
  connName: string;
  title: string;
}

export type Tab = TableTab | QueryTab;

/** 같은 테이블 탭인지 판단하는 키. 프로필이 있으면 재연결로 connId 가 바뀌어도 같은 탭이다. */
function tableKey(t: { connId: string; profileId?: string }, table: TableRef): string {
  return `${t.profileId ?? t.connId}:${table.database ?? ""}.${table.schema ?? ""}.${table.name}`;
}

function profileOf(connId: string): string | undefined {
  return useConnectionStore.getState().connections[connId]?.profileId;
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
  /** 특정 프로필의 탭을 모두 닫는다(프로필 삭제 시). */
  closeProfileTabs: (profileId: string) => void;
}

/**
 * 연결 상태에 맞춰 탭을 다시 묶는다.
 *
 * 프로필 탭은 그 프로필의 연결에 붙었다 떨어진다 — 재시작 뒤 복원된 탭도, 연결을 끊었다
 * 다시 붙인 탭도 이 경로로 살아난다. 임시 연결의 탭은 되살릴 방법이 없어 연결과 함께 닫는다.
 */
function rebind(
  s: Pick<WorkspaceState, "tabs" | "activeTabId">,
  connections: Record<string, ActiveConnection>,
): Pick<WorkspaceState, "tabs" | "activeTabId"> {
  let changed = false;
  const tabs = s.tabs.flatMap((t): Tab[] => {
    if (!t.profileId) {
      if (connections[t.connId]) return [t];
      changed = true;
      return [];
    }
    const connId = connIdForProfile(connections, t.profileId) ?? "";
    if (connId === t.connId) return [t];
    changed = true;
    return [{ ...t, connId }];
  });
  if (!changed) return s;
  const activeTabId = tabs.some((t) => t.id === s.activeTabId)
    ? s.activeTabId
    : (tabs[0]?.id ?? null);
  return { tabs, activeTabId };
}

/** 저장할 수 있는 탭만 추린다(프로필 없는 탭과 F4 필터 같은 일회성 상태는 뺀다). */
function toSaved(s: Pick<WorkspaceState, "tabs" | "activeTabId">) {
  const tabs = s.tabs.flatMap((t): SavedTab[] => {
    if (!t.profileId) return [];
    return t.kind === "table"
      ? [{ id: t.id, kind: "table", profileId: t.profileId, connName: t.connName, table: t.table }]
      : [{ id: t.id, kind: "query", profileId: t.profileId, connName: t.connName, title: t.title }];
  });
  const activeTabId = tabs.some((t) => t.id === s.activeTabId)
    ? s.activeTabId
    : (tabs[0]?.id ?? null);
  return { tabs, activeTabId };
}

/** 복원한 콘솔 제목과 겹치지 않게 다음 번호를 고른다. */
function nextQueryNumber(tabs: Tab[]): number {
  const nums = tabs.map((t) =>
    t.kind === "query" ? Number(/^쿼리 (\d+)$/.exec(t.title)?.[1] ?? 0) : 0,
  );
  return Math.max(0, ...nums) + 1;
}

const saved = loadWorkspace();
// 닫힌 탭·임시 연결 탭이 남긴 콘솔 내용을 정리한다.
pruneDrafts(new Set(saved.tabs.map((t) => t.id)));
const restored = rebind(
  { tabs: saved.tabs.map((t): Tab => ({ ...t, connId: "" })), activeTabId: saved.activeTabId },
  useConnectionStore.getState().connections,
);

let queryCounter = nextQueryNumber(restored.tabs);

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => ({
  tabs: restored.tabs,
  activeTabId: restored.activeTabId,

  openTable: (connId, connName, table, initialFilters) => {
    const profileId = profileOf(connId);
    const key = tableKey({ connId, profileId }, table);
    const existing = get().tabs.find((t) => t.kind === "table" && tableKey(t, t.table) === key);
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
      profileId,
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
      profileId: profileOf(connId),
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

  closeProfileTabs: (profileId) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.profileId !== profileId);
      const activeTabId =
        tabs.find((t) => t.id === s.activeTabId)?.id ?? tabs[0]?.id ?? null;
      return { tabs, activeTabId };
    }),
}));

useConnectionStore.subscribe((s, prev) => {
  if (s.connections !== prev.connections) {
    useWorkspaceStore.setState((ws) => rebind(ws, s.connections));
  }
});

useWorkspaceStore.subscribe((s, prev) => {
  if (s.tabs !== prev.tabs || s.activeTabId !== prev.activeTabId) {
    saveWorkspace(toSaved(s));
  }
});
