import { Copy } from "lucide-react";
import { Modal } from "../../components/Modal";
import type { Cell } from "../../types";

/** 값 뷰어 표시용. JSON 으로 보이면 들여쓰기해 읽기 좋게 만든다. */
export function prettyValue(v: Cell): string {
  if (v === null || v === undefined) return "NULL";
  const s = String(v);
  const t = s.trim();
  if (/^[[{]/.test(t) && /[\]}]$/.test(t)) {
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      return s; // JSON 이 아니면 원문 그대로
    }
  }
  return s;
}

/**
 * 셀 값 전체를 펼쳐 보는 창. 그리드에서는 값이 잘려 보이기 때문에 따로 띄운다.
 * 테이블 그리드와 콘솔 결과가 함께 쓴다.
 */
export function ValueViewer({
  column,
  rowNo,
  value,
  pretty,
  onCopy,
  onClose,
}: {
  column: { name: string; dbType: string };
  rowNo: number;
  value: Cell;
  pretty: string;
  onCopy: (text: string) => void;
  onClose: () => void;
}) {
  const isNull = value === null || value === undefined;
  const raw = isNull ? "" : String(value);
  return (
    <Modal
      title={`${column.name} — ${rowNo}행`}
      onClose={onClose}
      footer={
        <>
          <span className="muted value-meta">
            {column.dbType}
            {!isNull && ` · ${raw.length.toLocaleString()}자`}
          </span>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            닫기
          </button>
          <button
            className="btn primary"
            onClick={() => onCopy(raw)}
            disabled={isNull}
            title="값을 클립보드로 복사"
          >
            <Copy size={13} /> 복사
          </button>
        </>
      }
    >
      <pre className={`value-view mono${isNull ? " null" : ""}`}>{pretty}</pre>
    </Modal>
  );
}
