import { useEffect, useMemo, useRef, useState } from "react";
import CodeMirror, { EditorView, type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { acceptCompletion } from "@codemirror/autocomplete";
import { keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { sqlCompletionSource, type SchemaEntry } from "../../lib/sqlCompletion";
import { sql, PostgreSQL, MySQL, SQLite, MSSQL, type SQLDialect } from "@codemirror/lang-sql";
import { oneDark } from "@codemirror/theme-one-dark";
import { AlertTriangle, FileDiff, History, Pin, PinOff, Play, X } from "lucide-react";
import {
  Group as PanelGroup,
  Panel,
  Separator as PanelResizeHandle,
} from "react-resizable-panels";
import * as api from "../../api";
import { ResultTable } from "../grid/ResultTable";
import type { Cell, DbKind, ExecContext, QueryResult } from "../../types";
import { useConnectionStore } from "../../store/connectionStore";
import { useUiStore } from "../../store/uiStore";
import { useHistoryStore } from "../../store/historyStore";
import { useLogStore } from "../../store/logStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { loadDraft, saveDraft } from "../../store/workspacePersist";
import { isShortcut, shortcutLabel } from "../../lib/keymap";
import { QueryHistory } from "./QueryHistory";
import {
  findErrorSpot,
  normalizeSmartQuotes,
  scanSqlText,
  type SqlErrorSpot,
} from "../../lib/sqlText";
import { Modal } from "../../components/Modal";
import { CopyButton } from "../../components/CopyButton";

/** 히스토리에 남길 오류 요약 — 첫 줄만 짧게. */
function errorLine(e: unknown): string {
  const msg = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e);
  return msg.split("\n")[0].slice(0, 200);
}

function dialectFor(kind?: DbKind): SQLDialect {
  switch (kind) {
    case "mysql":
      return MySQL;
    case "sqlite":
      return SQLite;
    case "mssql":
      return MSSQL;
    default:
      return PostgreSQL;
  }
}

/** 콘솔 결과 행 제한 선택지. 결과셋마다 이만큼만 받는다(DataGrip 의 Limit page size, 기본 500). */
const ROW_LIMITS = [100, 500, 1000, 5000];
const ROW_LIMIT_KEY = "db-studio.consoleRowLimit";

/** 모든 콘솔이 같은 제한을 쓰도록 로컬에 남긴 값을 읽는다. */
function loadRowLimit(): number {
  try {
    const v = Number(localStorage.getItem(ROW_LIMIT_KEY));
    return ROW_LIMITS.includes(v) ? v : 500;
  } catch {
    return 500;
  }
}

/** 실행할 SQL 과 에디터 안에서의 시작 위치(선택 영역만 실행할 때 0 이 아니다). */
interface ExecTarget {
  sql: string;
  base: number;
}

/**
 * 결과 탭 하나. 고정한 탭은 다음 실행에도 남는다(DataGrip 의 Pin Tab) —
 * 이전 결과와 나란히 비교할 수 있게.
 */
interface ResultTab {
  id: string;
  /** 탭 이름의 번호("결과 N"). 고정한 탭의 번호는 유지하고 새 결과는 그 뒤로 붙는다. */
  no: number;
  result: QueryResult;
  pinned: boolean;
  /** 이 결과를 낸 SQL(툴팁용). */
  sql: string;
  /** 지금까지 받은 행 전부(페이지를 넘기며 이어 읽은 것까지). 화면에는 한 페이지씩 보인다. */
  rows: Cell[][];
  /** 지금 보고 있는 페이지(0부터). */
  page: number;
  /** 페이지 크기 — 실행할 때의 행 제한. */
  pageSize: number;
  /** 서버에 열어 둔 커서. 다음 페이지를 이어 읽는다. 끝까지 읽었거나 커서로 열지 않았으면 null. */
  cursor: number | null;
  /** 서버 커서로 열었는지 — 페이지 이동 막대를 보일지. */
  paged: boolean;
  /** 다음 페이지를 읽는 중. */
  loading: boolean;
}

export function QueryTab({ connId, tabId }: { connId: string; tabId: string }) {
  const ui = useUiStore();
  const kind = useConnectionStore((s) => s.connections[connId]?.handle.kind);
  /** 앱을 다시 켜거나 다시 연결했을 때 이어서 쓰도록 남겨 둔 내용(`store/workspacePersist.ts`). */
  const [draft] = useState(() => loadDraft(tabId));
  const [text, setText] = useState(draft?.sql ?? "SELECT 1;");
  /** 결과 탭들. 다중 문장이면 여러 개가 오고, 고정한 탭은 이전 실행의 것도 남아 있다. */
  const [results, setResults] = useState<ResultTab[]>([]);
  /** 지금 보고 있는 결과 탭. */
  const [activeResultId, setActiveResultId] = useState<string | null>(null);
  /** 결과셋을 내지 않은 문장들의 영향 행 수 합계. */
  const [affected, setAffected] = useState<number | null>(null);
  /**
   * 쓰기 문장이 **어떤 행을 어떻게 바꿨는지** 돌려받을지.
   *
   * 켜면 백엔드가 `OUTPUT`/`RETURNING` 을 끼워 넣어 변경 전후 행을 결과 탭으로 보여 준다.
   * 사용자 SQL 을 고쳐 보내는 일이라 기본은 꺼 둔다 — 실제로 나간 SQL 은 로그에 남는다.
   */
  const [captureChanges, setCaptureChanges] = useState(false);
  const [running, setRunning] = useState(false);
  /** 결과셋마다 받을 최대 행 수. */
  const [rowLimit, setRowLimit] = useState(loadRowLimit);
  /** 마지막 실행이 남긴 오류. 위치를 찾았으면 spot 이 붙는다. */
  const [sqlError, setSqlError] = useState<{ message: string; spot: SqlErrorSpot | null } | null>(
    null,
  );
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  /**
   * 이 콘솔이 실행될 DB·스키마. 비우면 연결 기본값을 쓴다.
   *
   * 콘솔마다 따로 갖는다 — 탭을 여럿 열어 서로 다른 DB 를 보는 것이 흔한 사용이고,
   * 백엔드가 쿼리와 같은 커넥션에서 컨텍스트를 적용하므로 탭끼리 간섭하지 않는다.
   */
  const [ctx, setCtx] = useState<ExecContext>(draft?.ctx ?? { database: null, schema: null });
  /**
   * 내용을 남긴다. 키 입력마다 쓰지 않고 입력이 멈췄을 때 쓴다.
   * 결과와 "변경 행 보기"는 남기지 않는다 — 사용자 SQL 을 고쳐 보내는 토글이
   * 재시작 뒤에도 켜진 채 있으면 안 된다.
   */
  useEffect(() => {
    const t = setTimeout(() => saveDraft(tabId, { sql: text, ctx }), 300);
    return () => clearTimeout(t);
  }, [tabId, text, ctx]);
  const [dbs, setDbs] = useState<string[]>([]);
  const [schemas, setSchemas] = useState<string[]>([]);
  /** 자동완성용 테이블→컬럼 맵. 컨텍스트가 바뀔 때만 다시 받는다. */
  const [completions, setCompletions] = useState<SchemaEntry[]>([]);
  /** 자동완성 스키마 로드 상태. 비어 있을 때 원인을 알 수 있어야 한다. */
  const [schemaState, setSchemaState] = useState<"loading" | "ok" | "error">("loading");
  /**
   * 완성 소스가 읽을 최신 스키마.
   *
   * state 를 확장 의존성에 넣으면 스냅샷이 도착할 때마다 에디터가 통째로 재구성되어
   * 커서·실행취소 이력이 날아가고 입력이 끊긴다. ref 로 읽어 확장을 고정한다.
   */
  const schemaRef = useRef<SchemaEntry[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** N 접두사 경고 대기 중인 실행. 확인을 받으면 `proceed` 를 부른다. */
  const [nWarn, setNWarn] = useState<{ literals: string[]; proceed: () => void } | null>(
    null,
  );
  const addHistory = useHistoryStore((s) => s.add);
  const addLog = useLogStore((s) => s.add);
  const connName = useConnectionStore((s) => s.connections[connId]?.name ?? connId);

  /**
   * 쿼리 히스토리 토글 — ⌥⌘E / Ctrl+Alt+E (IntelliJ 의 Console.History.Browse).
   * ⌘E 는 IntelliJ 에서 "최근 파일"이라 쓰지 않는다.
   *
   * 탭은 전부 마운트된 채 `display` 로만 숨겨지므로 **활성 탭만** 반응해야 한다.
   * 그렇지 않으면 열어 둔 콘솔 수만큼 패널이 함께 열린다.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isShortcut(e, "queryHistory")) return;
      // CodeMirror 등이 이미 처리했으면 넘긴다.
      if (e.defaultPrevented) return;
      if (useWorkspaceStore.getState().activeTabId !== tabId) return;
      e.preventDefault();
      setHistoryOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabId]);

  /**
   * 실행 전 안전장치: SQL Server 에서 `N` 이 빠진 비ASCII 리터럴로 **쓰기**를 하려 하면 먼저 묻는다.
   *
   * `'한글'` 은 DB 기본 collation 의 코드페이지로 해석되어, 그 코드페이지에 없는 문자는
   * `?` 로 바뀌어 저장된다(컬럼이 NVARCHAR 여도 마찬가지). 원문이 남지 않아 되돌릴 수 없다.
   * 조회는 묻지 않는다 — 결과가 안 맞는 것은 즉시 드러나고, 매번 묻는 편이 더 해롭다.
   */
  function guarded(sqlText: string, exec: () => void) {
    if (kind === "mssql") {
      const scan = scanSqlText(sqlText);
      if (scan.writes && scan.unprefixed.length > 0) {
        setNWarn({ literals: scan.unprefixed, proceed: exec });
        return;
      }
    }
    exec();
  }

  /**
   * 실행할 SQL. **선택 영역이 있으면 그것만**, 없으면 에디터 전체(DataGrip 과 같다).
   * `base` 는 에디터 안에서의 시작 위치 — 오류 위치를 에디터 좌표로 되돌리는 데 쓴다.
   */
  function executionTarget(): ExecTarget {
    const state = editorRef.current?.view?.state;
    const sel = state?.selection.main;
    if (state && sel && !sel.empty) {
      const picked = state.sliceDoc(sel.from, sel.to);
      if (picked.trim()) return { sql: picked, base: sel.from };
    }
    return { sql: text, base: 0 };
  }

  /** 실행 진입점(버튼 · 단축키). */
  function execute() {
    const target = executionTarget();
    guarded(target.sql, () => runAuto(target));
  }

  function changeRowLimit(n: number) {
    setRowLimit(n);
    try {
      localStorage.setItem(ROW_LIMIT_KEY, String(n));
    } catch {
      // 저장하지 못해도 이번 세션에는 적용된다.
    }
  }

  /**
   * 실행 실패를 화면에 남긴다. DB 가 알려 준 위치를 찾으면 **에디터 커서를 그리로 옮겨**
   * 사용자가 바로 고칠 수 있게 한다. 위치를 못 찾으면 메시지만 보여 준다 —
   * 틀린 자리를 짚느니 안 짚는 편이 낫다.
   */
  function reportSqlError(e: unknown, title: string, target: ExecTarget) {
    let message = errorLine(e);
    // 변경 행 보기가 켜져 있으면 우리가 SQL 에 절을 끼워 넣은 상태다. 그걸 모르면
    // 멀쩡한 문장이 왜 깨졌는지 알 수 없다(트리거가 걸린 테이블 등).
    if (captureChanges) {
      message += "\n(변경 행 보기가 켜져 있어 OUTPUT/RETURNING 절이 추가된 상태입니다. 끄고 다시 실행해 보세요.)";
    }
    const rel = findErrorSpot(target.sql, message);
    // 선택 영역만 실행했으면 DB 가 준 위치는 그 안에서의 위치다 — 에디터 좌표로 되돌린다.
    const doc = editorRef.current?.view?.state.doc;
    let spot = rel;
    if (rel && target.base > 0 && doc) {
      const baseLine = doc.lineAt(target.base);
      spot = {
        ...rel,
        offset: target.base + rel.offset,
        line: baseLine.number + rel.line - 1,
        col: rel.line === 1 ? rel.col + (target.base - baseLine.from) : rel.col,
      };
    }
    setSqlError({ message, spot });
    if (spot) {
      const view = editorRef.current?.view;
      view?.focus();
      view?.dispatch({
        selection: { anchor: spot.offset, head: spot.offset + spot.length },
        scrollIntoView: true,
      });
    }
    addHistory({ sql: target.sql, connName, ok: false, error: message });
    ui.toastError(e, title, target.sql);
  }

  // DB 목록은 탭이 열릴 때 한 번 읽는다.
  useEffect(() => {
    let cancelled = false;
    api
      .listDatabases(connId)
      .then((d) => !cancelled && setDbs(d.map((x) => x.name)))
      .catch(() => {
        /* 목록을 못 읽어도 콘솔 자체는 쓸 수 있어야 한다 */
      });
    return () => {
      cancelled = true;
    };
  }, [connId]);

  // 스키마는 고른 DB 를 따라간다.
  useEffect(() => {
    let cancelled = false;
    api
      .listSchemas(connId, ctx.database ?? null)
      .then((s) => !cancelled && setSchemas(s.map((x) => x.name)))
      .catch(() => {
        /* 스키마 계층이 없는 DB(MySQL·SQLite)는 빈 목록이 정상 */
      });
    return () => {
      cancelled = true;
    };
  }, [connId, ctx.database]);

  /**
   * 자동완성 스키마를 받아 둔다.
   *
   * 테이블마다 `list_columns` 를 부르면 IPC 왕복이 테이블 수만큼 나가 쓸 수 없다.
   * 카탈로그를 한 번에 훑는 `schema_snapshot` 을 쓰고, 컨텍스트가 바뀔 때만 다시 받는다.
   */
  useEffect(() => {
    let cancelled = false;
    setSchemaState("loading");
    api
      // 스키마를 지정하지 않고 받는다 — `db.schema.table` 로 쓰려면 스키마별로 다 알아야 한다.
      .schemaSnapshot(connId, ctx.database ?? null, null)
      .then((rows) => {
        if (cancelled) return;
        setCompletions(rows);
        schemaRef.current = rows;
        setSchemaState("ok");
      })
      .catch((e) => {
        // 자동완성은 있으면 좋은 것이라 콘솔 자체는 계속 쓸 수 있어야 한다.
        // 다만 조용히 비어 버리면 왜 안 되는지 알 수 없으므로 로그에는 남긴다.
        if (cancelled) return;
        setCompletions([]);
        schemaRef.current = [];
        setSchemaState("error");
        addLog({
          kind: "error",
          label: "자동완성 스키마 로드 실패",
          detail: errorLine(e),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [connId, ctx.database]);

  /**
   * CodeMirror 확장. **매 렌더 새 배열을 주면 에디터가 통째로 재구성되어**
   * 커서와 실행 취소 이력이 날아가므로 입력값이 바뀔 때만 다시 만든다.
   */
  const cmExtensions = useMemo(() => {
    const dialect = dialectFor(kind);
    return [
      // 키워드 완성은 방언이 언어 데이터에 등록한다.
      sql({ dialect }),
      // 스키마 완성은 그 **옆에 덧붙인다**. `autocompletion({override})` 를 쓰면
      // 언어 데이터의 소스가 통째로 대체되어 키워드 완성이 함께 꺼진다.
      dialect.language.data.of({
        autocomplete: sqlCompletionSource(() => schemaRef.current),
      }),
      // Tab 으로도 완성을 적용한다(CodeMirror 기본 키맵은 Enter 뿐).
      // **Prec.highest 가 필요하다** — 그러지 않으면 basicSetup 쪽 Tab 처리에 먼저 먹힌다.
      // 팝업이 없을 때는 acceptCompletion 이 false 를 돌려주므로 다른 Tab 동작을 막지 않는다.
      Prec.highest(keymap.of([{ key: "Tab", run: acceptCompletion }])),
      // 에디터 본문(contenteditable)에도 OS 자동 교정을 끈다.
      EditorView.contentAttributes.of({
        autocapitalize: "none",
        autocorrect: "off",
        spellcheck: "false",
      }),
    ];
    // 스키마는 ref 로 읽으므로 의존성에 넣지 않는다 — 넣으면 매번 에디터가 재구성된다.
  }, [kind]);

  /**
   * 실행. **문장 종류를 가르지 않고 스크립트 경로 하나로 보낸다.**
   *
   * 예전에는 첫 키워드로 조회/실행을 갈랐는데, 그러면 여러 문장을 넣었을 때 첫 결과셋만
   * 오고 나머지는 사라진다 — 서버는 다 실행했는데 화면에 안 와서 "일부가 실행되지
   * 않았다"고 오해하게 된다. 이제 결과셋을 전부 받아 탭으로 보여 준다.
   */
  const activeTab = results.find((t) => t.id === activeResultId);

  /** 지금 페이지의 행만 담은 결과. 받아 둔 행에서 잘라 보인다. */
  const shown = useMemo(() => {
    if (!activeTab) return null;
    const from = activeTab.page * activeTab.pageSize;
    return {
      result: { ...activeTab.result, rows: activeTab.rows.slice(from, from + activeTab.pageSize) },
      from,
    };
  }, [activeTab]);

  /** 결과들이 열어 둔 서버 커서를 닫는다. 서버 자원을 붙들지 않게, 결과가 사라질 때마다 부른다. */
  function closeCursors(tabs: ResultTab[]) {
    for (const t of tabs) {
      if (t.cursor === null) continue;
      api.closeCursor(connId, t.cursor).catch(() => {
        /* 이미 닫혔거나 연결이 끊겼다 — 세션이 끝나면 서버가 정리한다 */
      });
    }
  }

  // 콘솔이 사라지면(탭 닫기 · 다시 연결되어 새로 그려짐) 열어 둔 커서를 닫는다.
  const resultsRef = useRef(results);
  resultsRef.current = results;
  useEffect(() => () => closeCursors(resultsRef.current), []); // eslint-disable-line react-hooks/exhaustive-deps

  function patchTab(id: string, patch: Partial<ResultTab>) {
    setResults((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  /** 다음 페이지. 받아 둔 행이 있으면 그걸 보이고, 없으면 서버 커서에서 이어 읽는다. */
  async function nextPage(tab: ResultTab) {
    if ((tab.page + 1) * tab.pageSize < tab.rows.length) {
      patchTab(tab.id, { page: tab.page + 1 });
      return;
    }
    if (tab.cursor === null || tab.loading) return;
    const cursor = tab.cursor;
    patchTab(tab.id, { loading: true });
    // 읽는 사이에 그 결과가 사라졌는지(탭 닫기 · 새로 실행). 그러면 커서만 정리하고 조용히 끝낸다 —
    // 이미 없는 탭에 대해 오류를 띄우면 무엇이 실패했는지 알 수 없다.
    const gone = () => !resultsRef.current.some((t) => t.id === tab.id);
    try {
      const p = await api.fetchCursor(connId, cursor, tab.pageSize);
      if (gone()) {
        if (!p.done) closeCursors([{ ...tab, cursor }]);
        return;
      }
      const got = p.result.rows.length;
      setResults((prev) =>
        prev.map((t) =>
          t.id !== tab.id
            ? t
            : {
                ...t,
                rows: got > 0 ? [...t.rows, ...p.result.rows] : t.rows,
                page: got > 0 ? t.page + 1 : t.page,
                cursor: p.done ? null : t.cursor,
                loading: false,
              },
        ),
      );
      if (got === 0) ui.setStatus("마지막 페이지입니다");
    } catch (e) {
      if (gone()) return;
      // 커서가 사라졌을 수 있다(연결이 다시 맺어짐 등). 아직 남아 있으면 닫고 더 읽지 않는다.
      closeCursors([{ ...tab, cursor }]);
      patchTab(tab.id, { cursor: null, loading: false });
      ui.toastError(e, "다음 페이지를 읽지 못했습니다");
    }
  }

  function togglePin(id: string) {
    setResults((prev) => prev.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)));
  }

  function closeResult(id: string) {
    closeCursors(results.filter((t) => t.id === id));
    const next = results.filter((t) => t.id !== id);
    setResults(next);
    if (id === activeResultId) setActiveResultId(next[next.length - 1]?.id ?? null);
  }

  async function runAuto(target: ExecTarget) {
    const sqlText = target.sql;
    setRunning(true);
    setSqlError(null);
    try {
      const r = await api.runScript(connId, sqlText, { maxRows: rowLimit, captureChanges }, ctx);
      // 고정한 결과는 남기고 나머지만 새 결과로 바꾼다. 사라지는 결과의 커서는 닫는다.
      closeCursors(results.filter((t) => !t.pinned));
      const ids = r.results.map(() => crypto.randomUUID());
      setResults((prev) => {
        const kept = prev.filter((t) => t.pinned);
        let no = Math.max(0, ...kept.map((t) => t.no));
        return [
          ...kept,
          ...r.results.map((result, i): ResultTab => {
            // SELECT 로만 이뤄진 실행이면 결과마다 제 커서가 있다(한 페이지로 끝났으면 없다).
            const cursor = r.cursors?.[i] ?? null;
            return {
              id: ids[i],
              no: ++no,
              result,
              pinned: false,
              sql: sqlText,
              rows: result.rows,
              page: 0,
              pageSize: rowLimit,
              cursor,
              paged: cursor !== null,
              loading: false,
            };
          }),
        ];
      });
      setActiveResultId(ids[0] ?? null);
      setAffected(r.rowsAffected);

      const rowCounts = r.results.map((x) => x.rows.length);
      // 조회와 쓰기가 섞인 스크립트는 **둘 다** 알려야 한다 — 결과 표가 떴다고
      // 영향 행 수를 숨기면 무엇이 바뀌었는지 알 길이 없다.
      const parts: string[] = [];
      if (r.results.length === 1) {
        parts.push(
          `${rowCounts[0]}행 반환${
            r.cursors?.[0] != null ? " (다음 페이지 있음)" : r.results[0].truncated ? " (잘림)" : ""
          }`,
        );
      } else if (r.results.length > 1) {
        parts.push(`결과 ${r.results.length}개 (${rowCounts.join(", ")}행)`);
      }
      if (r.rowsAffected > 0 || r.results.length === 0) {
        parts.push(`${r.rowsAffected}행 영향`);
      }
      const summary = parts.join(" · ");

      addHistory({
        sql: sqlText,
        connName,
        ok: true,
        rows: rowCounts.reduce((a, b) => a + b, r.rowsAffected),
        elapsedMs: r.elapsedMs,
      });
      ui.setStatus(`${summary} (${r.elapsedMs}ms)`);
      addLog({
        kind: r.results.length === 0 ? "exec" : "query",
        label: r.results.length > 1 ? "스크립트 실행" : "쿼리 실행",
        // 우리가 고쳐 보냈으면 **실제로 나간 SQL** 을 남긴다. 원문만 남기면
        // 무엇이 실행됐는지 확인할 방법이 없다.
        sql: r.sql.length > 0 ? r.sql.join("\n") : sqlText,
        detail: summary,
        elapsedMs: r.elapsedMs,
      });
      // 쓰기가 있었으면 토스트로도 알린다 — 상태바는 화면 맨 아래라 놓치기 쉬운데,
      // 몇 행이 바뀌었는지는 실행 직후 반드시 확인해야 하는 정보다.
      if (r.rowsAffected > 0 || r.results.length === 0) {
        ui.pushToast({
          kind: "success",
          title: "실행 완료",
          message: `${summary} (${r.elapsedMs}ms)`,
        });
      }
    } catch (e) {
      // 실패한 쿼리도 히스토리에 남긴다 — 고쳐 쓰려고 다시 꺼내는 경우가 많다.
      reportSqlError(e, "실행 실패", target);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="query-tab">
      <div className="query-toolbar">
          <button
            className="btn sm primary"
            onClick={execute}
            disabled={running}
            title={`${shortcutLabel("execute")} — 선택한 부분이 있으면 그것만, 없으면 전체를 실행합니다. 여러 문장이면 결과를 탭으로 보여 줍니다`}
          >
            <Play size={13} /> 실행
          </button>
          <button
            className={`btn sm${captureChanges ? " on" : ""}`}
            onClick={() => setCaptureChanges((v) => !v)}
            title={
              kind === "mysql"
                ? "MySQL 은 변경된 행을 돌려주는 문법이 없어 지원하지 않습니다"
                : "INSERT/UPDATE/DELETE 가 바꾼 행을 결과로 돌려받습니다. " +
                  "실행 전에 OUTPUT/RETURNING 절이 추가되며, 실제로 나간 SQL 은 로그에 남습니다"
            }
            disabled={kind === "mysql"}
          >
            <FileDiff size={13} /> 변경 행 보기
          </button>
          <button
            className={`btn sm${historyOpen ? " on" : ""}`}
            onClick={() => setHistoryOpen((v) => !v)}
            title={`쿼리 히스토리 (${shortcutLabel("queryHistory")})`}
          >
            <History size={13} /> 히스토리
          </button>
          <span className="spacer" />
          {dbs.length > 0 && (
            <select
              className="select sm"
              value={ctx.database ?? ""}
              onChange={(e) => setCtx({ database: e.target.value || null, schema: null })}
              title="이 콘솔이 실행될 데이터베이스"
            >
              <option value="">(연결 기본값)</option>
              {dbs.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          )}
          {schemas.length > 0 && (
            <select
              className="select sm"
              value={ctx.schema ?? ""}
              onChange={(e) => setCtx((c) => ({ ...c, schema: e.target.value || null }))}
              title="이 콘솔이 실행될 스키마"
            >
              <option value="">(기본 스키마)</option>
              {schemas.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          )}
          <span
            className="muted"
            title={
              schemaState === "error"
                ? "스키마를 읽지 못했습니다 — 로그 패널에서 원인을 확인하세요"
                : "자동완성에 쓰는 테이블 수. Ctrl+Space 로 직접 열 수 있습니다"
            }
            style={schemaState === "error" ? { color: "var(--danger)" } : undefined}
          >
            {schemaState === "loading"
              ? "스키마 읽는 중…"
              : schemaState === "error"
                ? "스키마 실패"
                : `테이블 ${completions.length}`}
          </span>
          <select
            className="select sm"
            value={rowLimit}
            onChange={(e) => changeRowLimit(Number(e.target.value))}
            title="한 번에 받을 행 수 — SELECT 한 문장은 이만큼씩 페이지로 넘겨 이어 읽고, 여러 문장이면 결과셋마다 이만큼에서 자른다"
          >
            {ROW_LIMITS.map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString()}행씩
              </option>
            ))}
          </select>

          {historyOpen && (
            <QueryHistory onPick={setText} onClose={() => setHistoryOpen(false)} />
          )}
        </div>

        <PanelGroup orientation="vertical" style={{ flex: 1, minHeight: 0 }}>
          <Panel defaultSize="40" minSize="15">
            <div
              style={{ height: "100%", overflow: "auto" }}
              // 실행 키는 에디터보다 **먼저** 받는다(capture). CodeMirror 기본 키맵에서 ⌘↩ 는
              // "빈 줄 삽입"이라, 늦게 받으면 선택 영역(⌘A 등)이 빈 줄로 바뀌어 지워진다.
              onKeyDownCapture={(e) => {
                if (!isShortcut(e, "execute")) return;
                e.preventDefault();
                e.stopPropagation();
                execute();
              }}
            >
              <CodeMirror
                ref={editorRef}
                value={text}
                theme={oneDark}
                height="100%"
                style={{ height: "100%", fontSize: 13 }}
                extensions={cmExtensions}
                // WHERE 필터 바와 같은 이유로 스마트 인용부호를 ASCII 로 되돌린다.
                onChange={(v) => setText(normalizeSmartQuotes(v))}
              />
            </div>
          </Panel>
          <PanelResizeHandle className="resize-handle horizontal" />
          <Panel defaultSize="60" minSize="15">
            <div className="query-result">
              {sqlError && (
                <div className="sql-error">
                  <div className="sql-error-head">
                    <AlertTriangle size={13} />
                    {sqlError.spot ? (
                      <b>
                        {sqlError.spot.line}행 {sqlError.spot.col}열 부근
                      </b>
                    ) : (
                      <b>실행 실패</b>
                    )}
                    {sqlError.spot && (
                      <button
                        className="btn sm"
                        onClick={() => {
                          const view = editorRef.current?.view;
                          view?.focus();
                          view?.dispatch({
                            selection: {
                              anchor: sqlError.spot!.offset,
                              head: sqlError.spot!.offset + sqlError.spot!.length,
                            },
                            scrollIntoView: true,
                          });
                        }}
                        title="에디터에서 그 위치로"
                      >
                        위치로 이동
                      </button>
                    )}
                    <span className="spacer" />
                    <CopyButton text={sqlError.message} title="오류 문구 복사" />
                    <button
                      className="btn icon"
                      title="닫기"
                      onClick={() => setSqlError(null)}
                    >
                      <X size={13} />
                    </button>
                  </div>
                  <pre className="sql-error-msg mono">{sqlError.message}</pre>
                </div>
              )}
              {/* 결과가 하나여도 탭을 그린다 — 고정(pin)하려면 탭이 있어야 한다. */}
              {results.length > 0 && (
                <div className="result-tabs" role="tablist">
                  {results.map((t) => (
                    <div
                      key={t.id}
                      role="tab"
                      aria-selected={t.id === activeResultId}
                      className={`result-tab${t.id === activeResultId ? " on" : ""}${
                        t.pinned ? " pinned" : ""
                      }`}
                      onClick={() => setActiveResultId(t.id)}
                      title={`${t.rows.length}행${
                        t.cursor !== null ? "+ (다음 페이지 있음)" : t.result.truncated ? " (잘림)" : ""
                      } · ${
                        t.result.elapsedMs
                      }ms\n${t.sql.trim().slice(0, 300)}`}
                    >
                      {t.pinned && <Pin size={11} className="result-pin-mark" />}
                      결과 {t.no}
                      <span className="muted">
                        {" "}
                        {t.rows.length.toLocaleString()}
                        {t.cursor !== null ? "+" : ""}행
                      </span>
                      <button
                        className="result-tab-btn"
                        title={t.pinned ? "고정 해제" : "고정 — 다음 실행에도 이 결과를 남긴다"}
                        onClick={(e) => {
                          e.stopPropagation();
                          togglePin(t.id);
                        }}
                      >
                        {t.pinned ? <PinOff size={11} /> : <Pin size={11} />}
                      </button>
                      <button
                        className="result-tab-btn"
                        title="결과 닫기"
                        onClick={(e) => {
                          e.stopPropagation();
                          closeResult(t.id);
                        }}
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                  {(affected ?? 0) > 0 && (
                    <span className="result-affected" title="결과셋을 내지 않은 문장들의 영향 행 수">
                      {affected}행 영향
                    </span>
                  )}
                </div>
              )}
              {activeTab && shown ? (
                // 탭마다 정렬·필터·커서가 따로여야 하므로 id 로 새로 마운트한다.
                <ResultTable
                  key={activeTab.id}
                  result={shown.result}
                  rowOffset={shown.from}
                  pager={
                    activeTab.paged
                      ? {
                          from: shown.from,
                          count: shown.result.rows.length,
                          fetched: activeTab.rows.length,
                          total: activeTab.cursor === null ? activeTab.rows.length : null,
                          hasPrev: activeTab.page > 0,
                          hasNext:
                            activeTab.cursor !== null ||
                            (activeTab.page + 1) * activeTab.pageSize < activeTab.rows.length,
                          loading: activeTab.loading,
                          onFirst: () => patchTab(activeTab.id, { page: 0 }),
                          onPrev: () =>
                            patchTab(activeTab.id, { page: Math.max(0, activeTab.page - 1) }),
                          onNext: () => nextPage(activeTab),
                        }
                      : undefined
                  }
                />
              ) : affected !== null ? (
                <div className="empty-state">
                  <h2>{affected}행 영향</h2>
                  <div className="muted">결과셋을 돌려주는 문장이 없습니다.</div>
                </div>
              ) : (
                <div className="empty-state">
                  <div className="muted">실행 결과가 여기에 표시됩니다.</div>
                </div>
              )}
            </div>
          </Panel>
        </PanelGroup>

        {nWarn && (
          <Modal
            title="N 접두사 없는 문자열이 있습니다"
            onClose={() => setNWarn(null)}
            footer={
              <>
                <button className="btn" onClick={() => setNWarn(null)}>
                  취소
                </button>
                <button
                  className="btn primary"
                  onClick={() => {
                    const go = nWarn.proceed;
                    setNWarn(null);
                    go();
                  }}
                >
                  그대로 실행
                </button>
              </>
            }
          >
            <p>
              SQL Server 는 <code>'…'</code> 를 <b>DB 기본 collation 의 코드페이지</b>로
              해석합니다. 그 코드페이지에 없는 문자는 <code>?</code> 로 바뀌어 저장되며,
              <b> 컬럼이 NVARCHAR 여도 마찬가지</b>입니다. 원문이 남지 않아 되돌릴 수 없습니다.
            </p>
            <p className="muted" style={{ marginTop: 8 }}>
              앞에 <code>N</code> 을 붙이면 유니코드로 전달됩니다:
            </p>
            <ul style={{ margin: "6px 0 0 18px" }}>
              {nWarn.literals.slice(0, 8).map((s) => (
                <li key={s} className="mono" style={{ fontSize: 12 }}>
                  <code>'{s}'</code> → <code>N'{s}'</code>
                </li>
              ))}
            </ul>
            {nWarn.literals.length > 8 && (
              <p className="muted" style={{ marginTop: 6 }}>
                외 {nWarn.literals.length - 8}건
              </p>
            )}
          </Modal>
        )}
    </div>
  );
}
