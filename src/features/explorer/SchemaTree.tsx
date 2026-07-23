import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Database,
  Eye,
  Folder,
  Loader2,
  Table2,
} from "lucide-react";
import * as api from "../../api";
import type { DbKind, SchemaInfo, TableInfo } from "../../types";
import { highlight, matches, useTreeFilter } from "./filterContext";
import { useConnectionStore } from "../../store/connectionStore";
import { useUiStore } from "../../store/uiStore";
import { useWorkspaceStore } from "../../store/workspaceStore";

interface Ctx {
  connId: string;
  connName: string;
}

/**
 * 연결 아래의 계층을 DB 종류에 맞게 지연 로딩으로 보여준다.
 * - SQL Server: 데이터베이스 → 스키마 → 테이블
 * - MySQL/MariaDB: 데이터베이스 → 테이블
 * - PostgreSQL: 스키마 → 테이블 (연결당 1 DB)
 * - SQLite: 테이블
 */
export function SchemaTree({ connId, connName }: Ctx) {
  const kind = useConnectionStore((s) => s.connections[connId]?.handle.kind);
  if (kind === "mssql" || kind === "mysql") {
    return <DatabaseList connId={connId} connName={connName} kind={kind} />;
  }
  return <RootSchemas connId={connId} connName={connName} />;
}

// ---------- 공용 ----------

