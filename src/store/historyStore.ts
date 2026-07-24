// 쿼리 히스토리. 실행한 SQL 을 로컬에 남겨 다시 꺼내 쓸 수 있게 한다.
//
// 서버에 보내지 않고 localStorage 에만 둔다(사내 도구 + 로컬 전량 보관 원칙).

import { create } from "zustand";

export interface HistoryEntry {
  id: string;
  sql: string;
  /** 실행한 연결의 표시 이름. 어떤 DB 에서 돌렸는지 구분용. */
  connName: string;
  /** epoch ms. */
  at: number;
  /** 성공 여부 — 실패한 쿼리도 남겨야 고쳐 쓸 수 있다. */
  ok: boolean;
  /** 성공 시 반환/영향 행 수. */
  rows?: number;
  elapsedMs?: number;
  /** 실패 시 오류 메시지(첫 줄만). */
  error?: string;
}

const KEY = "db-studio.queryHistory";
/** 무한정 쌓이면 저장·검색이 느려진다. 오래된 것부터 버린다. */
const LIMIT = 300;

function load(): HistoryEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function persist(entries: HistoryEntry[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    // 용량 초과 등은 기능에 치명적이지 않으므로 조용히 넘긴다.
  }
}

interface HistoryState {
  entries: HistoryEntry[];
  add: (e: Omit<HistoryEntry, "id" | "at">) => void;
  remove: (id: string) => void;
  clear: () => void;
}

export const useHistoryStore = create<HistoryState>()((set) => ({
  entries: load(),

  add: (e) =>
    set((s) => {
      const sql = e.sql.trim();
      if (!sql) return s;
      // 같은 연결에서 같은 SQL 을 연속 실행하면 새로 쌓지 않고 최신으로 올린다.
      const rest = s.entries.filter(
        (x) => !(x.sql === sql && x.connName === e.connName),
      );
      const next = [
        { ...e, sql, id: crypto.randomUUID(), at: Date.now() },
        ...rest,
      ].slice(0, LIMIT);
      persist(next);
      return { entries: next };
    }),

  remove: (id) =>
    set((s) => {
      const next = s.entries.filter((x) => x.id !== id);
      persist(next);
      return { entries: next };
    }),

  clear: () => {
    persist([]);
    return set({ entries: [] });
  },
}));
