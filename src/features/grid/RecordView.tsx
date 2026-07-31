import { useState } from "react";
import { Search, X } from "lucide-react";
import type { Cell, ColumnMeta } from "../../types";
import { rawTextInputProps } from "../../lib/sqlText";

interface Props {
  /** 숨김과 무관하게 **모든** 컬럼. 레코드 전체를 보는 것이 이 패널의 목적이다. */
  columns: ColumnMeta[];
  /** 화면에 보이는 행 번호(1부터). */
  rowNo: number;
  /** 컬럼명 → 현재 값(편집 중이면 편집값). */
  valueOf: (columnName: string) => Cell;
  /** 편집으로 더럽혀진 컬럼인지. */
  isDirty: (columnName: string) => boolean;
  primaryKeys: string[];
  /** 값을 누르면 그리드의 그 셀로 커서를 옮긴다(편집은 그리드에서 이어서 한다). */
  onPick: (columnName: string) => void;
  onClose: () => void;
}

function display(v: Cell): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/**
 * 한 레코드를 세로로 펼쳐 보는 사이드 패널 (DataGrip 의 Record View).
 *
 * 컬럼이 수십 개인 테이블은 그리드에서 한 행을 읽으려면 가로로 계속 스크롤해야 한다.
 * 여기서는 `컬럼명 · 값`을 위에서 아래로 훑을 수 있다.
 *
 * **숨긴 컬럼도 보여준다** — 숨김은 그리드 가로폭을 줄이려는 장치이고,
 * 이 패널은 반대로 레코드 전체를 확인하려는 곳이라 목적이 다르다.
 */
export function RecordView({
  columns,
  rowNo,
  valueOf,
  isDirty,
  primaryKeys,
  onPick,
  onClose,
}: Props) {
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? columns.filter(
        (c) =>
          c.name.toLowerCase().includes(needle) ||
          display(valueOf(c.name)).toLowerCase().includes(needle),
      )
    : columns;

  return (
    <div className="record-view" data-search-scope="record">
      <div className="col-panel-head">
        <span className="spacer">
          {rowNo}행 · {columns.length}개 컬럼
        </span>
        <button className="btn icon" title="닫기 (Esc)" onClick={onClose}>
          <X size={13} />
        </button>
      </div>

      <div className="col-panel-head">
        <Search size={13} className="muted" />
        <input
          {...rawTextInputProps}
          data-search-input=""
          className="where-input"
          placeholder="컬럼·값 검색"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              if (filter) setFilter("");
              else onClose();
            }
          }}
        />
      </div>

      <div className="record-body">
        {shown.length === 0 ? (
          <div className="muted" style={{ padding: "10px 12px", fontSize: 12 }}>
            일치하는 컬럼이 없습니다.
          </div>
        ) : (
          shown.map((c) => {
            const v = valueOf(c.name);
            return (
              <button
                key={c.name}
                className="record-row"
                onClick={() => onPick(c.name)}
                title="그리드의 이 셀로 이동"
              >
                <span className={`record-name${primaryKeys.includes(c.name) ? " pk" : ""}`}>
                  {c.name}
                </span>
                <span
                  className={`record-value mono${v === null ? " null" : ""}${
                    isDirty(c.name) ? " dirty" : ""
                  }`}
                >
                  {display(v)}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
