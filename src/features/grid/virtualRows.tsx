import type { RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

/** 헤더 한 줄 높이(`--row-h` 26px + 아래 테두리 1px). */
const HEAD_H = 27;
/** 행 높이 추정값. 실제 값은 그려진 행을 재서(`measureElement`) 맞춘다. */
const ROW_H = 27;

/**
 * 표의 행 가상 스크롤 — 보이는 행(과 위아래 여유분)만 그린다(docs/DESIGN.md §6-9).
 *
 * 콘솔 결과는 최대 5000행, 그리드는 최대 1000행인데 전부 DOM 으로 그리면 커서를 한 칸
 * 옮길 때마다 셀 수만 개를 다시 계산해 조작이 버벅거린다.
 *
 * `<table>` 구조와 sticky 헤더를 그대로 두려고 위아래 여백은 빈 행(`SpacerRow`)으로 채운다.
 * 행은 sticky 헤더 아래에서 시작하고 그 헤더가 위쪽을 가리므로 `scrollMargin` 과
 * `scrollPaddingStart` 를 헤더 높이만큼 준다 — 빠뜨리면 인덱스로 스크롤할 때 행이 헤더에 가리거나
 * 화면 아래에 걸친다.
 */
export function useVirtualRows(count: number, scrollRef: RefObject<HTMLElement | null>) {
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
    scrollMargin: HEAD_H,
    scrollPaddingStart: HEAD_H,
  });
  const items = virtualizer.getVirtualItems();
  const first = items[0];
  const last = items[items.length - 1];
  // 행 높이가 모두 같으므로 남은 행 수 × 행 높이가 아래 여백이다.
  const padTop = first ? first.start - HEAD_H : 0;
  const padBottom = last ? (count - 1 - last.index) * last.size : 0;
  return { virtualizer, items, padTop, padBottom };
}

/** 위아래 여백을 채우는 빈 행. 높이만 있고 보이지 않는다. */
export function SpacerRow({ height, colSpan }: { height: number; colSpan: number }) {
  if (height <= 0) return null;
  return (
    <tr className="v-spacer" aria-hidden style={{ height }}>
      <td colSpan={colSpan} />
    </tr>
  );
}
