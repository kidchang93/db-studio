import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { useUiStore } from "../store/uiStore";

/**
 * 텍스트를 통째로 클립보드에 넣는 작은 버튼.
 *
 * 오류 문구·SQL 은 선택을 풀어 두었지만(`global.css` "옮겨 적어야 하는 텍스트"),
 * 여러 줄을 드래그로 정확히 긁기는 번거롭다. 원문을 한 번에 가져갈 수 있어야 한다.
 */
export function CopyButton({ text, title = "복사" }: { text: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  const pushToast = useUiStore((s) => s.pushToast);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      pushToast({
        kind: "error",
        title: "복사 실패",
        message: "클립보드에 접근할 수 없습니다",
      });
    }
  }

  return (
    <button className="btn icon" title={copied ? "복사됨" : title} onClick={copy}>
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}
