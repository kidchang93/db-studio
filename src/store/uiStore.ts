import { create } from "zustand";
import { errorMessage } from "../types";
import { useLogStore } from "./logStore";

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
    const message = errorMessage(err);
    get().pushToast({ kind: "error", title, message });
    set({ status: `오류: ${message}` });
    // 토스트는 5초 뒤 사라진다. 오류만큼은 되짚을 수 있어야 하므로 로그에도 남긴다.
    // 모든 오류가 이 함수를 지나므로 여기 한 곳이면 빠짐없이 기록된다.
    useLogStore.getState().add({ kind: "error", label: title, detail: message });
  },

  setStatus: (status) => set({ status }),

  toggleTheme: () => {
    const theme = get().theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", theme);
    set({ theme });
  },
}));
