/**
 * 在留資格アラートの投入（P8-02 / PK-SPEC-P8 §1.4）。**Cron Trigger の入口。**
 *
 * task:  docs/tasks/P8-02.md
 * ルール: .claude/rules/architecture.md §5
 *
 * ```
 * 毎日 07:00 JST（RESIDENCY_ALERT_CRON）→ 全組織を QUEUE_NOTIFICATION へ
 *                                       ← 判定と通知はコンシューマ
 * ```
 *
 * ── ここでは判定しない ──────────────────────────────────
 * この関数の仕事は**「組織を数えてキューへ投げる」だけ。**
 * 台帳と在留資格の読み取りを Cron の CPU 予算に載せない
 * （`lib/photo/retentionDispatch.ts` と同じ形）。
 *
 * ── 8 本目のキューを作らない ────────────────────────────
 * `QUEUE_NOTIFICATION` に `kind` で相乗りする（DECISIONS #140 の判断を
 * 踏襲）。新しいキューは 4 環境ぶんの Cloudflare リソース作成が要る。
 */

import { listOrganizationDirectory, type Env } from "@pk/db";

import type { ResidencyAlertMessage } from "../../consumers/residencyAlert.js";

/**
 * 1 回の cron で扱う組織数の上限。
 *
 * `lib/photo/retentionDispatch.ts` と同じ値・同じ理由（CPU 予算への歯止め）。
 */
export const RESIDENCY_ALERT_ORGANIZATION_LIMIT = 200;

/** バッチの結果。**件数だけ。組織 ID を返さない**（ログに載せないため）。 */
export interface ResidencyAlertDispatchResult {
  organizations: number;
  queued: number;
  /** 投入に失敗した組織の数。0 でなければ調査が要る。 */
  failedOrganizations: number;
  /** 組織数が上限に達したか。真なら取りこぼしている可能性がある。 */
  truncated: boolean;
}

/**
 * 全組織の在留資格アラートをキューへ投げる。
 *
 * @param now cron の発火時刻。**この関数の中で `Date.now()` を呼ばない。**
 */
export async function dispatchResidencyAlerts(
  env: Env,
  now: Date,
): Promise<ResidencyAlertDispatchResult> {
  const organizations = await listOrganizationDirectory(env, RESIDENCY_ALERT_ORGANIZATION_LIMIT);

  const result: ResidencyAlertDispatchResult = {
    organizations: organizations.length,
    queued: 0,
    failedOrganizations: 0,
    truncated: organizations.length >= RESIDENCY_ALERT_ORGANIZATION_LIMIT,
  };

  for (const organization of organizations) {
    const message: ResidencyAlertMessage = {
      kind: "RESIDENCY_ALERT",
      orgShortId: organization.orgShortId,
      // **メッセージが時刻を持つ。** 再送で payload が変わらないようにする。
      requestedAtMs: now.getTime(),
    };
    try {
      await env.QUEUE_NOTIFICATION.send(message);
      result.queued += 1;
    } catch {
      // 1 組織で落ちても残りを止めない（`retentionDispatch.ts` と同じ判断）。
      result.failedOrganizations += 1;
    }
  }

  return result;
}
