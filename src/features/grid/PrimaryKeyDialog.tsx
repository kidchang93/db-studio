import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import * as api from "../../api";
import type { DdlPlan, TableRef } from "../../types";
import { Modal } from "../../components/Modal";
import { useUiStore } from "../../store/uiStore";
import { DdlPlanView } from "./DdlPlanView";

interface Props {
  connId: string;
  table: TableRef;
  columns: string[];
  onClose: () => void;
  /** 적용이 끝나 스키마가 바뀌었을 때. 호출부가 목록을 다시 읽는다. */
  onApplied: () => void;
}

/**
 * 기본 키 지정 확인 다이얼로그.
 *
 * DDL 은 되돌리기 어려우므로 실행될 SQL 을 그대로 보여주고, 서버에서 미리 검사한
 * 차단 사유(NULL·중복 등)가 없을 때만 적용 버튼을 열어 준다.
 */
export function PrimaryKeyDialog({
  connId,
  table,
  columns,
  onClose,
  onApplied,
}: Props) {
  const ui = useUiStore();
  const [plan, setPlan] = useState<DdlPlan | null>(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setPlan(null);
    setError(null);
    api
      .planPrimaryKey({ connId, table, columns })
      .then((p) => alive && setPlan(p))
      .catch((e) => {
        if (alive) setError(e?.message ?? String(e));
      });
    return () => {
      alive = false;
    };
  }, [connId, table, columns]);

  const canApply = !!plan && plan.blockers.length === 0 && !applying;

  async function apply() {
    setApplying(true);
    try {
      await api.applyPrimaryKey({ connId, table, columns });
      ui.pushToast({
        kind: "success",
        title: "기본 키 지정 완료",
        message: `${table.name} · ${columns.join(", ")}`,
      });
      onApplied();
      onClose();
    } catch (e) {
      ui.toastError(e, "기본 키 지정 실패");
      // 실패 사유가 데이터 변경일 수 있으므로 계획을 다시 세워 보여 준다.
      api.planPrimaryKey({ connId, table, columns }).then(setPlan).catch(() => {});
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal
      title={`기본 키 지정 — ${table.name}`}
      onClose={onClose}
      footer={
        <>
          <span className="muted value-meta">
            {columns.length}개 컬럼: {columns.join(", ")}
          </span>
          <span className="spacer" />
          <button className="btn" onClick={onClose} disabled={applying}>
            취소
          </button>
          <button className="btn primary" onClick={apply} disabled={!canApply}>
            <KeyRound size={13} /> {applying ? "적용 중…" : "적용"}
          </button>
        </>
      }
    >
      <DdlPlanView plan={plan} error={error} />
    </Modal>
  );
}
