import { useEffect, useMemo, useState } from "react";
import { Pencil } from "lucide-react";
import * as api from "../../api";
import type { ColumnChange, ColumnInfo, DdlPlan, TableRef } from "../../types";
import { Modal } from "../../components/Modal";
import { useUiStore } from "../../store/uiStore";
import { rawTextInputProps } from "../../lib/sqlText";
import { DdlPlanView } from "./DdlPlanView";

interface Props {
  connId: string;
  table: TableRef;
  column: ColumnInfo;
  onClose: () => void;
  /** 적용이 끝나 스키마가 바뀌었을 때. 호출부가 목록을 다시 읽는다. */
  onApplied: () => void;
}

/** 기본값 입력이 비어 있으면 "제거", 원래 값 그대로면 "유지"로 다룬다. */
function normalizeDefault(raw: string): string | null {
  const v = raw.trim();
  return v === "" ? null : v;
}

/**
 * 컬럼 속성(이름·타입·NULL·기본값) 변경 다이얼로그.
 *
 * 입력이 바뀔 때마다 서버에 계획을 물어 실행될 SQL 과 차단 사유를 보여주고,
 * 차단 사유가 없을 때만 적용할 수 있다.
 */
export function ColumnEditDialog({
  connId,
  table,
  column,
  onClose,
  onApplied,
}: Props) {
  const ui = useUiStore();
  const [name, setName] = useState(column.name);
  const [dbType, setDbType] = useState(column.dbType);
  const [nullable, setNullable] = useState(column.nullable);
  const [def, setDef] = useState(column.default ?? "");
  const [plan, setPlan] = useState<DdlPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const originalDefault = column.default ?? "";

  /** 바뀐 항목만 담아 보낸다 — 건드리지 않은 속성은 유지된다. */
  const change = useMemo<ColumnChange>(() => {
    const trimmed = name.trim();
    return {
      newName: trimmed && trimmed !== column.name ? trimmed : null,
      dbType: dbType.trim() && dbType.trim() !== column.dbType ? dbType.trim() : null,
      nullable: nullable !== column.nullable ? nullable : null,
      setDefault: def.trim() !== originalDefault.trim(),
      default: normalizeDefault(def),
    };
  }, [name, dbType, nullable, def, column, originalDefault]);

  const dirty =
    !!change.newName || !!change.dbType || change.nullable !== null || change.setDefault;

  // 입력이 멈추면 계획을 다시 물어본다(타이핑마다 서버를 때리지 않도록 지연).
  useEffect(() => {
    if (!dirty) {
      setPlan(null);
      setError(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      api
        .planAlterColumn({ connId, table, column: column.name, change })
        .then((p) => alive && (setPlan(p), setError(null)))
        .catch((e) => alive && setError(e?.message ?? String(e)));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [connId, table, column.name, change, dirty]);

  const canApply = dirty && !!plan && plan.blockers.length === 0 && !applying;

  async function apply() {
    setApplying(true);
    try {
      await api.applyAlterColumn({ connId, table, column: column.name, change });
      ui.pushToast({
        kind: "success",
        title: "컬럼 변경 완료",
        message: `${table.name}.${column.name}`,
      });
      onApplied();
      onClose();
    } catch (e) {
      ui.toastError(e, "컬럼 변경 실패");
      api
        .planAlterColumn({ connId, table, column: column.name, change })
        .then(setPlan)
        .catch(() => {});
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal
      title={`컬럼 변경 — ${column.name}`}
      onClose={onClose}
      footer={
        <>
          <span className="muted value-meta">
            {dirty ? "변경 내용 확인 후 적용" : "변경할 항목을 수정하세요"}
          </span>
          <span className="spacer" />
          <button className="btn" onClick={onClose} disabled={applying}>
            취소
          </button>
          <button className="btn primary" onClick={apply} disabled={!canApply}>
            <Pencil size={13} /> {applying ? "적용 중…" : "적용"}
          </button>
        </>
      }
    >
      <div className="field">
        <label>이름</label>
        <input
          {...rawTextInputProps}
          className="input mono"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="field">
        <label>타입</label>
        <input
          {...rawTextInputProps}
          className="input mono"
          value={dbType}
          placeholder="예) varchar(100)"
          onChange={(e) => setDbType(e.target.value)}
        />
      </div>

      <div className="field">
        <label>기본값</label>
        <input
          {...rawTextInputProps}
          className="input mono"
          value={def}
          placeholder="비우면 기본값 제거 — SQL 식 그대로 (예: 0, 'N', GETDATE())"
          onChange={(e) => setDef(e.target.value)}
        />
      </div>

      <label className="check-row">
        <input
          type="checkbox"
          checked={nullable}
          disabled={column.isPrimaryKey}
          onChange={(e) => setNullable(e.target.checked)}
        />
        NULL 허용
        {column.isPrimaryKey && (
          <span className="muted"> — 기본 키 컬럼이라 변경할 수 없습니다</span>
        )}
      </label>

      {dirty && <DdlPlanView plan={plan} error={error} />}
    </Modal>
  );
}
