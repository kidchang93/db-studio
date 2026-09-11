import { X } from "lucide-react";
import { useUiStore } from "../store/uiStore";
import { CopyButton } from "./CopyButton";

export function Toasts() {
  const toasts = useUiStore((s) => s.toasts);
  const dismiss = useUiStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <div className="row">
            <div className="spacer">
              <div className="toast-title">{t.title}</div>
              {t.message && <div className="muted toast-msg">{t.message}</div>}
            </div>
            {/* 오류 문구는 옮겨 적어야 할 때가 많다. 토스트는 5초 뒤 사라지므로 한 번에 가져가게 한다. */}
            {t.kind === "error" && t.message && (
              <CopyButton text={t.message} title="오류 문구 복사" />
            )}
            <button className="btn icon" onClick={() => dismiss(t.id)}>
              <X size={14} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
