import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";

/** 스냅샷 한 줄. 백엔드 `TableColumns` 와 같은 모양. */
export interface SchemaEntry {
  database?: string | null;
  schema?: string | null;
  table: string;
  columns: string[];
}

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

/**
 * SQL 문에서 참조 중인 테이블과 별칭을 찾는다.
 *
 * 파서를 돌리지 않고 `FROM`/`JOIN`/`UPDATE`/`INTO` 뒤의 이름만 훑는다 — 편집 중인
 * SQL 은 대개 문법이 깨져 있어서 파싱이 실패하고, 그때도 완성은 떠야 하기 때문이다.
 * 이름은 **적힌 그대로**(`db.schema.table` 포함) 돌려준다.
 */
export function referencedTables(sql: string): { name: string; alias?: string }[] {
  return [...sql.matchAll(TABLE_RE)].map((m) => ({ name: m[1], alias: m[2] }));
}

const eq = (a?: string | null, b?: string | null) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/**
 * 스키마 후보는 키워드보다 **뒤에 세운다**(`boost` 음수).
 *
 * `sel` 처럼 키워드를 치는 중에 이름이 우연히 매칭되면 목록 위를 차지해 방해가 된다.
 * 이름을 고를 때는 어차피 몇 글자만 쳐도 키워드가 걸러지므로 손해가 없다.
 */
const SCHEMA_BOOST = -1;

const item = (label: string, type: string, detail: string): Completion => ({
  label,
  type,
  detail,
  boost: SCHEMA_BOOST,
});

/** 중복 라벨을 접어 하나만 남긴다(여러 스키마에 같은 이름이 있을 수 있다). */
function uniq(items: Completion[]): Completion[] {
  const seen = new Set<string>();
  return items.filter((c) => (seen.has(c.label) ? false : (seen.add(c.label), true)));
}

const columnsOf = (rows: SchemaEntry[]) =>
  uniq(rows.flatMap((r) => r.columns.map((c) => item(c, "property", r.table))));

/**
 * 점으로 이어진 앞부분(`withGuidance.dbo.` 등)을 보고 그 자리에 올 후보를 만든다.
 *
 * **어느 단계인지 자리로 정하지 않고 이름이 무엇과 맞는지로 판단한다** — 사용자가
 * `dbo.` 로 시작할 수도, DB 부터 적을 수도, 테이블만 적을 수도 있어서 위치만으로는
 * 알 수 없다. `db.schema.table.column` 최대 4단계를 훑는다.
 */
function candidatesFor(parts: string[], rows: SchemaEntry[], sql: string): Completion[] {
  // 접두어가 없으면 최상위: 테이블 + DB + 스키마 + 참조 중인 테이블의 컬럼.
  if (parts.length === 0) {
    const out = [
      ...uniq(rows.map((r) => item(r.table, "class", r.schema ?? r.database ?? "테이블"))),
      ...uniq(rows.filter((r) => r.database).map((r) => item(r.database!, "namespace", "DB"))),
      ...uniq(rows.filter((r) => r.schema).map((r) => item(r.schema!, "namespace", "스키마"))),
    ];
    // FROM 절에 걸린 테이블의 컬럼도 올린다 — SELECT 자리에서 컬럼을 쓰려면 필요하다.
    for (const ref of referencedTables(sql)) {
      const last = ref.name.split(".").pop() as string;
      out.push(...columnsOf(rows.filter((r) => eq(r.table, last))));
    }
    return uniq(out);
  }

  const [head, ...rest] = parts;

  // 1) 별칭 → 그 테이블의 컬럼
  const alias = referencedTables(sql).find((r) => eq(r.alias, head));
  if (alias && rest.length === 0) {
    const last = alias.name.split(".").pop() as string;
    const hit = columnsOf(rows.filter((r) => eq(r.table, last)));
    if (hit.length > 0) return hit;
  }

  // 2) 테이블 이름 → 컬럼
  if (rest.length === 0) {
    const hit = columnsOf(rows.filter((r) => eq(r.table, head)));
    if (hit.length > 0) return hit;
  }

  // 3) 스키마 이름 → 그 스키마의 테이블, 또는 그 아래 컬럼
  const inSchema = rows.filter((r) => eq(r.schema, head));
  if (inSchema.length > 0) {
    if (rest.length === 0) return uniq(inSchema.map((r) => item(r.table, "class", head)));
    if (rest.length === 1) return columnsOf(inSchema.filter((r) => eq(r.table, rest[0])));
    return [];
  }

  // 4) DB 이름 → 스키마 / 테이블 / 컬럼
  const inDb = rows.filter((r) => eq(r.database, head));
  if (inDb.length > 0) {
    if (rest.length === 0) {
      const schemas = uniq(
        inDb.filter((r) => r.schema).map((r) => item(r.schema!, "namespace", "스키마")),
      );
      // 스키마 계층이 없는 DB 면 바로 테이블을 준다.
      return schemas.length > 0 ? schemas : uniq(inDb.map((r) => item(r.table, "class", head)));
    }
    const bySchema = inDb.filter((r) => eq(r.schema, rest[0]));
    if (bySchema.length > 0) {
      if (rest.length === 1) return uniq(bySchema.map((r) => item(r.table, "class", rest[0])));
      if (rest.length === 2) return columnsOf(bySchema.filter((r) => eq(r.table, rest[1])));
      return [];
    }
    // 스키마를 생략하고 DB 바로 아래 테이블을 적은 경우.
    if (rest.length === 1) return columnsOf(inDb.filter((r) => eq(r.table, rest[0])));
  }

  return [];
}

/**
 * 스키마 기반 자동완성.
 *
 * `lang-sql` 의 것을 쓰지 않고 직접 만든 이유는 두 가지다.
 * - **스키마를 나중에 갈아끼우기 위해서.** `sql({schema})` 는 설정이 정적이라 스냅샷이
 *   도착할 때마다 확장을 새로 만들어야 하고, 그러면 에디터가 통째로 재구성되어
 *   커서·실행취소 이력이 날아가고 입력이 끊긴다. 여기서는 `getRows()` 로 매번 최신
 *   값을 읽으므로 확장이 고정된다.
 * - **`db.schema.table` 3단계 이름을 다루기 위해서.**
 */
export function sqlCompletionSource(getRows: () => SchemaEntry[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const rows = getRows();
    if (rows.length === 0) return null;

    // 커서 앞의 `a.b.c.` 사슬 전체를 잡는다.
    const chain = context.matchBefore(/(?:[A-Za-z_][\w$]*\.)*[\w$]*/);
    if (!chain) return null;

    const lastDot = chain.text.lastIndexOf(".");
    const prefix = lastDot < 0 ? "" : chain.text.slice(0, lastDot);
    const parts = prefix ? prefix.split(".") : [];

    // 글자를 하나도 안 친 최상위에서는 명시적 호출(Ctrl+Space)에만 응답한다 —
    // 그러지 않으면 타이핑 내내 팝업이 따라다녀 방해가 된다.
    if (parts.length === 0 && chain.from === chain.to && !context.explicit) return null;

    const options = candidatesFor(parts, rows, context.state.doc.toString());
    if (options.length === 0) return null;

    return {
      // 마지막 점 뒤부터 교체한다. 앞의 수식어는 그대로 둔다.
      from: lastDot < 0 ? chain.from : chain.from + lastDot + 1,
      options,
      validFor: /^[\w$]*$/,
    };
  };
}
