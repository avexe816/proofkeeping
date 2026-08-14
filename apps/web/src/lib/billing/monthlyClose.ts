/**
 * 月次締めの自動起票（PK-SPEC-P5 §6.1）。**Cron Trigger の入口。**
 *
 * task:  docs/tasks/P5-05.md
 * ルール: .claude/rules/architecture.md §5 / .claude/rules/testing.md §4
 *
 * ```
 * 毎月 1 日 04:00 Asia/Tokyo  取引先ごとに「直近に締まった期間」の
 *                            billing_period を用意し、OPEN → REVIEWING
 * ```
 *
 * ── ここで金額を出さない ────────────────────────────────
 * §2.8 の `billing_period` に小計・税額の列は無い。集計した金額を
 * 置く先が無いので、**このバッチは期間の確定と状態遷移だけ**を行い、
 * 金額は画面と発行のたびに `buildInvoiceDraft()` が出す
 * （docs/DECISIONS.md #124）。ここで集計すると、捨てる数字のために
 * Cron の CPU 予算を使い切ることになる。
 *
 * ── 二重投入を怖がらない ────────────────────────────────
 * `ensureBillingPeriod()` が `uq_period` で 1 行に定め、状態は
 * 「`OPEN` のときだけ進める」楽観ロックで進む。**3 回走らせても
 * 結果が変わらない**（testing.md §4）。
 *
 * ── セッションを持たない経路 ────────────────────────────
 * `lib/report/dispatch.ts` と同じ形（OPEN_QUESTIONS #033）。組織の
 * 一覧は SHARD_00 の `org_directory` から取り、組織ごとに文脈を組む。
 */

import { closedPeriodAsOf, evaluateBillingPeriodTransition } from "@pk/billing";
import {
  ensureBillingPeriod,
  listCounterparties,
  listOrganizationDirectory,
  updateBillingPeriodStatus,
  type Env,
  type TenantContext,
} from "@pk/db";

import { businessDateOf } from "../businessDate.js";

/**
 * 月次締めの cron 式。**wrangler.toml の `[triggers]` と一字一句同じであること。**
 *
 * ── なぜ 28〜31 日なのか ────────────────────────────────
 * 走らせたいのは **1 日 04:00 Asia/Tokyo**。cron は UTC 指定なので
 * 前日の 19:00 UTC にあたる（`0 19`）。「前日」は月末日なので
 * 28・29・30・31 のいずれか。cron に「月末」を表す書き方は無いため
 * 4 日ぶん並べ、**本当に JST の 1 日かはハンドラが確かめる**
 * （`isMonthlyCloseMoment()`）。
 *
 * 毎日 1 回に広げると 1 か月に 30 回空振りする。ここを 4 回に抑える
 * ためだけの範囲指定で、判定の正しさは cron 式ではなくハンドラが持つ。
 */
export const MONTHLY_CLOSE_CRON = "0 19 28-31 * *";

/** 締めを起票する現地時刻の基準（§6.1「毎月 1 日 04:00」）。 */
export const MONTHLY_CLOSE_TIMEZONE = "Asia/Tokyo";

/**
 * 1 回の cron で扱う組織数の上限。
 *
 * `lib/report/dispatch.ts` と同じ値・同じ理由（Cron の CPU 予算に対する歯止め）。
 */
export const MONTHLY_CLOSE_ORGANIZATION_LIMIT = 200;

/** バッチの結果。**件数だけ。組織 ID を返さない**（ログに載せないため）。 */
export interface MonthlyCloseResult {
  organizations: number;
  /** 新しく起票した期間の数。 */
  created: number;
  /** `OPEN → REVIEWING` へ進めた期間の数。 */
  aggregated: number;
  /** 失敗した組織の数。0 でなければ調査が要る。 */
  failedOrganizations: number;
  /** 組織数が上限に達したか。真なら取りこぼしている可能性がある。 */
  truncated: boolean;
}

/**
 * その瞬間が「月の 1 日」か（現地時刻）。
 *
 * cron 式（`0 19 28-31 * *`）は UTC の月末を撃つだけなので、
 * **JST に直して 1 日かどうかをここで確かめる。** 月末が 30 日の月では
 * 31 日の回が発火しない一方、31 日ある月では 30 日の回も発火する。
 * この関数が無いと、締めが 1 日早く走る。
 *
 * 日締め時刻は見ない。§6.1 の「1 日 04:00」は暦日の 1 日であって
 * 業務日ではない（`dayCutoffTime` は施設ごとに違い、取引先の締めと
 * 対応しない）。
 */
export function isMonthlyCloseMoment(now: Date): boolean {
  return businessDateOf(now, MONTHLY_CLOSE_TIMEZONE, "00:00").endsWith("-01");
}

/**
 * 取引先ごとに直近に締まった期間を起票し、`REVIEWING` へ進める。
 *
 * @param now cron の発火時刻。**この関数の中で `Date.now()` を呼ばない**
 *   （テストから時刻を固定できるようにする / CLAUDE.md §5）。
 */
export async function runMonthlyClose(env: Env, now: Date): Promise<MonthlyCloseResult> {
  const organizations = await listOrganizationDirectory(env, MONTHLY_CLOSE_ORGANIZATION_LIMIT);

  const result: MonthlyCloseResult = {
    organizations: organizations.length,
    created: 0,
    aggregated: 0,
    failedOrganizations: 0,
    truncated: organizations.length >= MONTHLY_CLOSE_ORGANIZATION_LIMIT,
  };

  // 現地時刻の暦日。取引先の締め日と突き合わせる基準になる。
  const onDate = businessDateOf(now, MONTHLY_CLOSE_TIMEZONE, "00:00");

  for (const organization of organizations) {
    const ctx: TenantContext = {
      organizationId: organization.organizationId,
      orgShortId: organization.orgShortId,
      role: "ORG_ADMIN",
      allowedPropertyIds: [],
      now,
    };

    try {
      // **無効化した取引先は締めない。** 取引を終えた相手に請求の
      // 下書きを作り続けない（`isActive` の意味 / §2.1）。
      const counterparties = await listCounterparties(env, ctx, { isActive: true });

      for (const counterparty of counterparties) {
        const range = closedPeriodAsOf(counterparty.closingDay, onDate);

        const ensured = await ensureBillingPeriod(env, ctx, {
          counterpartyId: counterparty.id,
          ...range,
        });
        if (ensured.created) result.created += 1;

        // **`OPEN` のときだけ進む。** 既に確認中・合意済み・請求済みの
        // 期間を巻き戻さない（§2.8 の注記）。状態機械を通してから
        // 楽観ロック付きで書く。
        const transition = evaluateBillingPeriodTransition("OPEN", "AGGREGATE");
        if (!transition.allowed) continue;

        const changed = await updateBillingPeriodStatus(
          env,
          ctx,
          ensured.id,
          { status: transition.next, aggregatedAt: now },
          "OPEN",
        );
        result.aggregated += changed;
      }
    } catch {
      // **1 組織の失敗で他組織を止めない。** 例外の中身はログに出さない
      // （組織 ID・シャード番号を出さない / architecture.md §1）。
      result.failedOrganizations += 1;
    }
  }

  return result;
}
