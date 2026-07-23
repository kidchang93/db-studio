import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  Ban,
  Check,
  Copy,
  Eye,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
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
import { Modal } from "../../components/Modal";
import { normalizeSmartQuotes } from "../../lib/sqlText";

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
  /** 실제 조회에 적용된 WHERE (Enter/버튼으로 확정) */
  const [whereSql, setWhereSql] = useState("");
  /** 입력 중인 WHERE 텍스트 */
  const [whereDraft, setWhereDraft] = useState("");
  /**
   * 재조회 트리거. WHERE 를 같은 값으로 다시 적용하면 상태가 바뀌지 않아
   * load 이펙트가 돌지 않으므로, Enter/적용 때마다 이 값을 올려 강제로 다시 조회한다.
   */
  const [reloadKey, setReloadKey] = useState(0);
  /**
   * WHERE 컬럼 자동완성 상태. Tab 을 누른 시점의 접두어(prefix)와 삽입 위치(start)를
   * 붙잡아 두고, Tab 을 반복할 때 같은 후보 목록 안에서 순환한다.
   */
  const [ac, setAc] = useState<{
    start: number;
    items: string[];
    idx: number;
  } | null>(null);
  const whereRef = useRef<HTMLInputElement>(null);

  // 편집 상태
  const [edits, setEdits] = useState<Record<number, Record<string, Cell>>>({});
  const [deleted, setDeleted] = useState<Set<number>>(new Set());
  const [inserts, setInserts] = useState<InsertRow[]>([]);
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<{ row: number | string; col: string } | null>(null);
  /** 클릭·키보드로 이동하는 셀 커서(행 인덱스, 컬럼 인덱스). 트리의 tree-cursor 와 같은 역할. */
  const [cursor, setCursor] = useState<{ row: number; col: number } | null>(null);
  /** 값 뷰어로 펼쳐 보는 셀. 그리드 셀은 잘려 보이므로 전체 값을 따로 띄운다. */
  const [viewer, setViewer] = useState<{ row: number; col: number } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

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
        filterSql: whereSql || null,
      });
      setPage(p);
      setEdits({});
      setDeleted(new Set());
      setInserts([]);
      setSelection(new Set());
      setEditing(null);
      setCursor(null);
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
  }, [connId, table, offset, sort, whereSql, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
  }, [load]);

  /** WHERE 조건 적용. 조건이 그대로여도 다시 조회한다(새로고침처럼 쓰는 경우). */
  function applyWhere() {
    setOffset(0);
    setWhereSql(whereDraft);
    setReloadKey((k) => k + 1);
  }

  function clearWhere() {
    setWhereDraft("");
    setOffset(0);
    setWhereSql("");
    setReloadKey((k) => k + 1);
    setAc(null);
  }

  /** 커서 바로 앞의 식별자 토큰(자동완성 대상)을 찾는다. */
  function tokenBefore(text: string, caret: number) {
    const m = text.slice(0, caret).match(/[A-Za-z_][A-Za-z0-9_]*$/);
    return { word: m?.[0] ?? "", start: m ? caret - m[0].length : caret };
  }

  /** 후보 목록의 idx 번째 컬럼명을 입력창에 써 넣고 커서를 그 뒤로 옮긴다. */
  function insertCompletion(next: { start: number; items: string[]; idx: number }) {
    const input = whereRef.current;
    if (!input) return;
    const end = input.selectionStart ?? whereDraft.length;
    const name = next.items[next.idx];
    setWhereDraft(whereDraft.slice(0, next.start) + name + whereDraft.slice(end));
    setAc(next);
    const caret = next.start + name.length;
    // 값이 반영된 뒤에 커서를 옮긴다.
    requestAnimationFrame(() => input.setSelectionRange(caret, caret));
  }

  /**
   * Tab 컬럼 자동완성. 처음 누르면 커서 앞 토큰으로 후보를 모아 첫 번째를 넣고,
   * 이어서 누르면 같은 후보 안에서 다음(Shift 면 이전) 것으로 바꾼다.
   */
  function completeColumn(step: number) {
    const input = whereRef.current;
    if (!input || columns.length === 0) return;

    if (ac) {
      insertCompletion({
        ...ac,
        idx: (ac.idx + step + ac.items.length) % ac.items.length,
      });
      return;
    }
    const caret = input.selectionStart ?? whereDraft.length;
    const { word, start } = tokenBefore(whereDraft, caret);
    const items = columns
      .map((c) => c.name)
      .filter((n) => n.toLowerCase().startsWith(word.toLowerCase()));
    if (items.length === 0) {
      ui.setStatus(word ? `'${word}' 로 시작하는 컬럼이 없습니다` : "컬럼이 없습니다");
      return;
    }
    insertCompletion({ start, items, idx: 0 });
  }

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

  /** 클립보드 복사용 텍스트. NULL 은 빈 값으로 둬야 붙여넣기가 자연스럽다. */
  function clipText(v: Cell): string {
    return v === null || v === undefined ? "" : String(v);
  }

  async function copyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      ui.setStatus(`${label} 복사됨`);
    } catch {
      ui.pushToast({
        kind: "error",
        title: "복사 실패",
        message: "클립보드에 접근할 수 없습니다",
      });
    }
  }

  /** 선택된 행이 있으면 그 행들을 TSV 로, 없으면 커서 셀 값을 복사한다. */
  function copyCurrent() {
    if (selection.size > 0) {
      const idxs = [...selection].sort((a, b) => a - b);
      const tsv = idxs
        .map((i) => columns.map((c) => clipText(cellValue(i, c.name))).join("\t"))
        .join("\n");
      copyText(tsv, `${idxs.length}개 행`);
      return;
    }
    if (!cursor) return;
    copyText(clipText(cellValue(cursor.row, columns[cursor.col].name)), "셀 값");
  }

  /** 셀 커서를 표 범위 안으로 눌러 이동시킨다. */
  function moveCursor(row: number, col: number) {
    setCursor({
      row: Math.max(0, Math.min(rows.length - 1, row)),
      col: Math.max(0, Math.min(columns.length - 1, col)),
    });
  }

  /** 클릭한 셀을 커서로 삼고 그리드에 포커스를 준다(이후 방향키가 바로 먹도록). */
  function focusCell(row: number, col: number) {
    setCursor({ row, col });
    gridRef.current?.focus();
  }

  /** 값 뷰어 표시용. JSON 으로 보이면 들여쓰기해 읽기 좋게 만든다. */
  function prettyValue(v: Cell): string {
    if (v === null || v === undefined) return "NULL";
    const s = String(v);
    const t = s.trim();
    if (/^[[{]/.test(t) && /[\]}]$/.test(t)) {
      try {
        return JSON.stringify(JSON.parse(t), null, 2);
      } catch {
        return s; // JSON 이 아니면 원문 그대로
      }
    }
    return s;
  }

  /** 그리드 키보드 조작: 방향키 이동, Enter/F2 편집, Space 행 선택. */
  function onGridKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // 셀 편집 중에는 에디터(input)가, 값 뷰어가 떠 있으면 모달이 키를 처리한다.
    if (e.target instanceof HTMLInputElement || viewer) return;
    if (rows.length === 0 || columns.length === 0) return;

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
      copyCurrent();
      e.preventDefault();
      return;
    }
    const NAV = [
      "ArrowDown",
      "ArrowUp",
      "ArrowRight",
      "ArrowLeft",
      "Home",
      "End",
      "Enter",
      "F2",
      " ",
    ];
    if (!NAV.includes(e.key)) return;
    e.preventDefault();

    // 커서가 아직 없으면 첫 셀부터 시작한다.
    if (!cursor) {
      setCursor({ row: 0, col: 0 });
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        moveCursor(cursor.row + 1, cursor.col);
        break;
      case "ArrowUp":
        moveCursor(cursor.row - 1, cursor.col);
        break;
      case "ArrowRight":
        moveCursor(cursor.row, cursor.col + 1);
        break;
      case "ArrowLeft":
        moveCursor(cursor.row, cursor.col - 1);
        break;
      case "Home":
        moveCursor(cursor.row, 0);
        break;
      case "End":
        moveCursor(cursor.row, columns.length - 1);
        break;
      case "Enter":
      case "F2":
        // Shift+Enter 는 값 뷰어, 그 외에는 편집(DataGrip 과 동일).
        if (e.key === "Enter" && e.shiftKey) {
          setViewer(cursor);
        } else if (editable && !deleted.has(cursor.row)) {
          setEditing({ row: cursor.row, col: columns[cursor.col].name });
        }
        break;
      case " ":
        if (editable) toggleRowSelect(cursor.row);
        break;
    }
  }

  // 커서가 보이는 영역 밖으로 나가면 따라 스크롤한다.
  useEffect(() => {
    if (!cursor) return;
    gridRef.current
      ?.querySelector<HTMLElement>("td.cell-cursor")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [cursor]);

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

        <span className="toolbar-sep" />

        <button
          className="btn sm"
          onClick={copyCurrent}
          disabled={!cursor && selection.size === 0}
          title={
            selection.size > 0
              ? `선택한 ${selection.size}개 행 복사 (⌘/Ctrl+C)`
              : cursor
                ? "셀 값 복사 (⌘/Ctrl+C)"
                : "셀을 클릭하거나 방향키로 선택하세요"
          }
        >
          <Copy size={13} /> 복사
        </button>
        <button
          className="btn sm"
          onClick={() => cursor && setViewer(cursor)}
          disabled={!cursor}
          title={
            cursor
              ? "값 전체 보기 (Shift+Enter)"
              : "셀을 클릭하거나 방향키로 선택하세요"
          }
        >
          <Eye size={13} /> 값 보기
        </button>

        <span className="spacer" />

        {cursor && columns[cursor.col] && (
          <span className="muted mono cursor-pos">
            {offset + cursor.row + 1}행 · {columns[cursor.col].name}
          </span>
        )}

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

      {/* DataGrip 스타일 WHERE 필터 바 */}
      <div className="where-bar">
        <span className="where-label">WHERE</span>
        <div className="where-field">
          <input
            ref={whereRef}
            className="where-input mono"
            placeholder="예) id > 100 AND name LIKE '%kim%'   —  Tab 컬럼 완성 · Enter 적용"
            value={whereDraft}
            // macOS 스마트 인용부호(‘ ’)가 섞이면 DB 가 문자열 구분자로 읽지 못한다.
            onChange={(e) => {
              setWhereDraft(normalizeSmartQuotes(e.target.value));
              setAc(null); // 직접 타이핑하면 완성 사이클을 끊는다
            }}
            onBlur={() => setAc(null)}
            onKeyDown={(e) => {
              // 자동완성 사이클: Tab/방향키로 후보 순환
              if (e.key === "Tab" || (ac && (e.key === "ArrowDown" || e.key === "ArrowUp"))) {
                e.preventDefault();
                completeColumn(e.shiftKey || e.key === "ArrowUp" ? -1 : 1);
                return;
              }
              if (e.key === "Enter") {
                setAc(null);
                applyWhere();
              } else if (e.key === "Escape") {
                // 후보가 떠 있으면 그것만 닫고, 아니면 필터를 지운다.
                if (ac) setAc(null);
                else clearWhere();
              }
            }}
          />
          {ac && ac.items.length > 1 && (
            <ul className="ac-popup">
              {ac.items.map((n, i) => (
                <li
                  key={n}
                  className={i === ac.idx ? "active" : ""}
                  // mousedown 기본동작을 막아야 입력창 포커스가 유지된다.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    insertCompletion({ ...ac, idx: i });
                  }}
                >
                  {n}
                </li>
              ))}
            </ul>
          )}
        </div>
        {whereSql && (
          <button className="btn icon" title="필터 지우기 (Esc)" onClick={clearWhere}>
            <X size={14} />
          </button>
        )}
        <button className="btn sm" onClick={applyWhere} title="조건 적용 · 다시 조회 (Enter)">
          적용
        </button>
      </div>

      {!editable && page && (
        <div className="grid-toolbar" style={{ color: "var(--warning)" }}>
          <Ban size={13} /> 이 테이블은 기본 키가 없어 읽기 전용입니다.
        </div>
      )}

      <div
        className="grid-scroll"
        ref={gridRef}
        tabIndex={0}
        onKeyDown={onGridKeyDown}
      >
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
                  {columns.map((c, colIdx) => {
                    const val = cellValue(rowIdx, c.name);
                    const isEditingCell =
                      editing?.row === rowIdx && editing?.col === c.name;
                    return (
                      <td
                        key={c.name}
                        className={[
                          val === null ? "null" : "",
                          isDirty(rowIdx, c.name) ? "dirty" : "",
                          cursor?.row === rowIdx && cursor?.col === colIdx
                            ? "cell-cursor"
                            : "",
                        ].join(" ")}
                        onClick={() => focusCell(rowIdx, colIdx)}
                        onDoubleClick={() =>
                          editable && !isDel && setEditing({ row: rowIdx, col: c.name })
                        }
                      >
                        {isEditingCell ? (
                          <CellEditor
                            initial={val}
                            logicalType={c.logicalType}
                            onCommit={(raw) => {
                              setExistingCell(rowIdx, c.name, coerce(raw, c.logicalType));
                              setEditing(null);
                              gridRef.current?.focus(); // 편집 후 방향키가 계속 먹도록
                            }}
                            onCancel={() => {
                              setEditing(null);
                              gridRef.current?.focus();
                            }}
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
                          logicalType={c.logicalType}
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

      {viewer && columns[viewer.col] && (
        <ValueViewer
          column={columns[viewer.col]}
          rowNo={offset + viewer.row + 1}
          value={cellValue(viewer.row, columns[viewer.col].name)}
          pretty={prettyValue(cellValue(viewer.row, columns[viewer.col].name))}
          onCopy={(text) => copyText(text, "값")}
          onClose={() => {
            setViewer(null);
            gridRef.current?.focus(); // 닫은 뒤 방향키가 이어지도록
          }}
        />
      )}
    </div>
  );
}

/** 셀 값 전체를 펼쳐 보는 패널. 그리드에서는 값이 잘려 보이기 때문에 따로 띄운다. */
function ValueViewer({
  column,
  rowNo,
  value,
  pretty,
  onCopy,
  onClose,
}: {
  column: { name: string; dbType: string };
  rowNo: number;
  value: Cell;
  pretty: string;
  onCopy: (text: string) => void;
  onClose: () => void;
}) {
  const isNull = value === null || value === undefined;
  const raw = isNull ? "" : String(value);
  return (
    <Modal
      title={`${column.name} — ${rowNo}행`}
      onClose={onClose}
      footer={
        <>
          <span className="muted value-meta">
            {column.dbType}
            {!isNull && ` · ${raw.length.toLocaleString()}자`}
          </span>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            닫기
          </button>
          <button
            className="btn primary"
            onClick={() => onCopy(raw)}
            disabled={isNull}
            title="값을 클립보드로 복사"
          >
            <Copy size={13} /> 복사
          </button>
        </>
      }
    >
      <pre className={`value-view mono${isNull ? " null" : ""}`}>{pretty}</pre>
    </Modal>
  );
}

/** DB 문자열 → <input type=date|datetime-local|time> 이 받는 형식. */
function toDateInput(raw: string, lt: LogicalType): string {
  if (!raw) return "";
  if (lt === "datetime") {
    const s = raw.replace(" ", "T");
    const m = s.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?/);
    return m ? m[1] + (m[2] ?? ":00") : "";
  }
  if (lt === "date") {
    const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : "";
  }
  if (lt === "time") {
    const m = raw.match(/^(\d{2}:\d{2})(:\d{2})?/);
    return m ? m[1] + (m[2] ?? ":00") : "";
  }
  return raw;
}

/** 날짜 입력값 → DB 로 보낼 문자열. */
function fromDateInput(v: string, lt: LogicalType): string {
  if (!v) return "";
  return lt === "datetime" ? v.replace("T", " ") : v;
}

function CellEditor({
  initial,
  logicalType,
  onCommit,
  onCancel,
}: {
  initial: Cell;
  logicalType: LogicalType;
  onCommit: (raw: string) => void;
  onCancel: () => void;
}) {
  const isDate =
    logicalType === "date" || logicalType === "datetime" || logicalType === "time";
  const inputType =
    logicalType === "date"
      ? "date"
      : logicalType === "datetime"
        ? "datetime-local"
        : logicalType === "time"
          ? "time"
          : "text";

  const [v, setV] = useState(
    initial === null
      ? ""
      : isDate
        ? toDateInput(String(initial), logicalType)
        : String(initial),
  );
  const commit = () => onCommit(isDate ? fromDateInput(v, logicalType) : v);

  return (
    <input
      className="cell-input"
      type={inputType}
      step={isDate ? 1 : undefined}
      autoFocus
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") onCancel();
      }}
    />
  );
}
