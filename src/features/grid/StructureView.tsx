import { useEffect, useMemo, useRef, useState } from "react";
import { KeyRound, Search, X } from "lucide-react";
import { PrimaryKeyDialog } from "./PrimaryKeyDialog";
import * as api from "../../api";
import type { ColumnInfo, TableRef } from "../../types";
import { useUiStore } from "../../store/uiStore";
import { highlight, matches } from "../explorer/filterContext";
import { rawTextInputProps } from "../../lib/sqlText";

interface Props {
  connId: string;
  table: TableRef;
}

/**
 * 테이블의 컬럼 목록을 표로 보여준다.
 * 컬럼이 수백 개인 테이블이 있어 검색(부분 수열 매칭)을 전면에 둔다.
 */
export function StructureView({ connId, table }: Props) {
  const ui = useUiStore();
  const [cols, setCols] = useState<ColumnInfo[] | null>(null);
  const [filter, setFilter] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  /** PK 후보로 고른 컬럼(순서 = 기본 키 컬럼 순서). */
  const [picked, setPicked] = useState<string[]>([]);
  const [pkDialog, setPkDialog] = useState(false);
  /** DDL 적용 후 컬럼 목록을 다시 읽기 위한 트리거. */
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    api
      .listColumns(connId, table)
      .then((c) => {
        if (alive) setCols(c);
      })
      .catch((e) => ui.toastError(e, "컬럼 정보를 불러오지 못했습니다"));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, table, reloadKey]);

  // 컬럼이 많을 때가 본론이라, 화면에 들어오면 바로 검색할 수 있게 한다.
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const shown = useMemo(() => {
    const all = cols ?? [];
    if (!filter) return all;
    return all.filter((c) => matches(c.name, filter) || matches(c.dbType, filter));
  }, [cols, filter]);

  async function copyName(name: string) {
    try {
      await navigator.clipboard.writeText(name);
      ui.setStatus(`컬럼명 '${name}' 복사됨`);
    } catch {
      ui.pushToast({
        kind: "error",
        title: "복사 실패",
        message: "클립보드에 접근할 수 없습니다",
      });
    }
  }

  const total = cols?.length ?? 0;
  /** 이미 PK 가 있으면 새로 지정할 수 없다(먼저 제거해야 한다). */
  const hasPk = !!cols?.some((c) => c.isPrimaryKey);

  function togglePick(name: string) {
    setPicked((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    );
  }

  return (
    <div className="structure-view" data-search-scope="structure">
      {!hasPk && cols && cols.length > 0 && (
        <div className="grid-toolbar">
          <KeyRound size={13} className="muted" />
          <span className="muted">
            {picked.length === 0
              ? "기본 키가 없습니다. 컬럼을 선택해 지정할 수 있습니다."
              : `기본 키 후보: ${picked.join(", ")}`}
          </span>
          <span className="spacer" />
          {picked.length > 0 && (
            <button className="btn sm" onClick={() => setPicked([])}>
              선택 해제
            </button>
          )}
          <button
            className="btn sm primary"
            disabled={picked.length === 0}
            onClick={() => setPkDialog(true)}
            title={
              picked.length === 0
                ? "왼쪽 체크박스로 컬럼을 선택하세요"
                : "선택한 컬럼으로 기본 키 지정"
            }
          >
            기본 키 지정
          </button>
        </div>
      )}

      <div className="where-bar">
        <Search size={13} className="muted" />
        <div className="where-field">
          <input
            ref={searchRef}
            {...rawTextInputProps}
            data-search-input=""
            className="where-input"
            placeholder="컬럼 검색 — 이름·타입 (예: cc → con_code)"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setFilter("")}
          />
        </div>
        {filter && (
          <button className="btn icon" title="검색 지우기 (Esc)" onClick={() => setFilter("")}>
            <X size={14} />
          </button>
        )}
        <span className="muted cursor-pos">
          {filter ? `${shown.length} / ${total}` : `${total}개 컬럼`}
        </span>
      </div>

      <div className="grid-scroll">
        <table className="grid">
          <thead>
            <tr>
              {!hasPk && <th className="pick" />}
              <th className="rownum">#</th>
              <th>이름</th>
              <th>타입</th>
              <th>NULL</th>
              <th>기본값</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => (
              <tr key={c.name} className={picked.includes(c.name) ? "selected" : ""}>
                {!hasPk && (
                  <td className="pick">
                    <input
                      type="checkbox"
                      checked={picked.includes(c.name)}
                      onChange={() => togglePick(c.name)}
                      title="기본 키 컬럼으로 선택"
                    />
                  </td>
                )}
                <td className="rownum">{c.ordinal}</td>
                <td
                  className={c.isPrimaryKey ? "pk" : ""}
                  title="클릭하면 컬럼명 복사"
                  onClick={() => copyName(c.name)}
                >
                  {c.isPrimaryKey && <KeyRound size={11} className="pk-icon" />}
                  {highlight(c.name, filter)}
                </td>
                <td className="muted">{highlight(c.dbType, filter)}</td>
                <td className={c.nullable ? "muted" : ""}>
                  {c.nullable ? "NULL" : "NOT NULL"}
                </td>
                <td className={c.default ? "" : "null"}>{c.default ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {cols && shown.length === 0 && (
          <div className="empty-state">
            <h2>{total === 0 ? "컬럼이 없습니다" : "검색 결과가 없습니다"}</h2>
            {total > 0 && (
              <div className="muted">‘{filter}’ 와 일치하는 컬럼이 없습니다.</div>
            )}
          </div>
        )}
      </div>

      {pkDialog && (
        <PrimaryKeyDialog
          connId={connId}
          table={table}
          columns={picked}
          onClose={() => setPkDialog(false)}
          onApplied={() => {
            setPicked([]);
            setReloadKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}
