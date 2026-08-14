/**
 * tenant isolation: integration / sync_log / external_mapping
 *
 * task:  docs/tasks/P6-01.md / docs/tasks/P6-04.md
 * ルール: .claude/rules/testing.md §2
 *
 * **他組織の連携が 1 件混ざると、他社の稼働記録が自社の照合へ流れ込む。**
 * PK-SPEC-P6 §8.5 が「他組織の `integrationId` で Webhook を投げると 404」を
 * 受け入れ基準に置いているのはこのため。第 2 パターン（越境 ID → 404）が
 * 直接それに対応する。
 *
 * `integration` は `propertyId` が任意（`null` が組織全体）。施設スコープの
 * 検査は `listIntegrations()` に掛かる。**組織全体の連携は施設スコープロールに
 * 見えない**（見えなさすぎる方向。`listOrgWideIntegrations()` は組織全体
 * ロールの Queue コンシューマから使う）。
 */

import {
  findIntegrationById,
  listExternalMappings,
  listIntegrations,
  listSyncLogs,
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
  table: "integration",
  list: (env, ctx) => listIntegrations(env, ctx, {}),
  findById: (env, ctx, id) => findIntegrationById(env, ctx, id),
  entityPrefix: "intg",
  propertyColumn: "property_id",
});

describeTenantIsolation({
  table: "sync_log",
  list: (env, ctx) => listSyncLogs(env, ctx, { integrationId: ownId(ctx, "intg") }),
  propertyColumn: null,
});

describeTenantIsolation({
  table: "external_mapping",
  list: (env, ctx) => listExternalMappings(env, ctx, { integrationId: ownId(ctx, "intg") }),
  propertyColumn: null,
});
