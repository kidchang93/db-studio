import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  Database,
  Filter,
  Pencil,
  Plug,
  Plus,
  Search,
  Terminal,
  Trash2,
  Unplug,
  X,
} from "lucide-react";
import { Modal } from "../../components/Modal";
import { ConnectionDialog } from "./ConnectionDialog";
import { SchemaPicker } from "./SchemaPicker";
import { SchemaTree } from "../explorer/SchemaTree";
import { isFilterActive, TreeFilterContext } from "../explorer/filterContext";
import {
  connIdForProfile,
  useConnectionStore,
} from "../../store/connectionStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { DB_META, type ConnectionProfile, type DbKind } from "../../types";
import { rawTextInputProps } from "../../lib/sqlText";

const VISIBLE_TOP_KEY = "db-studio.visibleTop";

/** 연결 아래 최상위 계층의 이름 — SQL Server·MySQL 은 DB, 그 외는 스키마. */
function topLabel(kind: DbKind): "데이터베이스" | "스키마" {
  return kind === "mssql" || kind === "mysql" ? "데이터베이스" : "스키마";
}

/** 표시 대상 선택은 UI 상태이므로 localStorage 에 남긴다(프로필 파일은 건드리지 않는다). */
function loadVisibleTop(): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem(VISIBLE_TOP_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function saveVisibleTop(v: Record<string, string[]>) {
  try {
    localStorage.setItem(VISIBLE_TOP_KEY, JSON.stringify(v));
  } catch {
    // 저장 실패는 기능에 치명적이지 않으므로 조용히 넘긴다.
  }
}

export function Sidebar() {
  const profiles = useConnectionStore((s) => s.profiles);
  const connections = useConnectionStore((s) => s.connections);
  const loadProfiles = useConnectionStore((s) => s.loadProfiles);
  const connectProfile = useConnectionStore((s) => s.connectProfile);
  const disconnect = useConnectionStore((s) => s.disconnect);
  const deleteProfile = useConnectionStore((s) => s.deleteProfile);
  const closeConnectionTabs = useWorkspaceStore((s) => s.closeConnectionTabs);
  const openQuery = useWorkspaceStore((s) => s.openQuery);

  const [dialog, setDialog] = useState<{ profile: ConnectionProfile | null } | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [pwPrompt, setPwPrompt] = useState<ConnectionProfile | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ConnectionProfile | null>(null);
  const [filter, setFilter] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [matchIdx, setMatchIdx] = useState(0);
  // 트리 필터(DataGrip 스타일): 검색어와 별개로 표시 대상을 좁힌다.
  const [hideUnmatched, setHideUnmatched] = useState(false);
  const [showTables, setShowTables] = useState(true);
  const [showViews, setShowViews] = useState(true);
  const [filterMenu, setFilterMenu] = useState(false);
  /** 연결별로 트리에 노출할 최상위 노드. 키가 없으면 전체 표시. */
  const [visibleTop, setVisibleTop] = useState<Record<string, string[]>>(loadVisibleTop);
  /** 연결별 최상위 노드 전체 목록(트리가 로드하며 알려 준다). */
  const [topNodes, setTopNodes] = useState<Record<string, string[]>>({});
  /** 선택기를 연 대상 프로필. */
  const [picker, setPicker] = useState<ConnectionProfile | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLElement | null>(null);
  const filterMenuRef = useRef<HTMLDivElement>(null);

  const treeFilter = useMemo(
    () => ({ text: filter, hideUnmatched, showTables, showViews, visibleTop }),
    [filter, hideUnmatched, showTables, showViews, visibleTop],
  );

  function resetFilters() {
    setHideUnmatched(false);
    setShowTables(true);
    setShowViews(true);
  }

  /** 트리가 최상위 목록을 읽어 오면 받아 둔다(선택기와 뱃지에 필요). */
  const reportTopLevel = useCallback((profileId: string, names: string[]) => {
    setTopNodes((prev) =>
      prev[profileId]?.length === names.length &&
      prev[profileId].every((n, i) => n === names[i])
        ? prev
        : { ...prev, [profileId]: names },
    );
  }, []);

  /** 선택 결과를 저장한다. null 이면 전체 표시로 되돌린다. */
  function applyVisibleTop(profileId: string, next: string[] | null) {
    setVisibleTop((prev) => {
      const out = { ...prev };
      if (next) out[profileId] = next;
      else delete out[profileId];
      saveVisibleTop(out);
      return out;
    });
  }

  // 필터 메뉴는 바깥을 클릭하거나 Esc 를 누르면 닫는다.
  useEffect(() => {
    if (!filterMenu) return;
    const onDown = (e: globalThis.MouseEvent) => {
      if (!filterMenuRef.current?.contains(e.target as Node)) setFilterMenu(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setFilterMenu(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [filterMenu]);

  /**
   * 키보드 이동 대상 행들(DOM 순서 = 화면 순서).
   * 검색 중이면 일치 항목만, 아니면 트리의 모든 행.
   */
  function navItems(): HTMLElement[] {
    const root = treeRef.current;
    if (!root) return [];
    const sel = filter ? '[data-match="1"]' : ".tree-node";
    return Array.from(root.querySelectorAll<HTMLElement>(sel));
  }

  /** 커서를 el 로 옮기고 강조 + 화면에 보이게 스크롤. */
  function setCursor(el: HTMLElement, list: HTMLElement[]) {
    cursorRef.current?.classList.remove("tree-cursor");
    list.forEach((x) => x.classList.remove("tree-cursor"));
    el.classList.add("tree-cursor");
    cursorRef.current = el;
    el.scrollIntoView({ block: "nearest" });
    setMatchIdx(list.indexOf(el));
    setMatchCount(list.length);
  }

  /** 현재 커서에서 delta 만큼 이동(순환). */
  function moveBy(delta: number) {
    const list = navItems();
    setMatchCount(list.length);
    if (list.length === 0) return;
    const cur = cursorRef.current ? list.indexOf(cursorRef.current) : -1;
    const next = cur < 0 ? 0 : cur + delta;
    setCursor(list[((next % list.length) + list.length) % list.length], list);
  }

  function cursorEl(): HTMLElement | null {
    const list = navItems();
    const el = cursorRef.current;
    return el && list.includes(el) ? el : (list[0] ?? null);
  }

  function fire(el: HTMLElement, type: "click" | "dblclick") {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  }

  /** 현재 행 실행: 테이블이면 열고, 그 외에는 펼치기/접기. */
  function activateCurrent() {
    const el = cursorEl();
    if (!el) return;
    fire(el, el.getAttribute("data-kind") === "table" ? "dblclick" : "click");
  }

  /** 트리 키보드 조작. 처리했으면 true. */
  function handleNavKey(e: KeyboardEvent): boolean {
    switch (e.key) {
      case "ArrowDown":
        moveBy(1);
        e.preventDefault();
        return true;
      case "ArrowUp":
        moveBy(-1);
        e.preventDefault();
        return true;
      case "ArrowRight": {
        // 닫힌 폴더면 펼치고, 이미 열려 있으면 아래로 이동.
        const el = cursorEl();
        if (el?.getAttribute("data-open") === "0") fire(el, "click");
        else moveBy(1);
        e.preventDefault();
        return true;
      }
      case "ArrowLeft": {
        // 열린 폴더면 접고, 아니면 위로 이동.
        const el = cursorEl();
        if (el?.getAttribute("data-open") === "1") fire(el, "click");
        else moveBy(-1);
        e.preventDefault();
        return true;
      }
      case "Enter":
        activateCurrent();
        e.preventDefault();
        return true;
      case "Escape":
        exitSearch();
        e.preventDefault();
        return true;
      default:
        return false;
    }
  }

  // 검색어가 바뀌면 첫 일치 항목으로 이동(렌더 후).
  useEffect(() => {
    const t = setTimeout(() => {
      const list = navItems();
      setMatchCount(list.length);
      // 검색을 끝냈을 뿐이면 커서를 남긴다. 지워 버리면 애써 찾은 위치가 사라져
      // 트리 맨 위로 돌아가고, 다시 마우스로 클릭해야 한다.
      if (!filter) return;
      if (list.length > 0) setCursor(list[0], list);
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  /**
   * 검색을 끝내고 트리로 포커스를 넘긴다. **커서는 그대로 둔다** —
   * 검색으로 찾아 둔 위치에서 방향키 탐색을 이어갈 수 있어야 한다.
   */
  function exitSearch() {
    setFilter("");
    treeRef.current?.focus();
  }

  /**
   * 마우스로 행을 클릭해도 키보드와 같은 위치에 커서를 둔다.
   * 클릭 직후 방향키를 바로 쓸 수 있도록 트리에 포커스도 넘긴다.
   */
  function onTreeClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    // 행 안의 액션 버튼(연결/편집/삭제)은 자기 동작만 하고 포커스를 가져가지 않는다.
    if (target.closest("button, input")) return;
    const el = target.closest<HTMLElement>(".tree-node");
    if (!el) return;

    const list = navItems();
    if (list.includes(el)) {
      setCursor(el, list);
    } else {
      // 검색 중 일치하지 않는 행을 클릭한 경우: 강조만 옮기고 n/m 카운터는 그대로 둔다.
      cursorRef.current?.classList.remove("tree-cursor");
      el.classList.add("tree-cursor");
      cursorRef.current = el;
    }
    treeRef.current?.focus();
  }

  // IntelliJ speed-search: 트리에 포커스가 있을 때 문자를 입력하면 검색창으로 넘긴다.
  function onTreeKeyDown(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement) return;
    if (handleNavKey(e)) return;
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      setFilter((f) => f + e.key);
      searchRef.current?.focus();
      e.preventDefault();
    }
  }

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  async function handleConnect(profile: ConnectionProfile, password?: string) {
    // 비밀번호를 저장하지 않는 서버 연결이면 먼저 프롬프트.
    if (!DB_META[profile.kind].usesFile && !profile.savePassword && password === undefined) {
      setPwPrompt(profile);
      return;
    }
    const connId = await connectProfile(profile.id, password ?? null);
    if (connId) setExpanded((e) => ({ ...e, [profile.id]: true }));
  }

  async function handleDisconnect(connId: string) {
    closeConnectionTabs(connId);
    await disconnect(connId);
  }

  async function handleDelete(profile: ConnectionProfile) {
    const connId = connIdForProfile(connections, profile.id);
    if (connId) {
      closeConnectionTabs(connId);
      await disconnect(connId);
    }
    await deleteProfile(profile.id);
  }

  return (
    <div className="panel" data-search-scope="tree">
      <div className="sidebar-header">
        <Database size={14} />
        <span className="spacer">데이터 소스</span>
        <button className="btn icon" title="새 연결" onClick={() => setDialog({ profile: null })}>
          <Plus size={15} />
        </button>
      </div>

      <div className="tree-search">
        <Search size={13} className="muted" />
        <input
          ref={searchRef}
          {...rawTextInputProps}
          data-search-input=""
          className="tree-search-input"
          placeholder="검색 (↑↓ 이동 · Enter 열기)"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={handleNavKey}
        />
        {filter && (
          <span className="muted" style={{ fontSize: 11, whiteSpace: "nowrap" }}>
            {matchCount > 0 ? `${matchIdx + 1}/${matchCount}` : "0"}
          </span>
        )}
        {filter && (
          <button className="btn icon" title="지우기" onClick={() => setFilter("")}>
            <X size={13} />
          </button>
        )}
        <div className="filter-menu-wrap" ref={filterMenuRef}>
          <button
            className={`btn icon${isFilterActive(treeFilter) ? " on" : ""}`}
            title="필터"
            aria-expanded={filterMenu}
            onClick={() => setFilterMenu((v) => !v)}
          >
            <Filter size={13} />
            {isFilterActive(treeFilter) && <span className="dot" />}
          </button>
          {filterMenu && (
            <div className="filter-menu">
              <label>
                <input
                  type="checkbox"
                  checked={hideUnmatched}
                  onChange={(e) => setHideUnmatched(e.target.checked)}
                />
                일치 항목만 보기
              </label>
              <div className="muted note">
                펼치지 않은 폴더는 내용을 알 수 없어 이름으로 걸러집니다.
              </div>
              <div className="sep" />
              <div className="muted head">표시할 객체</div>
              <label>
                <input
                  type="checkbox"
                  checked={showTables}
                  onChange={(e) => setShowTables(e.target.checked)}
                />
                테이블
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={showViews}
                  onChange={(e) => setShowViews(e.target.checked)}
                />
                뷰
              </label>
              {isFilterActive(treeFilter) && (
                <>
                  <div className="sep" />
                  <button className="btn sm" onClick={resetFilters}>
                    필터 초기화
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <TreeFilterContext.Provider value={treeFilter}>
      <div
        className="tree"
        ref={treeRef}
        tabIndex={0}
        onKeyDown={onTreeKeyDown}
        onClick={onTreeClick}
      >
        {profiles.length === 0 && (
          <div className="tree-empty">
            연결이 없습니다.
            <br />
            상단 + 버튼으로 추가하세요.
          </div>
        )}

        {profiles.map((p) => {
          const connId = connIdForProfile(connections, p.id);
          const isOpen = expanded[p.id] && connId;
          return (
            <div key={p.id}>
              <div
                className="tree-node"
                data-kind="connection"
                data-open={connId ? (expanded[p.id] ? "1" : "0") : undefined}
                onClick={() => {
                  if (connId) setExpanded((e) => ({ ...e, [p.id]: !e[p.id] }));
                }}
                onDoubleClick={() => !connId && handleConnect(p)}
              >
                <span className="tree-twisty">
                  {connId ? (
                    isOpen ? (
                      <ChevronDown size={13} />
                    ) : (
                      <ChevronRight size={13} />
                    )
                  ) : null}
                </span>
                <Database size={13} color={connId ? "var(--success)" : "var(--text-faint)"} />
                <span className="tree-label">{p.name}</span>
                <span className="tree-badge">{DB_META[p.kind].label}</span>
                {isOpen && (topNodes[p.id]?.length ?? 0) > 0 && (
                  <button
                    className={`schema-count${visibleTop[p.id] ? " on" : ""}`}
                    title={`트리에 표시할 ${topLabel(p.kind)} 선택`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setPicker(p);
                    }}
                  >
                    {(visibleTop[p.id] ?? topNodes[p.id]).length} / {topNodes[p.id].length}
                  </button>
                )}
                <span className="spacer" />
                <span className="node-actions">
                  {connId ? (
                    <>
                      <button
                        className="btn icon"
                        title="SQL 콘솔"
                        onClick={(e) => {
                          e.stopPropagation();
                          openQuery(connId, p.name);
                        }}
                      >
                        <Terminal size={13} />
                      </button>
                      <button
                        className="btn icon"
                        title="연결 해제"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDisconnect(connId);
                        }}
                      >
                        <Unplug size={13} />
                      </button>
                    </>
                  ) : (
                    <button
                      className="btn icon"
                      title="연결"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleConnect(p);
                      }}
                    >
                      <Plug size={13} />
                    </button>
                  )}
                  <button
                    className="btn icon"
                    title="편집"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDialog({ profile: p });
                    }}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    className="btn icon"
                    title="삭제"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteTarget(p);
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </span>
              </div>
              {isOpen && connId && (
                <SchemaTree
                  connId={connId}
                  connName={p.name}
                  path={p.id}
                  onTopLevel={(names) => reportTopLevel(p.id, names)}
                />
              )}
            </div>
          );
        })}
      </div>
      </TreeFilterContext.Provider>

      {picker && (
        <SchemaPicker
          connName={picker.name}
          all={topNodes[picker.id] ?? []}
          label={topLabel(picker.kind)}
          selected={visibleTop[picker.id] ?? null}
          onApply={(next) => applyVisibleTop(picker.id, next)}
          onClose={() => setPicker(null)}
        />
      )}

      {dialog && (
        <ConnectionDialog profile={dialog.profile} onClose={() => setDialog(null)} />
      )}

      {pwPrompt && (
        <PasswordPrompt
          profile={pwPrompt}
          onCancel={() => setPwPrompt(null)}
          onSubmit={(pw) => {
            const p = pwPrompt;
            setPwPrompt(null);
            handleConnect(p, pw);
          }}
        />
      )}

      {deleteTarget && (
        <Modal
          title="연결 삭제"
          onClose={() => setDeleteTarget(null)}
          footer={
            <>
              <button className="btn" onClick={() => setDeleteTarget(null)}>
                취소
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  const p = deleteTarget;
                  setDeleteTarget(null);
                  handleDelete(p);
                }}
              >
                삭제
              </button>
            </>
          }
        >
          <p style={{ margin: 0 }}>
            <b>{deleteTarget.name}</b> 연결을 삭제할까요?
          </p>
          <p className="muted" style={{ marginBottom: 0 }}>
            저장된 프로필과 키체인 비밀번호가 삭제됩니다. 실제 데이터베이스에는
            영향을 주지 않습니다.
          </p>
        </Modal>
      )}
    </div>
  );
}

function PasswordPrompt({
  profile,
  onSubmit,
  onCancel,
}: {
  profile: ConnectionProfile;
  onSubmit: (pw: string) => void;
  onCancel: () => void;
}) {
  const [pw, setPw] = useState("");
  return (
    <Modal
      title={`${profile.name} 비밀번호`}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            취소
          </button>
          <button className="btn primary" onClick={() => onSubmit(pw)}>
            연결
          </button>
        </>
      }
    >
      <div className="field">
        <label>{profile.username ?? "사용자"} 비밀번호</label>
        <input
          className="input"
          type="password"
          autoFocus
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSubmit(pw)}
        />
      </div>
    </Modal>
  );
}
