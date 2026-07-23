import { create } from "zustand";
import type { TableRef } from "../types";

export interface TableTab {
  id: string;
  kind: "table";
  connId: string;
  connName: string;
  table: TableRef;
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
  openTable: (connId: string, connName: string, table: TableRef) => void;
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

  openTable: (connId, connName, table) => {
    const key = tableKey(connId, table);
    const existing = get().tabs.find(
      (t) => t.kind === "table" && tableKey(t.connId, t.table) === key,
    );
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }
    const tab: TableTab = {
      id: crypto.randomUUID(),
      kind: "table",
      connId,
      connName,
      table,
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
