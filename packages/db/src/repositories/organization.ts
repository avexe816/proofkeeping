/**
 * 組織と税務プロファイルのリポジトリ。
 *
 * task: docs/tasks/P0-07.md
 * ルール: .claude/rules/architecture.md §2 / .claude/rules/billing.md §1
 *
 * ── 引数に組織 ID を取らない ────────────────────────────
 * 「どの組織か」は常に `ctx` が持つ。リクエストから組織 ID を受け取らない
 * （PK-SPEC-P0 §19.5）。そのため `findOrganization()` は自組織しか返せない。
 *
 * `organization` は `id === organizationId` なので、施設の次元を持たない。
 * `NO_PROPERTY_SCOPE` を明示する。
 */

import type { Env } from "../env.js";
import { getTenantDb, type TenantContext } from "../router.js";
import { organization, organizationTaxProfile } from "../schema/organization.js";

import { NO_PROPERTY_SCOPE, withTenantScope } from "./base.js";

/** 自組織。存在しなければ `undefined`（呼び出し側が 404 に写像する）。 */
export async function findOrganization(env: Env, ctx: TenantContext) {
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(organization)
    .where(withTenantScope(organization, ctx, NO_PROPERTY_SCOPE))
    .limit(1);
  return rows[0];
}

/**
 * 適格請求書の発行元情報（billing.md §1）。
 *
 * 未登録なら `undefined`。**その場合に既定値を返さないこと。**
 * 登録番号の有無は「適格請求書ではありません」の表示に直結する（同 §1）。
 */
export async function findTaxProfile(env: Env, ctx: TenantContext) {
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(organizationTaxProfile)
    .where(withTenantScope(organizationTaxProfile, ctx, NO_PROPERTY_SCOPE))
    .limit(1);
  return rows[0];
}
