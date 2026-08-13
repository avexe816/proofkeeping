/**
 * ベースライン週次バッチの投入（PK-SPEC-P3 §5.1）。**Cron Trigger の入口。**
 *
 * task:  docs/tasks/P3-09.md
 * ルール: .claude/rules/architecture.md §5
 *
 * ```
 * 毎週日曜 03:00 JST → 全組織・全アクティブ施設を QUEUE_BASELINE_LEARNING へ
 *                     ← 統計量を出して書くのはコンシューマ
 * ```
 *
 * ── ここでは計算しない ──────────────────────────────────
 * `lib/report/dispatch.ts` と同じ形。この関数の仕事は
 * **「施設を数えてキューへ投げる」だけ。** 90 日ぶんの観察を読む処理を
 * Cron の CPU 予算に載せない（architecture.md §5）。
 *
 * ── セッションを持たない経路 ────────────────────────────
 * 組織の一覧は SHARD_00 の `org_directory` から取り、組織ごとに文脈を
 * 組み立てる（OPEN_QUESTIONS #033）。
 *
 * ── 二重投入を怖がらない ────────────────────────────────
 * コンシューマは再計算方式で、同じメッセージを 3 回処理しても
 * 行数も値も変わらない（testing.md §4 / `repositories/baseline.ts`）。
 */

import {
  listOrganizationDirectory,
  listProperties,
  type Env,
  type TenantContext,
} from "@pk/db";

import type { BaselineLearningMessage } from "../../consumers/baselineLearning.js";
import { businessDateOf, previousBusinessDate } from "../businessDate.js";

import { DEFAULT_BASELINE_WINDOW_DAYS } from "./window.js";

/**
 * ベースライン週次バッチの cron 式。
 * **wrangler.toml の `[triggers]` と一字一句同じであること。**
 *
 * §5.1 は「毎週日曜 03:00 JST」。cron は UTC 指定なので**土曜 18:00 UTC**。
 * 日本は夏時間を採らないので固定のオフセットで足りる。
 * ここと wrangler.toml がずれると、**別の cron の回でこのバッチが走る**
 * （`scheduled()` は式の文字列で振り分ける）。
 */
export const BASELINE_LEARNING_CRON = "0 18 * * 6";

/** 1 回の cron で扱う組織数の上限（`lib/report/dispatch.ts` と同じ値・同じ理由）。 */
export const BASELINE_ORGANIZATION_LIMIT = 200;

/** バッチの結果。**件数だけ。組織 ID を返さない**（ログに載せないため）。 */
export interface BaselineDispatchResult {
  organizations: number;
  /** キューへ投げた施設の数。 */
  queued: number;
  /** 投入に失敗した組織の数。0 でなければ調査が要る。 */
  failedOrganizations: number;
  /** 組織数が上限に達したか。真なら取りこぼしている可能性がある。 */
  truncated: boolean;
}

/**
 * 全施設のベースライン再計算をキューへ投げる。
 *
 * ── ウィンドウ終端は「前の業務日」────────────────────────
 * 03:00 は多くの施設で日締め（既定 05:00）より前なので、その瞬間の
 * 業務日は**まだ終わっていない。** 途中の日を終端にすると、走った時刻
 * によって最終日のサンプル数が変わる（決定性が崩れる / §9.3）。
 * 施設のタイムゾーンと日締めから業務日を出し、1 日戻した日を終端にする。
 *
 * @param now cron の発火時刻。**この関数の中で `Date.now()` を呼ばない**
 *   （テストから時刻を固定できるようにする / CLAUDE.md §5）。
 */
export async function dispatchBaselineLearning(
  env: Env,
  now: Date,
): Promise<BaselineDispatchResult> {
  const organizations = await listOrganizationDirectory(env, BASELINE_ORGANIZATION_LIMIT);

  const result: BaselineDispatchResult = {
    organizations: organizations.length,
    queued: 0,
    failedOrganizations: 0,
    truncated: organizations.length >= BASELINE_ORGANIZATION_LIMIT,
  };

  for (const organization of organizations) {
    const ctx: TenantContext = {
      organizationId: organization.organizationId,
      orgShortId: organization.orgShortId,
      role: "ORG_ADMIN",
      allowedPropertyIds: [],
      now,
    };

    try {
      const properties = await listProperties(env, ctx, { isActive: true });
      for (const property of properties) {
        const message: BaselineLearningMessage = {
          kind: "BASELINE_LEARNING",
          organizationId: organization.organizationId,
          orgShortId: organization.orgShortId,
          propertyId: property.id,
          computedTo: previousBusinessDate(
            businessDateOf(now, property.timezone, property.dayCutoffTime),
          ),
          windowDays: DEFAULT_BASELINE_WINDOW_DAYS,
          mode: "AUTO",
          requestedById: null,
          // **メッセージが時刻を持つ。** 再送で payload が変わらないようにする。
          requestedAtMs: now.getTime(),
        };
        await env.QUEUE_BASELINE_LEARNING.send(message);
        result.queued += 1;
      }
    } catch {
      // 1 組織で落ちても残りを止めない（`lib/report/dispatch.ts` と同じ判断）。
      result.failedOrganizations += 1;
    }
  }

  return result;
}
