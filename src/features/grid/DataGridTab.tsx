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
  ChevronsDown,
  ChevronsUp,
  Columns3,
  Copy,
  CopyPlus,
  Eye,
  PanelRight,
  Plus,
  Download,
  RefreshCw,
  RotateCcw,
  Table as TableIcon,
  Trash2,
  X,
} from "lucide-react";
import * as api from "../../api";
import type {
  Cell,
  FilterSpec,
  ForeignKeyRef,
  LogicalType,
  RowEdit,
  SortSpec,
  TablePage,
  TableRef,
} from "../../types";
import { useUiStore } from "../../store/uiStore";
import { useLogStore, type LogChange } from "../../store/logStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { Modal } from "../../components/Modal";
import { StructureView } from "./StructureView";
import { ExportDialog } from "./ExportDialog";
import { ColumnVisibilityPanel } from "./ColumnVisibilityPanel";
import { RecordView } from "./RecordView";
import { normalizeSmartQuotes, rawTextInputProps } from "../../lib/sqlText";

interface Props {
  connId: string;
  table: TableRef;
  /** 탭을 열 때 적용할 필터(F4 로 들어온 경우). 백엔드가 값 바인딩으로 처리한다. */
  initialFilters?: FilterSpec[];
}

interface InsertRow {
  id: string;
  values: Record<string, Cell>;
}

const PAGE_SIZES = [100, 200, 500, 1000] as const;
const DEFAULT_PAGE_SIZE = 200;

function displayValue(v: Cell): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/**
 * 집계용 숫자 변환.
 *
 * NUMERIC·BIGINT 는 정밀도 보존 때문에 **문자열로 내려오므로**(`docs/DESIGN.md` §4)
 * 문자열도 받아야 한다. 숫자로 볼 수 없으면 null 이라 집계에서 빠진다.
 * boolean 은 일부러 제외한다 — true/false 를 1/0 으로 더하면 오해를 부른다.
 */
function toNumber(v: Cell): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 집계 값 표시. 긴 소수는 자르고, 배정밀도로 정확할 수 없는 크기는 근사임을 밝힌다. */
function formatAgg(n: number): string {
  if (!Number.isFinite(n)) return "-";
  const approx = Math.abs(n) > Number.MAX_SAFE_INTEGER ? "≈" : "";
  return (
    approx +
    (Number.isInteger(n)
      ? n.toLocaleString()
      : n.toLocaleString(undefined, { maximumFractionDigits: 4 }))
  );
}

export type AggFn = "sum" | "avg" | "min" | "max" | "count";

/** 상태바에서 고를 수 있는 집계 함수. DataGrip 의 aggregator 위젯과 같은 역할. */
const AGG_FNS: { key: AggFn; label: string }[] = [
  { key: "sum", label: "합계" },
  { key: "avg", label: "평균" },
  { key: "min", label: "최소" },
  { key: "max", label: "최대" },
  { key: "count", label: "개수" },
];

interface Agg {
  count: number;
  sum: number;
  avg: number;
  min: number;
  max: number;
}

