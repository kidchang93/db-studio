// 백엔드 src-tauri/src/models.rs 와 1:1 대응하는 IPC 계약 타입.
// 백엔드는 camelCase 로 직렬화한다.

export type DbKind = "postgres" | "mysql" | "sqlite" | "mssql";

export type LogicalType =
  | "null"
  | "bool"
  | "int"
  | "float"
  | "decimal"
  | "string"
  | "bytes"
  | "date"
  | "time"
  | "datetime"
  | "json"
  | "uuid"
  | "array"
  | "unknown";

export type SslMode = "disable" | "prefer" | "require" | "verifyCa" | "verifyFull";

export interface SslConfig {
  mode: SslMode;
  caCert?: string | null;
  clientCert?: string | null;
  clientKey?: string | null;
}

export interface SshConfig {
  host: string;
  port?: number | null;
  user: string;
  keyPath?: string | null;
}

export interface ConnectionConfig {
  kind: DbKind;
  host?: string | null;
  port?: number | null;
  database?: string | null;
  username?: string | null;
  password?: string | null;
  ssl?: SslConfig | null;
  ssh?: SshConfig | null;
  params?: Record<string, string>;
}

export interface ConnectionProfile {
  id: string;
  name: string;
  kind: DbKind;
  host?: string | null;
  port?: number | null;
  database?: string | null;
  username?: string | null;
  savePassword: boolean;
  ssl?: SslConfig | null;
  ssh?: SshConfig | null;
  params: Record<string, string>;
}

export interface ConnectionHandle {
  connId: string;
  kind: DbKind;
  serverVersion?: string | null;
}

export interface DatabaseInfo {
  name: string;
}

export interface SchemaInfo {
  name: string;
}

export type TableKind = "table" | "view";

export interface TableInfo {
  name: string;
  schema?: string | null;
  kind: TableKind;
}

export interface ColumnInfo {
  name: string;
  dbType: string;
  logicalType: LogicalType;
  nullable: boolean;
  isPrimaryKey: boolean;
  default?: string | null;
  ordinal: number;
}

/** 기본 키 지정 요청 (Rust: SetPrimaryKeyRequest). */
export interface SetPrimaryKeyRequest {
  connId: string;
  table: TableRef;
  columns: string[];
}

/** 컬럼 속성 변경 내용. 지정하지 않은 항목은 유지된다 (Rust: ColumnChange). */
export interface ColumnChange {
  /** 새 이름(없으면 유지). */
  newName?: string | null;
  /** 새 DB 타입(없으면 유지). */
  dbType?: string | null;
  /** NULL 허용 여부(없으면 유지). */
  nullable?: boolean | null;
  /** 기본값을 건드릴지. false 면 default 는 무시된다. */
  setDefault: boolean;
  /** setDefault 가 true 일 때의 값. null 이면 기본값 제거. */
  default?: string | null;
}

/** 컬럼 속성 변경 요청 (Rust: AlterColumnRequest). */
export interface AlterColumnRequest {
  connId: string;
  table: TableRef;
  /** 변경 대상 컬럼의 현재 이름. */
  column: string;
  change: ColumnChange;
}

/** 테이블 DDL 조회 결과 (Rust: TableDdl). */
export interface TableDdl {
  sql: string;
  /** DB 원문이면 true, 컬럼 메타로 조립한 근사치면 false. */
  exact: boolean;
}

/** DDL 실행 계획 — 미리보기 + 사전 검증 (Rust: DdlPlan). */
export interface DdlPlan {
  /** 실행될 SQL(순서대로). */
  statements: string[];
  /** 비어 있어야 적용할 수 있다. */
  blockers: string[];
  /** 막지는 않지만 알려야 할 사항. */
  warnings: string[];
}

export interface ColumnMeta {
  name: string;
  dbType: string;
  logicalType: LogicalType;
}

/** 그리드 셀 값. 백엔드는 serde_json::Value 로 내려준다. */
export type Cell = string | number | boolean | null;

