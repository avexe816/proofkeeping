/**
 * tenant isolation: archive_manifest
 *
 * task:  docs/tasks/P7-08.md
 * ルール: .claude/rules/testing.md §2
 *
 * ── この表が効く理由 ────────────────────────────────────
 * **他組織の行が 1 件混ざると、他社の R2 キーが自社に見える。**
 * `objectKey` は `archive/{orgId}/{year}/{table}.jsonl.gz` で、
 * 復元（P7-09）はこの表を起点に R2 を引く。混ざれば
 * **他社の退避データを復元する経路**になる。
 *
 * ── 施設スコープが掛からない ────────────────────────────
 * `archive_manifest` は `propertyId` 列を持たない。退避は組織 × 年 × 表の
 * 単位で、施設で分けない（§19.7 の R2 キーにも施設が出てこない）。
 * よって第 4 パターンは `propertyColumn: null` として扱う。
 */

import { listArchiveManifests } from "@pk/db";

import { describeTenantIsolation } from "./isolation-suite.js";

describeTenantIsolation({
  table: "archive_manifest",
  list: (env, ctx) => listArchiveManifests(env, ctx),
  propertyColumn: null,
});