function Twisty({ open }: { open: boolean }) {
  return (
    <span className="tree-twisty">
      {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
    </span>
  );
}

function Loading({ depth }: { depth: number }) {
  return (
    <div className="tree-node" style={{ paddingLeft: depth * 14 }}>
      <Loader2 size={13} className="spin" /> <span className="muted">로딩…</span>
    </div>
  );
}

/** 검색어를 반영해 이름을 강조 렌더링한다. */
function HighlightedName({ name }: { name: string }) {
  const filter = useTreeFilter();
  return <>{highlight(name, filter)}</>;
}

// ---------- 데이터베이스 레벨 (mssql/mysql) ----------

function DatabaseList({ connId, connName, kind }: Ctx & { kind: DbKind }) {
  const [dbs, setDbs] = useState<string[] | null>(null);
  const toastError = useUiStore((s) => s.toastError);

  useEffect(() => {
    let cancelled = false;
    api
      .listDatabases(connId)
      .then((d) => !cancelled && setDbs(d.map((x) => x.name)))
      .catch((e) => {
        if (!cancelled) {
          toastError(e, "데이터베이스 목록 로드 실패");
          setDbs([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connId, toastError]);

  if (dbs === null) return <Loading depth={1} />;
  if (dbs.length === 0) return <div className="tree-empty">데이터베이스 없음</div>;
  return (
    <>
      {dbs.map((db) => (
        <DatabaseNode
          key={db}
          connId={connId}
          connName={connName}
          kind={kind}
          database={db}
        />
      ))}
    </>
  );
}

function DatabaseNode({
  connId,
  connName,
  kind,
  database,
}: Ctx & { kind: DbKind; database: string }) {
  const [open, setOpen] = useState(false);
  const filter = useTreeFilter();
  return (
    <>
      <div
        className="tree-node"
        data-match={filter && matches(database, filter) ? "1" : undefined}
        data-kind="database"
        style={{ paddingLeft: 14 }}
        onClick={() => setOpen((o) => !o)}
      >
        <Twisty open={open} />
        <Database size={13} />
        <span className="tree-label">
          <HighlightedName name={database} />
        </span>
      </div>
      {open &&
        (kind === "mssql" ? (
          <SchemaList
            connId={connId}
            connName={connName}
            database={database}
            depth={2}
          />
        ) : (
          <TableNodes
            connId={connId}
            connName={connName}
            database={database}
            schema={null}
            depth={2}
          />
        ))}
    </>
  );
}

// ---------- 스키마 레벨 ----------

function RootSchemas({ connId, connName }: Ctx) {
  const [schemas, setSchemas] = useState<SchemaInfo[] | null>(null);
  const toastError = useUiStore((s) => s.toastError);

  useEffect(() => {
    let cancelled = false;
    api
      .listSchemas(connId)
      .then((s) => !cancelled && setSchemas(s))
      .catch((e) => {
        if (!cancelled) {
          toastError(e, "스키마 로드 실패");
          setSchemas([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connId, toastError]);

  if (schemas === null) return <Loading depth={1} />;
  // 스키마 계층이 없는 DB(SQLite): 테이블 직접.
  if (schemas.length === 0) {
    return (
      <TableNodes
        connId={connId}
        connName={connName}
        database={null}
        schema={null}
        depth={1}
      />
    );
  }
  return (
    <>
      {schemas.map((s) => (
        <SchemaNode
          key={s.name}
          connId={connId}
          connName={connName}
          database={null}
          schema={s.name}
          depth={1}
        />
      ))}
    </>
  );
}

function SchemaList({
  connId,
  connName,
  database,
  depth,
}: Ctx & { database: string; depth: number }) {
  const [schemas, setSchemas] = useState<SchemaInfo[] | null>(null);
  const toastError = useUiStore((s) => s.toastError);

  useEffect(() => {
    let cancelled = false;
    api
      .listSchemas(connId, database)
      .then((s) => !cancelled && setSchemas(s))
      .catch((e) => {
        if (!cancelled) {
          toastError(e, "스키마 로드 실패");
          setSchemas([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connId, database, toastError]);

  if (schemas === null) return <Loading depth={depth} />;
  if (schemas.length === 0) {
    return (
      <TableNodes
        connId={connId}
        connName={connName}
        database={database}
        schema={null}
        depth={depth}
      />
    );
  }
  return (
    <>
      {schemas.map((s) => (
        <SchemaNode
          key={s.name}
          connId={connId}
          connName={connName}
          database={database}
          schema={s.name}
          depth={depth}
        />
      ))}
    </>
  );
}

function SchemaNode({
  connId,
  connName,
  database,
  schema,
  depth,
}: Ctx & { database: string | null; schema: string; depth: number }) {
  const [open, setOpen] = useState(false);
  const filter = useTreeFilter();
  return (
    <>
      <div
        className="tree-node"
        data-match={filter && matches(schema, filter) ? "1" : undefined}
        data-kind="schema"
        style={{ paddingLeft: depth * 14 }}
        onClick={() => setOpen((o) => !o)}
      >
        <Twisty open={open} />
        <Folder size={13} />
        <span className="tree-label">
          <HighlightedName name={schema} />
        </span>
      </div>
      {open && (
        <TableNodes
          connId={connId}
          connName={connName}
          database={database}
          schema={schema}
          depth={depth + 1}
        />
      )}
    </>
  );
}

// ---------- 테이블 레벨 ----------

function TableNodes({
  connId,
  connName,
  database,
  schema,
  depth,
}: Ctx & { database: string | null; schema: string | null; depth: number }) {
  const [tables, setTables] = useState<TableInfo[] | null>(null);
  const toastError = useUiStore((s) => s.toastError);
  const openTable = useWorkspaceStore((s) => s.openTable);
  const filter = useTreeFilter();

  useEffect(() => {
    let cancelled = false;
    api
      .listTables(connId, database, schema)
      .then((t) => !cancelled && setTables(t))
      .catch((e) => {
        if (!cancelled) {
          toastError(e, "테이블 로드 실패");
          setTables([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connId, database, schema, toastError]);

  if (tables === null) return <Loading depth={depth} />;
  if (tables.length === 0) {
    return (
      <div className="tree-empty" style={{ paddingLeft: depth * 14 + 8 }}>
        테이블 없음
      </div>
    );
  }
  // 검색해도 항목을 숨기지 않는다. 일치 항목만 표시(data-match)하고 강조한다.
  return (
    <>
      {tables.map((t) => (
        <div
          key={t.name}
          className="tree-node"
          data-match={filter && matches(t.name, filter) ? "1" : undefined}
          data-kind="table"
          style={{ paddingLeft: depth * 14 }}
          onDoubleClick={() =>
            openTable(connId, connName, {
              database: database ?? null,
              schema: t.schema ?? schema ?? null,
              name: t.name,
            })
          }
          title="더블클릭하여 열기"
        >
          <span className="tree-twisty" />
          {t.kind === "view" ? <Eye size={13} /> : <Table2 size={13} />}
          <span className="tree-label">{highlight(t.name, filter)}</span>
          {t.kind === "view" && <span className="tree-badge">뷰</span>}
        </div>
      ))}
    </>
  );
}
