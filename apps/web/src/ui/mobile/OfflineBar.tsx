/**
 * オフライン・未送信の帯（PK-SPEC-P1 §9.2 / ui-writing.md §5）。
 *
 * task: docs/tasks/P1-12.md
 *
 * ```
 * ⚠ オフライン ・ 送信待ちの記録 3 件      [ いま送る ]
 * ```
 *
 * ── 常時表示する ────────────────────────────────────────
 * オフライン時、または未送信がある間は消さない（ui-writing.md §5）。
 * 「送れていない」ことが見えない画面は、現場が気づけない。
 *
 * ── 帯そのものがボタン ──────────────────────────────────
 * §8.2 の flush トリガー 3「未送信バーのタップ」。手袋でも押せるよう、
 * 帯の全体（最小 48px）を押せる領域にしてある。
 *
 * ── 文言 ────────────────────────────────────────────────
 * 「接続できません」「保存に失敗しました」を使わない（PK-IMPL-CONTRACT §5.1）。
 * 事実だけを述べる: オフラインである・端末に保存されている・N 件が待っている。
 */

import type { Translator } from "../../lib/i18n.js";
import type { QueueState } from "../../lib/offline/queue.js";

export interface OfflineBarProps {
  t: Translator;
  state: QueueState;
  offline: boolean;
  onSend: () => void;
}

export function OfflineBar({ t, state, offline, onSend }: OfflineBarProps): React.ReactElement | null {
  if (!offline && state.pending === 0) return null;

  const tone = state.manualRetry
    ? "pk-m-offline--manual"
    : state.stale
      ? "pk-m-offline--stale"
      : "";

  const message = state.manualRetry
    ? t("m.offline.manualRetry")
    : state.stale
      ? t("m.offline.stale")
      : offline
        ? t("m.offline.bar")
        : t("m.offline.pending");

  return (
    <button
      type="button"
      className={`pk-m-offline ${tone}`}
      onClick={onSend}
      aria-live="polite"
    >
      <span>{message}</span>
      {state.pending === 0 ? null : (
        <span className="pk-m-offline__count">
          {state.pending}
          {state.flushing ? ` · ${t("m.offline.sending")}` : ""}
        </span>
      )}
    </button>
  );
}
