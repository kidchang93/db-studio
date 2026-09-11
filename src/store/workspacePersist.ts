// 작업공간(열린 탭 · 콘솔 내용)을 로컬에 남겨 앱을 다시 켜도 이어서 쓰게 한다.
//
// IntelliJ 콘솔은 파일로 남아 재시작해도 그대로다. 여기서는 localStorage 에 둔다
// (historyStore 와 같은 원칙 — 서버·외부로 보내지 않는다).
//
// 탭 목록과 콘솔 내용을 **따로** 저장한다. 콘솔 SQL 을 탭 상태(zustand)에 넣으면
// 키 입력마다 모든 탭(그리드 포함)이 다시 그려져 입력이 무거워진다.

import type { ExecContext, TableRef } from "../types";

const WORKSPACE_KEY = "db-studio.workspace";
const DRAFTS_KEY = "db-studio.consoleDrafts";

/**
 * 저장되는 탭. 런타임 connId 는 재시작하면 무의미하므로 **프로필 id** 로 남긴다.
 * 프로필 없이 연 임시 연결의 탭은 되살릴 방법이 없어 저장하지 않는다.
 */
export type SavedTab =
  | { id: string; kind: "table"; profileId: string; connName: string; table: TableRef }
  | { id: string; kind: "query"; profileId: string; connName: string; title: string };

export interface SavedWorkspace {
  tabs: SavedTab[];
  activeTabId: string | null;
}

/** 콘솔 하나의 내용. 결과는 남기지 않는다(다시 실행하면 된다). */
export interface ConsoleDraft {
  sql: string;
  ctx: ExecContext;
}

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 용량 초과 등은 기능에 치명적이지 않으므로 조용히 넘긴다.
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 손으로 고쳤거나 옛 형식인 항목은 버린다 — 깨진 탭 하나가 복원 전체를 막으면 안 된다. */
function isSavedTab(v: unknown): v is SavedTab {
  if (!isRecord(v)) return false;
  if (typeof v.id !== "string" || typeof v.profileId !== "string") return false;
  if (typeof v.connName !== "string") return false;
  if (v.kind === "query") return typeof v.title === "string";
  if (v.kind === "table") return isRecord(v.table) && typeof v.table.name === "string";
  return false;
}

export function loadWorkspace(): SavedWorkspace {
  const raw = read(WORKSPACE_KEY);
  if (!isRecord(raw)) return { tabs: [], activeTabId: null };
  const tabs = Array.isArray(raw.tabs) ? raw.tabs.filter(isSavedTab) : [];
  const active = tabs.find((t) => t.id === raw.activeTabId);
  return { tabs, activeTabId: active?.id ?? tabs[0]?.id ?? null };
}

export function saveWorkspace(w: SavedWorkspace) {
  write(WORKSPACE_KEY, w);
}

function readDrafts(): Record<string, ConsoleDraft> {
  const raw = read(DRAFTS_KEY);
  return isRecord(raw) ? (raw as Record<string, ConsoleDraft>) : {};
}

export function loadDraft(tabId: string): ConsoleDraft | null {
  const d = readDrafts()[tabId];
  if (!isRecord(d) || typeof d.sql !== "string") return null;
  const ctx = isRecord(d.ctx) ? d.ctx : {};
  return {
    sql: d.sql,
    ctx: {
      database: typeof ctx.database === "string" ? ctx.database : null,
      schema: typeof ctx.schema === "string" ? ctx.schema : null,
    },
  };
}

export function saveDraft(tabId: string, draft: ConsoleDraft) {
  write(DRAFTS_KEY, { ...readDrafts(), [tabId]: draft });
}

/**
 * `keep` 에 없는 탭의 콘솔 내용을 지운다.
 *
 * 닫은 탭과, 저장되지 않는 임시 연결의 탭이 남긴 내용이 끝없이 쌓이지 않게 한다.
 */
export function pruneDrafts(keep: Set<string>) {
  const all = readDrafts();
  const kept = Object.fromEntries(Object.entries(all).filter(([id]) => keep.has(id)));
  if (Object.keys(kept).length !== Object.keys(all).length) write(DRAFTS_KEY, kept);
}
