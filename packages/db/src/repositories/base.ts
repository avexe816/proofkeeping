/**
 * リポジトリ層の共通ヘルパー。テナント分離の第 1 層（強制注入）の実体。
 *
 * 仕様: docs/PK-SPEC-P0.md §19.4 第1層
 * ルール: .claude/rules/architecture.md §2
 * task:  docs/tasks/P0-07.md
 *
 * ── この層が担うもの ────────────────────────────────────
 * DB への到達経路は `getTenantDb()` に限定されている（ESLint `no-raw-drizzle` /
 * `no-direct-shard-access`）。しかしその先で `organizationId` 条件を
 * **書き忘れることは lint では止められない。** ここが止める。
 *
 * すべてのクエリの `where` は `withTenantScope()` が組み立てる。
 * 呼び出し側が `eq(table.organizationId, ...)` を手書きしないこと。
 *
 * ── db.query.* を使わない ───────────────────────────────
 * P0-06 で `getTenantDb()` にスキーマを渡したため、relational query API
 * （`db.query.room.findMany()`）も型としては生えている。**使わないこと。**
 * あちらは `where` を省いても型エラーにならず、`withTenantScope()` を
 * 迂回した全件取得が自然に書けてしまう。`db.select().from(...).where(...)` に統一する。
 */

import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";

import type { ShardContext, TenantContext } from "../router.js";
import type { Role } from "../schema/user.js";

/**
 * `organizationId` 列を持つテナント表だけを受け付ける制約。
 *
 * `organizationId` を持たない表（`schema/meta.ts` の `schema_version` など）を
 * `withTenantScope()` へ渡すとコンパイルが通らない。
 *
 * **ただし `org_directory`（全局テーブル）はこの型を満たしてしまう。**
 * 採番レジストリとして `organization_id` 列を持つため、型では弾けない。
 * 全局テーブルはシャード分離の外側にあり、テナント文脈で引くと
 * `getGlobalDb()`（SHARD_00 固定）を迂回することになる。
 * リポジトリがこの表に触れていないことは repositories.spec.ts が
 * ソースを走査して固定する。**型の保証ではないので、この層で
 * `org_directory` を引く必要が出たら設計を疑うこと**（P0-06 申し送り 2）。
 *
 * 引数の型として直接使い、型引数（`<T extends TenantScopedTable>`）にはしない。
 * 戻り値が常に `SQL` で、テーブルの具体型を持ち回る必要が無いため
 * （型引数にすると `@typescript-eslint/no-unnecessary-type-parameters` が落とす）。
 */
export type TenantScopedTable = SQLiteTable & { organizationId: AnySQLiteColumn };

/** 恒真。「絞り込まない」を `undefined` ではなくこれで表す（下記の理由）。 */
export const ALWAYS_TRUE: SQL = sql`1 = 1`;

/** 恒偽。担当施設が 1 件も無い施設スコープロールに使う。 */
export const ALWAYS_FALSE: SQL = sql`1 = 0`;

/**
 * 組織全体を見るロール（.claude/rules/security.md §1）。
 *
 * **ここに載っていないロールは施設スコープとして扱う。** 既定を制限側に倒すのは、
 * `ROLES` にロールが増えたとき、追記を忘れても「見えすぎる」方向には壊れないため。
 * 逆向き（施設スコープ側を列挙する）にすると、新ロールが全施設を取得できてしまう。
 * この不変条件は base.spec.ts が `ROLES` 全件を走査して固定している。
 */
const ORG_WIDE_ROLES: ReadonlySet<Role> = new Set<Role>(["OWNER", "ORG_ADMIN", "AUDITOR"]);

/** 組織全体を見るロールか。 */
export function isOrgWideRole(role: Role): boolean {
  return ORG_WIDE_ROLES.has(role);
}

/**
 * 施設列を持たない表であることを明示するマーカー。
 *
 * `organization` / `organizationTaxProfile` / `user` / `membership` は
 * `propertyId` を持たない。**引数を省略可能にせず、この値を書かせる。**
 * 省略を許すと「施設で絞るべき表なのに書き忘れた」場合と区別がつかず、
 * 静かに組織全体が見える形で壊れる。
 *
 * なお、施設スコープロールがこれらの表へ**到達してよいか**は権限の問題で、
 * この層の責務ではない（P0-10 の `assertPermission` / OPEN_QUESTIONS #016）。
 */
export const NO_PROPERTY_SCOPE = "NO_PROPERTY_SCOPE" as const;

/** `withTenantScope()` の第 3 引数。施設列そのものか、持たないことの明示。 */
export type PropertyScope = AnySQLiteColumn | typeof NO_PROPERTY_SCOPE;