function aggValue(fn: AggFn, a: Agg): number {
  switch (fn) {
    case "avg":
      return a.avg;
    case "min":
      return a.min;
    case "max":
      return a.max;
    case "count":
      return a.count;
    default:
      return a.sum;
  }
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

export function DataGridTab({ connId, table, initialFilters }: Props) {
  const ui = useUiStore();
  const [page, setPage] = useState<TablePage | null>(null);
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
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
  /** 관련 레코드 탐색(F4)으로 들어온 필터. WHERE 바와 달리 값이 바인딩된다. */
  const [relFilters, setRelFilters] = useState<FilterSpec[]>(initialFilters ?? []);
  /** F4 대상 선택 팝업(관련 대상이 둘 이상일 때). */
  const [relPick, setRelPick] = useState<
    { fk: ForeignKeyRef; outgoing: boolean; filters: FilterSpec[] }[] | null
  >(null);
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
  /** 데이터 그리드 / 컬럼 구조 중 무엇을 보고 있는지. */
  const [view, setView] = useState<"data" | "structure">("data");
  /** 클릭·키보드로 이동하는 셀 커서(행 인덱스, 컬럼 인덱스). 트리의 tree-cursor 와 같은 역할. */
  const [cursor, setCursor] = useState<{ row: number; col: number } | null>(null);
  /**
   * 범위 선택의 고정점. Shift 없이 움직이면 커서를 따라오고,
   * Shift 를 누른 채 움직이면 여기 남아서 anchor~cursor 사각 영역이 선택된다.
   */
  const [anchor, setAnchor] = useState<{ row: number; col: number } | null>(null);
  /** 값 뷰어로 펼쳐 보는 셀. 그리드 셀은 잘려 보이므로 전체 값을 따로 띄운다. */
  const [viewer, setViewer] = useState<{ row: number; col: number } | null>(null);
  /** 화면에서 감춘 컬럼(이름 기준). 300컬럼 테이블의 가로 스크롤을 줄인다. */
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(new Set());
  const [colPanel, setColPanel] = useState(false);
  /** 레코드 뷰(사이드 패널) 열림 여부. 커서 행을 세로로 펼쳐 본다. */
  const [recordOpen, setRecordOpen] = useState(false);
  /** 행 이동 다이얼로그(⌘/Ctrl+G). 열려 있으면 입력 중인 행 번호를 들고 있다. */
  const [gotoRow, setGotoRow] = useState<string | null>(null);
  /** 선택 셀 집계에 쓸 함수. DataGrip 처럼 골라 쓸 수 있게 둔다(기본 합계). */
  const [aggFn, setAggFn] = useState<AggFn>("sum");
  const [exporting, setExporting] = useState(false);
  const openTable = useWorkspaceStore((s) => s.openTable);
  const connName = useWorkspaceStore(
    (s) => s.tabs.find((x) => x.kind === "table" && x.connId === connId)?.connName ?? connId,
  );
  const gridRef = useRef<HTMLDivElement>(null);

  const allColumns = page?.result.columns ?? [];
  /** 숨김을 걸러낸, 실제로 그리는 컬럼. 커서·복사·내보내기가 모두 이 기준을 쓴다. */
  const columns = useMemo(
    () => allColumns.filter((c) => !hiddenCols.has(c.name)),
    [allColumns, hiddenCols],
  );
  const rows = page?.result.rows ?? [];
  const pks = page?.primaryKeys ?? [];
  /**
   * 기본 키가 없어도 편집을 연다. 행 식별은 모든 컬럼의 원본 값으로 하고,
   * 값이 같은 행이 여럿이면 백엔드가 커밋을 통째로 취소한다(`sql::ensure_single_row`).
   */
  const editable = allColumns.length > 0;
  /** 기본 키 없이 값으로 행을 찾는 상태 — 한계를 사용자에게 알려야 한다. */
  const byValues = editable && pks.length === 0;

  /**
   * 컬럼명 → `rows` 안의 위치.
   *
   * `rows` 는 **숨김과 무관하게** 서버가 준 전체 컬럼 순서다. 화면용 `columns`(숨김 제외)로
   * 인덱스를 만들면 컬럼을 하나라도 숨긴 순간 값이 밀려 읽힌다.
   */
  const colIndex = useMemo(() => {
    const m: Record<string, number> = {};
    allColumns.forEach((c, i) => (m[c.name] = i));
    return m;
  }, [allColumns]);

  const pendingCount =
    Object.keys(edits).length + deleted.size + inserts.length;

  /** anchor~cursor 가 만드는 선택 사각형(양끝 포함). 단일 셀이면 1×1. */
  const range = useMemo(() => {
    if (!cursor || !anchor) return null;
    return {
      r1: Math.min(anchor.row, cursor.row),
      r2: Math.max(anchor.row, cursor.row),
      c1: Math.min(anchor.col, cursor.col),
      c2: Math.max(anchor.col, cursor.col),
    };
  }, [cursor, anchor]);

  /** 두 칸 이상 선택됐을 때만 범위를 칠한다(1×1 은 커서 테두리로 충분). */
  const multiRange =
    range && (range.r1 !== range.r2 || range.c1 !== range.c2) ? range : null;

  /**
   * 선택 범위의 숫자 셀 집계(합계·평균·최소·최대).
   *
   * 서버에 다시 묻지 않고 **화면에 보이는 값**을 그대로 센다 — 편집 중인 값도
   * 반영되어야 하고(`cellValue`), 페이지 밖은 애초에 선택할 수 없다.
   * 숫자가 하나도 없으면 null 이라 아무것도 표시하지 않는다.
   */
  const aggregate = useMemo(() => {
    if (!multiRange) return null;
    let count = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let r = multiRange.r1; r <= multiRange.r2; r++) {
      for (let c = multiRange.c1; c <= multiRange.c2; c++) {
        const n = toNumber(cellValue(r, columns[c].name));
        if (n === null) continue;
        count++;
        sum += n;
        if (n < min) min = n;
        if (n > max) max = n;
      }
    }
    return count > 0 ? { count, sum, avg: sum / count, min, max } : null;

    // cellValue 는 매 렌더 새로 만들어지므로 그 입력(rows·edits·columns)을 의존성으로 둔다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multiRange, columns, rows, edits]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = await api.fetchTablePage({
        connId,
        table,
        limit: pageSize,
        offset,
        sort,
        filters: relFilters,
        filterSql: whereSql || null,
      });
      setPage(p);
      setEdits({});
      setDeleted(new Set());
      setInserts([]);
      setSelection(new Set());
      setEditing(null);
      setCursor(null);
      setAnchor(null);
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
  }, [connId, table, offset, sort, whereSql, relFilters, reloadKey, pageSize]); // eslint-disable-line react-hooks/exhaustive-deps

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

  /**
   * UPDATE/DELETE 의 WHERE 에 쓸 행 식별 값.
   *
   * 기본 키가 있으면 그 컬럼만, 없으면 모든 컬럼의 **원본**(편집 전) 값을 쓴다 —
   * DB 에 지금 들어 있는 행과 맞아야 하기 때문이다.
   * 바이너리 컬럼은 `=` 비교가 부적합하거나 DB 가 아예 거부하므로 뺀다.
   */
  function rowKey(rowIdx: number): Record<string, Cell> {
    const names =
      pks.length > 0
        ? pks
        : allColumns.filter((c) => c.logicalType !== "bytes").map((c) => c.name);
    const key: Record<string, Cell> = {};
    for (const k of names) key[k] = rows[rowIdx][colIndex[k]];
    return key;
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

  /** 커서 행을 복사해 새 행으로 추가한다(PK 는 비워 DB 가 채우게 둔다). */
  function cloneRow() {
    if (!cursor || !editable) return;
    const values: Record<string, Cell> = {};
    for (const c of allColumns) {
      // PK 를 그대로 복사하면 중복으로 커밋이 실패한다.
      values[c.name] = pks.includes(c.name) ? null : cellValue(cursor.row, c.name);
    }
    setInserts((p) => [...p, { id: crypto.randomUUID(), values }]);
    ui.setStatus(`${offset + cursor.row + 1}행을 복제했습니다 — 커밋해야 반영됩니다`);
  }

  /** 선택 범위(없으면 커서 셀)를 NULL 로 만든다. */
  function setRangeNull() {
    if (!range || !editable) return;
    for (let r = range.r1; r <= range.r2; r++) {
      if (deleted.has(r)) continue;
      for (let c = range.c1; c <= range.c2; c++) {
        setExistingCell(r, columns[c].name, null);
      }
    }
  }

  function revert() {
    setEdits({});
    setDeleted(new Set());
    setInserts([]);
    setSelection(new Set());
    setEditing(null);
  }

  /** 행 식별 값을 `id=3` 처럼 한 줄로. 로그에서 어느 행인지 알아보기 위한 표기다. */
  function keyLabel(pk: Record<string, Cell>): string {
    return Object.entries(pk)
      .map(([k, v]) => `${k}=${v === null ? "NULL" : v}`)
      .join(", ");
  }

  async function commit() {
    const editsList: RowEdit[] = [];
    // 무엇이 어떻게 바뀌는지 — 커밋 뒤 로그에 남긴다. 커밋에 성공하면 화면이
    // 새 값으로 덮여, 지금 모아 두지 않으면 이전 값을 다시 볼 방법이 없다.
    const changes: LogChange[] = [];

    // UPDATE
    for (const [idxStr, rowChanges] of Object.entries(edits)) {
      const rowIdx = Number(idxStr);
      if (deleted.has(rowIdx)) continue; // 삭제될 행은 갱신 생략
      const pk = rowKey(rowIdx);
      editsList.push({ type: "update", pk, changes: rowChanges });
      changes.push({
        op: "update",
        key: keyLabel(pk),
        fields: Object.entries(rowChanges).map(([column, after]) => ({
          column,
          before: rows[rowIdx][colIndex[column]],
          after,
        })),
      });
    }
    // DELETE
    for (const rowIdx of deleted) {
      const pk = rowKey(rowIdx);
      editsList.push({ type: "delete", pk });
      changes.push({
        op: "delete",
        key: keyLabel(pk),
        // 삭제는 사라지는 행 전체를 남긴다 — 되살리려면 모든 컬럼이 필요하다.
        fields: allColumns.map((c) => ({
          column: c.name,
          before: rows[rowIdx][colIndex[c.name]],
        })),
      });
    }
    // INSERT — null 뿐인 컬럼은 제외해 DB 기본값이 적용되게 한다.
    for (const ins of inserts) {
      const values: Record<string, Cell> = {};
      for (const [k, v] of Object.entries(ins.values)) {
        if (v !== null) values[k] = v;
      }
      if (Object.keys(values).length === 0) continue;
      editsList.push({ type: "insert", values });
      changes.push({
        op: "insert",
        key: "새 행",
        fields: Object.entries(values).map(([column, after]) => ({ column, after })),
      });
    }

    if (editsList.length === 0) return;

    try {
      const res = await api.applyChanges({ connId, table, edits: editsList });
      ui.pushToast({
        kind: "success",
        title: "커밋 완료",
        message: `추가 ${res.inserted} · 수정 ${res.updated} · 삭제 ${res.deleted}`,
      });
      // 커밋은 백엔드가 문장을 만들기 때문에, 응답에 실려 온 SQL 을 그대로 남긴다.
      // 값은 SQL 이 아니라 `changes` 로 따로 싣는다 — 문형에는 값을 넣지 않는다.
      useLogStore.getState().add({
        kind: "commit",
        label: `커밋 — ${table.name}`,
        sql: res.statements.join("\n"),
        detail: `추가 ${res.inserted} · 수정 ${res.updated} · 삭제 ${res.deleted}`,
        changes,
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

  /** 행 선택이 있으면 그 행들을, 없으면 선택된 셀 범위를 TSV 로 복사한다. */
  function copyCurrent() {
    if (selection.size > 0) {
      const idxs = [...selection].sort((a, b) => a - b);
      const tsv = idxs
        .map((i) => columns.map((c) => clipText(cellValue(i, c.name))).join("\t"))
        .join("\n");
      copyText(tsv, `${idxs.length}개 행`);
      return;
    }
    if (!range) return;
    const lines: string[] = [];
    for (let r = range.r1; r <= range.r2; r++) {
      const cells: string[] = [];
      for (let c = range.c1; c <= range.c2; c++) {
        cells.push(clipText(cellValue(r, columns[c].name)));
      }
      lines.push(cells.join("\t"));
    }
    const n = (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1);
    copyText(lines.join("\n"), n === 1 ? "셀 값" : `셀 ${n}개`);
  }

  /**
   * 셀 커서를 표 범위 안으로 눌러 이동시킨다.
   * `extend` 가 true(Shift 조합)면 anchor 를 남겨 범위를 넓히고, 아니면 anchor 를 끌고 온다.
   */
  function moveCursor(row: number, col: number, extend = false) {
    const next = {
      row: Math.max(0, Math.min(rows.length - 1, row)),
      col: Math.max(0, Math.min(columns.length - 1, col)),
    };
    setCursor(next);
    if (!extend) setAnchor(next);
    else if (!anchor) setAnchor(cursor ?? next);
  }

  /** 클릭한 셀을 커서로 삼고 그리드에 포커스를 준다(이후 방향키가 바로 먹도록). */
  function focusCell(row: number, col: number, extend = false) {
    setCursor({ row, col });
    if (!extend) setAnchor({ row, col });
    else if (!anchor) setAnchor(cursor ?? { row, col });
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
  /**
   * 관련 레코드 탐색(F4 — DataGrip 과 같은 키).
   *
   * 커서 행을 기준으로 **참조하는 쪽(부모)** 과 **참조받는 쪽(자식)** 을 모두 모은다.
   * 대상이 하나면 바로 열고, 여럿이면 고르게 한다.
   *
   * 조건은 문자열 WHERE 가 아니라 `FilterSpec` 으로 넘긴다 — 백엔드가 값 바인딩과
   * 식별자 quoting 을 하므로 이스케이프·방언 차이를 프론트가 떠안지 않는다.
   */
  async function gotoRelated() {
    if (!cursor || !rows[cursor.row]) return;
    let rel;
    try {
      rel = await api.tableRelations(connId, table);
    } catch (e) {
      ui.toastError(e, "관련 레코드 조회 실패");
      return;
    }

    const targets: { fk: ForeignKeyRef; outgoing: boolean; filters: FilterSpec[] }[] = [];
    const add = (fk: ForeignKeyRef, outgoing: boolean) => {
      // 기준 행의 값으로 상대 테이블을 건다. columns 는 언제나 이 테이블 쪽이다.
      const filters: FilterSpec[] = [];
      for (let i = 0; i < fk.columns.length; i++) {
        const v = cellValue(cursor.row, fk.columns[i]);
        const target = fk.refColumns[i];
        if (target === undefined) return; // 컬럼 대응이 깨진 FK 는 건너뛴다
        // NULL 을 = 로 비교하면 아무것도 안 걸린다. 나가는 FK 가 NULL 이면 부모가 없다는 뜻.
        if (v === null) {
          if (outgoing) return;
          filters.push({ column: target, op: "isnull", value: null });
        } else {
          filters.push({ column: target, op: "eq", value: v });
        }
      }
      if (filters.length > 0) targets.push({ fk, outgoing, filters });
    };
    rel.outgoing.forEach((fk) => add(fk, true));
    rel.incoming.forEach((fk) => add(fk, false));

    if (targets.length === 0) {
      ui.pushToast({
        kind: "info",
        title: "관련 레코드 없음",
        message: "이 행에서 따라갈 외래키가 없습니다.",
      });
      return;
    }
    if (targets.length === 1) {
      const t0 = targets[0];
      openTable(connId, connName, t0.fk.table, t0.filters);
      return;
    }
    setRelPick(targets);
  }

  function onGridKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // 셀 편집 중에는 에디터(input)가, 값 뷰어가 떠 있으면 모달이 키를 처리한다.
    if (e.target instanceof HTMLInputElement || viewer) return;
    if (rows.length === 0 || columns.length === 0) return;

    const mod = e.metaKey || e.ctrlKey;

    if (mod && e.key.toLowerCase() === "c") {
      copyCurrent();
      e.preventDefault();
      return;
    }
    // ⌘/Ctrl+D: 행 복제
    if (mod && e.key.toLowerCase() === "d") {
      cloneRow();
      e.preventDefault();
      return;
    }
    // ⌘/Ctrl+Shift+N: 선택 셀을 NULL 로
    if (mod && e.shiftKey && e.key.toLowerCase() === "n") {
      setRangeNull();
      e.preventDefault();
      return;
    }
    // F4: 관련 레코드로 이동 (DataGrip 과 같은 키)
    if (e.key === "F4") {
      gotoRelated();
      e.preventDefault();
      return;
    }
    // ⌘/Ctrl+G: 행 번호로 이동 (DataGrip 과 같은 키)
    if (mod && e.key.toLowerCase() === "g") {
      setGotoRow(cursor ? String(offset + cursor.row + 1) : "");
      e.preventDefault();
      return;
    }
    // ⌘/Ctrl+Alt+↑/↓: 이전·다음 페이지
    if (mod && e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      if (e.key === "ArrowUp") setOffset(Math.max(0, offset - pageSize));
      else if (!atLastPage) setOffset(offset + pageSize);
      e.preventDefault();
      return;
    }
    // ⌘/Ctrl+A: 표 전체 선택
    if (mod && e.key.toLowerCase() === "a") {
      setAnchor({ row: 0, col: 0 });
      setCursor({ row: rows.length - 1, col: columns.length - 1 });
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
      moveCursor(0, 0);
      return;
    }
    // Shift 는 선택 확장, ⌘/Ctrl 은 그 방향 끝까지 점프(엑셀·DataGrip 과 동일).
    const ext = e.shiftKey;
    const lastRow = rows.length - 1;
    const lastCol = columns.length - 1;

    switch (e.key) {
      case "ArrowDown":
        moveCursor(mod ? lastRow : cursor.row + 1, cursor.col, ext);
        break;
      case "ArrowUp":
        moveCursor(mod ? 0 : cursor.row - 1, cursor.col, ext);
        break;
      case "ArrowRight":
        moveCursor(cursor.row, mod ? lastCol : cursor.col + 1, ext);
        break;
      case "ArrowLeft":
        moveCursor(cursor.row, mod ? 0 : cursor.col - 1, ext);
        break;
      case "Home":
        // Home 은 행의 처음, ⌘/Ctrl+Home 은 표의 첫 셀.
        moveCursor(mod ? 0 : cursor.row, 0, ext);
        break;
      case "End":
        moveCursor(mod ? lastRow : cursor.row, lastCol, ext);
        break;
      case "Enter":
      case "F2":
        // ⌘/Ctrl+Shift+Enter 는 레코드 뷰, Shift+Enter 는 값 뷰어,
        // 그 외에는 편집(모두 DataGrip 과 같은 키).
        if (e.key === "Enter" && e.shiftKey && (e.metaKey || e.ctrlKey)) {
          setRecordOpen((v) => !v);
        } else if (e.key === "Enter" && e.shiftKey) {
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

  /** 내보내기 대상 — 셀 범위를 잡았으면 그 부분만, 아니면 현재 페이지 전체. */
  const exportRows = useMemo(() => {
    if (!multiRange) {
      return rows.map((_, r) => columns.map((c) => cellValue(r, c.name)));
    }
    const out: Cell[][] = [];
    for (let r = multiRange.r1; r <= multiRange.r2; r++) {
      const line: Cell[] = [];
      for (let c = multiRange.c1; c <= multiRange.c2; c++) {
        line.push(cellValue(r, columns[c].name));
      }
      out.push(line);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, columns, multiRange, edits]);

  const totalRows = page?.totalRows ?? null;
  const atLastPage =
    totalRows != null ? offset + pageSize >= totalRows : rows.length < pageSize;

  if (view === "structure") {
    return (
      <div className="grid-tab" data-search-scope="grid">
        <div className="grid-toolbar">
          <ViewToggle view={view} onChange={setView} />
        </div>
        <StructureView connId={connId} table={table} />
      </div>
    );
  }

  return (
    <div className="grid-tab" data-search-scope="grid">
      <div className="grid-toolbar">
        <ViewToggle view={view} onChange={setView} />
        <span className="toolbar-sep" />
        <button className="btn sm" onClick={load} disabled={loading} title="새로고침">
          <RefreshCw size={13} /> 새로고침
        </button>
        <button
          className="btn sm"
          onClick={addInsertRow}
          disabled={!editable}
          title={editable ? "행 추가" : "컬럼 정보가 없어 편집 불가"}
        >
          <Plus size={13} /> 행 추가
        </button>
        <button
          className="btn sm"
          onClick={cloneRow}
          disabled={!editable || !cursor}
          title={
            !editable
              ? "컬럼 정보가 없어 편집 불가"
              : cursor
                ? "커서 행 복제 (⌘/Ctrl+D)"
                : "복제할 행을 선택하세요"
          }
        >
          <CopyPlus size={13} /> 행 복제
        </button>
        <button
          className="btn sm"
          onClick={setRangeNull}
          disabled={!editable || !range}
          title="선택 셀을 NULL 로 (⌘/Ctrl+Shift+N)"
        >
          NULL
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
          onClick={() => setExporting(true)}
          disabled={rows.length === 0}
          title="선택 범위 또는 전체를 CSV·JSON 등으로 내보내기"
        >
          <Download size={13} /> 내보내기
        </button>
        <button
          className={`btn sm${hiddenCols.size > 0 ? " on" : ""}`}
          onClick={() => setColPanel((v) => !v)}
          disabled={allColumns.length === 0}
          title="표시할 컬럼 선택"
        >
          <Columns3 size={13} /> 컬럼
          {hiddenCols.size > 0 && ` (${columns.length}/${allColumns.length})`}
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
        <button
          className={`btn sm${recordOpen ? " on" : ""}`}
          onClick={() => setRecordOpen((v) => !v)}
          disabled={!cursor}
          title={
            cursor
              ? "레코드 뷰 — 한 행을 세로로 (⌘/Ctrl+Shift+Enter)"
              : "행을 먼저 선택하세요"
          }
        >
          <PanelRight size={13} /> 레코드
        </button>

        <span className="spacer" />

        {cursor && columns[cursor.col] && (
          <span className="muted mono cursor-pos">
            {multiRange
              ? `${multiRange.r2 - multiRange.r1 + 1}행 × ${
                  multiRange.c2 - multiRange.c1 + 1
                }열 선택`
              : `${offset + cursor.row + 1}행 · ${columns[cursor.col].name}`}
          </span>
        )}

        {aggregate && (
          <span
            className="muted mono cursor-pos"
            title={`선택한 숫자 ${aggregate.count}개 · 클릭하면 집계 함수를 바꿉니다`}
          >
            <select
              className="agg-select"
              value={aggFn}
              onChange={(e) => setAggFn(e.target.value as AggFn)}
              title="집계 함수"
            >
              {AGG_FNS.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>{" "}
            {formatAgg(aggValue(aggFn, aggregate))}
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
        <select
          className="select sm"
          value={pageSize}
          title="페이지당 행 수"
          onChange={(e) => {
            setOffset(0);
            setPageSize(Number(e.target.value));
          }}
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n}행
            </option>
          ))}
        </select>
        <button
          className="btn icon"
          disabled={offset === 0}
          onClick={() => setOffset(0)}
          title="첫 페이지"
        >
          <ChevronsUp size={14} />
        </button>
        <button
          className="btn icon"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - pageSize))}
          title="이전 페이지"
        >
          <ArrowUp size={14} />
        </button>
        <button
          className="btn icon"
          disabled={atLastPage}
          onClick={() => setOffset(offset + pageSize)}
          title="다음 페이지"
        >
          <ArrowDown size={14} />
        </button>
        <button
          className="btn icon"
          // 전체 행 수를 모르면 마지막 위치를 계산할 수 없다.
          disabled={totalRows == null || atLastPage}
          onClick={() =>
            totalRows != null &&
            setOffset(Math.max(0, Math.floor((totalRows - 1) / pageSize) * pageSize))
          }
          title={totalRows == null ? "전체 행 수를 알 수 없습니다" : "마지막 페이지"}
        >
          <ChevronsDown size={14} />
        </button>
      </div>

      {/* DataGrip 스타일 WHERE 필터 바 */}
      <div className="where-bar">
        <span className="where-label">WHERE</span>
        <div className="where-field">
          <input
            ref={whereRef}
            {...rawTextInputProps}
            data-search-input=""
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

      {relFilters.length > 0 && (
        <div className="grid-toolbar">
          <span className="muted">
            관련 레코드 필터:{" "}
            <span className="mono">
              {relFilters
                .map((f) => `${f.column} ${f.op === "isnull" ? "IS NULL" : `= ${String(f.value)}`}`)
                .join(" AND ")}
            </span>
          </span>
          <button
            className="btn sm"
            onClick={() => {
              setRelFilters([]);
              setOffset(0);
            }}
            title="필터 없이 전체 보기"
          >
            <X size={13} /> 필터 해제
          </button>
        </div>
      )}

      {byValues && page && (
        <div className="grid-toolbar" style={{ color: "var(--warning)" }}>
          <Ban size={13} /> 기본 키가 없어 <b>모든 컬럼 값</b>으로 행을 찾습니다. 값이 완전히
          같은 행이 여럿이면 커밋이 통째로 취소됩니다 — 구조 뷰에서 기본 키를 지정하면
          안전해집니다.
        </div>
      )}

      <div className="grid-main">
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
                          multiRange &&
                          rowIdx >= multiRange.r1 &&
                          rowIdx <= multiRange.r2 &&
                          colIdx >= multiRange.c1 &&
                          colIdx <= multiRange.c2
                            ? "in-range"
                            : "",
                        ].join(" ")}
                        // Shift+클릭이면 현재 anchor 에서 여기까지 범위로 잡는다.
                        onClick={(e) => focusCell(rowIdx, colIdx, e.shiftKey)}
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

      {relPick && (
        <Modal
          title="관련 레코드"
          onClose={() => setRelPick(null)}
          footer={
            <button className="btn" onClick={() => setRelPick(null)}>
              닫기
            </button>
          }
        >
          <div className="muted" style={{ marginBottom: 8, fontSize: 12 }}>
            따라갈 관계를 고르세요. 위쪽은 이 행이 <b>참조하는</b> 부모, 아래쪽은 이 행을{" "}
            <b>참조하는</b> 자식입니다.
          </div>
          <div className="rel-list">
            {relPick.map((r, i) => (
              <button
                key={`${r.fk.name}-${i}`}
                className="rel-item"
                onClick={() => {
                  openTable(connId, connName, r.fk.table, r.filters);
                  setRelPick(null);
                }}
              >
                <span className="rel-dir">{r.outgoing ? "→ 부모" : "← 자식"}</span>
                <span className="rel-table">{r.fk.table.name}</span>
                <span className="muted mono rel-cond">
                  {r.filters
                    .map((f) => `${f.column} ${f.op === "isnull" ? "IS NULL" : `= ${String(f.value)}`}`)
                    .join(" AND ")}
                </span>
              </button>
            ))}
          </div>
        </Modal>
      )}

      {gotoRow !== null && (
        <GotoRowDialog
          value={gotoRow}
          onChange={setGotoRow}
          first={offset + 1}
          last={offset + rows.length}
          onClose={() => {
            setGotoRow(null);
            gridRef.current?.focus();
          }}
          onGo={(n) => {
            // 화면의 행 번호는 offset 기준이라 페이지 안 인덱스로 되돌린다.
            const row = n - offset - 1;
            setCursor({ row, col: cursor?.col ?? 0 });
            setAnchor({ row, col: cursor?.col ?? 0 });
            setGotoRow(null);
            gridRef.current?.focus();
            // 렌더 뒤에 스크롤해야 해당 행이 이미 그려져 있다.
            setTimeout(() => {
              gridRef.current
                ?.querySelectorAll<HTMLElement>("tbody tr")
                [row]?.scrollIntoView({ block: "center" });
            }, 0);
          }}
        />
      )}

      {recordOpen && cursor && rows[cursor.row] !== undefined && (
        <RecordView
          columns={allColumns}
          rowNo={offset + cursor.row + 1}
          valueOf={(name) => cellValue(cursor.row, name)}
          isDirty={(name) => isDirty(cursor.row, name)}
          primaryKeys={pks}
          onPick={(name) => {
            // 숨긴 컬럼은 그리드에 없으므로 커서를 옮길 수 없다 — 그때는 그대로 둔다.
            const col = columns.findIndex((c) => c.name === name);
            if (col >= 0) setCursor({ row: cursor.row, col });
            gridRef.current?.focus();
          }}
          onClose={() => {
            setRecordOpen(false);
            gridRef.current?.focus();
          }}
        />
      )}
      </div>

      {colPanel && (
        <ColumnVisibilityPanel
          columns={allColumns}
          hidden={hiddenCols}
          onToggle={(name) =>
            setHiddenCols((prev) => {
              const next = new Set(prev);
              if (next.has(name)) next.delete(name);
              else next.add(name);
              return next;
            })
          }
          onAll={(hide) =>
            setHiddenCols(hide ? new Set(allColumns.map((c) => c.name)) : new Set())
          }
          onClose={() => setColPanel(false)}
        />
      )}

      {exporting && (
        <ExportDialog
          columns={columns}
          // 선택 범위가 있으면 그만큼만, 없으면 현재 페이지 전체.
          rows={exportRows}
          name={table.name}
          scopeNote={multiRange ? "선택 범위" : undefined}
          onClose={() => setExporting(false)}
        />
      )}

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

/** 데이터 / 구조 뷰 전환. 같은 테이블 안에서 보는 대상만 바꾼다. */
function ViewToggle({
  view,
  onChange,
}: {
  view: "data" | "structure";
  onChange: (v: "data" | "structure") => void;
}) {
  return (
    <div className="seg" role="tablist">
      <button
        role="tab"
        aria-selected={view === "data"}
        className={view === "data" ? "active" : ""}
        onClick={() => onChange("data")}
        title="테이블 데이터"
      >
        <TableIcon size={12} /> 데이터
      </button>
      <button
        role="tab"
        aria-selected={view === "structure"}
        className={view === "structure" ? "active" : ""}
        onClick={() => onChange("structure")}
        title="컬럼 구조 — 이름·타입·PK·기본값"
      >
        <Columns3 size={12} /> 구조
      </button>
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
      {...rawTextInputProps}
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

/**
 * 행 번호로 이동 (⌘/Ctrl+G — DataGrip 과 같은 키).
 *
 * **현재 페이지 안에서만** 옮긴다. 화면에 보이는 번호(`offset + i + 1`)를 그대로 받되,
 * 페이지 밖 번호는 받지 않고 범위를 알려 준다 — 다른 페이지로 넘어가는 것은
 * 재조회를 동반해서, "이동"이라는 기대와 달리 화면이 통째로 바뀌기 때문이다.
 */
function GotoRowDialog({
  value,
  onChange,
  first,
  last,
  onGo,
  onClose,
}: {
  value: string;
  onChange: (v: string) => void;
  first: number;
  last: number;
  onGo: (n: number) => void;
  onClose: () => void;
}) {
  const n = Number(value.trim());
  const valid = Number.isInteger(n) && n >= first && n <= last;

  return (
    <Modal
      title="행 이동"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            취소
          </button>
          <button className="btn primary" disabled={!valid} onClick={() => onGo(n)}>
            이동
          </button>
        </>
      }
    >
      <div className="field">
        <label>행 번호</label>
        <input
          {...rawTextInputProps}
          className="input"
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && valid) onGo(n);
          }}
          placeholder={`${first} – ${last}`}
        />
      </div>
      <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
        이 페이지에 보이는 범위는 {first} – {last} 행입니다.
      </div>
    </Modal>
  );
}
