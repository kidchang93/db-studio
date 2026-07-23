import { create } from "zustand";
import {
  checkForUpdate,
  getVersion,
  installUpdate,
  type Update,
} from "../lib/updater";
import { errorMessage } from "../types";
import { useUiStore } from "./uiStore";

interface UpdateState {
  version: string;
  available: Update | null;
  checking: boolean;
  installing: boolean;
  /** 앱 시작 시: 버전 로드 + 조용한 확인. */
  init: () => Promise<void>;
  /** 업데이트 확인. manual=true 면 결과를 토스트로 알린다. */
  check: (manual: boolean) => Promise<void>;
  /** 사용 가능한 업데이트를 설치하고 재시작. */
  install: () => Promise<void>;
}

export const useUpdateStore = create<UpdateState>()((set, get) => ({
  version: "",
  available: null,
  checking: false,
  installing: false,

  init: async () => {
    try {
      set({ version: await getVersion() });
    } catch {
      // 개발 환경 등에서 실패 가능 — 무시.
    }
    await get().check(false);
  },

  check: async (manual) => {
    if (get().checking) return;
    set({ checking: true });
    try {
      const update = await checkForUpdate();
      set({ available: update });
      if (manual) {
        const ui = useUiStore.getState();
        if (update) {
          ui.pushToast({
            kind: "info",
            title: "업데이트 있음",
            message: `새 버전 ${update.version} 이(가) 있습니다.`,
          });
        } else {
          ui.pushToast({
            kind: "success",
            title: "최신 버전",
            message: "이미 최신 버전을 사용 중입니다.",
          });
        }
      }
    } catch (e) {
      // 미배포/개발 환경에서는 확인이 실패할 수 있으므로 수동 확인 시에만 알린다.
      if (manual) {
        useUiStore.getState().pushToast({
          kind: "error",
          title: "업데이트 확인 실패",
          message: errorMessage(e),
        });
      }
    } finally {
      set({ checking: false });
    }
  },

  install: async () => {
    const update = get().available;
    if (!update) return;
    set({ installing: true });
    useUiStore.getState().setStatus(`업데이트 ${update.version} 다운로드 중…`);
    try {
      await installUpdate(update); // 완료 후 앱이 재시작된다.
    } catch (e) {
      useUiStore.getState().toastError(e, "업데이트 설치 실패");
      set({ installing: false });
    }
  },
}));
