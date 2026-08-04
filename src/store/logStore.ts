import { create } from "zustand";
import type { Cell } from "../types";

export type LogKind = "query" | "exec" | "commit" | "error";

/** 컬럼 하나가 어떻게 바뀌었는지. 추가는 before, 삭제는 after 가 없다. */
export interface LogField {
  column: string;
  before?: Cell;
  after?: Cell;
}

/** 쓰기 한 건이 실제로 무엇을 바꿨는지. */
export interface LogChange {
  op: "insert" | "update" | "delete";
  /** 어떤 행인지 — `id=3` 처럼 식별 컬럼만 추린 표기. */
  key: string;
  fields: LogField[];
}

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
  /**
   * 행 단위 변경 내역. **값이 담긴다.**
   *
   * 무엇이 바뀌었는지 확인하려면 값이 없으면 소용이 없다. 대신 이 로그는
   * 메모리에만 있고(디스크 기록·외부 전송 없음) SQL 문형에는 여전히 값을
   * 이어붙이지 않는다(`docs/DESIGN.md` §6-4).
   */
  changes?: LogChange[];
}

/**
 * 앱이 실행한 SQL 과 그 결과를 쌓아 두는 로그.
 *
 * 토스트는 5초 뒤 사라지고 상태바는 마지막 한 줄만 남아서, 무슨 일이 있었는지
 * 되짚을 방법이 없었다. 특히 그리드 커밋은 백엔드가 문장을 만들기 때문에
 * 사용자가 무엇이 실행됐는지 알 길이 아예 없었다.
 *
 * **SQL 문형에는 값을 담지 않는다** — 백엔드가 문형만 내려보낸다
 * (`ApplyChangesResult::statements`). 값은 `changes` 에 따로 실어 표시만 한다.
 * 어느 쪽이든 메모리에만 남고 디스크·외부로 나가지 않는다(`docs/DESIGN.md` §6-4·§9).
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
