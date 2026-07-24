import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Modal } from "../../components/Modal";
import { highlight, matches } from "../explorer/filterContext";
import { rawTextInputProps } from "../../lib/sqlText";

interface Props {
  /** 연결 이름(제목에 표시). */
  connName: string;
  /** 이 연결이 가진 전체 최상위 노드(DB 또는 스키마) 이름. */
  all: string[];
  /** 스키마 계층이 있는 DB 인지 — 문구를 맞추기 위해. */
  label: "데이터베이스" | "스키마";
  /** 현재 선택. null 이면 전체 표시 상태. */
  selected: string[] | null;
  /** 확정. null 을 주면 전체 표시로 되돌린다. */
  onApply: (next: string[] | null) => void;
  onClose: () => void;
}

/**
 * 트리에 노출할 데이터베이스·스키마를 고르는 선택기 (DataGrip 의 "N of M").
 *
 * 서버에 수십~수백 개가 있는 경우가 흔해, 필요한 것만 남겨 트리를 가볍게 만든다.
 */
export function SchemaPicker({
  connName,
  all,
  label,
  selected,
  onApply,
  onClose,
}: Props) {
  const [filter, setFilter] = useState("");
  // null(전체)로 들어와도 편집 중에는 구체적인 집합으로 다룬다.
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(selected ?? all),
  );

  const shown = useMemo(
    () => (filter ? all.filter((n) => matches(n, filter)) : all),
    [all, filter],
  );

  function toggle(name: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  /** 검색으로 걸러진 것들만 한 번에 켜고 끈다(수백 개일 때 유용). */
  function setAllShown(on: boolean) {
    setPicked((prev) => {
      const next = new Set(prev);
      shown.forEach((n) => (on ? next.add(n) : next.delete(n)));
      return next;
    });
  }

  function apply() {
    // 전부 선택했으면 '전체 표시'와 같으므로 선택을 저장하지 않는다.
    onApply(picked.size === all.length ? null : [...picked]);
    onClose();
  }

  return (
    <Modal
      title={`표시할 ${label} — ${connName}`}
      onClose={onClose}
      footer={
        <>
          <span className="muted value-meta">
            {picked.size} / {all.length} 선택
          </span>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            취소
          </button>
          <button
            className="btn primary"
            onClick={apply}
            disabled={picked.size === 0}
            title={picked.size === 0 ? "최소 하나는 선택해야 합니다" : undefined}
          >
            적용
          </button>
        </>
      }
    >
      <div className="picker-search">
        <Search size={13} className="muted" />
        <input
          {...rawTextInputProps}
          className="where-input"
          placeholder={`${label} 검색`}
          value={filter}
          autoFocus
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setFilter("")}
        />
      </div>

      <div className="picker-actions">
        <button className="btn sm" onClick={() => setAllShown(true)}>
          {filter ? "검색 결과 모두 선택" : "모두 선택"}
        </button>
        <button className="btn sm" onClick={() => setAllShown(false)}>
          {filter ? "검색 결과 모두 해제" : "모두 해제"}
        </button>
      </div>

      <div className="picker-list">
        {shown.map((n) => (
          <label key={n}>
            <input
              type="checkbox"
              checked={picked.has(n)}
              onChange={() => toggle(n)}
            />
            <span className="tree-label">{highlight(n, filter)}</span>
          </label>
        ))}
        {shown.length === 0 && (
          <div className="muted picker-empty">검색 결과가 없습니다.</div>
        )}
      </div>
    </Modal>
  );
}
