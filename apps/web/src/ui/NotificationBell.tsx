import { Link } from "react-router";

import { t } from "../lib/i18n.js";
import { formatNotificationBadge } from "../lib/notification/badge.js";

/**
 * 通知の鈴（PK-SPEC-UI-A01 §3.1 / §3.2）。
 *
 * 参照: ui-prototypes/owner/pkown-v3-A-login-daily.html（`.bell` / `.bd3`）
 *
 * ── プロトタイプの alert を画面 1 枚に置き換えない ────────
 * プロトタイプは押すと差異 4 件を alert で並べる。**同じ内容の一覧は
 * すでに `/app/audit/findings` にある。** 鈴の中にもう 1 つ一覧を作らず、
 * その画面へ送るだけにする（簡素化）。
 *
 * ── 0 件のときは鈴だけ残す ──────────────────────────────
 * A01 §3.2「0 件 → バッジを表示しない」。鈴そのものは消さない。
 * 鈴ごと出さないのは**差異を読めない相手**の場合で、その判断は
 * `countNotificationBadge()` を呼ぶ側（layout）が行う。
 */
export function NotificationBell(props: { count: number }) {
  const badge = formatNotificationBadge(props.count);

  return (
    <Link
      aria-label={t("notification.bell.label")}
      className="pk-bell"
      title={t("notification.bell.label")}
      to="/app/audit/findings"
    >
      {/* 絵文字は装飾。読み上げは `aria-label` が担う。 */}
      <span aria-hidden="true">🔔</span>
      {badge === null ? null : <span className="pk-bell__badge">{badge}</span>}
    </Link>
  );
}
