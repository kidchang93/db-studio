import { useState } from "react";
import { Modal } from "../../components/Modal";
import * as api from "../../api";
import {
  DB_META,
  type ConnectionConfig,
  type ConnectionProfile,
  type DbKind,
} from "../../types";
import { useConnectionStore } from "../../store/connectionStore";
import { useUiStore } from "../../store/uiStore";

interface Props {
  /** 편집 대상. null 이면 신규. */
  profile?: ConnectionProfile | null;
  onClose: () => void;
}

const KINDS: DbKind[] = ["postgres", "mysql", "sqlite", "mssql"];

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

  function buildConfig(): ConnectionConfig {
    return {
      kind,
      host: usesFile ? null : host || null,
      port: usesFile ? null : port ? Number(port) : null,
      database: database || null,
      username: usesFile ? null : username || null,
      password: usesFile ? null : password || null,
      params: {},
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
      params: profile?.params ?? {},
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
        </>
      )}
    </Modal>
  );
}
