/**
 * 写真の保持期間管理の投入（PK-SPEC-P7 §4.5）。**Cron Trigger の入口。**
 *
 * task:  docs/tasks/P7-10.md
 * ルール: .claude/rules/architecture.md §5
 *
 * ```
 * 毎日 02:00 JST（夜間の回に相乗り）→ 全組織を QUEUE_ARCHIVE_RESTORE へ
 *                                    ← 消すのはコンシューマ
 * ```
 *
 * ── cron を増やさない ───────────────────────────────────
 * §4.5 は「日次バッチ」とだけ書き、時刻を定めていない。夜間の回
 * （`0 17 * * *` / タスク生成と稼働照合が走る）に相乗りさせる。
 * DECISIONS #160（年次アーカイブを月次締めに相乗りさせた）と同じ判断。
 *
 * ── ここでは消さない ────────────────────────────────────
 * この関数の仕事は**「組織を数えてキューへ投げる」だけ。**
 * 4 表ぶんの走査と R2 の削除を Cron の CPU 予算に載せない（§5）。
 *
 * ── 版数をここで読む ────────────────────────────────────
 * 保持期間の既定は版数で決まる（`retention.ts`）。**版数が引けない組織は
 * 投げない。** 「引けないから既定の 6 か月」にすると、上位プランの組織の
 * 写真を 7 か月早く消しうる。**消すのは取り返しがつかない。**
 */

import { listOrganizationDirectory, findSubscription, type Env, type TenantContext } from "@pk/db";

import type { PhotoRetentionMessage } from "../../consumers/photoRetention.js";

/**
 * 1 回の cron で扱う組織数の上限。
 *
 * `lib/billing/monthlyClose.ts` と同じ値・同じ理由（Cron の CPU 予算に対する歯止め）。
 */
export const PHOTO_RETENTION_ORGANIZATION_LIMIT = 200;

/** バッチの結果。**件数だけ。組織 ID を返さない**（ログに載せないため）。 */
export interface PhotoRetentionDispatchResult {
  organizations: number;
  /** キューへ投げた組織の数。 */
  queued: number;
  /** **版数が引けなかった組織の数。** この組織の写真はこの回で消えない。 */
  skippedNoPlan: number;
  /** 投入に失敗した組織の数。0 でなければ調査が要る。 */
  failedOrganizations: number;
  /** 組織数が上限に達したか。真なら取りこぼしている可能性がある。 */
  truncated: boolean;
}

/**
 * 全組織の保持期間管理をキューへ投げる。
 *
 * @param now cron の発火時刻。**この関数の中で `Date.now()` を呼ばない**
 *   （テストから時刻を固定できるようにする / CLAUDE.md §5）。
 */
export async function dispatchPhotoRetention(
  env: Env,
  now: Date,
): Promise<PhotoRetentionDispatchResult> {
  const organizations = await listOrganizationDirectory(env, PHOTO_RETENTION_ORGANIZATION_LIMIT);

  const result: PhotoRetentionDispatchResult = {
    organizations: organizations.length,
    queued: 0,
    skippedNoPlan: 0,
    failedOrganizations: 0,
    truncated: organizations.length >= PHOTO_RETENTION_ORGANIZATION_LIMIT,
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
      const subscription = await findSubscription(env, ctx);
      // **版数が引けなければ投げない**（冒頭の注記）。
      if (subscription === undefined) {
        result.skippedNoPlan += 1;
        continue;
      }

      const message: PhotoRetentionMessage = {
        kind: "PHOTO_RETENTION",
        orgShortId: organization.orgShortId,
        plan: subscription.plan,
        // **メッセージが時刻を持つ。** 再送で payload が変わらないようにする。
        requestedAtMs: now.getTime(),
      };
      await env.QUEUE_ARCHIVE_RESTORE.send(message);
      result.queued += 1;
    } catch {
      // 1 組織で落ちても残りを止めない（`lib/baseline/dispatch.ts` と同じ判断）。
      result.failedOrganizations += 1;
    }
  }

  return result;
}
