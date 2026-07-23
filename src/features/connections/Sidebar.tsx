import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  Database,
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
import { SchemaTree } from "../explorer/SchemaTree";
import { TreeFilterContext } from "../explorer/filterContext";
import {
  connIdForProfile,
  useConnectionStore,
} from "../../store/connectionStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { DB_META, type ConnectionProfile } from "../../types";

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
  const searchRef = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const matchIdxRef = useRef(0);

  /** 현재 트리에 그려진 일치 항목들(DOM 순서 = 화면 순서). */
  function getMatches(): HTMLElement[] {
    const root = treeRef.current;
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>('[data-match="1"]'));
  }

  /** idx 번째 일치 항목을 현재 위치로 표시하고 화면에 보이게 스크롤. */
  function focusMatch(idx: number) {
    const list = getMatches();
    list.forEach((el) => el.classList.remove("current-match"));
    setMatchCount(list.length);
    if (list.length === 0) return;
    const i = ((idx % list.length) + list.length) % list.length;
    matchIdxRef.current = i;
    setMatchIdx(i);
    const el = list[i];
    el.classList.add("current-match");
    el.scrollIntoView({ block: "nearest" });
  }

  /** 현재 일치 항목 실행: 테이블이면 열고, DB/스키마면 펼치기. */
  function activateCurrent() {
    const el = getMatches()[matchIdxRef.current];
    if (!el) return;
    const type = el.getAttribute("data-kind") === "table" ? "dblclick" : "click";
    el.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  }

  /** 검색 이동 키 처리. 처리했으면 true. */
  function handleNavKey(e: KeyboardEvent): boolean {
    if (e.key === "ArrowDown") {
      focusMatch(matchIdxRef.current + 1);
      e.preventDefault();
      return true;
    }
    if (e.key === "ArrowUp") {
      focusMatch(matchIdxRef.current - 1);
      e.preventDefault();
      return true;
    }
    if (e.key === "Enter") {
      activateCurrent();
      e.preventDefault();
      return true;
    }
    if (e.key === "Escape") {
      setFilter("");
      return true;
    }
    return false;
  }

  // 검색어가 바뀌면 첫 일치 항목으로 이동(렌더 후).
  useEffect(() => {
    matchIdxRef.current = 0;
    const t = setTimeout(() => {
      if (!filter) {
        getMatches().forEach((el) => el.classList.remove("current-match"));
        setMatchCount(0);
        return;
      }
      focusMatch(0);
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

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
    <div className="panel">
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
      </div>

      <TreeFilterContext.Provider value={filter}>
      <div className="tree" ref={treeRef} tabIndex={0} onKeyDown={onTreeKeyDown}>
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
              {isOpen && connId && <SchemaTree connId={connId} connName={p.name} />}
            </div>
          );
        })}
      </div>
      </TreeFilterContext.Provider>

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
