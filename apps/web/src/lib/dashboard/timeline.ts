/**
 * 本日の動き（タイムライン）の語彙と組み立て。**純粋関数。**
 *
 * 参照:  ui-prototypes/owner/pkown-v3-A-login-daily.html（02 の本日の動き）
 * ルール: .claude/rules/security.md §5 / ui-writing.md §2
 *
 * ── 監査ログのうち「現場で起きたこと」だけ ──────────────
 * 設定変更・マスタ更新は監査ログの画面（P7-20）で見るもので、朝の 1 枚に
 * 混ぜない。**この表に載っていない操作は出さない**（既定で出さない側に
 * 倒す。新しい操作が増えたときに、意図せず現場の画面へ漏れない）。
 *
 * ── 実行者を出さない ────────────────────────────────────
 * 誰がやったかは出さない（security.md §5 / プロトタイプの確定事項）。
 * 時刻から勤務時間や作業ペースが間接的に見えるため、個人と結び付けない。
 *
 * ── 色は区分であって、急かす色ではない ──────────────────
 * 再清掃はオレンジ、入室不可は青（ui-writing.md §3 / 契約 §11.2
 * 「保留（入室不可）を赤で表示 → 青。清掃の遅れではない」）。
 */

import type { MessageKey } from "../i18n.js";

/** 点の色。**赤（`danger`）は差異の確認だけ**に使う。 */
export type TimelineTone = "ok" | "warn" | "info" | "danger" | "muted";

interface TimelineEvent {
  label: MessageKey;
  tone: TimelineTone;
}

/**
 * 監査ログの `action` → 文言と色。
 *
 * **ここに無い `action` は載せない。** 一覧に足すときは、それが
 * 「現場で起きたこと」かを確かめること（設定変更は監査ログの画面へ）。
 */
export const TIMELINE_EVENTS: Partial<Record<string, TimelineEvent>> = {
  "task.completed": { label: "dashboard.org.event.taskCompleted", tone: "ok" },
  "task.blocked": { label: "dashboard.org.event.taskBlocked", tone: "info" },
  "task.reworkAssigned": { label: "dashboard.org.event.reworkAssigned", tone: "warn" },
  "rework.resolved": { label: "dashboard.org.event.reworkResolved", tone: "ok" },
  "inspection.passed": { label: "dashboard.org.event.inspectionPassed", tone: "ok" },
  "inspection.failed": { label: "dashboard.org.event.inspectionFailed", tone: "warn" },
  "room.statusOverridden": { label: "dashboard.org.event.roomOverridden", tone: "info" },
  "finding.statusChanged": { label: "dashboard.org.event.findingUpdated", tone: "danger" },
};

/** 画面へ渡す 1 行。**人の識別子を持たない。** */
export interface TimelineRow {
  id: string;
  /** epoch ミリ秒。表示は `formatClock()`。 */
  at: number;
  label: MessageKey;
  tone: TimelineTone;
  /** 施設名。組織全体の操作は `null`。 */
  propertyName: string | null;
}

/** 監査ログ 1 件ぶんの入力。 */
export interface TimelineLogInput {
  id: string;
  at: Date;
  action: string;
  propertyId: string | null;
}

/**
 * 監査ログを本日の動きへ。**新しい順・`limit` 件まで。**
 *
 * @param nameOf 施設 ID → 表示名。引けない ID は `null`（ID を出さない）。
 */
export function buildTimeline(
  logs: readonly TimelineLogInput[],
  nameOf: ReadonlyMap<string, string>,
  limit: number,
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const log of logs) {
    const event = TIMELINE_EVENTS[log.action];
    if (event === undefined) continue;
    rows.push({
      id: log.id,
      at: log.at.getTime(),
      label: event.label,
      tone: event.tone,
      propertyName: log.propertyId === null ? null : (nameOf.get(log.propertyId) ?? null),
    });
    if (rows.length >= limit) break;
  }
  return rows;
}
