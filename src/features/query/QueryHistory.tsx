import { useMemo, useState } from "react";
import { Check, Clock, Search, Trash2, X } from "lucide-react";
import { useHistoryStore, type HistoryEntry } from "../../store/historyStore";
import { matches } from "../explorer/filterContext";
import { rawTextInputProps } from "../../lib/sqlText";

interface Props {
  /** 선택한 SQL 을 에디터에 넣는다. */
  onPick: (sql: string) => void;
  onClose: () => void;
}

/** 실행 시각을 상대 표기로. 오래된 것은 날짜로 보여준다. */
function when(at: number): string {
  const diff = Date.now() - at;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}시간 전`;
  return new Date(at).toLocaleDateString();
}

/** SQL 을 한 줄로 접어 목록에 보여준다. */
function oneLine(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/**
 * 쿼리 히스토리 패널.
 *
 * 실패한 쿼리도 남긴다 — 고쳐 쓰려고 다시 꺼내는 경우가 많기 때문.
 */
export function QueryHistory({ onPick, onClose }: Props) {
  const entries = useHistoryStore((s) => s.entries);
  const remove = useHistoryStore((s) => s.remove);
  const clear = useHistoryStore((s) => s.clear);
  const [filter, setFilter] = useState("");

  const shown = useMemo(
    () => (filter ? entries.filter((e) => matches(e.sql, filter)) : entries),
    [entries, filter],
  );

  function pick(e: HistoryEntry) {
    onPick(e.sql);
    onClose();
  }

  return (
    <>
      <div className="panel-backdrop" onMouseDown={onClose} />
      <div className="history-panel">
        <div className="col-panel-head">
          <Search size={13} className="muted" />
          <input
            {...rawTextInputProps}
            className="where-input"
            placeholder="히스토리 검색"
            value={filter}
            autoFocus
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                if (filter) setFilter("");
                else onClose();
              }
            }}
          />
          <button className="btn icon" title="닫기 (Esc)" onClick={onClose}>
            <X size={13} />
          </button>
        </div>

        <div className="col-panel-actions">
          <span className="muted">
            {filter ? `${shown.length} / ${entries.length}` : `${entries.length}건`}
          </span>
          <span className="spacer" />
          {entries.length > 0 && (
            <button
              className="btn sm"
              onClick={clear}
              title="모든 기록을 지웁니다(되돌릴 수 없음)"
            >
              전체 삭제
            </button>
          )}
        </div>

        <div className="history-list">
          {shown.map((e) => (
            <div
              key={e.id}
              className="history-item"
              onClick={() => pick(e)}
              title="클릭하면 에디터에 넣습니다"
            >
              <span className={`history-mark ${e.ok ? "ok" : "fail"}`}>
                {e.ok ? <Check size={11} /> : <X size={11} />}
              </span>
              <div className="history-body">
                <div className="history-sql mono">{oneLine(e.sql)}</div>
                <div className="muted history-meta">
                  <Clock size={10} /> {when(e.at)} · {e.connName}
                  {e.ok
                    ? e.rows != null && ` · ${e.rows}행${e.elapsedMs != null ? ` · ${e.elapsedMs}ms` : ""}`
                    : e.error && ` · ${e.error}`}
                </div>
              </div>
              <button
                className="btn icon"
                title="이 기록 삭제"
                onClick={(ev) => {
                  ev.stopPropagation();
                  remove(e.id);
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}

          {shown.length === 0 && (
            <div className="muted picker-empty">
              {entries.length === 0
                ? "실행한 쿼리가 아직 없습니다."
                : "검색 결과가 없습니다."}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
