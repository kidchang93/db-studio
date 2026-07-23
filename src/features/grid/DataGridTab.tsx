import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Ban,
  Check,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "lucide-react";
import * as api from "../../api";
import type {
  Cell,
  LogicalType,
  RowEdit,
  SortSpec,
  TablePage,
  TableRef,
} from "../../types";
import { useUiStore } from "../../store/uiStore";

interface Props {
  connId: string;
  table: TableRef;
}

interface InsertRow {
  id: string;
  values: Record<string, Cell>;
}

const PAGE_SIZE = 200;

function displayValue(v: Cell): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

function coerce(input: string, lt: LogicalType): Cell {
  if (input === "") return null;
  switch (lt) {
    case "int": {
      const n = Number(input);
      return Number.isInteger(n) ? n : input;
    }
    case "float": {
      const n = Number(input);
      return Number.isNaN(n) ? input : n;
    }
    case "bool": {
      const v = input.trim().toLowerCase();
      if (["true", "1", "t", "yes"].includes(v)) return true;
      if (["false", "0", "f", "no"].includes(v)) return false;
      return input;
    }
    default:
      return input; // decimal/문자열/날짜 등은 문자열 그대로(정밀도 보존)
  }
}

export function DataGridTab({ connId, table }: Props) {
  const ui = useUiStore();
  const [page, setPage] = useState<TablePage | null>(null);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<SortSpec[]>([]);
  const [loading, setLoading] = useState(false);

  // 편집 상태
  const [edits, setEdits] = useState<Record<number, Record<string, Cell>>>({});
  const [deleted, setDeleted] = useState<Set<number>>(new Set());
  const [inserts, setInserts] = useState<InsertRow[]>([]);
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<{ row: number | string; col: string } | null>(null);

  const columns = page?.result.columns ?? [];
  const rows = page?.result.rows ?? [];
  const pks = page?.primaryKeys ?? [];
  const editable = pks.length > 0;

  const colIndex = useMemo(() => {
    const m: Record<string, number> = {};
    columns.forEach((c, i) => (m[c.name] = i));
    return m;
  }, [columns]);

  const pendingCount =
    Object.keys(edits).length + deleted.size + inserts.length;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = await api.fetchTablePage({
        connId,
        table,
        limit: PAGE_SIZE,
        offset,
        sort,
        filters: [],
      });
      setPage(p);
      setEdits({});
      setDeleted(new Set());
      setInserts([]);
      setSelection(new Set());
      setEditing(null);
      ui.setStatus(
        `${table.name}: ${p.result.rows.length}행 표시` +
          (p.totalRows != null ? ` / 전체 ${p.totalRows}행` : "") +
          ` (${p.result.elapsedMs}ms)`,
      );
    } catch (e) {
      ui.toastError(e, "데이터 로드 실패");
    } finally {
      setLoading(false);
    }
  }, [connId, table, offset, sort]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
  }, [load]);

  function toggleSort(col: string) {
    setOffset(0);
    setSort((prev) => {
      const cur = prev.find((s) => s.column === col);
      if (!cur) return [{ column: col, descending: false }];
      if (!cur.descending) return [{ column: col, descending: true }];
      return [];
    });
  }

  function cellValue(rowIdx: number, colName: string): Cell {
    const ov = edits[rowIdx];
    if (ov && colName in ov) return ov[colName];
    return rows[rowIdx][colIndex[colName]];
  }

  function setExistingCell(rowIdx: number, colName: string, value: Cell) {
    setEdits((prev) => {
      const original = rows[rowIdx][colIndex[colName]];
      const rowEdits = { ...(prev[rowIdx] ?? {}) };
      if (value === original) {
        delete rowEdits[colName];
      } else {
        rowEdits[colName] = value;
      }
      const next = { ...prev };
      if (Object.keys(rowEdits).length === 0) delete next[rowIdx];
      else next[rowIdx] = rowEdits;
      return next;
    });
  }

  function isDirty(rowIdx: number, colName: string): boolean {
    return !!edits[rowIdx] && colName in edits[rowIdx];
  }

  function addInsertRow() {
    const values: Record<string, Cell> = {};
    columns.forEach((c) => (values[c.name] = null));
    setInserts((p) => [...p, { id: crypto.randomUUID(), values }]);
  }

  function deleteSelected() {
    setDeleted((prev) => {
      const next = new Set(prev);
      selection.forEach((i) => next.add(i));
      return next;
    });
    setSelection(new Set());
  }

  function toggleRowSelect(rowIdx: number) {
    if (deleted.has(rowIdx)) {
      setDeleted((prev) => {
        const next = new Set(prev);
        next.delete(rowIdx);
        return next;
      });
      return;
    }
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(rowIdx)) next.delete(rowIdx);
      else next.add(rowIdx);
      return next;
    });
  }

  function revert() {
    setEdits({});
    setDeleted(new Set());
    setInserts([]);
    setSelection(new Set());
    setEditing(null);
  }

  async function commit() {
    const editsList: RowEdit[] = [];

    // UPDATE
    for (const [idxStr, changes] of Object.entries(edits)) {
      const rowIdx = Number(idxStr);
      if (deleted.has(rowIdx)) continue; // 삭제될 행은 갱신 생략
      const pk: Record<string, Cell> = {};
      for (const k of pks) pk[k] = rows[rowIdx][colIndex[k]];
      editsList.push({ type: "update", pk, changes });
    }
    // DELETE
    for (const rowIdx of deleted) {
      const pk: Record<string, Cell> = {};
      for (const k of pks) pk[k] = rows[rowIdx][colIndex[k]];
      editsList.push({ type: "delete", pk });
    }
    // INSERT — null 뿐인 컬럼은 제외해 DB 기본값이 적용되게 한다.
    for (const ins of inserts) {
      const values: Record<string, Cell> = {};
      for (const [k, v] of Object.entries(ins.values)) {
        if (v !== null) values[k] = v;
      }
      if (Object.keys(values).length > 0) editsList.push({ type: "insert", values });
    }

    if (editsList.length === 0) return;

    try {
      const res = await api.applyChanges({ connId, table, edits: editsList });
      ui.pushToast({
        kind: "success",
        title: "커밋 완료",
        message: `추가 ${res.inserted} · 수정 ${res.updated} · 삭제 ${res.deleted}`,
      });
      await load();
    } catch (e) {
      ui.toastError(e, "커밋 실패 (롤백됨)");
    }
  }

  const totalRows = page?.totalRows ?? null;

  return (
    <div className="grid-tab">
      <div className="grid-toolbar">
        <button className="btn sm" onClick={load} disabled={loading} title="새로고침">
          <RefreshCw size={13} /> 새로고침
        </button>
        <button
          className="btn sm"
          onClick={addInsertRow}
          disabled={!editable}
          title={editable ? "행 추가" : "PK 가 없어 편집 불가"}
        >
          <Plus size={13} /> 행 추가
        </button>
        <button
          className="btn sm"
          onClick={deleteSelected}
          disabled={!editable || selection.size === 0}
        >
          <Trash2 size={13} /> 선택 삭제 {selection.size > 0 ? `(${selection.size})` : ""}
        </button>

        <span className="spacer" />

        {pendingCount > 0 && (
          <>
            <span className="muted">{pendingCount}건 변경 대기</span>
            <button className="btn sm" onClick={revert} title="되돌리기">
              <RotateCcw size={13} /> 되돌리기
            </button>
            <button className="btn sm primary" onClick={commit} title="커밋(트랜잭션)">
              <Check size={13} /> 커밋
            </button>
          </>
        )}

        <span className="muted" style={{ marginLeft: 8 }}>
          {offset + 1}–{offset + rows.length}
          {totalRows != null ? ` / ${totalRows}` : ""}
        </span>
        <button
          className="btn icon"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          title="이전 페이지"
        >
          <ArrowUp size={14} />
        </button>
        <button
          className="btn icon"
          disabled={totalRows != null ? offset + PAGE_SIZE >= totalRows : rows.length < PAGE_SIZE}
          onClick={() => setOffset(offset + PAGE_SIZE)}
          title="다음 페이지"
        >
          <ArrowDown size={14} />
        </button>
      </div>

      {!editable && page && (
        <div className="grid-toolbar" style={{ color: "var(--warning)" }}>
          <Ban size={13} /> 이 테이블은 기본 키가 없어 읽기 전용입니다.
        </div>
      )}

      <div className="grid-scroll">
        <table className="grid">
          <thead>
            <tr>
              <th className="rownum">#</th>
              {columns.map((c) => {
                const s = sort.find((x) => x.column === c.name);
                return (
                  <th
                    key={c.name}
                    className={pks.includes(c.name) ? "pk" : ""}
                    onClick={() => toggleSort(c.name)}
                    title={`${c.dbType}${pks.includes(c.name) ? " · PK" : ""}`}
                  >
                    {c.name}
                    {s && (s.descending ? " ▾" : " ▴")}
                    <span className="col-type">{c.dbType}</span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((_, rowIdx) => {
              const isDel = deleted.has(rowIdx);
              const isSel = selection.has(rowIdx);
              return (
                <tr
                  key={rowIdx}
                  className={isDel ? "del-row" : isSel ? "selected" : ""}
                >
                  <td className="rownum" onClick={() => editable && toggleRowSelect(rowIdx)}>
                    {offset + rowIdx + 1}
                  </td>
                  {columns.map((c) => {
                    const val = cellValue(rowIdx, c.name);
                    const isEditingCell =
                      editing?.row === rowIdx && editing?.col === c.name;
                    return (
                      <td
                        key={c.name}
                        className={[
                          val === null ? "null" : "",
                          isDirty(rowIdx, c.name) ? "dirty" : "",
                        ].join(" ")}
                        onDoubleClick={() =>
                          editable && !isDel && setEditing({ row: rowIdx, col: c.name })
                        }
                      >
                        {isEditingCell ? (
                          <CellEditor
                            initial={val}
                            onCommit={(raw) => {
                              setExistingCell(rowIdx, c.name, coerce(raw, c.logicalType));
                              setEditing(null);
                            }}
                            onCancel={() => setEditing(null)}
                          />
                        ) : (
                          displayValue(val)
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}

            {/* 신규 삽입 행 */}
            {inserts.map((ins) => (
              <tr key={ins.id} className="new-row">
                <td
                  className="rownum"
                  title="이 신규 행 제거"
                  onClick={() => setInserts((p) => p.filter((r) => r.id !== ins.id))}
                >
                  ×
                </td>
                {columns.map((c) => {
                  const val = ins.values[c.name];
                  const isEditingCell = editing?.row === ins.id && editing?.col === c.name;
                  return (
                    <td
                      key={c.name}
                      className={val === null ? "null" : ""}
                      onDoubleClick={() => setEditing({ row: ins.id, col: c.name })}
                    >
                      {isEditingCell ? (
                        <CellEditor
                          initial={val}
                          onCommit={(raw) => {
                            const v = coerce(raw, c.logicalType);
                            setInserts((p) =>
                              p.map((r) =>
                                r.id === ins.id
                                  ? { ...r, values: { ...r.values, [c.name]: v } }
                                  : r,
                              ),
                            );
                            setEditing(null);
                          }}
                          onCancel={() => setEditing(null)}
                        />
                      ) : (
                        displayValue(val)
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>

        {page && rows.length === 0 && inserts.length === 0 && (
          <div className="empty-state">
            <h2>행이 없습니다</h2>
            <div className="muted">‘행 추가’로 새 데이터를 삽입할 수 있습니다.</div>
          </div>
        )}
      </div>
    </div>
  );
}

function CellEditor({
  initial,
  onCommit,
  onCancel,
}: {
  initial: Cell;
  onCommit: (raw: string) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(initial === null ? "" : String(initial));
  return (
    <input
      className="cell-input"
      autoFocus
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onCommit(v)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(v);
        else if (e.key === "Escape") onCancel();
      }}
    />
  );
}
