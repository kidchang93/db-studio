import { useEffect } from "react";
import { Database, Terminal } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
import { useConnectionStore } from "../../store/connectionStore";
import { useWorkspaceStore } from "../../store/workspaceStore";

export function AppShell() {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);
  const openQuery = useWorkspaceStore((s) => s.openQuery);
  const connections = useConnectionStore((s) => s.connections);

  /**
   * ⌘/Ctrl+F → 지금 있는 영역의 검색창으로 포커스.
   *
   * 검색창이 여러 곳(트리 · 구조 뷰 · WHERE 바)이라 포커스 위치로 대상을 고른다.
   * 각 영역은 `data-search-scope`, 그 안의 입력은 `data-search-input` 으로 표시한다.
   * 해당하는 영역이 없으면(빈 화면 등) 좌측 트리 검색으로 보낸다.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "f") return;
      // SQL 에디터(CodeMirror)는 자체 검색 패널을 연다. 이미 처리됐으면 넘긴다.
      if (e.defaultPrevented) return;
      const scope = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(
        "[data-search-scope]",
      );
      const input =
        scope?.querySelector<HTMLInputElement>("[data-search-input]") ??
        document.querySelector<HTMLInputElement>(
          '[data-search-scope="tree"] [data-search-input]',
        );
      if (!input) return;
      e.preventDefault();
      input.focus();
      input.select(); // 이어서 바로 새 검색어를 칠 수 있게
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /**
   * ⌘/Ctrl+W → 활성 탭 닫기.
   *
   * macOS 기본 메뉴의 "창 닫기"를 제거해(`src-tauri/src/lib.rs`) 이 키가 여기까지 온다.
   * 열린 탭이 없으면 브라우저처럼 창을 닫는다 — ⌘W 로 앱을 빠져나갈 길은 남겨 둔다.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "w") return;
      if (e.defaultPrevented) return;
      e.preventDefault();
      const { tabs: cur, activeTabId: id, closeTab } = useWorkspaceStore.getState();
      if (cur.length === 0) {
        getCurrentWindow().close();
        return;
      }
      closeTab(id ?? cur[cur.length - 1].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /**
   * ⌘/Ctrl+K → SQL 콘솔 열기.
   * 지금 보고 있는 탭의 연결을 쓰고, 탭이 없으면 연결된 것 중 첫 번째를 쓴다.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "k") return;
      if (e.defaultPrevented) return;
      const { tabs: cur, activeTabId: id } = useWorkspaceStore.getState();
      const active = cur.find((t) => t.id === id);
      const conns = useConnectionStore.getState().connections;
      const first = Object.values(conns)[0];
      const target =
        active && conns[active.connId]
          ? { connId: active.connId, connName: active.connName }
          : first && { connId: first.handle.connId, connName: first.name };
      if (!target) return;
      e.preventDefault();
      openQuery(target.connId, target.connName);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openQuery]);

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
                {tabs.length === 0 && (
                  <WelcomePane
                    connections={connections}
                    onOpenConsole={openQuery}
                  />
                )}
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

function WelcomePane({
  connections,
  onOpenConsole,
}: {
  connections: Record<string, { handle: { connId: string }; name: string }>;
  onOpenConsole: (connId: string, connName: string) => void;
}) {
  const list = Object.values(connections);
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

      {/* 연결이 있으면 바로 SQL 을 쓸 수 있게 길을 열어 준다. */}
      {list.length > 0 && (
        <div className="welcome-actions">
          {list.map((c) => (
            <button
              key={c.handle.connId}
              className="btn"
              onClick={() => onOpenConsole(c.handle.connId, c.name)}
            >
              <Terminal size={13} /> {c.name} SQL 콘솔
            </button>
          ))}
          <div className="muted welcome-hint">단축키 ⌘/Ctrl+K</div>
        </div>
      )}
    </div>
  );
}
