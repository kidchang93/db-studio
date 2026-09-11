import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowDown, ArrowUp, ChevronsUp, Copy, Download, Eye, PanelRight, Search } from "lucide-react";
import type { Cell, QueryResult } from "../../types";
import { useUiStore } from "../../store/uiStore";
import { isShortcut, shortcutLabel } from "../../lib/keymap";
import { rawTextInputProps } from "../../lib/sqlText";
import { visibleRows, type ResultSort } from "../../lib/resultView";
import { columnWidths, rowNumberWidth } from "../../lib/gridLayout";
import { ExportDialog } from "./ExportDialog";
import { RecordView } from "./RecordView";
import { ValueViewer, prettyValue } from "./ValueViewer";
import { SpacerRow, useVirtualRows } from "./virtualRows";

function display(v: Cell): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/** 클립보드용 텍스트. NULL 은 빈 값으로 둬야 붙여넣기가 자연스럽다. */
function clip(v: Cell): string {
  return v === null || v === undefined ? "" : String(v);
}

/** 콘솔 결과의 페이지 이동. 다음 페이지는 서버 커서에서 이어 읽는다(docs/DESIGN.md §6-3). */
export interface ResultPager {
  /** 지금 페이지 첫 행의 위치(0부터). */
  from: number;
  /** 지금 페이지의 행 수. */
  count: number;
  /** 지금까지 받은 행 수. */
  fetched: number;
  /** 전체 행 수. 끝까지 읽기 전에는 모른다(null). */
  total: number | null;
  hasPrev: boolean;
  hasNext: boolean;
  loading: boolean;
  onFirst: () => void;
  onPrev: () => void;
  onNext: () => void;
}

/**
 * 읽기 전용 결과 그리드(쿼리 콘솔 결과).
 *
 * 편집은 없지만 **받아 둔 결과를 다루는 도구**는 있어야 한다 — 복사·내보내기, 그리고
 * 정렬·필터·값 보기·레코드 뷰(docs/DESIGN.md §6-3 "결과 그리드").
 *
 * 정렬·필터는 **받아 둔 행 안에서** 한다. 서버에 다시 묻지 않는다 — 정렬하려고 사용자 SQL 을
 * 다시 실행하면 쓰기 문장이 한 번 더 실행될 수 있다. 편집이 없으므로 그리드 탭(`DataGridTab`)의
 * pending·커밋 기계는 가져오지 않는다.
 *
 * 커서·선택 좌표는 **화면에 보이는 순서**(정렬·필터 적용 후)의 위치다.
 */
