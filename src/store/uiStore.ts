import { create } from "zustand";
import { errorMessage } from "../types";

export interface Toast {
  id: string;
  kind: "error" | "info" | "success";
  title: string;
  message?: string;
}

interface UiState {
  toasts: Toast[];
  status: string;
  theme: "dark" | "light";
  pushToast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: string) => void;
  toastError: (err: unknown, title?: string) => void;
  setStatus: (s: string) => void;
  toggleTheme: () => void;
}

export const useUiStore = create<UiState>()((set, get) => ({
  toasts: [],
  status: "준비됨",
  theme: "dark",

  pushToast: (t) => {
    const id = crypto.randomUUID();
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
    // 5초 뒤 자동 소멸
    setTimeout(() => get().dismissToast(id), 5000);
  },

  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  toastError: (err, title = "오류") => {
    get().pushToast({ kind: "error", title, message: errorMessage(err) });
    set({ status: `오류: ${errorMessage(err)}` });
  },

  setStatus: (status) => set({ status }),

  toggleTheme: () => {
    const theme = get().theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", theme);
    set({ theme });
  },
}));
