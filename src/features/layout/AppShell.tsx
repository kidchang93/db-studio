import { Database } from "lucide-react";
import {
  Group as PanelGroup,
  Panel,
  Separator as PanelResizeHandle,
} from "react-resizable-panels";
import { Sidebar } from "../connections/Sidebar";
import { StatusBar } from "./StatusBar";
import { TabBar } from "./TabBar";
import { DataGridTab } from "../grid/DataGridTab";
import { QueryTab } from "../query/QueryTab";
import { Toasts } from "../../components/Toasts";
import { useWorkspaceStore } from "../../store/workspaceStore";

export function AppShell() {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);

  return (
    <div className="app">
      <div className="app-main">
        <PanelGroup orientation="horizontal" style={{ height: "100%" }}>
          <Panel defaultSize="22" minSize="12" maxSize="45">
            <Sidebar />
          </Panel>
          <PanelResizeHandle className="resize-handle" />
          <Panel defaultSize="78" minSize="40">
            <div className="panel" style={{ background: "var(--bg)" }}>
              <TabBar />
              <div className="tab-content">
                {tabs.length === 0 && <WelcomePane />}
                {tabs.map((t) => (
                  <div
                    key={t.id}
                    className="tab-pane"
                    style={{ display: t.id === activeTabId ? "flex" : "none" }}
                  >
                    {t.kind === "table" ? (
                      <DataGridTab connId={t.connId} table={t.table} />
                    ) : (
                      <QueryTab connId={t.connId} />
                    )}
                  </div>
                ))}
              </div>
            </div>
          </Panel>
        </PanelGroup>
      </div>
      <StatusBar />
      <Toasts />
    </div>
  );
}

function WelcomePane() {
  return (
    <div className="empty-state">
      <Database size={48} strokeWidth={1} />
      <h2>DB Studio</h2>
      <div className="muted" style={{ maxWidth: 380 }}>
        왼쪽에서 <b>＋</b> 버튼으로 데이터베이스 연결을 추가하고, 연결한 뒤
        테이블을 더블클릭하면 데이터 그리드가 열립니다.
        <br />
        <br />
        PostgreSQL · MySQL/MariaDB · SQLite · SQL Server 를 지원합니다.
      </div>
    </div>
  );
}
