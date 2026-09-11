// IntelliJ(DataGrip) 기본 키맵에 맞춘 단축키 표.
//
// 사용자가 IntelliJ DB 콘솔과 나란히 쓰므로 손에 익은 키가 그대로 통해야 한다(docs/DESIGN.md §6-8).
// 값은 IntelliJ 오픈소스 키맵 정의에서 가져왔고, 항목마다 IntelliJ 액션 ID 를 남긴다.
//   Windows: platform-resources/src/keymaps/$default.xml
//   macOS  : Mac OS X 10.5+.xml — 여기 없는 액션은 $default 를 물려받되 Ctrl↔⌘ 를 바꾼다
//            (MacOSDefaultKeymap.convertShortcutFromParent).
// DataGrip 전용 액션(Console.TableResult.*)은 DataGrip 문서의 Windows 표기에 같은 변환을 적용했다.
//
// macOS 는 Ctrl 을 ⌘ 로 바꾼 것만이 아니다 — 새로고침 ⌘R / Ctrl+F5, 행 이동 ⌘L / Ctrl+G,
// 행 추가 ⌘N / Alt+Insert 처럼 키 자체가 다르다. 그래서 OS 별로 따로 적는다.

export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/**
 * `"meta+alt+E"` 꼴. 수식키는 meta·ctrl·alt·shift, 마지막이 키 이름이다.
 * 키 이름은 글자·숫자·`F1`~`F12`·`Enter`·`Backspace`·`Delete`·`Insert`·`Space`·`Escape`·
 * `ArrowUp` 등, 그리고 `[` `]` `/`.
 */
type Combo = string;

interface Binding {
  mac: Combo[];
  win: Combo[];
}

export const KEYMAP = {
  // ── 콘솔 ──
  /** Console.Execute.Multiline */
  execute: { mac: ["meta+Enter"], win: ["ctrl+Enter"] },
  /** Console.History.Browse — `⌘E` 는 IntelliJ 에서 "최근 파일"이다. */
  queryHistory: { mac: ["meta+alt+E"], win: ["ctrl+alt+E"] },
  /** 앱 고유(IntelliJ 의 새 콘솔 키는 확인하지 못해 기존 키를 유지한다). */
  newConsole: { mac: ["meta+K"], win: ["ctrl+K"] },

  // ── 탭 ──
  /** CloseContent. Windows 의 Ctrl+W 는 이전부터 쓰던 키라 함께 둔다. */
  closeTab: { mac: ["meta+W"], win: ["ctrl+F4", "ctrl+W"] },
  /**
   * NextTab / PreviousTab. macOS 의 ⌃←/→ 는 IntelliJ 에도 있지만 입력칸의 캐럿 이동(줄 끝으로)과
   * 겹쳐 뺐다. Windows 의 Alt+←/→ 는 웹뷰의 뒤로·앞으로 가기라 오히려 가로채야 한다.
   */
  nextTab: { mac: ["meta+shift+]"], win: ["alt+ArrowRight"] },
  prevTab: { mac: ["meta+shift+["], win: ["alt+ArrowLeft"] },

  // ── 검색 ──
  /** Find */
  find: { mac: ["meta+F"], win: ["ctrl+F"] },

  // ── 데이터 에디터(그리드) ──
  /** Refresh — 데이터 에디터의 Reload Page */
  refresh: { mac: ["meta+R"], win: ["ctrl+F5"] },
  /** Console.TableResult.Submit — pending 변경 커밋 */
  submit: { mac: ["meta+Enter"], win: ["ctrl+Enter"] },
  /** ChangesView.Revert — Revert Selected */
  revert: { mac: ["meta+alt+Z"], win: ["ctrl+alt+Z"] },
  /** NewElement — Add Row */
  addRow: { mac: ["meta+N"], win: ["alt+Insert"] },
  /** EditorDeleteLine · DeleteItem — Delete Row */
  deleteRow: { mac: ["meta+Backspace"], win: ["ctrl+Y", "alt+Delete"] },
  /** EditorDuplicate — Clone Row */
  cloneRow: { mac: ["meta+D"], win: ["ctrl+D"] },
  /** Console.TableResult.SetNull */
  setNull: { mac: ["meta+alt+N"], win: ["ctrl+alt+N"] },
  /** GotoLine — Go to Row */
  gotoRow: { mac: ["meta+L"], win: ["ctrl+G"] },
  /** Console.TableResult.NextPage / PreviousPage */
  nextPage: { mac: ["meta+alt+ArrowDown"], win: ["ctrl+alt+ArrowDown"] },
  prevPage: { mac: ["meta+alt+ArrowUp"], win: ["ctrl+alt+ArrowUp"] },
  /** EditSource — Related Rows */
  relatedRows: { mac: ["F4"], win: ["F4"] },
  /** Console.TableResult.EditValueMaximized — 값 뷰어 */
  valueView: { mac: ["shift+Enter"], win: ["shift+Enter"] },
  /** 앱 고유 — 레코드 뷰(DataGrip 에 같은 기본 키가 없다) */
  recordView: { mac: ["meta+shift+Enter"], win: ["ctrl+shift+Enter"] },
  /** Select Row */
  selectRow: { mac: ["shift+Space"], win: ["shift+Space"] },
  /** $Copy */
  copy: { mac: ["meta+C"], win: ["ctrl+C"] },
  /** $SelectAll */
  selectAll: { mac: ["meta+A"], win: ["ctrl+A"] },
} satisfies Record<string, Binding>;

