import { useState } from "react";
import { Trash2, X } from "lucide-react";
import { useLogStore, type LogEntry, type LogKind } from "../../store/logStore";

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

function Row({ entry }: { entry: LogEntry }) {
  const [open, setOpen] = useState(false);
  const sql = entry.sql?.trim();
  return (
    <div className="log-row" data-kind={entry.kind}>
      <button
        className="log-head"
        onClick={() => sql && setOpen((v) => !v)}
        title={sql ? "SQL 펼치기/접기" : undefined}
        style={{ cursor: sql ? "pointer" : "default" }}
      >
        <span className="mono muted">{timeOf(entry.ts)}</span>
        <span className="log-kind" style={{ color: KIND_COLOR[entry.kind] }}>
          {KIND_LABEL[entry.kind]}
        </span>
        <span className="log-label">{entry.label}</span>
        {entry.detail && <span className="muted log-detail">{entry.detail}</span>}
        {entry.elapsedMs !== undefined && (
          <span className="muted mono">{entry.elapsedMs}ms</span>
        )}
      </button>
      {/* SQL 은 접어 둔다 — 커밋 한 번에 문장이 여럿일 수 있어 펼치면 목록이 묻힌다. */}
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
