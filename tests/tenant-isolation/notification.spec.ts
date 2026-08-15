/**
 * tenant isolation: notification_preference / push_subscription
 *
 * task:  docs/tasks/P6-09.md
 * ルール: .claude/rules/testing.md §2
 *
 * ── なぜこの 2 表が効くのか ─────────────────────────────
 * **他組織の行が 1 件混ざると、その組織の人へ通知が飛ぶ。** 本文は
 * 件名と 1 行要約だけ（ui-writing.md §6）だが、それでも
 * 「どこかの施設で CRITICAL の不具合が起きた」という事実が
 * 別の会社へ渡る。`push_subscription` に至っては、他社の端末の
 * 宛先（`endpoint` / `p256dh`）を引ける状態そのものが漏洩になる。
 *
 * ── 施設スコープが掛からない ────────────────────────────
 * どちらの表も施設の列を持たない（PK-SPEC-P6 §2.4 / §2.5）。宛先は
 * `membership` に紐づき、施設で絞るのは**宛先を引く側**
 * （`listNotificationRecipients()` が `property_assignment` を起点にする）。
 * したがって第 4 パターン（施設スコープロールが担当外を取得できない）は
 * `propertyColumn: null` として扱う。
 *
 * P6-01 の `integration.spec.ts` が `integration` / `sync_log` /
 * `external_mapping` を見ている。**この 2 表はそこに無かった**（読み書きの
 * 経路が P6-09 まで無かったため）。
 */

import {
  listDeliverablePushMembershipIds,
  listNotificationPreferences,
  type TenantContext,
} from "@pk/db";

import { describeTenantIsolation } from "./isolation-suite.js";

/**
 * その文脈の組織に属する ID。**別組織の ID を渡すと第 2 層が先に落とす。**
 *
 * 理由は `occupancy.spec.ts` の同名関数と同じ。
 */
function ownId(ctx: TenantContext, prefix: string): string {
  return `${ctx.orgShortId}__${prefix}_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
}

describeTenantIsolation({
  table: "notification_preference",
  list: (env, ctx) =>
    listNotificationPreferences(env, ctx, {
      membershipIds: [ownId(ctx, "mem")],
      eventCode: "issue.critical",
    }),
  propertyColumn: null,
});

describeTenantIsolation({
  table: "push_subscription",
  list: (env, ctx) => listDeliverablePushMembershipIds(env, ctx, [ownId(ctx, "mem")]),
  propertyColumn: null,
});
