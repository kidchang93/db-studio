import type { Cell, QueryResult } from "../../types";

function display(v: Cell): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/** 읽기 전용 결과 그리드(쿼리 에디터 결과 표시용). */
export function ResultTable({ result }: { result: QueryResult }) {
  if (result.columns.length === 0) {
    return (
      <div className="empty-state">
        <div className="muted">반환된 컬럼이 없습니다.</div>
      </div>
    );
  }
  return (
    <div className="grid-scroll">
      <table className="grid">
        <thead>
          <tr>
            <th className="rownum">#</th>
            {result.columns.map((c) => (
              <th key={c.name} title={c.dbType}>
                {c.name}
                <span className="col-type">{c.dbType}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr key={i}>
              <td className="rownum">{i + 1}</td>
              {row.map((v, j) => (
                <td key={j} className={v === null ? "null" : ""}>
                  {display(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
