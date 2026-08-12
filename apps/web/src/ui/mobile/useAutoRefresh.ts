/**
 * 30 秒ごとの自動更新とプルダウン更新（PK-SPEC-P1 §9.2 / ui-writing.md §3）。
 *
 * task: docs/tasks/P1-08.md
 *
 * ── オフラインでは取りに行かない ────────────────────────
 * 30 秒ごとに失敗する取得を繰り返すと、電池を使い、キューの送信と
 * 帯域を取り合う。**繋がっていないと分かっている間は止める。**
 *
 * ── プルダウンは自前で拾う ──────────────────────────────
 * ブラウザ標準の pull-to-refresh はページ全体を読み直す（SPA の状態と
 * 未送信の表示が一度消える）。先頭で下へ引いた指の動きだけを見て、
 * loader の再取得に写す。
 */

import { useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";

/** 引き下げたと見なす距離（px）。誤爆しない程度に大きく取る。 */
const PULL_THRESHOLD_PX = 70;

export interface AutoRefresh {
  /** 手動更新ボタン（ui-writing.md §3「手動更新ボタンも置く」）。 */
  refresh: () => void;
  /** 取得中か。ボタンの状態表示に使う。 */
  refreshing: boolean;
  /** 引き下げ中の距離（px）。0 なら引いていない。 */
  pullDistance: number;
}

export function useAutoRefresh(intervalMs: number): AutoRefresh {
  const revalidator = useRevalidator();
  const [pullDistance, setPullDistance] = useState(0);
  const startY = useRef<number | null>(null);

  // revalidate は毎描画で同一性が変わりうる。ref に逃がして effect を
  // 30 秒タイマーの張り直しから守る。
  const revalidate = useRef(revalidator.revalidate);
  revalidate.current = revalidator.revalidate;

  useEffect(() => {
    const tick = (): void => {
      if (!navigator.onLine) return;
      if (document.visibilityState !== "visible") return;
      void revalidate.current();
    };
    const timer = setInterval(tick, intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [intervalMs]);

  useEffect(() => {
    const onTouchStart = (event: TouchEvent): void => {
      startY.current = window.scrollY <= 0 ? (event.touches[0]?.clientY ?? null) : null;
    };
    const onTouchMove = (event: TouchEvent): void => {
      if (startY.current === null) return;
      const current = event.touches[0]?.clientY ?? 0;
      setPullDistance(Math.max(0, Math.min(current - startY.current, PULL_THRESHOLD_PX * 2)));
    };
    const onTouchEnd = (): void => {
      if (startY.current !== null && pullDistance >= PULL_THRESHOLD_PX) {
        void revalidate.current();
      }
      startY.current = null;
      setPullDistance(0);
    };

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", onTouchEnd);
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [pullDistance]);

  return {
    refresh: () => {
      void revalidate.current();
    },
    refreshing: revalidator.state !== "idle",
    pullDistance,
  };
}
