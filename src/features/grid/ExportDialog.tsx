import { useMemo, useState } from "react";
import { Clipboard, Download } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import * as api from "../../api";
import type { Cell, ColumnMeta } from "../../types";
import { Modal } from "../../components/Modal";
import { useUiStore } from "../../store/uiStore";
import {
  FORMAT_EXT,
  FORMAT_LABELS,
  formatRows,
  type ExportFormat,
} from "../../lib/exportData";

interface Props {
  columns: ColumnMeta[];
  rows: Cell[][];
  /** 파일명·SQL INSERT 에 쓸 이름. */
  name: string;
  /** 선택 영역만 내보내는 경우의 안내 문구(없으면 전체). */
  scopeNote?: string;
  onClose: () => void;
}

const FORMATS: ExportFormat[] = ["csv", "tsv", "json", "markdown", "sql"];

/** 내보내기 — 형식을 고르고 클립보드나 파일로 내보낸다. */
export function ExportDialog({ columns, rows, name, scopeNote, onClose }: Props) {
  const ui = useUiStore();
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [header, setHeader] = useState(true);
  const [busy, setBusy] = useState(false);

  const content = useMemo(
    () => formatRows(columns, rows, { format, header, tableName: name }),
    [columns, rows, format, header, name],
  );

  // 큰 결과를 통째로 그리면 느려지므로 앞부분만 미리 보여준다.
  const preview = useMemo(() => {
    const lines = content.split("\n");
    return lines.length > 12
      ? `${lines.slice(0, 12).join("\n")}\n… (${lines.length - 12}줄 더)`
      : content;
  }, [content]);

  async function copy() {
    setBusy(true);
    try {
      await navigator.clipboard.writeText(content);
      ui.setStatus(`${rows.length}행 ${FORMAT_LABELS[format]} 복사됨`);
      onClose();
    } catch {
      ui.pushToast({
        kind: "error",
        title: "복사 실패",
        message: "클립보드에 접근할 수 없습니다",
      });
    } finally {
      setBusy(false);
    }
  }

  async function saveFile() {
    setBusy(true);
    try {
      const ext = FORMAT_EXT[format];
      const path = await save({
        defaultPath: `${name}.${ext}`,
        filters: [{ name: FORMAT_LABELS[format], extensions: [ext] }],
      });
      if (!path) return; // 사용자가 취소
      await api.writeTextFile(path, content);
      ui.pushToast({
        kind: "success",
        title: "내보내기 완료",
        message: `${rows.length}행 · ${path}`,
      });
      onClose();
    } catch (e) {
      ui.toastError(e, "내보내기 실패");
    } finally {
      setBusy(false);
    }
  }

  const showHeaderOption = format === "csv" || format === "tsv";

  return (
    <Modal
      title="데이터 내보내기"
      onClose={onClose}
      footer={
        <>
          <span className="muted value-meta">
            {rows.length.toLocaleString()}행 · {columns.length}컬럼
            {scopeNote ? ` · ${scopeNote}` : ""}
          </span>
          <span className="spacer" />
          <button className="btn" onClick={onClose} disabled={busy}>
            취소
          </button>
          <button className="btn" onClick={copy} disabled={busy || rows.length === 0}>
            <Clipboard size={13} /> 클립보드
          </button>
          <button
            className="btn primary"
            onClick={saveFile}
            disabled={busy || rows.length === 0}
          >
            <Download size={13} /> 파일로 저장
          </button>
        </>
      }
    >
      <div className="field">
        <label>형식</label>
        <div className="seg">
          {FORMATS.map((f) => (
            <button
              key={f}
              className={format === f ? "active" : ""}
              onClick={() => setFormat(f)}
            >
              {FORMAT_LABELS[f]}
            </button>
          ))}
        </div>
      </div>

      {showHeaderOption && (
        <label className="check-row">
          <input
            type="checkbox"
            checked={header}
            onChange={(e) => setHeader(e.target.checked)}
          />
          첫 줄에 컬럼명 포함
        </label>
      )}

      <div className="pk-section">
        <div className="pk-head">미리보기</div>
        <pre className="value-view mono">{preview || "(내보낼 데이터가 없습니다)"}</pre>
      </div>
    </Modal>
  );
}
