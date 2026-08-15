/**
 * 年次アーカイブの投入（PK-SPEC-P0 §19.7）。**Cron Trigger の入口。**
 *
 * task:  docs/tasks/P7-08.md
 * ルール: .claude/rules/architecture.md §5
 *
 * ```
 * 毎年 2 月 1 日 04:00 JST → 全組織 × 対象年を QUEUE_ARCHIVE_RESTORE へ
 *                            ← 書き出すのはコンシューマ（consumers/archive.ts）
 * ```
 *
 * ── なぜ cron を増やさないのか ──────────────────────────
 * §19.7 は「年次で実行する」と書くだけで時刻を定めていない。
 * **月次締めの cron（`0 19 28-31 * *`）に相乗りさせ、1 月かどうかを
 * ハンドラで見る。** 5 本目の cron を足すと 4 環境ぶんの
 * `[triggers]` 変更が要り、Cloudflare の cron 上限にも近づく
 * （DECISIONS #160）。判定の正しさは cron 式ではなくここが持つ。
 *
 * ── なぜ 1 月ではなく 2 月なのか ────────────────────────
 * 退避の下限は 13 か月（`archiveCutoffBusinessDate()`）。2 月 1 日に
 * 走らせると境界は前年の 1 月 1 日で、**2 年前の 1 年ぶんが丸ごと
 * 対象に収まる。** 1 月 1 日に走らせると境界が 2 年前の 12 月 1 日に
 * なり、対象年の 12 月だけが翌年へ持ち越される。
 *
 * ── ここでは書き出さない ────────────────────────────────
 * `lib/baseline/dispatch.ts` と同じ形。この関数の仕事は
 * **「組織を数えてキューへ投げる」だけ。** 表 5 本ぶんの全行読み取りと
 * gzip を Cron の CPU 予算に載せない（architecture.md §5）。
 *
 * ── 二重投入を怖がらない ────────────────────────────────
 * コンシューマは同じキーへ上書きし、`archive_manifest` は
 * `uq_archive_manifest` で 1 行のまま（testing.md §4）。
 */

import { listOrganizationDirectory, type Env } from "@pk/db";

import type { ArchiveExportMessage } from "../../consumers/archive.js";
import { businessDateOf } from "../businessDate.js";

/** 年次アーカイブを起動する現地時刻の基準。 */
export const ARCHIVE_DISPATCH_TIMEZONE = "Asia/Tokyo";

/**
 * 1 回の cron で扱う組織数の上限。
 *
 * `lib/billing/monthlyClose.ts` と同じ値・同じ理由（Cron の CPU 予算に対する歯止め）。
 */
export const ARCHIVE_ORGANIZATION_LIMIT = 200;

/**
 * いま年次アーカイブを走らせる回か。**2 月 1 日（JST）だけ真。**
 *
 * 月次締めと同じ cron に相乗りしているので、**月次締めの回すべてで
 * 呼ばれる。** ここが偽なら何もしない。
 */
export function isArchiveDispatchMoment(now: Date): boolean {
  return businessDateOf(now, ARCHIVE_DISPATCH_TIMEZONE, "00:00").endsWith("-02-01");
}

/**
 * 退避する対象年。**実行する年の 2 年前。**
 *
 * 2026 年 2 月に走らせると 2024 年ぶんを退避する。2025 年ぶんは
 * まだ 13 か月に届かない月があるので、翌年に回す（`runArchiveExport()` が
 * `WITHIN_RETENTION` で弾く形にもなっている）。
 */
export function archiveTargetYear(now: Date): number {
  return Number(businessDateOf(now, ARCHIVE_DISPATCH_TIMEZONE, "00:00").slice(0, 4)) - 2;
}

/** バッチの結果。**件数だけ。組織 ID を返さない**（ログに載せないため）。 */
export interface ArchiveDispatchResult {
  organizations: number;
  /** 退避する年。 */
  year: number;
  /** キューへ投げた組織の数。 */
  queued: number;
  /** 投入に失敗した組織の数。0 でなければ調査が要る。 */
  failedOrganizations: number;
  /** 組織数が上限に達したか。真なら取りこぼしている可能性がある。 */
  truncated: boolean;
}

/**
 * 全組織の年次アーカイブをキューへ投げる。
 *
 * @param now cron の発火時刻。**この関数の中で `Date.now()` を呼ばない**
 *   （テストから時刻を固定できるようにする / CLAUDE.md §5）。
 */
export async function dispatchArchiveExport(
  env: Env,
  now: Date,
): Promise<ArchiveDispatchResult> {
  const organizations = await listOrganizationDirectory(env, ARCHIVE_ORGANIZATION_LIMIT);
  const year = archiveTargetYear(now);

  const result: ArchiveDispatchResult = {
    organizations: organizations.length,
    year,
    queued: 0,
    failedOrganizations: 0,
    truncated: organizations.length >= ARCHIVE_ORGANIZATION_LIMIT,
  };

  for (const organization of organizations) {
    const message: ArchiveExportMessage = {
      kind: "ARCHIVE_EXPORT",
      orgShortId: organization.orgShortId,
      year,
      // **メッセージが時刻を持つ。** 再送で payload が変わらないようにする。
      requestedAtMs: now.getTime(),
    };
    try {
      await env.QUEUE_ARCHIVE_RESTORE.send(message);
      result.queued += 1;
    } catch {
      // 1 組織で落ちても残りを止めない（`lib/baseline/dispatch.ts` と同じ判断）。
      result.failedOrganizations += 1;
    }
  }

  return result;
}
