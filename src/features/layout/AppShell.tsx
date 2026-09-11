import { useEffect, useState } from "react";
import { Database, Terminal } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Group as PanelGroup,
  Panel,
  Separator as PanelResizeHandle,
} from "react-resizable-panels";
import { Sidebar } from "../connections/Sidebar";
import { StatusBar } from "./StatusBar";
import { LogPanel } from "./LogPanel";
import { TabBar } from "./TabBar";
import { DisconnectedPane } from "./DisconnectedPane";
import { DataGridTab } from "../grid/DataGridTab";
import { QueryTab } from "../query/QueryTab";
import { Toasts } from "../../components/Toasts";
import { isShortcut, isWebviewReload, shortcutLabel } from "../../lib/keymap";
import { useConnectionStore } from "../../store/connectionStore";
import { useWorkspaceStore, type Tab } from "../../store/workspaceStore";
import { useLogStore } from "../../store/logStore";

export function AppShell() {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);
  const openQuery = useWorkspaceStore((s) => s.openQuery);
  const connections = useConnectionStore((s) => s.connections);
  const logOpen = useLogStore((s) => s.open);

  /**
   * 찾기(⌘F / Ctrl+F) → 지금 있는 영역의 검색창으로 포커스.
   *
   * 검색창이 여러 곳(트리 · 구조 뷰 · WHERE 바)이라 포커스 위치로 대상을 고른다.
   * 각 영역은 `data-search-scope`, 그 안의 입력은 `data-search-input` 으로 표시한다.
   * 해당하는 영역이 없으면(빈 화면 등) 좌측 트리 검색으로 보낸다.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isShortcut(e, "find")) return;
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
   * 탭 닫기(⌘W / Ctrl+F4, IntelliJ 의 CloseContent).
   *
   * macOS 기본 메뉴의 "창 닫기"를 제거해(`src-tauri/src/lib.rs`) 이 키가 여기까지 온다.
   * 열린 탭이 없으면 브라우저처럼 창을 닫는다 — ⌘W 로 앱을 빠져나갈 길은 남겨 둔다.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isShortcut(e, "closeTab")) return;
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
   * SQL 콘솔 열기(⌘K / Ctrl+K).
   * 지금 보고 있는 탭의 연결을 쓰고, 탭이 없으면 연결된 것 중 첫 번째를 쓴다.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isShortcut(e, "newConsole")) return;
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

  /**
   * 다음·이전 탭(⌘⇧] ⌘⇧[ / Alt+→ Alt+←, IntelliJ 의 NextTab · PreviousTab).
   *
   * 웹뷰 새로고침 키도 여기서 막는다 — 웹뷰가 새로 읽히면 화면이 연결 목록을 잊는데
   * 백엔드 세션은 남는다. 우리 새로고침(⌘R / Ctrl+F5)은 트리·그리드가 각자 처리한다.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isWebviewReload(e)) e.preventDefault();
      const next = isShortcut(e, "nextTab");
      if (!next && !isShortcut(e, "prevTab")) return;
      if (e.defaultPrevented) return;
      const { tabs: cur, activeTabId: id, setActive } = useWorkspaceStore.getState();
      if (cur.length < 2) return;
      e.preventDefault();
      const i = cur.findIndex((t) => t.id === id);
      setActive(cur[(i + (next ? 1 : -1) + cur.length) % cur.length].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
                    {!connections[t.connId] ? (
                      <DisconnectedPane tab={t} />
                    ) : (
                      // 연결이 바뀌면(재연결) 이전 연결의 상태를 끌고 가지 않도록 새로 마운트한다.
                      <TabContent key={t.connId} tab={t} active={t.id === activeTabId} />
                    )}
                  </div>
                ))}
              </div>
            </div>
          </Panel>
        </PanelGroup>
      </div>
      {logOpen && <LogPanel />}
      <StatusBar />
      <Toasts />
    </div>
  );
}

/**
 * 탭 내용. **한 번이라도 열어 본 뒤에야** 그린다.
 *
 * 재시작 뒤 복원한 탭이 여럿이면, 프로필을 연결하는 순간 전부 동시에 마운트되어
 * 테이블 탭마다 페이지·COUNT·PK 조회를 한꺼번에 보낸다. SQL Server 는 연결 하나에
 * 줄을 세우므로 지금 보려는 탭이 그 뒤로 밀리고, 운영 DB 에 괜한 부하를 준다.
 * IntelliJ 처럼 보이는 탭만 불러온다. 한 번 그린 뒤에는 숨겨도 상태를 유지한다.
 */
function TabContent({ tab, active }: { tab: Tab; active: boolean }) {
  const [seen, setSeen] = useState(active);
  useEffect(() => {
    if (active) setSeen(true);
  }, [active]);
  if (!seen && !active) return null;
  return tab.kind === "table" ? (
    <DataGridTab
      connId={tab.connId}
      table={tab.table}
      initialFilters={tab.initialFilters}
      active={active}
    />
  ) : (
    <QueryTab connId={tab.connId} tabId={tab.id} />
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
          <div className="muted welcome-hint">단축키 {shortcutLabel("newConsole")}</div>
        </div>
      )}
    </div>
  );
}
