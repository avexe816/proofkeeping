/**
 * 送信キューの状態を画面へ繋ぐ hook（PK-SPEC-P1 §8）。
 *
 * task: docs/tasks/P1-12.md
 *
 * **SSR では何もしない。** `useEffect` の中でだけ購読と flush を始める。
 * サーバー側で `indexedDB` を触ると画面全体が落ちる。
 */

import { useCallback, useEffect, useState } from "react";

import { FLUSH_POLL_INTERVAL_MS } from "../../lib/offline/policy.js";
import {
  flushQueue,
  retryFailed,
  startAutoFlush,
  subscribeQueue,
  type QueueState,
} from "../../lib/offline/queue.js";

const IDLE: QueueState = {
  pending: 0,
  manualRetry: false,
  stale: false,
  flushing: false,
  ids: [],
};

export interface OfflineQueue {
  state: QueueState;
  /** ブラウザが「オフライン」と言っているか。 */
  offline: boolean;
  /** 未送信バーのタップ（flush トリガー 3）。赤バッジも積み直す。 */
  sendNow: () => void;
}

export function useOfflineQueue(): OfflineQueue {
  const [state, setState] = useState<QueueState>(IDLE);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribeQueue(setState);
    const stopAutoFlush = startAutoFlush(FLUSH_POLL_INTERVAL_MS);

    const sync = (): void => {
      setOffline(!navigator.onLine);
    };
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);

    return () => {
      unsubscribe();
      stopAutoFlush();
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  const sendNow = useCallback(() => {
    void retryFailed().then(() => flushQueue());
  }, []);

  return { state, offline, sendNow };
}
