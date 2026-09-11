import { useState } from "react";
import { Plug, Table2, Terminal } from "lucide-react";
import { DB_META } from "../../types";
import { useConnectionStore } from "../../store/connectionStore";
import { useWorkspaceStore, type Tab } from "../../store/workspaceStore";
import { loadDraft } from "../../store/workspacePersist";

/**
 * 연결되지 않은 탭 — 재시작 뒤 복원됐거나 연결을 끊은 경우.
 *
 * 탭을 되살리려고 **자동으로 접속하지 않는다.** 운영 DB 도 섞여 있어, 앱을 켰다는 이유만으로
 * 세션을 여는 것은 사용자가 원한 일이 아니다. 여기서 한 번 연결하면 같은 프로필의 탭이
 * 모두 함께 살아난다(`workspaceStore` 의 `rebind`).
 */
export function DisconnectedPane({ tab }: { tab: Tab }) {
  const profile = useConnectionStore((s) => s.profiles.find((p) => p.id === tab.profileId));
  const connectProfile = useConnectionStore((s) => s.connectProfile);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const [busy, setBusy] = useState(false);
  // 무엇을 쓰던 콘솔인지 알아볼 수 있게 남은 SQL 을 보여 준다.
  const [sql] = useState(() => (tab.kind === "query" ? loadDraft(tab.id)?.sql.trim() : undefined));
  // 비밀번호를 저장하지 않는 서버 연결은 사이드바의 입력 창을 거쳐야 한다.
  const needsPassword = !!profile && !DB_META[profile.kind].usesFile && !profile.savePassword;

  async function connect() {
    if (!profile) return;
    setBusy(true);
    await connectProfile(profile.id, null);
    setBusy(false);
  }

  return (
    <div className="empty-state">
      {tab.kind === "table" ? (
        <Table2 size={40} strokeWidth={1} />
      ) : (
        <Terminal size={40} strokeWidth={1} />
      )}
      <h2>{tab.kind === "table" ? tab.table.name : tab.title}</h2>
      {!profile ? (
        <>
          <div className="muted">이 탭의 연결 프로필이 더 이상 없습니다.</div>
          <button className="btn" onClick={() => closeTab(tab.id)}>
            탭 닫기
          </button>
        </>
      ) : needsPassword ? (
        <div className="muted">
          {profile.name} 에 연결되어 있지 않습니다. 왼쪽 목록에서 연결하면 이 탭이 이어서 열립니다.
        </div>
      ) : (
        <>
          <div className="muted">{profile.name} 에 연결되어 있지 않습니다.</div>
          <button className="btn primary" disabled={busy} onClick={connect}>
            <Plug size={13} /> {busy ? "연결 중…" : `${profile.name} 연결`}
          </button>
        </>
      )}
      {sql && <pre className="disconnected-sql mono">{sql}</pre>}
    </div>
  );
}
