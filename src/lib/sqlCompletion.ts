import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";

/** 테이블명 → 컬럼명 목록. */
export type SchemaMap = Record<string, string[]>;

/**
 * SQL 문에서 참조 중인 테이블과 별칭을 찾는다.
 *
 * 파서를 돌리지 않고 `FROM`/`JOIN`/`UPDATE`/`INTO` 뒤의 이름만 훑는다 — 편집 중인
 * SQL 은 대개 문법이 깨져 있어서 파싱이 실패하고, 그때도 완성은 떠야 하기 때문이다.
 *
 * `FROM users u`, `FROM users AS u`, `JOIN dbo.orders o` 를 모두 잡는다.
 */
/** 별칭 자리에 올 수 없는 절 키워드. 이걸 별칭으로 삼키면 뒤 테이블을 놓친다. */
const ALIAS_STOP = [
  "on","where","join","inner","left","right","full","outer","cross","group",
  "order","having","set","values","select","union","limit","offset","using","and","or",
].join("|");

/**
 * 별칭 그룹에 **negative lookahead 를 걸어야 한다.** 그냥 `([A-Za-z_]\w*)?` 로 두면
 * `FROM a JOIN b` 에서 `JOIN` 을 a 의 별칭 후보로 소비해 버려, 정규식 위치가 그 뒤로
 * 넘어가면서 정작 `b` 를 놓친다.
 */
const TABLE_RE = new RegExp(
  String.raw`\b(?:from|join|update|into)\s+([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*)` +
    String.raw`(?:\s+(?:as\s+)?(?!(?:${ALIAS_STOP})\b)([A-Za-z_][\w$]*))?`,
  "gi",
);

export function referencedTables(sql: string): { table: string; alias?: string }[] {
  const out: { table: string; alias?: string }[] = [];
  for (const m of sql.matchAll(TABLE_RE)) {
    // 스키마 접두사는 떼고 테이블 이름만 남긴다(스냅샷 키가 테이블 이름이므로).
    const table = m[1].split(".").pop() as string;
    out.push({ table, alias: m[2] });
  }
  return out;
}

function tableItems(schema: SchemaMap): Completion[] {
  return Object.keys(schema).map((t) => ({ label: t, type: "class", detail: "테이블" }));
}

function columnItems(table: string, cols: string[]): Completion[] {
  return cols.map((c) => ({ label: c, type: "property", detail: table }));
}

/**
 * 스키마 기반 자동완성.
 *
 * `lang-sql` 의 것을 쓰지 않고 직접 만든 이유는 **스키마를 나중에 갈아끼우기 위해서**다.
 * `sql({schema})` 는 설정이 정적이라 스냅샷이 도착할 때마다 확장을 새로 만들어야 하고,
 * 그러면 에디터가 통째로 재구성되어 커서·실행취소 이력이 날아가고 입력이 끊긴다.
 * 여기서는 `getSchema()` 로 매번 최신 값을 읽으므로 확장이 고정된다.
 *
 * 제안 규칙(DataGrip 과 같은 결):
 * - `별칭.` 또는 `테이블.` 뒤 → 그 테이블의 컬럼
 * - 그 외 → 테이블 목록 + **지금 FROM 절에 있는 테이블들의 컬럼**
 *   (SELECT 절에서 컬럼을 쓰려면 이게 있어야 한다)
 */
export function sqlCompletionSource(getSchema: () => SchemaMap) {
  return (context: CompletionContext): CompletionResult | null => {
    const schema = getSchema();
    if (Object.keys(schema).length === 0) return null;

    // `이름.` 뒤인지 먼저 본다. 이때는 그 테이블의 컬럼만 제안한다.
    const dotted = context.matchBefore(/([A-Za-z_][\w$]*)\.([\w$]*)/);
    if (dotted) {
      const [, qualifier] = /([A-Za-z_][\w$]*)\.([\w$]*)/.exec(dotted.text)!;
      const refs = referencedTables(context.state.doc.toString());
      // 별칭이면 원래 테이블로 바꾼다.
      const target =
        refs.find((r) => r.alias?.toLowerCase() === qualifier.toLowerCase())?.table ?? qualifier;
      const cols =
        schema[target] ??
        schema[Object.keys(schema).find((t) => t.toLowerCase() === target.toLowerCase()) ?? ""];
      if (!cols) return null;
      return {
        from: dotted.from + qualifier.length + 1,
        options: columnItems(target, cols),
        validFor: /^[\w$]*$/,
      };
    }

    const word = context.matchBefore(/[\w$]*/);
    if (!word) return null;
    // 글자를 하나도 안 친 상태에서는 명시적 호출(Ctrl+Space)에만 응답한다 —
    // 그러지 않으면 타이핑 내내 팝업이 따라다녀 방해가 된다.
    if (word.from === word.to && !context.explicit) return null;

    const options = tableItems(schema);
    // FROM 절에 이미 테이블이 있으면 그 컬럼도 후보에 올린다.
    const seen = new Set<string>();
    for (const { table } of referencedTables(context.state.doc.toString())) {
      const key =
        schema[table] !== undefined
          ? table
          : (Object.keys(schema).find((t) => t.toLowerCase() === table.toLowerCase()) ?? "");
      const cols = schema[key];
      if (!cols || seen.has(key)) continue;
      seen.add(key);
      options.push(...columnItems(key, cols));
    }

    return { from: word.from, options, validFor: /^[\w$]*$/ };
  };
}
