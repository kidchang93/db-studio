import { useState } from "react";
import { ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import { Modal } from "../../components/Modal";
import * as api from "../../api";
import {
  DB_META,
  type ConnectionConfig,
  type ConnectionProfile,
  type DbKind,
  type SshConfig,
  type SslConfig,
  type SslMode,
} from "../../types";
import { useConnectionStore } from "../../store/connectionStore";
import { useUiStore } from "../../store/uiStore";

interface Props {
  /** 편집 대상. null 이면 신규. */
  profile?: ConnectionProfile | null;
  onClose: () => void;
}

const KINDS: DbKind[] = ["postgres", "mysql", "sqlite", "mssql"];

const SSL_MODES: { value: SslMode; label: string }[] = [
  { value: "disable", label: "사용 안 함" },
  { value: "prefer", label: "가능하면 사용 (prefer)" },
  { value: "require", label: "필수 (require)" },
  { value: "verifyCa", label: "CA 검증 (verify-ca)" },
  { value: "verifyFull", label: "전체 검증 (verify-full)" },
];

export function ConnectionDialog({ profile, onClose }: Props) {
  const isEdit = !!profile;
  const [name, setName] = useState(profile?.name ?? "새 연결");
  const [kind, setKind] = useState<DbKind>(profile?.kind ?? "postgres");
  const [host, setHost] = useState(profile?.host ?? "localhost");
  const [port, setPort] = useState<string>(
    profile?.port?.toString() ?? DB_META[profile?.kind ?? "postgres"].defaultPort?.toString() ?? "",
  );
  const [database, setDatabase] = useState(profile?.database ?? "");
  const [username, setUsername] = useState(profile?.username ?? "");
  const [password, setPassword] = useState("");
  const [savePassword, setSavePassword] = useState(profile?.savePassword ?? true);

  // SSL
  const [sslMode, setSslMode] = useState<SslMode>(profile?.ssl?.mode ?? "disable");
  const [caCert, setCaCert] = useState(profile?.ssl?.caCert ?? "");
  const [clientCert, setClientCert] = useState(profile?.ssl?.clientCert ?? "");
  const [clientKey, setClientKey] = useState(profile?.ssl?.clientKey ?? "");

  // SSH 터널
  const [sshEnabled, setSshEnabled] = useState(!!profile?.ssh);
  const [sshHost, setSshHost] = useState(profile?.ssh?.host ?? "");
  const [sshPort, setSshPort] = useState(profile?.ssh?.port?.toString() ?? "22");
  const [sshUser, setSshUser] = useState(profile?.ssh?.user ?? "");
  const [sshKeyPath, setSshKeyPath] = useState(profile?.ssh?.keyPath ?? "");

  // 고급 파라미터
  const [params, setParams] = useState<[string, string][]>(
    Object.entries(profile?.params ?? {}),
  );
  const [showAdvanced, setShowAdvanced] = useState(
    (!!profile?.ssl && profile.ssl.mode !== "disable") ||
      !!profile?.ssh ||
      Object.keys(profile?.params ?? {}).length > 0,
  );
  const [busy, setBusy] = useState(false);

  const saveProfile = useConnectionStore((s) => s.saveProfile);
  const ui = useUiStore();

  const usesFile = DB_META[kind].usesFile;

  function onKindChange(k: DbKind) {
    setKind(k);
    if (!DB_META[k].usesFile && DB_META[k].defaultPort) {
      setPort(DB_META[k].defaultPort!.toString());
    }
  }

  function buildSsl(): SslConfig | null {
    // SQLite 는 SSL 개념이 없음. 그 외에는 항상 명시적으로 모드를 보낸다
    // ("사용 안 함"도 명시해야 드라이버가 암호화를 진짜로 끈다 — 특히 SQL Server).
    if (usesFile) return null;
    return {
      mode: sslMode,
      caCert: caCert || null,
      clientCert: clientCert || null,
      clientKey: clientKey || null,
    };
  }

  function buildParams(): Record<string, string> {
    return Object.fromEntries(params.filter(([k]) => k.trim() !== ""));
  }

  function buildSsh(): SshConfig | null {
    if (usesFile || !sshEnabled || !sshHost.trim() || !sshUser.trim()) return null;
    return {
      host: sshHost.trim(),
      port: sshPort ? Number(sshPort) : null,
      user: sshUser.trim(),
      keyPath: sshKeyPath || null,
    };
  }

  function buildConfig(): ConnectionConfig {
    return {
      kind,
      host: usesFile ? null : host || null,
      port: usesFile ? null : port ? Number(port) : null,
      database: database || null,
      username: usesFile ? null : username || null,
      password: usesFile ? null : password || null,
      ssl: buildSsl(),
      ssh: buildSsh(),
      params: buildParams(),
    };
  }

  function buildProfile(): ConnectionProfile {
    return {
      id: profile?.id ?? crypto.randomUUID(),
      name,
      kind,
      host: usesFile ? null : host || null,
      port: usesFile ? null : port ? Number(port) : null,
      database: database || null,
      username: usesFile ? null : username || null,
      savePassword: usesFile ? false : savePassword,
      ssl: buildSsl(),
      ssh: buildSsh(),
      params: buildParams(),
    };
  }

  async function onTest() {
    setBusy(true);
    try {
      const version = await api.testConnection(buildConfig());
      ui.pushToast({
        kind: "success",
        title: "연결 성공",
        message: version ?? "서버에 연결했습니다.",
      });
    } catch (e) {
      ui.toastError(e, "연결 실패");
    } finally {
      setBusy(false);
    }
  }

  async function onSave() {
    setBusy(true);
    try {
      await saveProfile(buildProfile(), savePassword ? password : null);
      ui.pushToast({ kind: "success", title: "저장됨", message: `${name} 프로필을 저장했습니다.` });
      onClose();
    } catch (e) {
      ui.toastError(e, "저장 실패");
    } finally {
      setBusy(false);
    }
  }

  function updateParam(i: number, field: 0 | 1, value: string) {
    setParams((prev) =>
      prev.map((p, idx) =>
        idx === i
          ? ((field === 0 ? [value, p[1]] : [p[0], value]) as [string, string])
          : p,
      ),
    );
  }

  return (
    <Modal
      title={isEdit ? "연결 편집" : "새 연결"}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onTest} disabled={busy}>
            연결 테스트
          </button>
          <span className="spacer" />
          <button className="btn" onClick={onClose} disabled={busy}>
            취소
          </button>
          <button className="btn primary" onClick={onSave} disabled={busy}>
            저장
          </button>
        </>
      }
    >
      <div className="field">
        <label>이름</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="field">
        <label>데이터베이스 종류</label>
        <select
          className="select"
          value={kind}
          onChange={(e) => onKindChange(e.target.value as DbKind)}
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {DB_META[k].label}
            </option>
          ))}
        </select>
      </div>

      {usesFile ? (
        <div className="field">
          <label>파일 경로</label>
          <input
            className="input mono"
            placeholder="/path/to/database.db  (또는 :memory:)"
            value={database}
            onChange={(e) => setDatabase(e.target.value)}
          />
        </div>
      ) : (
        <>
          <div className="row" style={{ gap: 12 }}>
            <div className="field" style={{ flex: 3 }}>
              <label>호스트</label>
              <input className="input" value={host} onChange={(e) => setHost(e.target.value)} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>포트</label>
              <input
                className="input"
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))}
              />
            </div>
          </div>

          <div className="field">
            <label>데이터베이스</label>
            <input
              className="input"
              value={database}
              onChange={(e) => setDatabase(e.target.value)}
            />
          </div>

          <div className="field">
            <label>사용자명</label>
            <input
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>

          <div className="field">
            <label>비밀번호{isEdit && savePassword ? " (변경 시에만 입력)" : ""}</label>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <label className="row" style={{ cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={savePassword}
              onChange={(e) => setSavePassword(e.target.checked)}
            />
            <span>비밀번호를 OS 키체인에 저장</span>
          </label>

          {/* ===== 고급 (SSL + 파라미터) ===== */}
          <button
            className="btn ghost sm"
            style={{ marginTop: 12, paddingLeft: 0 }}
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            고급 (SSL · 파라미터)
          </button>

          {showAdvanced && (
            <div style={{ marginTop: 8, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
              <div className="field">
                <label>SSL / TLS</label>
                <select
                  className="select"
                  value={sslMode}
                  onChange={(e) => setSslMode(e.target.value as SslMode)}
                >
                  {SSL_MODES.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>

              {sslMode !== "disable" && (
                <>
                  <div className="field">
                    <label>CA 인증서 경로 (서버 검증)</label>
                    <input
                      className="input mono"
                      placeholder="/path/to/ca.pem"
                      value={caCert}
                      onChange={(e) => setCaCert(e.target.value)}
                    />
                  </div>
                  <div className="row" style={{ gap: 12 }}>
                    <div className="field" style={{ flex: 1 }}>
                      <label>클라이언트 인증서 (mTLS)</label>
                      <input
                        className="input mono"
                        placeholder="/path/to/client.crt"
                        value={clientCert}
                        onChange={(e) => setClientCert(e.target.value)}
                      />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label>클라이언트 키</label>
                      <input
                        className="input mono"
                        placeholder="/path/to/client.key"
                        value={clientKey}
                        onChange={(e) => setClientKey(e.target.value)}
                      />
                    </div>
                  </div>
                </>
              )}

              <div className="field">
                <label className="row" style={{ cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={sshEnabled}
                    onChange={(e) => setSshEnabled(e.target.checked)}
                  />
                  <span>SSH 터널 사용 (bastion 경유 · 키 인증)</span>
                </label>
              </div>
              {sshEnabled && (
                <>
                  <div className="row" style={{ gap: 12 }}>
                    <div className="field" style={{ flex: 3 }}>
                      <label>SSH 호스트</label>
                      <input
                        className="input"
                        placeholder="bastion.example.com"
                        value={sshHost}
                        onChange={(e) => setSshHost(e.target.value)}
                      />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label>포트</label>
                      <input
                        className="input"
                        value={sshPort}
                        onChange={(e) => setSshPort(e.target.value.replace(/[^0-9]/g, ""))}
                      />
                    </div>
                  </div>
                  <div className="field">
                    <label>SSH 사용자</label>
                    <input
                      className="input"
                      value={sshUser}
                      onChange={(e) => setSshUser(e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label>개인키 경로 (비우면 ssh-agent/기본 키)</label>
                    <input
                      className="input mono"
                      placeholder="~/.ssh/id_ed25519"
                      value={sshKeyPath}
                      onChange={(e) => setSshKeyPath(e.target.value)}
                    />
                  </div>
                </>
              )}

              <div className="field">
                <label>연결 파라미터 (key = value)</label>
                {params.map((p, i) => (
                  <div className="row" style={{ gap: 6, marginBottom: 4 }} key={i}>
                    <input
                      className="input mono"
                      style={{ flex: 1 }}
                      placeholder="application_name"
                      value={p[0]}
                      onChange={(e) => updateParam(i, 0, e.target.value)}
                    />
                    <span className="muted">=</span>
                    <input
                      className="input mono"
                      style={{ flex: 1 }}
                      placeholder="db-studio"
                      value={p[1]}
                      onChange={(e) => updateParam(i, 1, e.target.value)}
                    />
                    <button
                      className="btn icon"
                      onClick={() => setParams((prev) => prev.filter((_, idx) => idx !== i))}
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
                <button
                  className="btn ghost sm"
                  style={{ paddingLeft: 0 }}
                  onClick={() => setParams((prev) => [...prev, ["", ""]])}
                >
                  <Plus size={14} /> 파라미터 추가
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
