/**
 * tenant isolation: archive_restore / archive_restore_row
 *
 * task:  docs/tasks/P7-09.md
 * ルール: .claude/rules/testing.md §2
 *
 * ── この表が効く理由 ────────────────────────────────────
 * **復元した写しは 13 か月以上前の記録そのもの。** 他組織の行が 1 件でも
 * 混ざると、他社の清掃記録・観察記録が画面にそのまま出る
 * （`payload` は JSONL の 1 行を丸ごと持つ）。
 *
 * 起票の側（`archive_restore`）が混ざると、**他社の復元を自社の
 * 「同時実行 1 件」に数えてしまい**、正当な復元が拒まれる（§9.2）。
 *
 * ── 施設スコープが掛からない ────────────────────────────
 * `archive_restore` は `propertyId` 列を持つが、これは**絞り込みの条件**
 * であって権限のスコープではない。復元を要求できるのは `OWNER` /
 * `ORG_ADMIN` だけで（`permission.ts` の `archive.restore`）、
 * どちらも組織全体ロール。よって第 4 パターンは `propertyColumn: null`。
 */

import { listArchiveRestoreRows, listArchiveRestores } from "@pk/db";

import { describeTenantIsolation } from "./isolation-suite.js";

describeTenantIsolation({
  table: "archive_restore",
  list: (env, ctx) => listArchiveRestores(env, ctx),
  propertyColumn: null,
});

describeTenantIsolation({
  table: "archive_restore_row",
  list: (env, ctx) =>
    listArchiveRestoreRows(env, ctx, { restoreId: `${ctx.orgShortId}__arst_01JBXQ3ZK8N4P2VYR6ABCDEFGH` }),
  propertyColumn: null,
});
