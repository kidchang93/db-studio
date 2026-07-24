import { AlertTriangle, Info } from "lucide-react";
import type { DdlPlan } from "../../types";

/**
 * DDL 계획을 보여주는 공통 패널 — 차단 사유 · 경고 · 실행될 SQL.
 *
 * 구조 변경은 되돌릴 수 없으므로, 어떤 SQL 이 나가는지 항상 그대로 노출한다.
 * 기본 키 지정과 컬럼 속성 변경이 함께 쓴다.
 */
export function DdlPlanView({
  plan,
  error,
}: {
  plan: DdlPlan | null;
  error?: string | null;
}) {
  if (error) return <div className="pk-blocker">{error}</div>;
  if (!plan) return <div className="muted">검사 중…</div>;

  return (
    <>
      {plan.blockers.length > 0 && (
        <div className="pk-section">
          <div className="pk-head danger">
            <AlertTriangle size={13} /> 적용할 수 없습니다
          </div>
          <ul className="pk-list">
            {plan.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
      )}

      {plan.warnings.length > 0 && (
        <div className="pk-section">
          <div className="pk-head warn">
            <Info size={13} /> 확인하세요
          </div>
          <ul className="pk-list">
            {plan.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {plan.statements.length > 0 && (
        <div className="pk-section">
          <div className="pk-head">실행될 SQL</div>
          <pre className="value-view mono">{plan.statements.join(";\n")}</pre>
        </div>
      )}

      {plan.blockers.length === 0 && plan.statements.length > 0 && (
        <div className="muted pk-note">
          구조 변경은 되돌릴 수 없습니다. SQL 을 확인한 뒤 적용하세요.
        </div>
      )}
    </>
  );
}