export function ResultTable({
  result,
  rowOffset = 0,
  pager,
}: {
  result: QueryResult;
  /** 이 페이지 첫 행의 위치 — 행 번호를 전체 기준으로 보이기 위해. */
  rowOffset?: number;
  pager?: ResultPager;
}) {
  const ui = useUiStore();
  const [cursor, setCursor] = useState<{ row: number; col: number } | null>(null);
  /** 범위 선택의 고정점. Shift 로 움직이면 여기부터 커서까지가 선택된다. */
  const [anchor, setAnchor] = useState<{ row: number; col: number } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [sort, setSort] = useState<ResultSort | null>(null);
  const [filter, setFilter] = useState("");
  const [viewer, setViewer] = useState<{ row: number; col: number } | null>(null);
  const [recordOpen, setRecordOpen] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

  const cols = result.columns;
  const rows = result.rows;

  /** 화면에 보이는 행들의 원래 인덱스(필터 → 정렬 순, `lib/resultView.ts`). */
  const view = useMemo(() => visibleRows(rows, cols, filter, sort), [rows, cols, filter, sort]);

  /** 화면 위치 r 의 행. */
  const at = (r: number) => rows[view[r]];

  const range = useMemo(() => {
    if (!cursor || !anchor) return null;
    return {
      r1: Math.min(anchor.row, cursor.row),
      r2: Math.max(anchor.row, cursor.row),
      c1: Math.min(anchor.col, cursor.col),
      c2: Math.max(anchor.col, cursor.col),
    };
  }, [cursor, anchor]);

  const multi = range && (range.r1 !== range.r2 || range.c1 !== range.c2) ? range : null;

  // 열 폭은 결과 전체로 한 번 정한다 — 보이는 행만 그리면 자동 폭이 스크롤마다 달라진다.
  const widths = useMemo(() => columnWidths(cols, rows.length, (r, c) => rows[r][c]), [cols, rows]);
  const { virtualizer, items, padTop, padBottom } = useVirtualRows(view.length, gridRef);

  // 방향키로 커서가 화면 밖으로 나가면 따라 스크롤한다. 그 행이 아직 그려지지 않았을 수
  // 있어 먼저 행 위치로 옮기고, 그려진 뒤 가로 방향을 셀에 맞춘다.
  useEffect(() => {
    if (!cursor) return;
    virtualizer.scrollToIndex(cursor.row, { align: "auto" });
    const id = requestAnimationFrame(() =>
      gridRef.current
        ?.querySelector<HTMLElement>("td.cell-cursor")
        ?.scrollIntoView({ block: "nearest", inline: "nearest" }),
    );
    return () => cancelAnimationFrame(id);
  }, [cursor, virtualizer]);

  // 페이지를 넘기면 선택을 풀고 맨 위부터 보인다.
  useEffect(() => {
    clearSelection();
    virtualizer.scrollToOffset(0);
  }, [rowOffset, virtualizer]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 보이는 순서가 바뀌면 커서가 엉뚱한 행을 가리키므로 선택을 푼다. */
  function clearSelection() {
    setCursor(null);
    setAnchor(null);
    setViewer(null);
  }

  /** 헤더 클릭: 오름 → 내림 → 해제(테이블 그리드와 같은 순서). */
  function toggleSort(col: number) {
    clearSelection();
    setSort((prev) => {
      if (!prev || prev.col !== col) return { col, desc: false };
      if (!prev.desc) return { col, desc: true };
      return null;
    });
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

  /** 선택 범위가 있으면 그 부분, 없으면 보이는 행 전체를 헤더까지 붙여 TSV 로 복사한다. */
  function copySelection() {
    if (view.length === 0) return;
    if (multi) {
      const lines: string[] = [];
      for (let r = multi.r1; r <= multi.r2; r++) {
        const line: string[] = [];
        for (let c = multi.c1; c <= multi.c2; c++) line.push(clip(at(r)[c]));
        lines.push(line.join("\t"));
      }
      const n = (multi.r2 - multi.r1 + 1) * (multi.c2 - multi.c1 + 1);
      copyText(lines.join("\n"), `${n}개 셀`);
      return;
    }
    if (cursor) {
      copyText(clip(at(cursor.row)[cursor.col]), "셀");
      return;
    }
    copyAll();
  }

  function copyAll() {
    const header = cols.map((c) => c.name).join("\t");
    const body = view.map((i) => rows[i].map(clip).join("\t"));
    copyText([header, ...body].join("\n"), `${view.length}행`);
  }

  function move(dr: number, dc: number, extend: boolean) {
    if (view.length === 0 || cols.length === 0) return;
    const cur = cursor ?? { row: 0, col: 0 };
    const next = {
      row: Math.max(0, Math.min(view.length - 1, cur.row + dr)),
      col: Math.max(0, Math.min(cols.length - 1, cur.col + dc)),
    };
    setCursor(next);
    if (!extend) setAnchor(next);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (isShortcut(e, "copy")) {
      copySelection();
      e.preventDefault();
      return;
    }
    if (isShortcut(e, "selectAll")) {
      setAnchor({ row: 0, col: 0 });
      setCursor({ row: view.length - 1, col: cols.length - 1 });
      e.preventDefault();
      return;
    }
    if (isShortcut(e, "valueView")) {
      if (cursor) setViewer(cursor);
      e.preventDefault();
      return;
    }
    if (isShortcut(e, "recordView")) {
      if (cursor) setRecordOpen((v) => !v);
      e.preventDefault();
      return;
    }
    // 페이지 이동은 방향키보다 먼저 본다(⌥⌘↓ 도 e.key 는 ArrowDown 이다).
    if (pager && isShortcut(e, "nextPage")) {
      if (pager.hasNext && !pager.loading) pager.onNext();
      e.preventDefault();
      return;
    }
    if (pager && isShortcut(e, "prevPage")) {
      if (pager.hasPrev) pager.onPrev();
      e.preventDefault();
      return;
    }
    const map: Record<string, [number, number]> = {
      ArrowDown: [1, 0],
      ArrowUp: [-1, 0],
      ArrowRight: [0, 1],
      ArrowLeft: [0, -1],
    };
    const d = map[e.key];
    if (!d) return;
    move(d[0], d[1], e.shiftKey);
    e.preventDefault();
  }

  if (cols.length === 0) {
    return (
      <div className="empty-state">
        <div className="muted">반환된 컬럼이 없습니다.</div>
      </div>
    );
  }

  const exportCols = multi ? cols.slice(multi.c1, multi.c2 + 1) : cols;
  // 범위를 잡았으면 **행과 컬럼을 함께** 잘라야 한다. 행만 자르면 헤더 수가 어긋난다.
  const exportRows = multi
    ? view.slice(multi.r1, multi.r2 + 1).map((i) => rows[i].slice(multi.c1, multi.c2 + 1))
    : view.map((i) => rows[i]);
  const narrowed = filter.trim() !== "" || sort !== null;
  const rowNoW = rowNumberWidth(rowOffset + view.length);

  return (
    <div className="result-pane" data-search-scope="result">
      <div className="grid-toolbar">
        <button className="btn sm" onClick={copySelection} disabled={view.length === 0}>
          <Copy size={13} /> 복사
        </button>
        <button className="btn sm" onClick={() => setExporting(true)} disabled={view.length === 0}>
          <Download size={13} /> 내보내기
        </button>
        <button
          className="btn sm"
          onClick={() => cursor && setViewer(cursor)}
          disabled={!cursor}
          title={cursor ? `값 전체 보기 (${shortcutLabel("valueView")})` : "셀을 먼저 고르세요"}
        >
          <Eye size={13} /> 값 보기
        </button>
        <button
          className={`btn sm${recordOpen ? " on" : ""}`}
          onClick={() => setRecordOpen((v) => !v)}
          disabled={!cursor}
          title={
            cursor ? `레코드 뷰 — 한 행을 세로로 (${shortcutLabel("recordView")})` : "행을 먼저 고르세요"
          }
        >
          <PanelRight size={13} /> 레코드
        </button>
        <span className="toolbar-sep" />
        <label className="result-filter" title={`결과 안에서 찾기 (${shortcutLabel("find")})`}>
          <Search size={13} className="muted" />
          <input
            {...rawTextInputProps}
            data-search-input=""
            className="where-input"
            placeholder="결과 안에서 찾기"
            value={filter}
            onChange={(e) => {
              clearSelection();
              setFilter(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                if (filter) {
                  clearSelection();
                  setFilter("");
                }
                gridRef.current?.focus();
              }
            }}
          />
        </label>
        {pager && (
          <span className="result-pager">
            <button
              className="btn icon"
              onClick={pager.onFirst}
              disabled={!pager.hasPrev}
              title="첫 페이지"
            >
              <ChevronsUp size={14} />
            </button>
            <button
              className="btn icon"
              onClick={pager.onPrev}
              disabled={!pager.hasPrev}
              title={`이전 페이지 (${shortcutLabel("prevPage")})`}
            >
              <ArrowUp size={14} />
            </button>
            <span className="muted mono" title="끝까지 읽기 전에는 전체 행 수를 알 수 없습니다">
              {pager.count === 0
                ? "0"
                : `${(pager.from + 1).toLocaleString()}–${(pager.from + pager.count).toLocaleString()}`}
              {" / "}
              {pager.total !== null ? pager.total.toLocaleString() : `${pager.fetched.toLocaleString()}+`}
            </span>
            <button
              className="btn icon"
              onClick={pager.onNext}
              disabled={!pager.hasNext || pager.loading}
              title={
                pager.loading
                  ? "읽는 중…"
                  : `다음 페이지 (${shortcutLabel("nextPage")}) — 서버에서 이어 읽습니다`
              }
            >
              <ArrowDown size={14} />
            </button>
          </span>
        )}
        <span className="spacer" />
        {multi ? (
          <span className="muted mono">
            {multi.r2 - multi.r1 + 1}행 × {multi.c2 - multi.c1 + 1}열 선택
          </span>
        ) : (
          <span className="muted">
            {filter.trim() ? `${view.length} / ${rows.length}행` : `${rows.length}행`}
            {/* 행 제한에 걸려 잘렸으면 서버에 더 있다는 것을 알린다. */}
            {!pager && result.truncated && (
              <span title="SELECT 로만 이뤄진 실행만 페이지로 넘깁니다(SQL Server). DECLARE·SET·쓰기가 섞인 스크립트는 문장끼리 이어져야 해서 한 번에 실행하고 행 제한에서 자릅니다">
                {` · 처음 ${rows.length.toLocaleString()}행만 받음(페이지로 넘길 수 없는 결과)`}
              </span>
            )}
            {/* 잘린 결과를 정렬하면 전체를 정렬한 것처럼 보이면 안 된다. */}
            {sort && (pager ? " · 지금 페이지 안에서만 정렬" : result.truncated && " · 불러온 행 안에서만 정렬")}
            {!narrowed && ` · 셀을 고르고 ${shortcutLabel("copy")}, 고른 것이 없으면 전체`}
          </span>
        )}
      </div>

      <div className="grid-main">
        <div className="grid-scroll" tabIndex={0} onKeyDown={onKeyDown} ref={gridRef}>
          <table
            className="grid fixed"
            style={{ width: rowNoW + widths.reduce((a, b) => a + b, 0) }}
          >
            <colgroup>
              <col style={{ width: rowNoW }} />
              {widths.map((w, j) => (
                <col key={j} style={{ width: w }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th className="rownum">#</th>
                {cols.map((c, j) => (
                  <th
                    key={c.name + j}
                    title={`${c.dbType} · 클릭하면 정렬(불러온 행 안에서)`}
                    onClick={() => toggleSort(j)}
                  >
                    {c.name}
                    {sort?.col === j && (sort.desc ? " ▾" : " ▴")}
                    <span className="col-type">{c.dbType}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <SpacerRow height={padTop} colSpan={cols.length + 1} />
              {items.map(({ index: i }) => {
                const ri = view[i];
                return (
                <tr key={ri} data-index={i} ref={virtualizer.measureElement}>
                  <td className="rownum">{rowOffset + i + 1}</td>
                  {rows[ri].map((v, j) => {
                    const isCursor = cursor?.row === i && cursor?.col === j;
                    const inRange =
                      multi && i >= multi.r1 && i <= multi.r2 && j >= multi.c1 && j <= multi.c2;
                    return (
                      <td
                        key={j}
                        className={`${v === null ? "null" : ""}${isCursor ? " cell-cursor" : ""}${
                          inRange ? " in-range" : ""
                        }`}
                        onMouseDown={(e) => {
                          setCursor({ row: i, col: j });
                          if (!e.shiftKey) setAnchor({ row: i, col: j });
                        }}
                        onDoubleClick={() => setViewer({ row: i, col: j })}
                      >
                        {display(v)}
                      </td>
                    );
                  })}
                </tr>
                );
              })}
              <SpacerRow height={padBottom} colSpan={cols.length + 1} />
            </tbody>
          </table>
          {view.length === 0 && rows.length > 0 && (
            <div className="muted" style={{ padding: "10px 12px", fontSize: 12 }}>
              "{filter}" 가 들어간 행이 없습니다.
            </div>
          )}
        </div>

        {recordOpen && cursor && view[cursor.row] !== undefined && (
          <RecordView
            columns={cols}
            rowNo={cursor.row + 1}
            valueOf={(name) => at(cursor.row)[cols.findIndex((c) => c.name === name)]}
            isDirty={() => false}
            primaryKeys={[]}
            onPick={(name) => {
              const col = cols.findIndex((c) => c.name === name);
              if (col >= 0) {
                setCursor({ row: cursor.row, col });
                setAnchor({ row: cursor.row, col });
              }
              gridRef.current?.focus();
            }}
            onClose={() => {
              setRecordOpen(false);
              gridRef.current?.focus();
            }}
          />
        )}
      </div>

      {viewer && cols[viewer.col] && view[viewer.row] !== undefined && (
        <ValueViewer
          column={cols[viewer.col]}
          rowNo={viewer.row + 1}
          value={at(viewer.row)[viewer.col]}
          pretty={prettyValue(at(viewer.row)[viewer.col])}
          onCopy={(text) => copyText(text, "값")}
          onClose={() => {
            setViewer(null);
            gridRef.current?.focus(); // 닫은 뒤 방향키가 이어지도록
          }}
        />
      )}

      {exporting && (
        <ExportDialog
          columns={exportCols}
          rows={exportRows}
          name="query_result"
          scopeNote={multi ? "선택한 범위" : narrowed ? "필터·정렬한 결과" : "결과 전체"}
          onClose={() => setExporting(false)}
        />
      )}
    </div>
  );
}
