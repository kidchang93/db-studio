// 결과셋을 텍스트 형식으로 변환하는 순수 유틸 (DataGrip 의 data extractor 에 해당).

import type { Cell, ColumnMeta } from "../types";

export type ExportFormat = "csv" | "tsv" | "json" | "markdown" | "sql";

export const FORMAT_LABELS: Record<ExportFormat, string> = {
  csv: "CSV",
  tsv: "TSV",
  json: "JSON",
  markdown: "Markdown",
  sql: "SQL INSERT",
};

export const FORMAT_EXT: Record<ExportFormat, string> = {
  csv: "csv",
  tsv: "tsv",
  json: "json",
  markdown: "md",
  sql: "sql",
};

export interface ExportOptions {
  format: ExportFormat;
  /** 첫 줄에 컬럼명을 넣을지(CSV/TSV 한정). */
  header: boolean;
  /** SQL INSERT 로 내보낼 때 쓸 테이블명. */
  tableName?: string;
}

/** 표시용 문자열. NULL 은 빈 값으로 둬야 붙여넣기·재적재가 자연스럽다. */
function text(v: Cell): string {
  return v === null || v === undefined ? "" : String(v);
}

/**
 * CSV 필드 escape (RFC 4180).
 * 구분자·따옴표·개행이 있으면 따옴표로 감싸고, 안의 따옴표는 두 번 반복한다.
 */
function csvField(v: Cell, delim: string): string {
  const s = text(v);
  if (s.includes(delim) || s.includes('"') || /[\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** SQL 리터럴. 숫자·불리언은 그대로, 그 외는 작은따옴표로 감싸 이스케이프. */
function sqlLiteral(v: Cell): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Markdown 표 셀 — 파이프와 개행이 표를 깨뜨리므로 치환한다. */
function mdCell(v: Cell): string {
  return text(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * 결과셋을 지정한 형식의 문자열로 만든다.
 * `columns` 와 각 행의 값 순서는 대응한다고 가정한다(호출부가 맞춰서 넘긴다).
 */
export function formatRows(
  columns: ColumnMeta[],
  rows: Cell[][],
  opts: ExportOptions,
): string {
  const names = columns.map((c) => c.name);

  switch (opts.format) {
    case "csv":
    case "tsv": {
      const delim = opts.format === "csv" ? "," : "\t";
      const lines: string[] = [];
      if (opts.header) lines.push(names.map((n) => csvField(n, delim)).join(delim));
      for (const r of rows) lines.push(r.map((v) => csvField(v, delim)).join(delim));
      return lines.join("\n");
    }

    case "json": {
      const objs = rows.map((r) => {
        const o: Record<string, Cell> = {};
        names.forEach((n, i) => (o[n] = r[i] ?? null));
        return o;
      });
      return JSON.stringify(objs, null, 2);
    }

    case "markdown": {
      const head = `| ${names.map(mdCell).join(" | ")} |`;
      const sep = `| ${names.map(() => "---").join(" | ")} |`;
      const body = rows.map((r) => `| ${r.map(mdCell).join(" | ")} |`);
      return [head, sep, ...body].join("\n");
    }

    case "sql": {
      const table = opts.tableName || "table_name";
      const cols = names.join(", ");
      return rows
        .map((r) => `INSERT INTO ${table} (${cols}) VALUES (${r.map(sqlLiteral).join(", ")});`)
        .join("\n");
    }
  }
}
