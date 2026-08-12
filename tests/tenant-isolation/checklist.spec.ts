/**
 * tenant isolation: checklist_template / checklist_item / task_checklist_result
 *
 * task:  docs/tasks/P1-01.md / docs/tasks/P1-06.md
 * ルール: .claude/rules/testing.md §2
 *
 * ── テンプレートの 2 表は施設列で絞らない ───────────────
 * 組織共通テンプレート（`propertyId = null`）が施設スコープロールから
 * 見えなくなると、清掃員のチェックリストが空になる
 * （`repositories/checklist.ts` の冒頭）。よって `propertyColumn` は `null`。
 * **組織条件は全クエリに載る**ことをスイートが確かめる。
 */

import {
  listChecklistResults,
  listTemplateItems,
  listTemplates,
  listTemplatesForProperty,
  type TenantContext,
} from "@pk/db";

import { describeTenantIsolation } from "./isolation-suite.js";

function ownId(ctx: TenantContext, prefix: string): string {
  return `${ctx.orgShortId}__${prefix}_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
}

describeTenantIsolation({
  table: "checklist_template",
  list: (env, ctx) => listTemplates(env, ctx),
  // 施設 ID を取る口（テンプレート候補の列挙）で越境を確かめる。
  findById: (env, ctx, id) => listTemplatesForProperty(env, ctx, id),
  entityPrefix: "prop",
  propertyColumn: null,
});

describeTenantIsolation({
  table: "checklist_item",
  list: (env, ctx) => listTemplateItems(env, ctx, [ownId(ctx, "ctpl")]),
  findById: (env, ctx, id) => listTemplateItems(env, ctx, [id]),
  entityPrefix: "ctpl",
  propertyColumn: null,
});

describeTenantIsolation({
  table: "task_checklist_result",
  list: (env, ctx) => listChecklistResults(env, ctx, ownId(ctx, "task")),
  findById: (env, ctx, id) => listChecklistResults(env, ctx, id),
  entityPrefix: "task",
  propertyColumn: "property_id",
});
