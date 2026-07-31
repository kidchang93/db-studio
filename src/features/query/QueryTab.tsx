import { useEffect, useState } from "react";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { sql, PostgreSQL, MySQL, SQLite, MSSQL, type SQLDialect } from "@codemirror/lang-sql";
import { oneDark } from "@codemirror/theme-one-dark";
import { History, Play, ScrollText } from "lucide-react";
import {
  Group as PanelGroup,
  Panel,
  Separator as PanelResizeHandle,
} from "react-resizable-panels";
import * as api from "../../api";
import { ResultTable } from "../grid/ResultTable";
import type { DbKind, ExecResult, QueryResult } from "../../types";
import { useConnectionStore } from "../../store/connectionStore";
import { useUiStore } from "../../store/uiStore";
import { useHistoryStore } from "../../store/historyStore";
import { useLogStore } from "../../store/logStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { QueryHistory } from "./QueryHistory";
import { normalizeSmartQuotes, returnsRows, scanSqlText } from "../../lib/sqlText";
import { Modal } from "../../components/Modal";

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

export function QueryTab({ connId, tabId }: { connId: string; tabId: string }) {
  const ui = useUiStore();
  const kind = useConnectionStore((s) => s.connections[connId]?.handle.kind);
  const [text, setText] = useState("SELECT 1;");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [exec, setExec] = useState<ExecResult | null>(null);
  const [running, setRunning] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** N 접두사 경고 대기 중인 실행. 확인을 받으면 `proceed` 를 부른다. */
  const [nWarn, setNWarn] = useState<{ literals: string[]; proceed: () => void } | null>(
    null,
  );
  const addHistory = useHistoryStore((s) => s.add);
  const addLog = useLogStore((s) => s.add);
  const connName = useConnectionStore((s) => s.connections[connId]?.name ?? connId);

  /**
   * ⌘/Ctrl+E → 히스토리 토글 (DataGrip 과 같은 키).
   *
   * 탭은 전부 마운트된 채 `display` 로만 숨겨지므로 **활성 탭만** 반응해야 한다.
   * 그렇지 않으면 열어 둔 콘솔 수만큼 패널이 함께 열린다.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "e") return;
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
  function guarded(exec: () => void) {
    if (kind === "mssql") {
      const scan = scanSqlText(text);
      if (scan.writes && scan.unprefixed.length > 0) {
        setNWarn({ literals: scan.unprefixed, proceed: exec });
        return;
      }
    }
    exec();
  }

  /**
   * 실행 버튼의 진입점. 문장 종류를 보고 조회/실행 경로를 **자동으로 가른다**.
   *
   * DML·DDL 을 조회 경로로 보내면 결과셋이 없어 빈 표와 "0행 반환"만 남는다.
   * 정작 알아야 할 영향 행 수는 실행 경로에서만 나온다.
   */
  async function runAuto() {
    if (returnsRows(text)) await run();
    else await runScript();
  }

  async function run() {
    setRunning(true);
    setExec(null);
    try {
      const r = await api.runQuery(connId, text, 5000);
      setResult(r);
      addHistory({
        sql: text,
        connName,
        ok: true,
        rows: r.rows.length,
        elapsedMs: r.elapsedMs,
      });
      ui.setStatus(
        `${r.rows.length}행 반환${r.truncated ? " (잘림)" : ""} (${r.elapsedMs}ms)`,
      );
      addLog({
        kind: "query",
        label: "쿼리 실행",
        sql: text,
        detail: `${r.rows.length}행 반환${r.truncated ? " (잘림)" : ""}`,
        elapsedMs: r.elapsedMs,
      });
    } catch (e) {
      // 실패한 쿼리도 남긴다 — 고쳐 쓰려고 다시 꺼내는 경우가 많다.
      addHistory({ sql: text, connName, ok: false, error: errorLine(e) });
      ui.toastError(e, "쿼리 실행 실패");
    } finally {
      setRunning(false);
    }
  }

  async function runScript() {
    setRunning(true);
    setResult(null);
    try {
      const r = await api.runExecute(connId, text);
      setExec(r);
      addHistory({
        sql: text,
        connName,
        ok: true,
        rows: r.rowsAffected,
        elapsedMs: r.elapsedMs,
      });
      ui.setStatus(`${r.rowsAffected}행 영향 (${r.elapsedMs}ms)`);
      addLog({
        kind: "exec",
        label: "문장 실행",
        sql: text,
        detail: `${r.rowsAffected}행 영향`,
        elapsedMs: r.elapsedMs,
      });
      // 쓰기 결과는 토스트로도 알린다 — 상태바는 화면 맨 아래라 놓치기 쉽고,
      // 몇 행이 바뀌었는지는 실행 직후 반드시 확인해야 하는 정보다.
      ui.pushToast({
        kind: "success",
        title: "실행 완료",
        message: `${r.rowsAffected}행 영향 (${r.elapsedMs}ms)`,
      });
    } catch (e) {
      addHistory({ sql: text, connName, ok: false, error: errorLine(e) });
      ui.toastError(e, "실행 실패");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="query-tab">
      <div className="query-toolbar">
          <button
            className="btn sm primary"
            onClick={() => guarded(runAuto)}
            disabled={running}
            title="Ctrl/Cmd+Enter"
          >
            <Play size={13} /> 실행
          </button>
          <button
            className="btn sm"
            onClick={() => guarded(runScript)}
            disabled={running}
            title="DDL/다중 문장"
          >
            <ScrollText size={13} /> 스크립트 실행
          </button>
          <button
            className={`btn sm${historyOpen ? " on" : ""}`}
            onClick={() => setHistoryOpen((v) => !v)}
            title="쿼리 히스토리 (Ctrl/Cmd+E)"
          >
            <History size={13} /> 히스토리
          </button>
          <span className="spacer" />
          <span className="muted">최대 5000행 표시</span>

          {historyOpen && (
            <QueryHistory onPick={setText} onClose={() => setHistoryOpen(false)} />
          )}
        </div>

        <PanelGroup orientation="vertical" style={{ flex: 1, minHeight: 0 }}>
          <Panel defaultSize="40" minSize="15">
            <div
              style={{ height: "100%", overflow: "auto" }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  guarded(runAuto);
                }
              }}
            >
              <CodeMirror
                value={text}
                theme={oneDark}
                height="100%"
                style={{ height: "100%", fontSize: 13 }}
                extensions={[
                  sql({ dialect: dialectFor(kind) }),
                  // 에디터 본문(contenteditable)에도 OS 자동 교정을 끈다.
                  EditorView.contentAttributes.of({
                    autocapitalize: "none",
                    autocorrect: "off",
                    spellcheck: "false",
                  }),
                ]}
                // WHERE 필터 바와 같은 이유로 스마트 인용부호를 ASCII 로 되돌린다.
                onChange={(v) => setText(normalizeSmartQuotes(v))}
              />
            </div>
          </Panel>
          <PanelResizeHandle className="resize-handle horizontal" />
          <Panel defaultSize="60" minSize="15">
            <div className="query-result">
              {result ? (
                <ResultTable result={result} />
              ) : exec ? (
                <div className="empty-state">
                  <h2>{exec.rowsAffected}행 영향</h2>
                  <div className="muted">{exec.elapsedMs}ms</div>
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
