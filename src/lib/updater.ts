// 자동 업데이트 래퍼 (Tauri Updater 플러그인).
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

export type { Update };
export { getVersion };

/** 원격 엔드포인트에서 업데이트 여부를 확인한다. 없으면 null. */
export function checkForUpdate(): Promise<Update | null> {
  return check();
}

/** 업데이트를 내려받아 설치하고 앱을 재시작한다. */
export async function installUpdate(update: Update): Promise<void> {
  await update.downloadAndInstall();
  await relaunch();
}
