import { useEffect, useState } from "react";
import { ChevronRight, ChevronDown, Table2, Eye, Folder, Loader2 } from "lucide-react";
import * as api from "../../api";
import type { SchemaInfo, TableInfo } from "../../types";
import { useUiStore } from "../../store/uiStore";
import { useWorkspaceStore } from "../../store/workspaceStore";

interface Props {
  connId: string;
  connName: string;
}

/** 연결 아래의 스키마/테이블을 지연 로딩으로 보여준다. */
export function SchemaTree({ connId, connName }: Props) {
  const [schemas, setSchemas] = useState<SchemaInfo[] | null>(null);
  const [rootTables, setRootTables] = useState<TableInfo[] | null>(null);
  const toastError = useUiStore((s) => s.toastError);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sc = await api.listSchemas(connId);
        if (cancelled) return;
        if (sc.length === 0) {
          // 스키마 계층이 없는 DB(SQLite/MySQL): 테이블을 바로 로드.
          setRootTables(await api.listTables(connId, null));
          setSchemas([]);
        } else {
          setSchemas(sc);
        }
      } catch (e) {
        if (!cancelled) toastError(e, "스키마 로드 실패");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connId, toastError]);

  if (schemas === null) {
    return (
      <div className="tree-node" style={{ paddingLeft: 24 }}>
        <Loader2 size={13} className="spin" /> <span className="muted">로딩…</span>
      </div>
    );
  }

  if (schemas.length === 0) {
    return (
      <TableList
        connId={connId}
        connName={connName}
        tables={rootTables ?? []}
        depth={1}
      />
    );
  }

  return (
    <>
      {schemas.map((s) => (
        <SchemaNode key={s.name} connId={connId} connName={connName} schema={s.name} />
      ))}
    </>
  );
}

function SchemaNode({
  connId,
  connName,
  schema,
}: {
  connId: string;
  connName: string;
  schema: string;
}) {
  const [open, setOpen] = useState(false);
  const [tables, setTables] = useState<TableInfo[] | null>(null);
  const toastError = useUiStore((s) => s.toastError);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && tables === null) {
      try {
        setTables(await api.listTables(connId, schema));
      } catch (e) {
        toastError(e, "테이블 로드 실패");
        setTables([]);
      }
    }
  }

  return (
    <>
      <div className="tree-node" style={{ paddingLeft: 12 }} onClick={toggle}>
        <span className="tree-twisty">
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
        <Folder size={13} />
        <span className="tree-label">{schema}</span>
      </div>
      {open &&
        (tables === null ? (
          <div className="tree-node" style={{ paddingLeft: 40 }}>
            <Loader2 size={13} className="spin" />
          </div>
        ) : (
          <TableList
            connId={connId}
            connName={connName}
            tables={tables}
            depth={2}
            schema={schema}
          />
        ))}
    </>
  );
}

function TableList({
  connId,
  connName,
  tables,
  depth,
  schema,
}: {
  connId: string;
  connName: string;
  tables: TableInfo[];
  depth: number;
  schema?: string;
}) {
  const openTable = useWorkspaceStore((s) => s.openTable);
  if (tables.length === 0) {
    return <div className="tree-empty" style={{ paddingLeft: depth * 12 + 12 }}>테이블 없음</div>;
  }
  return (
    <>
      {tables.map((t) => (
        <div
          key={t.name}
          className="tree-node"
          style={{ paddingLeft: depth * 12 + 12 }}
          onDoubleClick={() =>
            openTable(connId, connName, { schema: t.schema ?? schema ?? null, name: t.name })
          }
          title="더블클릭하여 열기"
        >
          <span className="tree-twisty" />
          {t.kind === "view" ? <Eye size={13} /> : <Table2 size={13} />}
          <span className="tree-label">{t.name}</span>
          {t.kind === "view" && <span className="tree-badge">뷰</span>}
        </div>
      ))}
    </>
  );
}
