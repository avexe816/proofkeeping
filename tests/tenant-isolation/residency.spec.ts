/**
 * tenant isolation: residency_record
 *
 * task:  docs/tasks/P8-02.md
 * ルール: .claude/rules/testing.md §2 / .claude/rules/security.md §3
 * 契約:  docs/PK-IMPL-CONTRACT.md INV-08
 *
 * **在留資格は雇用管理の個人情報のなかでも取り違えが最も高くつく。**
 * 1 行でも混ざれば、他社スタッフの在留期限が自社の画面に載る。
 * `residency.read` を `ORG_ADMIN` だけに絞ってあること（INV-08）と、
 * ここの越境が塞がっていることは**別々に効く防御**で、片方だけでは足りない。
 *
 * ── 施設スコープを掛けていない ──────────────────────────
 * 在留資格は組織に属する事実で、施設に紐づかない（`property_id` の列が無い）。
 * `propertyColumn: null` を明示する（payout.spec.ts と同じ形）。
 */

import { listResidencyRecords } from "@pk/db";

import { describeTenantIsolation } from "./isolation-suite.js";

describeTenantIsolation({
  table: "residency_record",
  list: (env, ctx) => listResidencyRecords(env, ctx),
  entityPrefix: "resd",
  propertyColumn: null,
});
