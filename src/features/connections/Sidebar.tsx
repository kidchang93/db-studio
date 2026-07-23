import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Database,
  Pencil,
  Plug,
  Plus,
  Terminal,
  Trash2,
  Unplug,
} from "lucide-react";
import { Modal } from "../../components/Modal";
import { ConnectionDialog } from "./ConnectionDialog";
import { SchemaTree } from "../explorer/SchemaTree";
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

      <div className="tree">
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
                      if (confirm(`'${p.name}' 프로필을 삭제할까요?`)) handleDelete(p);
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
