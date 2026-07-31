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

/** 목록에 한 줄로 얹기 위해 개행·연속 공백을 접는다. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
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

  return (
    <div className="log-row" data-kind={entry.kind}>
      <button
        className="log-head"
        onClick={() => sql && setOpen((v) => !v)}
        title={sql ? "클릭하면 전문 보기" : undefined}
        style={{ cursor: sql ? "pointer" : "default" }}
      >
        <span className="mono muted">{timeOf(entry.ts)}</span>
        <span className="log-kind" style={{ color: KIND_COLOR[entry.kind] }}>
          {KIND_LABEL[entry.kind]}
        </span>
        <span className={`log-label${sql ? " mono" : ""}`}>{preview}</span>
        {entry.detail && <span className="muted log-detail">{entry.detail}</span>}
        {entry.elapsedMs !== undefined && (
          <span className="muted mono log-ms">{entry.elapsedMs}ms</span>
        )}
      </button>
      {/* 한 줄로 잘린 전문·여러 문장은 펼쳐서 본다. */}
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
