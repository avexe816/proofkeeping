/**
 * topbar の通知バッジの件数（PK-SPEC-UI-A01 §3.2）。
 *
 * 参照: ui-prototypes/owner/pkown-v3-A-login-daily.html（`.bell` / `.bd3`）
 *
 * ── 数えるのは HIGH と MEDIUM の未対応だけ ──────────────
 * A01 §3.2 の規定は 4 行しかない。「HIGH・MEDIUM を含める」「LOW を
 * 含めない」「99 件超は 99+」「0 件はバッジを出さない」。
 * プロトタイプの鈴も同じで、押すと差異の一覧が出る。
 * **鈴のための新しい入れ物（通知テーブル・既読管理）を作らない。**
 * 数える対象は既にある差異レポートで足りる。
 *
 * ── 読めない相手には `null` を返す ──────────────────────
 * `CLEANER` / `INSPECTOR` は差異レポートに到達できない
 * （security.md §1 / 到達したら 404）。**件数も同じ扱いにする。**
 * 「4 件あります」とだけ見えるのは、存在を示唆する 403 と変わらない。
 * **0 と `null` を混ぜないこと。** 0 は「読めるが未対応が無い」で
 * 鈴は出る。`null` は「そもそも鈴を出さない」。
 */

import { countFindingsByStatus, type Env, type TenantContext } from "@pk/db";

import { ORGANIZATION_TARGET, can, propertyTarget } from "../auth/permission.js";

/** 未対応とみなす状態。`lib/dashboard/org.ts` の「要対応」と同じ。 */
const OPEN_FINDING_STATUSES = ["OPEN", "REVIEWING"] as const;

/** バッジに出す上限。これを超えたら表示は `99+`（A01 §3.2）。 */
export const NOTIFICATION_BADGE_CAP = 99;

/**
 * バッジの表示（A01 §3.2）。**0 件は `null`**（バッジを出さない）。
 *
 * 数の丸めを描画側に置かない。**「0 は出さない」と「99+」は同じ規定の
 * 2 行**なので、離すと片方だけ直る。
 */
export function formatNotificationBadge(count: number): string | null {
  if (count <= 0) return null;
  return count > NOTIFICATION_BADGE_CAP ? `${String(NOTIFICATION_BADGE_CAP)}+` : String(count);
}

/**
 * 通知バッジの件数を数える。**権限が無ければ `null`（鈴ごと出さない）。**
 *
 * `propertyId` は topbar が表示している施設。全社表示（`null`）なら
 * 組織全体を数える（リポジトリが施設スコープを掛けるので、施設
 * スコープのロールは担当施設ぶんしか返らない）。
 *
 * **期間で絞らない。** 先月に出た未対応の差異が鈴から消えてはいけない
 * （`lib/dashboard/org.ts` と同じ判断）。
 */
export async function countNotificationBadge(
  env: Env,
  ctx: TenantContext,
  propertyId: string | null,
): Promise<number | null> {
  const target = propertyId === null ? ORGANIZATION_TARGET : propertyTarget([propertyId]);
  // 全社を読めないロールに `ORGANIZATION_TARGET` を当てると false になる。
  // 施設が 1 つも選べていない状態なので、鈴を出さないのが正しい。
  if (!can(ctx, "finding.read", target)) return null;

  const counts = await countFindingsByStatus(env, ctx, {
    propertyId: propertyId ?? undefined,
    severity: ["HIGH", "MEDIUM"],
  });

  return OPEN_FINDING_STATUSES.reduce((sum, status) => sum + (counts.get(status) ?? 0), 0);
}
