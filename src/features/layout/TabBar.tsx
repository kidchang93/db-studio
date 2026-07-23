import { Table2, Terminal, X } from "lucide-react";
import { useWorkspaceStore } from "../../store/workspaceStore";

export function TabBar() {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);
  const setActive = useWorkspaceStore((s) => s.setActive);
  const closeTab = useWorkspaceStore((s) => s.closeTab);

  if (tabs.length === 0) return null;

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
    </div>
  );
}
