/**
 * 夜間の照合バッチの投入（PK-SPEC-P4 §5.1）。**Cron Trigger の入口。**
 *
 * task:  docs/tasks/P4-05.md
 * ルール: .claude/rules/architecture.md §5
 *
 * ```
 * 毎日 02:00 JST → 全組織・全アクティブ施設を QUEUE_RECONCILIATION へ
 *                 ← 3 系統を突き合わせるのはコンシューマ
 * ```
 *
 * ── ここでは照合しない ──────────────────────────────────
 * `lib/baseline/dispatch.ts` と同じ形。この関数の仕事は**「施設を数えて
 * キューへ投げる」だけ。** 客室数 × 3 系統の読み込みを Cron の CPU 予算に
 * 載せない（architecture.md §5）。
 *
 * ── cron 式を新設しない ─────────────────────────────────
 * §5.1 の 02:00 JST は、既にある**タスク自動生成（P1-03）と同じ時刻**。
 * cron を 1 本足すのではなく、`0 17 * * *` の回で 2 つを続けて走らせる
 * （DECISIONS #113）。無料枠は 5 本で、同じ時刻に 2 本置いても分けられない。
 *
 * ── 対象の業務日 ────────────────────────────────────────
 * §5.1 は「施設の日締め時刻 + 21 時間」。既定（05:00）の施設では、
 * 02:00 の時点で**まだ閉じていない当日**が 21 時間目にあたる。清掃も検査も
 * 終わっている時刻なので、**当日の業務日**を照合する。取込が遅れて届いた
 * ぶんは翌日以降の再実行が差分として拾う（§5.3 MUST）。
 */

import {
  listOrganizationDirectory,
  listProperties,
  type Env,
  type TenantContext,
} from "@pk/db";

import type { ReconciliationMessage } from "../../consumers/reconciliation.js";
import { businessDateOf } from "../businessDate.js";

/**
 * 照合バッチの cron 式。**タスク自動生成（P1-03）と同じ回に相乗りする。**
 *
 * `wrangler.toml` の `[triggers]` に**この式は既にある。** 本数を増やさない
 * こと（無料枠 5 本 / DECISIONS #113）。`scheduled()` はこの式の回で
 * タスク生成と照合の両方を走らせる。
 */
export const RECONCILIATION_CRON = "0 17 * * *";

/** 1 回の cron で扱う組織数の上限（`lib/baseline/dispatch.ts` と同じ値・同じ理由）。 */
export const RECONCILIATION_ORGANIZATION_LIMIT = 200;

/** バッチの結果。**件数だけ。組織 ID を返さない**（ログに載せないため）。 */
export interface ReconciliationDispatchResult {
  organizations: number;
  /** キューへ投げた施設の数。 */
  queued: number;
  /** 投入に失敗した組織の数。0 でなければ調査が要る。 */
  failedOrganizations: number;
  /** 組織数が上限に達したか。真なら取りこぼしている可能性がある。 */
  truncated: boolean;
}

/**
 * 全施設の照合をキューへ投げる。
 *
 * @param now cron の発火時刻。**この関数の中で `Date.now()` を呼ばない**
 *   （テストから時刻を固定できるようにする / CLAUDE.md §5）。
 */
export async function dispatchReconciliation(
  env: Env,
  now: Date,
): Promise<ReconciliationDispatchResult> {
  const organizations = await listOrganizationDirectory(env, RECONCILIATION_ORGANIZATION_LIMIT);

  const result: ReconciliationDispatchResult = {
    organizations: organizations.length,
    queued: 0,
    failedOrganizations: 0,
    truncated: organizations.length >= RECONCILIATION_ORGANIZATION_LIMIT,
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
        const message: ReconciliationMessage = {
          kind: "RECONCILIATION",
          organizationId: organization.organizationId,
          orgShortId: organization.orgShortId,
          propertyId: property.id,
          businessDate: businessDateOf(now, property.timezone, property.dayCutoffTime),
          mode: "AUTO",
          requestedById: null,
          // **メッセージが時刻を持つ。** 再送で payload が変わらないようにする。
          requestedAtMs: now.getTime(),
        };
        await env.QUEUE_RECONCILIATION.send(message);
        result.queued += 1;
      }
    } catch {
      // 1 組織で落ちても残りを止めない（`lib/baseline/dispatch.ts` と同じ判断）。
      result.failedOrganizations += 1;
    }
  }

  return result;
}
