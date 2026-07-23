import { X } from "lucide-react";
import { useUiStore } from "../store/uiStore";

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
              {t.message && <div className="muted">{t.message}</div>}
            </div>
            <button className="btn icon" onClick={() => dismiss(t.id)}>
              <X size={14} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
