import { Download, Moon, RefreshCw, Sun } from "lucide-react";
import { useConnectionStore } from "../../store/connectionStore";
import { useUiStore } from "../../store/uiStore";
import { useUpdateStore } from "../../store/updateStore";

export function StatusBar() {
  const status = useUiStore((s) => s.status);
  const theme = useUiStore((s) => s.theme);
  const toggleTheme = useUiStore((s) => s.toggleTheme);
  const connCount = useConnectionStore((s) => Object.keys(s.connections).length);

  const version = useUpdateStore((s) => s.version);
  const available = useUpdateStore((s) => s.available);
  const checking = useUpdateStore((s) => s.checking);
  const installing = useUpdateStore((s) => s.installing);
  const checkUpdate = useUpdateStore((s) => s.check);
  const installUpdate = useUpdateStore((s) => s.install);

  return (
    <div className="statusbar">
      <span className={`dot ${connCount > 0 ? "on" : ""}`} />
      <span>{connCount}개 연결</span>
      <span className="spacer" />
      <span>{status}</span>

      {available ? (
        <button
          className="btn sm primary"
          onClick={installUpdate}
          disabled={installing}
          title={`새 버전 ${available.version} 설치 후 재시작`}
        >
          <Download size={13} />
          {installing ? "설치 중…" : `업데이트 ${available.version}`}
        </button>
      ) : (
        <button
          className="btn icon"
          onClick={() => checkUpdate(true)}
          disabled={checking}
          title="업데이트 확인"
        >
          <RefreshCw size={13} className={checking ? "spin" : ""} />
        </button>
      )}

      {version && <span className="muted">v{version}</span>}

      <button className="btn icon" onClick={toggleTheme} title="테마 전환">
        {theme === "dark" ? <Sun size={13} /> : <Moon size={13} />}
      </button>
    </div>
  );
}