export type ShortcutAction = keyof typeof KEYMAP;

interface Parsed {
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** 비교할 `KeyboardEvent.code` 후보. */
  codes: string[];
  key: string;
}

/**
 * 키 이름을 `KeyboardEvent.code` 로 바꾼다.
 *
 * `e.key` 로 비교하면 안 된다. macOS 에서 ⌥ 를 누르면 `e.key` 가 다른 글자(⌥E → `´`)로 바뀌고,
 * 한글 입력 상태에서는 `ㄷ` 같은 값이 와서 단축키가 먹지 않는다. `code` 는 자판 배열·입력기와
 * 무관한 물리 키라 이 문제가 없다.
 */
function codesFor(key: string): string[] {
  if (/^[A-Z]$/.test(key)) return [`Key${key}`];
  if (/^[0-9]$/.test(key)) return [`Digit${key}`, `Numpad${key}`];
  switch (key) {
    case "Enter":
      return ["Enter", "NumpadEnter"];
    case "[":
      return ["BracketLeft"];
    case "]":
      return ["BracketRight"];
    case "/":
      return ["Slash", "NumpadDivide"];
    default:
      return [key]; // F1~F12, Backspace, Delete, Insert, Space, Escape, Arrow*
  }
}

function parse(combo: Combo): Parsed {
  const parts = combo.split("+");
  // `meta+shift+]` 처럼 키 자체가 "+" 가 아닌 한 마지막 조각이 키다.
  const key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));
  return {
    meta: mods.has("meta"),
    ctrl: mods.has("ctrl"),
    alt: mods.has("alt"),
    shift: mods.has("shift"),
    codes: codesFor(key),
    key,
  };
}

const parsed: Record<ShortcutAction, Parsed[]> = Object.fromEntries(
  Object.entries(KEYMAP).map(([k, b]) => [k, (IS_MAC ? b.mac : b.win).map(parse)]),
) as Record<ShortcutAction, Parsed[]>;

/**
 * 이벤트가 그 액션의 단축키인지. **수식키가 정확히 같아야** 한다 —
 * 느슨하게 보면 ⌥⌘N(NULL)이 ⌘N(행 추가)으로도 잡힌다.
 */
export function isShortcut(
  e: { code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  action: ShortcutAction,
): boolean {
  return parsed[action].some(
    (p) =>
      p.codes.includes(e.code) &&
      p.meta === e.metaKey &&
      p.ctrl === e.ctrlKey &&
      p.alt === e.altKey &&
      p.shift === e.shiftKey,
  );
}

const MAC_KEY: Record<string, string> = {
  Enter: "↩",
  Backspace: "⌫",
  Delete: "⌦",
  Escape: "⎋",
  Space: "Space",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

const WIN_KEY: Record<string, string> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};

/**
 * 웹뷰 자체를 새로 읽는 키인지(F5·Ctrl+R·⌘R 계열, Shift 조합 포함).
 *
 * 웹뷰가 새로 읽히면 화면이 연결 목록을 잊는데 **백엔드 세션은 남는다**(Windows WebView2 는
 * F5·Ctrl+R 이 기본 동작이다). 우리 새로고침(⌘R / Ctrl+F5)도 여기 걸리므로, 막는 것과 별개로
 * 각 화면이 자기 새로고침을 처리한다.
 */
export function isWebviewReload(e: { code: string; metaKey: boolean; ctrlKey: boolean }): boolean {
  return e.code === "F5" || (e.code === "KeyR" && (e.metaKey || e.ctrlKey));
}

/** 툴팁에 쓸 표기. macOS 는 `⌥⌘E`, Windows 는 `Ctrl+Alt+E`. 첫 번째 키만 보여 준다. */
export function shortcutLabel(action: ShortcutAction): string {
  const p = parsed[action][0];
  if (IS_MAC) {
    // macOS 관례 순서: ⌃ ⌥ ⇧ ⌘
    return `${p.ctrl ? "⌃" : ""}${p.alt ? "⌥" : ""}${p.shift ? "⇧" : ""}${p.meta ? "⌘" : ""}${
      MAC_KEY[p.key] ?? p.key
    }`;
  }
  return [p.ctrl && "Ctrl", p.alt && "Alt", p.shift && "Shift", WIN_KEY[p.key] ?? p.key]
    .filter(Boolean)
    .join("+");
}