/**
 * 施設スコープロールを担当施設に絞る条件を返す。
 *
 * ── 戻り値に `undefined` を使わない理由 ──────────────────
 * drizzle の `and()` は `undefined` を黙って捨てる。この関数が
 * 「絞り込み不要」を `undefined` で表すと、実装の誤りで `undefined` が
 * 返った瞬間に**条件が消えて全施設が見える。** 失敗が例外ではなく
 * 「余分に見える」形で現れるため、テストを書いていない経路では気づけない。
 * 常に `SQL` を返す全域関数にして、この失敗モード自体を無くす
 * （router.ts と同じ方針 / docs/DECISIONS.md #007・#017）。
 *
 * @param propertyColumn 絞り込む列。表によって違う
 *   （`property.id` / `room.propertyId` / `building.propertyId` …）。
 */
export function scopeToProperties(ctx: TenantContext, propertyColumn: AnySQLiteColumn): SQL {
  if (isOrgWideRole(ctx.role)) return ALWAYS_TRUE;

  // 担当施設ゼロ。**「制限なし」ではなく「1 件も見えない」。**
  // drizzle の `inArray(col, [])` はバージョンにより例外／`false` と挙動が割れるため、
  // ライブラリ任せにせずここで確定させる。
  if (ctx.allowedPropertyIds.length === 0) return ALWAYS_FALSE;

  return inArray(propertyColumn, [...ctx.allowedPropertyIds]);
}

/**
 * 発注元ロール（CLIENT_VIEWER / P5-16）を自分の取引先に絞る条件を返す。
 *
 * `scopeToProperties()` と同じ設計: 常に `SQL` を返す全域関数で、
 * 「絞り込みが静かに消える」失敗モードを作らない。
 *
 * - CLIENT_VIEWER 以外 → 絞らない（この層の責務は取引先スコープだけ。
 *   組織・施設の絞りは `withTenantScope()` が別に掛ける）。
 * - CLIENT_VIEWER で取引先が未設定 → **1 件も見えない。** 設定漏れの
 *   アカウントが全取引先の請求を読める形で壊れないようにする。
 *
 * @param counterpartyColumn 絞り込む列（`billingPeriod.counterpartyId` 等）。
 */
export function scopeToCounterparty(ctx: TenantContext, counterpartyColumn: AnySQLiteColumn): SQL {
  if (ctx.role !== "CLIENT_VIEWER") return ALWAYS_TRUE;
  const counterpartyId = ctx.counterpartyId ?? null;
  if (counterpartyId === null) return ALWAYS_FALSE;
  return eq(counterpartyColumn, counterpartyId);
}

/**
 * すべてのクエリの `where` を組み立てる。**リポジトリはこれ以外を使わない。**
 *
 * `organizationId` の一致（第 1 層）と施設スコープの絞り込みを必ず載せ、
 * 個別条件は後ろに足す。個別条件だけを `where` に渡す書き方をしないこと。
 *
 * @param extra `undefined` を混ぜてよい（フィルタ未指定を表現できる）。
 */
export function withTenantScope(
  table: TenantScopedTable,
  ctx: TenantContext,
  propertyColumn: PropertyScope,
  ...extra: (SQL | undefined)[]
): SQL {
  const conditions: SQL[] = [
    eq(table.organizationId, ctx.organizationId), // 常に強制
    propertyColumn === NO_PROPERTY_SCOPE ? ALWAYS_TRUE : scopeToProperties(ctx, propertyColumn),
    ...extra.filter((condition): condition is SQL => condition !== undefined),
  ];
  // conditions は常に 2 件以上あるため `and()` が undefined を返す経路は無い。
  // それでも既定を置くのは、型を満たすために `!` を使わないため。
  return and(...conditions) ?? ALWAYS_TRUE;
}

/**
 * **認証ブートストラップ専用。** 組織の一致だけを条件にする。
 *
 * `TenantContext` を作るには `membership.role` と `property_assignment` が要る。
 * その 2 つを引くクエリはロールが確定する前に走るため、`withTenantScope()` を
 * 使えない（`ctx.role` がまだ無い / docs/DECISIONS.md #016）。
 *
 * **業務リポジトリからこれを呼ばないこと。** 施設スコープが掛からず、
 * 第 1 層が半分だけになる。使用箇所は `repositories/user.ts` の
 * `findMembershipByUserId` / `listAssignedPropertyIds` の 2 つに限る。
 * この 2 つ以外に増えていないことは repositories.spec.ts が固定している。
 */
export function withOrganizationScope(
  table: TenantScopedTable,
  ctx: ShardContext,
  ...extra: (SQL | undefined)[]
): SQL {
  const conditions: SQL[] = [
    eq(table.organizationId, ctx.organizationId),
    ...extra.filter((condition): condition is SQL => condition !== undefined),
  ];
  return and(...conditions) ?? ALWAYS_TRUE;
}
