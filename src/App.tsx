import { useEffect } from "react";
import { AppShell } from "./features/layout/AppShell";
import { useUiStore } from "./store/uiStore";
import { useUpdateStore } from "./store/updateStore";

export default function App() {
  const theme = useUiStore((s) => s.theme);
  const initUpdates = useUpdateStore((s) => s.init);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    // 앱 버전 로드 + 시작 시 조용한 업데이트 확인.
    initUpdates();
  }, [initUpdates]);

  return <AppShell />;
}
