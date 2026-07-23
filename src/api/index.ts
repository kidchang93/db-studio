// Tauri command 래퍼. 컴포넌트는 invoke 를 직접 부르지 않고 이 함수들만 사용한다.
// command 이름은 snake_case, 인자 키는 camelCase (Tauri 가 자동 변환).

import { invoke } from "@tauri-apps/api/core";
import type {
  ApplyChangesRequest,
  ApplyChangesResult,
  ColumnInfo,
  ConnectionConfig,
  ConnectionHandle,
  ConnectionProfile,
  DatabaseInfo,
  ExecResult,
  FetchPageRequest,
  QueryResult,
  SchemaInfo,
  TableInfo,
  TablePage,
  TableRef,
} from "../types";

// ---- 연결 ----
export function connect(config: ConnectionConfig): Promise<ConnectionHandle> {
  return invoke("connect", { config });
}

export function disconnect(connId: string): Promise<void> {
  return invoke("disconnect", { connId });
}

export function testConnection(config: ConnectionConfig): Promise<string | null> {
  return invoke("test_connection", { config });
}

// ---- 프로필 ----
export function listProfiles(): Promise<ConnectionProfile[]> {
  return invoke("list_profiles");
}

export function saveProfile(
  profile: ConnectionProfile,
  password?: string | null,
): Promise<void> {
  return invoke("save_profile", { profile, password: password ?? null });
}

export function deleteProfile(id: string): Promise<void> {
  return invoke("delete_profile", { id });
}

export function connectProfile(
  id: string,
  password?: string | null,
): Promise<ConnectionHandle> {
  return invoke("connect_profile", { id, password: password ?? null });
}

// ---- 메타데이터 ----
export function listDatabases(connId: string): Promise<DatabaseInfo[]> {
  return invoke("list_databases", { connId });
}

export function listSchemas(
  connId: string,
  database?: string | null,
): Promise<SchemaInfo[]> {
  return invoke("list_schemas", { connId, database: database ?? null });
}

export function listTables(
  connId: string,
  schema?: string | null,
): Promise<TableInfo[]> {
  return invoke("list_tables", { connId, schema: schema ?? null });
}

export function listColumns(
  connId: string,
  table: TableRef,
): Promise<ColumnInfo[]> {
  return invoke("list_columns", { connId, table });
}

// ---- 데이터 ----
export function fetchTablePage(req: FetchPageRequest): Promise<TablePage> {
  return invoke("fetch_table_page", { req });
}

export function applyChanges(
  req: ApplyChangesRequest,
): Promise<ApplyChangesResult> {
  return invoke("apply_changes", { req });
}

// ---- 쿼리 ----
export function runQuery(
  connId: string,
  sql: string,
  maxRows?: number | null,
): Promise<QueryResult> {
  return invoke("run_query", { connId, sql, maxRows: maxRows ?? null });
}

export function runExecute(connId: string, sql: string): Promise<ExecResult> {
  return invoke("run_execute", { connId, sql });
}
