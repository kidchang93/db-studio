import { useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import type { ColumnMeta } from "../../types";
import { highlight, matches } from "../explorer/filterContext";
import { rawTextInputProps } from "../../lib/sqlText";

interface Props {
  columns: ColumnMeta[];
  /** 감춘 컬럼 이름. */
  hidden: Set<string>;
  onToggle: (name: string) => void;
  /** true 면 전부 감추고, false 면 전부 보인다. */
  onAll: (hide: boolean) => void;
  onClose: () => void;
}

/**
 * 표시할 컬럼을 고르는 패널.
 *
 * 컬럼이 수백 개인 테이블은 가로 스크롤만으로 다루기 어려워, 필요한 것만 남긴다.
 * 모달이 아닌 드롭다운이라 그리드를 보면서 켜고 끌 수 있다.
 */
export function ColumnVisibilityPanel({
  columns,
  hidden,
  onToggle,
  onAll,
  onClose,
}: Props) {
  const [filter, setFilter] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const shown = useMemo(
    () => (filter ? columns.filter((c) => matches(c.name, filter)) : columns),
    [columns, filter],
  );
  const visibleCount = columns.length - hidden.size;

  return (
    <>
      {/* 바깥을 누르면 닫힌다. */}
      <div className="panel-backdrop" onMouseDown={onClose} />
      <div className="col-panel">
        <div className="col-panel-head">
          <Search size={13} className="muted" />
          <input
            ref={searchRef}
            {...rawTextInputProps}
            className="where-input"
            placeholder="컬럼 검색"
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
            {visibleCount} / {columns.length} 표시
          </span>
          <span className="spacer" />
          <button className="btn sm" onClick={() => onAll(false)}>
            모두 표시
          </button>
          <button
            className="btn sm"
            onClick={() => onAll(true)}
            title="모두 감추면 그리드가 비어 보입니다"
          >
            모두 감추기
          </button>
        </div>

        <div className="col-panel-list">
          {shown.map((c) => (
            <label key={c.name}>
              <input
                type="checkbox"
                checked={!hidden.has(c.name)}
                onChange={() => onToggle(c.name)}
              />
              <span className="tree-label">{highlight(c.name, filter)}</span>
              <span className="muted col-type">{c.dbType}</span>
            </label>
          ))}
          {shown.length === 0 && (
            <div className="muted picker-empty">검색 결과가 없습니다.</div>
          )}
        </div>
      </div>
    </>
  );
}
