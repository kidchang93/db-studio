import { useState } from "react";
import { Trash2, X } from "lucide-react";
import { useLogStore, type LogChange, type LogEntry, type LogKind } from "../../store/logStore";
import type { Cell } from "../../types";

const KIND_LABEL: Record<LogKind, string> = {
  query: "조회",
  exec: "실행",
  commit: "커밋",
  error: "오류",
};

/** 종류별 색. 오류만 눈에 띄면 되고 나머지는 조용해야 한다. */
const KIND_COLOR: Record<LogKind, string> = {
  query: "var(--text-faint)",
  exec: "var(--accent)",
  commit: "var(--success)",
  error: "var(--danger)",
};

function timeOf(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 목록에 한 줄로 얹기 위해 개행·연속 공백을 접는다. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

const OP_LABEL: Record<LogChange["op"], string> = {
  insert: "추가",
  update: "수정",
  delete: "삭제",
};

/** 값 한 칸. NULL 과 빈 문자열은 눈으로 구분되어야 한다. */
function valueText(v: Cell | undefined): string {
  if (v === null || v === undefined) return "NULL";
  if (v === "") return "(빈 문자열)";
  return String(v);
}

/**
 * 행 단위 변경 내역.
 *
 * "3행 영향"만으로는 무엇이 바뀌었는지 알 수 없다. 어느 행의 어느 컬럼이
 * 무엇에서 무엇으로 바뀌었는지를 그대로 보여 준다.
 */
function Changes({ changes }: { changes: LogChange[] }) {
  return (
    <div className="log-changes">
      {changes.map((c, i) => (
        <div key={i} className="log-change">
          <div className="log-change-head">
            <span className={`log-op ${c.op}`}>{OP_LABEL[c.op]}</span>
            <span className="mono">{c.key}</span>
          </div>
          {c.fields.map((f) => (
            <div key={f.column} className="log-field mono">
              <span className="log-field-name">{f.column}</span>
              {c.op !== "insert" && <span className="log-before">{valueText(f.before)}</span>}
              {c.op === "update" && <span className="log-arrow">→</span>}
              {c.op !== "delete" && <span className="log-after">{valueText(f.after)}</span>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Row({ entry }: { entry: LogEntry }) {
  const [open, setOpen] = useState(false);
  const sql = entry.sql?.trim();
  const statements = sql ? sql.split("\n").filter((l) => l.trim()) : [];

  /**
   * 목록의 주 텍스트는 **SQL 그 자체**다.
   *
   * "문장 실행" 같은 라벨은 왼쪽 종류 배지와 겹쳐서, 그걸 보여 주면 정작 무엇이
   * 실행됐는지는 펼쳐야만 알 수 있다. 로그를 여는 이유가 바로 그것이므로 앞에 세운다.
   */
  const preview =
    statements.length > 1
      ? `${statements.length}개 문장 — ${oneLine(statements[0])}`
      : sql
        ? oneLine(sql)
        : entry.label;

  const changes = entry.changes ?? [];
  const expandable = Boolean(sql) || changes.length > 0;

  return (
    <div className="log-row" data-kind={entry.kind}>
      <button
        className="log-head"
        onClick={() => expandable && setOpen((v) => !v)}
        title={expandable ? "클릭하면 변경 내역과 SQL 전문 보기" : undefined}
        style={{ cursor: expandable ? "pointer" : "default" }}
      >
        <span className="mono muted">{timeOf(entry.ts)}</span>
        <span className="log-kind" style={{ color: KIND_COLOR[entry.kind] }}>
          {KIND_LABEL[entry.kind]}
        </span>
        <span className={`log-label${sql ? " mono" : ""}`}>{preview}</span>
        {entry.detail && <span className="muted log-detail">{entry.detail}</span>}
        {changes.length > 0 && (
          <span className="muted log-detail">변경 {changes.length}행</span>
        )}
        {entry.elapsedMs !== undefined && (
          <span className="muted mono log-ms">{entry.elapsedMs}ms</span>
        )}
      </button>
      {/* 무엇이 바뀌었는지가 먼저다. SQL 전문은 그 아래에 둔다. */}
      {open && changes.length > 0 && <Changes changes={changes} />}
      {open && sql && <pre className="log-sql mono">{sql}</pre>}
    </div>
  );
}

export function LogPanel() {
  const entries = useLogStore((s) => s.entries);
  const clear = useLogStore((s) => s.clear);
  const setOpen = useLogStore((s) => s.setOpen);

  return (
    <div className="log-panel">
      <div className="log-panel-head">
        <span className="spacer">로그 {entries.length > 0 && `(${entries.length})`}</span>
        <button className="btn icon" title="지우기" onClick={clear} disabled={entries.length === 0}>
          <Trash2 size={13} />
        </button>
        <button className="btn icon" title="닫기" onClick={() => setOpen(false)}>
          <X size={13} />
        </button>
      </div>
      <div className="log-body">
        {entries.length === 0 ? (
          <div className="muted" style={{ padding: "10px 12px", fontSize: 12 }}>
            실행한 쿼리와 커밋이 여기에 쌓입니다. 항목을 클릭하면 실제로 나간 SQL 을 볼 수 있습니다.
          </div>
        ) : (
          entries.map((e) => <Row key={e.id} entry={e} />)
        )}
      </div>
    </div>
  );
}