export interface QueryResult {
  columns: ColumnMeta[];
  rows: Cell[][];
  truncated: boolean;
  elapsedMs: number;
}

export interface ExecResult {
  rowsAffected: number;
  elapsedMs: number;
}

export interface TableRef {
  database?: string | null;
  schema?: string | null;
  name: string;
}

export interface SortSpec {
  column: string;
  descending: boolean;
}

export interface FilterSpec {
  column: string;
  op: string;
  value: Cell;
}

export interface FetchPageRequest {
  connId: string;
  table: TableRef;
  limit: number;
  offset: number;
  sort: SortSpec[];
  filters: FilterSpec[];
  /** DataGrip 스타일 WHERE 조건(사용자 직접 입력). */
  filterSql?: string | null;
}

export interface TablePage {
  result: QueryResult;
  primaryKeys: string[];
  totalRows?: number | null;
}

export type RowEdit =
  | { type: "insert"; values: Record<string, Cell> }
  | { type: "update"; pk: Record<string, Cell>; changes: Record<string, Cell> }
  | { type: "delete"; pk: Record<string, Cell> };

export interface ApplyChangesRequest {
  connId: string;
  table: TableRef;
  edits: RowEdit[];
}

export interface ApplyChangesResult {
  inserted: number;
  updated: number;
  deleted: number;
  /** 실제로 실행된 문장(로그 패널용). 값은 바인딩되므로 문형만 담긴다. */
  statements: string[];
}

/** 자동완성용 스키마 스냅샷 — 테이블 하나와 그 컬럼 이름들. */
export interface TableColumns {
  /** 이 테이블이 속한 DB. 연결 기본 DB 면 null. */
  database?: string | null;
  /** 스키마. 스키마 개념이 없는 DB(SQLite·MySQL)면 null. */
  schema?: string | null;
  table: string;
  columns: string[];
}

/**
 * SQL 콘솔이 실행될 컨텍스트. 지정하지 않으면 연결 기본값을 쓴다.
 *
 * 무엇을 실제로 바꿀 수 있는지는 DB 마다 다르다 — PostgreSQL 은 DB 가 연결 단위라
 * 스키마만, SQL Server 는 DB 만(스키마는 세션에서 못 바꾼다), MySQL 은 DB(=스키마),
 * SQLite 는 둘 다 해당 없음.
 */
export interface ExecContext {
  database?: string | null;
  schema?: string | null;
}

/** 외래키 한 건. 관련 레코드 탐색(F4)에 쓴다. */
export interface ForeignKeyRef {
  name: string;
  /** 기준 테이블 쪽 컬럼. 방향과 무관하게 **언제나 기준 테이블**의 컬럼이다. */
  columns: string[];
  table: TableRef;
  /** 상대 테이블 쪽 컬럼. `columns` 와 순서가 대응한다(복합 FK). */
  refColumns: string[];
}

/** 한 테이블을 기준으로 본 외래키 관계. */
export interface TableRelations {
  /** 이 테이블이 참조하는 것(부모로 간다). */
  outgoing: ForeignKeyRef[];
  /** 이 테이블을 참조하는 것(자식으로 간다). */
  incoming: ForeignKeyRef[];
}

/** 백엔드 AppError 직렬화 형태. */
export interface AppError {
  kind: string;
  message: string;
}

export function isAppError(e: unknown): e is AppError {
  return (
    typeof e === "object" &&
    e !== null &&
    "kind" in e &&
    "message" in e
  );
}

export function errorMessage(e: unknown): string {
  if (isAppError(e)) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** DB 종류별 기본 포트/표시명. */
export const DB_META: Record<
  DbKind,
  { label: string; defaultPort?: number; usesFile: boolean }
> = {
  postgres: { label: "PostgreSQL", defaultPort: 5432, usesFile: false },
  mysql: { label: "MySQL / MariaDB", defaultPort: 3306, usesFile: false },
  sqlite: { label: "SQLite", usesFile: true },
  mssql: { label: "SQL Server", defaultPort: 1433, usesFile: false },
};
