import { Table2, Terminal, X } from "lucide-react";
import { useConnectionStore } from "../../store/connectionStore";
import { useWorkspaceStore } from "../../store/workspaceStore";

export function TabBar() {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);
  const setActive = useWorkspaceStore((s) => s.setActive);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const openQuery = useWorkspaceStore((s) => s.openQuery);
  const connections = useConnectionStore((s) => s.connections);

  if (tabs.length === 0) return null;

  // 새 콘솔은 지금 보고 있는 탭의 연결에서 연다. 그 연결이 끊겼으면 비활성.
  const active = tabs.find((t) => t.id === activeTabId);
  const canOpenConsole = !!active && !!connections[active.connId];

  return (
    <div className="tabbar">
      {tabs.map((t) => (
        <div
          key={t.id}
          className={`tab ${t.id === activeTabId ? "active" : ""}`}
          onClick={() => setActive(t.id)}
          title={t.kind === "table" ? t.table.name : t.title}
        >
          {t.kind === "table" ? <Table2 size={13} /> : <Terminal size={13} />}
          <span className="tab-label">
            {t.kind === "table" ? t.table.name : t.title}
            <span className="muted"> · {t.connName}</span>
          </span>
          <span
            className="close"
            onClick={(e) => {
              e.stopPropagation();
              closeTab(t.id);
            }}
          >
            <X size={12} />
          </span>
        </div>
      ))}

      {/* 콘솔 열기가 트리 hover 에만 있어 찾기 어려웠다. 탭바에 상시 노출한다. */}
      <button
        className="tab-action"
        disabled={!canOpenConsole}
        title={
          canOpenConsole
            ? `${active.connName} 에 SQL 콘솔 열기 (⌘/Ctrl+K)`
            : "연결된 탭이 있어야 콘솔을 열 수 있습니다"
        }
        onClick={() => active && openQuery(active.connId, active.connName)}
      >
        <Terminal size={13} />
        SQL 콘솔
      </button>
    </div>
  );
}
