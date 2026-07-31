import { create } from "zustand";

export type LogKind = "query" | "exec" | "commit" | "error";

export interface LogEntry {
  id: string;
  /** 기록 시각(표시는 시:분:초). */
  ts: number;
  kind: LogKind;
  /** 무슨 동작이었는지 한 줄 요약. */
  label: string;
  /** 실제로 실행된 SQL. 여러 문장이면 개행으로 잇는다. */
  sql?: string;
  /** 결과 요약 또는 오류 메시지. */
  detail?: string;
  elapsedMs?: number;
}

/**
 * 앱이 실행한 SQL 과 그 결과를 쌓아 두는 로그.
 *
 * 토스트는 5초 뒤 사라지고 상태바는 마지막 한 줄만 남아서, 무슨 일이 있었는지
 * 되짚을 방법이 없었다. 특히 그리드 커밋은 백엔드가 문장을 만들기 때문에
 * 사용자가 무엇이 실행됐는지 알 길이 아예 없었다.
 *
 * **값은 담지 않는다** — 백엔드가 문형만 내려보낸다(`ApplyChangesResult::statements`).
 * 로그에 개인정보나 자격증명이 새지 않아야 한다(`docs/DESIGN.md` §9).
 */
interface LogState {
  entries: LogEntry[];
  /** 하단 패널 열림 여부. */
  open: boolean;
  add: (e: Omit<LogEntry, "id" | "ts">) => void;
  clear: () => void;
  toggle: () => void;
  setOpen: (open: boolean) => void;
}

/** 메모리에 무한정 쌓이지 않도록 최근 것만 남긴다. */
const MAX_ENTRIES = 300;

export const useLogStore = create<LogState>()((set) => ({
  entries: [],
  open: false,

  add: (e) =>
    set((s) => {
      const entry: LogEntry = { ...e, id: crypto.randomUUID(), ts: Date.now() };
      // 최신이 위로 오게 앞에 넣는다(패널이 위에서부터 읽힌다).
      const entries = [entry, ...s.entries];
      return { entries: entries.length > MAX_ENTRIES ? entries.slice(0, MAX_ENTRIES) : entries };
    }),

  clear: () => set({ entries: [] }),
  toggle: () => set((s) => ({ open: !s.open })),
  setOpen: (open) => set({ open }),
}));
