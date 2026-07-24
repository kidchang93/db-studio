import { useState } from "react";
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
import { QueryHistory } from "./QueryHistory";
import { normalizeSmartQuotes } from "../../lib/sqlText";

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

export function QueryTab({ connId }: { connId: string }) {
  const ui = useUiStore();
  const kind = useConnectionStore((s) => s.connections[connId]?.handle.kind);
  const [text, setText] = useState("SELECT 1;");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [exec, setExec] = useState<ExecResult | null>(null);
  const [running, setRunning] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const addHistory = useHistoryStore((s) => s.add);
  const connName = useConnectionStore((s) => s.connections[connId]?.name ?? connId);

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
    } catch (e) {
      addHistory({ sql: text, connName, ok: false, error: errorLine(e) });
      ui.toastError(e, "스크립트 실행 실패");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="query-tab">
      <div className="query-toolbar">
          <button className="btn sm primary" onClick={run} disabled={running} title="Ctrl/Cmd+Enter">
            <Play size={13} /> 실행
          </button>
          <button className="btn sm" onClick={runScript} disabled={running} title="DDL/다중 문장">
            <ScrollText size={13} /> 스크립트 실행
          </button>
          <button
            className={`btn sm${historyOpen ? " on" : ""}`}
            onClick={() => setHistoryOpen((v) => !v)}
            title="쿼리 히스토리"
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
                  run();
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
    </div>
  );
}
