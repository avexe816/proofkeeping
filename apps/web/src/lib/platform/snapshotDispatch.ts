/**
 * テナントのスナップショットの投入（PF-02）。**Cron Trigger の入口。**
 *
 * task:  docs/tasks/PF-02.md
 * ルール: .claude/rules/architecture.md §5
 *
 * ```
 * 02:00 JST（夜間バッチの相乗り）→ 全組織を QUEUE_ROLLUP_UPDATE へ
 *                                ← 読み取りと書き込みはコンシューマ
 * ```
 *
 * ── ここでは 1 テナントも読まない ───────────────────────
 * この関数の仕事は**「組織を数えてキューへ投げる」だけ。**
 * 16 シャードぶんの読み取りを Cron の CPU 予算に載せない
 * （`lib/staff/residencyAlertDispatch.ts` と同じ形）。
 *
 * ── キューも cron も新設しない ──────────────────────────
 * `QUEUE_ROLLUP_UPDATE` に `kind` で相乗りする（DECISIONS #140 / #160）。
 * 新しいキューは 4 環境ぶんの Cloudflare リソース作成が要り、人間を待たせる。
 * 発火も 02:00 JST の回に相乗りさせる（写真の保持期限・照合と同じ）。
 *
 * **運営面のファイルだが、`getPlatformDb()` を呼ばない。** ここが触るのは
 * 全局の組織レジストリとキューだけで、運営の表はコンシューマが書く。
 */

import { listOrganizationDirectory, type Env } from "@pk/db";

import type { TenantSnapshotMessage } from "../../consumers/tenantSnapshot.js";

/**
 * 1 回の cron で扱う組織数の上限。
 *
 * `lib/staff/residencyAlertDispatch.ts` と同じ値・同じ理由（CPU 予算への歯止め）。
 */
export const TENANT_SNAPSHOT_ORGANIZATION_LIMIT = 200;

/** バッチの結果。**件数だけ。組織 ID を返さない**（ログに載せないため）。 */
export interface TenantSnapshotDispatchResult {
  organizations: number;
  queued: number;
  /** 投入に失敗した組織の数。0 でなければ調査が要る。 */
  failedOrganizations: number;
  /** 組織数が上限に達したか。真なら取りこぼしている可能性がある。 */
  truncated: boolean;
}

/**
 * 全組織のスナップショット更新をキューへ投げる。
 *
 * @param now cron の発火時刻。**この関数の中で `Date.now()` を呼ばない。**
 */
export async function dispatchTenantSnapshots(
  env: Env,
  now: Date,
): Promise<TenantSnapshotDispatchResult> {
  const organizations = await listOrganizationDirectory(env, TENANT_SNAPSHOT_ORGANIZATION_LIMIT);

  const result: TenantSnapshotDispatchResult = {
    organizations: organizations.length,
    queued: 0,
    failedOrganizations: 0,
    truncated: organizations.length >= TENANT_SNAPSHOT_ORGANIZATION_LIMIT,
  };

  for (const organization of organizations) {
    const message: TenantSnapshotMessage = {
      kind: "TENANT_SNAPSHOT",
      orgShortId: organization.orgShortId,
      // **メッセージが時刻を持つ。** 再送で payload が変わらないようにする。
      requestedAtMs: now.getTime(),
    };
    try {
      await env.QUEUE_ROLLUP_UPDATE.send(message);
      result.queued += 1;
    } catch {
      // 1 組織で落ちても残りを止めない（`residencyAlertDispatch.ts` と同じ判断）。
      result.failedOrganizations += 1;
    }
  }

  return result;
}
