/**
 * 在留資格の期限アラートの判定（P8-02 / PK-SPEC-P8 §1.4）。**純粋。**
 *
 * task:  docs/tasks/P8-02.md
 * 決定: docs/DECISIONS.md #221（通知は 90 日と 30 日の 2 段。60 日は無い）
 *
 * ```
 * 毎日 07:00 JST（Cron）→ 全組織を QUEUE_NOTIFICATION へ（dispatch）
 *                        → consumers/residencyAlert.ts が判定して notify()
 * ```
 *
 * ── 2 段の意味が違う ────────────────────────────────────
 * プロトタイプ ops 07 のトグルは 2 つ。
 *
 *   「期限90日前に通知」    …… **その日に 1 回だけ**（初回の気づき）
 *   「期限30日前に再通知」  …… **更新手続きが未完了の場合、毎日**
 *
 * 90 日ちょうどの日にだけ数え、30 日以内は毎日数える。89〜31 日の間は
 * どちらにも入らない（催促の間を空ける）。**期限切れも 30 日側に入る** —
 * 配分が止まったまま黙って放置される状態を作らない。
 *
 * ── 更新手続きが出ていれば再通知しない ──────────────────
 * プロトタイプのトグルの但し書きどおり。`renewalAppliedOn` が入って
 * いれば 30 日側から外す。**90 日側は外さない**（申請済みでも、期限の
 * 3 か月前に一度は目に入るべき情報）。
 *
 * ── 退職者を数えない ────────────────────────────────────
 * `workStatus = RESIGNED` のスタッフの在留資格は雇用主の管理対象では
 * なくなっている。数え続けると、退職処理のたびにアラートが残る。
 */

import type { ResidencyRow, StaffLedgerRow } from "@pk/db";

import { daysUntil } from "./ledger.js";

/**
 * 07:00 JST（PK-SPEC-P8 §1.4「毎日 07:00 JST のバッチ」）。UTC では前日 22:00。
 *
 * **相乗りではなく専用の cron。** 写真の保持期限（DECISIONS #165）は仕様が
 * 時刻を定めていなかったので夜間の回に相乗りしたが、こちらは仕様が
 * 07:00 と明記している。02:00 の回に載せると管理者の受信箱に深夜の
 * メールが並ぶ。
 */
export const RESIDENCY_ALERT_CRON = "0 22 * * *";

/** 初回通知の日数（期限のちょうど 90 日前）。 */
export const RESIDENCY_FIRST_NOTICE_DAYS = 90;

/** 毎日再通知に入る日数（期限まで 30 日以内）。 */
export const RESIDENCY_DAILY_NOTICE_DAYS = 30;

/** 判定の結果。**人数だけ。個人を特定できる値を持たない**（ui-writing.md §6）。 */
export interface ResidencyAlertCounts {
  /** 期限のちょうど 90 日前を今日迎えたスタッフの数。 */
  firstNotice: number;
  /** 期限まで 30 日以内（期限切れ含む）で、更新手続きが未申請のスタッフの数。 */
  dueSoon: number;
  /** 通知に載せる合計。0 なら送らない。 */
  total: number;
}

export interface ResidencyAlertInput {
  ledger: readonly StaffLedgerRow[];
  residency: readonly ResidencyRow[];
  /** 判定の基準日（業務日）。**現在時刻をここで読まない。** */
  businessDate: string;
}

/**
 * 通知に載せる人数を数える。
 *
 * 台帳に無い `staffProfileId` の在留資格は数えない（無効化で台帳から
 * 消えた行の残骸）。`expiresOn` の無い行（日本国籍など）も数えない。
 */
export function countResidencyAlerts(input: ResidencyAlertInput): ResidencyAlertCounts {
  const statusById = new Map(input.ledger.map((row) => [row.id, row.workStatus]));

  let firstNotice = 0;
  let dueSoon = 0;
  for (const record of input.residency) {
    const workStatus = statusById.get(record.staffProfileId);
    if (workStatus === undefined || workStatus === "RESIGNED") continue;
    if (record.expiresOn === null) continue;

    const days = daysUntil(input.businessDate, record.expiresOn);
    if (days === null) continue;

    if (days === RESIDENCY_FIRST_NOTICE_DAYS) firstNotice += 1;
    else if (days <= RESIDENCY_DAILY_NOTICE_DAYS && record.renewalAppliedOn === null) dueSoon += 1;
  }

  return { firstNotice, dueSoon, total: firstNotice + dueSoon };
}
