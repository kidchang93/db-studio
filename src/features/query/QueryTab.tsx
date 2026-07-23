import { useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { sql, PostgreSQL, MySQL, SQLite, MSSQL, type SQLDialect } from "@codemirror/lang-sql";
import { oneDark } from "@codemirror/theme-one-dark";
import { Play, ScrollText } from "lucide-react";
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

  async function run() {
    setRunning(true);
    setExec(null);
    try {
      const r = await api.runQuery(connId, text, 5000);
      setResult(r);
      ui.setStatus(
        `${r.rows.length}행 반환${r.truncated ? " (잘림)" : ""} (${r.elapsedMs}ms)`,
      );
    } catch (e) {
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
      ui.setStatus(`${r.rowsAffected}행 영향 (${r.elapsedMs}ms)`);
    } catch (e) {
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
          <span className="spacer" />
          <span className="muted">최대 5000행 표시</span>
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
                extensions={[sql({ dialect: dialectFor(kind) })]}
                onChange={setText}
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
