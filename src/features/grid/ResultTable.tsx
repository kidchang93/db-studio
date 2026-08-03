import { useMemo, useState, type KeyboardEvent } from "react";
import { Copy, Download } from "lucide-react";
import type { Cell, QueryResult } from "../../types";
import { useUiStore } from "../../store/uiStore";
import { ExportDialog } from "./ExportDialog";

function display(v: Cell): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/** 클립보드용 텍스트. NULL 은 빈 값으로 둬야 붙여넣기가 자연스럽다. */
function clip(v: Cell): string {
  return v === null || v === undefined ? "" : String(v);
}

/**
 * 읽기 전용 결과 그리드(쿼리 콘솔 결과).
 *
 * 편집은 없지만 **결과를 꺼내는 길은 있어야 한다** — 조회 결과를 다른 곳에 옮기려는데
 * 복사도 내보내기도 없으면 화면에 갇힌다. 셀 범위 선택 + ⌘C, 그리고 내보내기를 둔다.
 * 편집이 없으므로 그리드 탭(`DataGridTab`)의 pending·커밋 기계는 가져오지 않는다.
 */
export function ResultTable({ result }: { result: QueryResult }) {
  const ui = useUiStore();
  const [cursor, setCursor] = useState<{ row: number; col: number } | null>(null);
  /** 범위 선택의 고정점. Shift 로 움직이면 여기부터 커서까지가 선택된다. */
  const [anchor, setAnchor] = useState<{ row: number; col: number } | null>(null);
  const [exporting, setExporting] = useState(false);

  const cols = result.columns;
  const rows = result.rows;

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

  /** 선택 범위가 있으면 그 부분, 없으면 전체를 헤더까지 붙여 TSV 로 복사한다. */
  function copySelection() {
    if (rows.length === 0) return;
    if (multi) {
      const lines: string[] = [];
      for (let r = multi.r1; r <= multi.r2; r++) {
        const line: string[] = [];
        for (let c = multi.c1; c <= multi.c2; c++) line.push(clip(rows[r][c]));
        lines.push(line.join("\t"));
      }
      const n = (multi.r2 - multi.r1 + 1) * (multi.c2 - multi.c1 + 1);
      copyText(lines.join("\n"), `${n}개 셀`);
      return;
    }
    if (cursor) {
      copyText(clip(rows[cursor.row][cursor.col]), "셀");
      return;
    }
    copyAll();
  }

  function copyAll() {
    const header = cols.map((c) => c.name).join("\t");
    const body = rows.map((r) => r.map(clip).join("\t"));
    copyText([header, ...body].join("\n"), `${rows.length}행`);
  }

  function move(dr: number, dc: number, extend: boolean) {
    if (rows.length === 0 || cols.length === 0) return;
    const cur = cursor ?? { row: 0, col: 0 };
    const next = {
      row: Math.max(0, Math.min(rows.length - 1, cur.row + dr)),
      col: Math.max(0, Math.min(cols.length - 1, cur.col + dc)),
    };
    setCursor(next);
    if (!extend) setAnchor(next);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "c") {
      copySelection();
      e.preventDefault();
      return;
    }
    if (mod && e.key.toLowerCase() === "a") {
      setAnchor({ row: 0, col: 0 });
      setCursor({ row: rows.length - 1, col: cols.length - 1 });
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

  return (
    <div className="result-pane">
      <div className="grid-toolbar">
        <button className="btn sm" onClick={copySelection} disabled={rows.length === 0}>
          <Copy size={13} /> 복사
        </button>
        <button className="btn sm" onClick={() => setExporting(true)} disabled={rows.length === 0}>
          <Download size={13} /> 내보내기
        </button>
        <span className="spacer" />
        {multi ? (
          <span className="muted mono">
            {multi.r2 - multi.r1 + 1}행 × {multi.c2 - multi.c1 + 1}열 선택
          </span>
        ) : (
          <span className="muted">
            {rows.length}행 · 셀을 고르고 ⌘/Ctrl+C, 고른 것이 없으면 전체
          </span>
        )}
      </div>

      <div className="grid-scroll" tabIndex={0} onKeyDown={onKeyDown}>
        <table className="grid">
          <thead>
            <tr>
              <th className="rownum">#</th>
              {cols.map((c) => (
                <th key={c.name} title={c.dbType}>
                  {c.name}
                  <span className="col-type">{c.dbType}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                <td className="rownum">{i + 1}</td>
                {row.map((v, j) => {
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
                    >
                      {display(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {exporting && (
        <ExportDialog
          // 범위를 잡았으면 **행과 컬럼을 함께** 잘라야 한다. 행만 자르면 헤더 수가 어긋난다.
          columns={multi ? cols.slice(multi.c1, multi.c2 + 1) : cols}
          rows={
            multi
              ? rows.slice(multi.r1, multi.r2 + 1).map((r) => r.slice(multi.c1, multi.c2 + 1))
              : rows
          }
          name="query_result"
          scopeNote={multi ? "선택한 범위" : "결과 전체"}
          onClose={() => setExporting(false)}
        />
      )}
    </div>
  );
}
