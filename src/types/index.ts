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
