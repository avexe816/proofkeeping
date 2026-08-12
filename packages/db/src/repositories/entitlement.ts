/**
 * モジュールの利用可否（エンタイトルメント）。
 *
 * task: docs/tasks/P0-12.md
 * 仕様: docs/PK-SPEC-P7.md §3.1（モジュール）/ docs/PK-BIZ-PLAN.md §4（版数）
 *
 * ── P0-12 が持つのは判定だけ ────────────────────────────
 * 契約の作成・変更（`subscription` の書き込み、モジュールの有効化）は
 * P7-04 の担当。ここは「今このリクエストがそのモジュールを使ってよいか」を
 * 1 行で答える読み取りだけを持つ。書き込み関数を足すときは
 * `entitlement.updated` の監査ログ（P0-11）とセットにすること（security.md §6）。
 *
 * ── 施設単位と組織単位（P0-12 完了条件）────────────────
 * `moduleEntitlement.propertyId` が null なら組織全体、値があればその施設だけ。
 * **判定は OR。1 行でも `isEnabled` が真なら許可する**（`schema/billing.ts` の
 * 決定。SQLite の UNIQUE は NULL 同士を別値として扱うため、組織単位の行が
 * 重複しうる。「どれか 1 行」で答えられる形にしておく）。
 *
 * 帰結として、**施設単位の行で「無効」を表現することはできない。**
 * 組織全体が有効なら施設単位の `isEnabled = false` は判定を覆さない。
 * 施設ごとに止める必要が出たら、行の意味を変えるのではなく
 * 「組織単位の行を消して施設単位で列挙する」運用にすること。
 */

import { and, eq, gt, isNull, lte, or, type SQL } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant } from "../id.js";
import { getTenantDb, type TenantContext } from "../router.js";
import { moduleEntitlement, type ModuleCode } from "../schema/billing.js";

import { NO_PROPERTY_SCOPE, withTenantScope } from "./base.js";

/**
 * 施設の条件。`propertyId` が `null` なら組織全体の行だけ、
 * 値があれば「組織全体の行 または その施設の行」。
 *
 * `isModuleEnabled()` と `listEnabledModules()` で同じ形にするために切り出す。
 * **片方だけ条件が変わると、判定と表示が食い違う**（グレー表示なのに 402 が
 * 出ない、あるいはその逆）。
 */
function propertyCondition(propertyId: string | null): SQL | undefined {
  return propertyId === null
    ? isNull(moduleEntitlement.propertyId)
    : or(isNull(moduleEntitlement.propertyId), eq(moduleEntitlement.propertyId, propertyId));
}

/** 期間。`validFrom` が null なら開始済み、`validUntil` が null なら無期限。 */
function validityCondition(now: Date): SQL | undefined {
  return and(
    or(isNull(moduleEntitlement.validFrom), lte(moduleEntitlement.validFrom, now)),
    or(isNull(moduleEntitlement.validUntil), gt(moduleEntitlement.validUntil, now)),
  );
}

/**
 * モジュールが使えるか。
 *
 * ── なぜ `NO_PROPERTY_SCOPE` なのか ─────────────────────
 * この表は `propertyId` を持つが、**`scopeToProperties()` を掛けてはならない。**
 * 掛けると施設スコープロール（CLEANER など）に対して
 * `property_id IN (...)` が立ち、**組織全体の行（`property_id` が NULL）が
 * 条件から外れる。** 契約が有効なのに全員が 402 を受け取る形で壊れる。
 * 施設の絞り込みは下の `propertyCondition` が明示的に組む。
 *
 * エンタイトルメントは「組織が何を買ったか」であって、ロールごとに
 * 見え方が変わる資源ではない。**誰がその機能に到達してよいか**は
 * 権限の問題で、`assertPermission()`（P0-10）が別に判定する。
 *
 * @param propertyId 施設に紐づく操作ならその施設 ID。組織全体の操作は `null`。
 *   **省略可能にしていない。** 省略を許すと「施設で見るべき操作なのに
 *   書き忘れた」場合と区別がつかず、静かに広い側へ倒れる
 *   （`base.ts` の `NO_PROPERTY_SCOPE` と同じ方針）。
 */
export async function isModuleEnabled(
  env: Env,
  ctx: TenantContext,
  moduleCode: ModuleCode,
  propertyId: string | null,
): Promise<boolean> {
  if (propertyId !== null) assertIdBelongsToTenant(propertyId, ctx);

  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select({ id: moduleEntitlement.id })
    .from(moduleEntitlement)
    .where(
      withTenantScope(
        moduleEntitlement,
        ctx,
        NO_PROPERTY_SCOPE,
        eq(moduleEntitlement.moduleCode, moduleCode),
        eq(moduleEntitlement.isEnabled, true),
        propertyCondition(propertyId),
        // トライアル終了後も真を返し続ける実装にしないこと（PK-SPEC-P7 §2.5）。
        validityCondition(ctx.now),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

/**
 * 契約済みモジュールの一覧。**画面の出し分け専用の読み取り。**
 *
 * task: docs/tasks/P0-14.md（未購入モジュールのグレー表示）
 *
 * ── なぜ `isModuleEnabled()` を画面から呼ばないのか ──────
 * ナビゲーションは 10 項目以上あり、1 項目ずつ判定を呼ぶと D1 の往復が
 * 項目数だけ増える。**それ以上に**、画面が `isModuleEnabled()` を直接持つと
 * 「判定を呼ばずに表示する」書き方が型で通ってしまう。一覧を 1 回引いて
 * 集合として渡す形なら、出し分けの入力が 1 つに定まる。
 *
 * ── これは権限判定ではない ──────────────────────────────
 * 返すのは「組織が何を買ったか」。**誰がその機能に到達してよいかは
 * `assertPermission()` が別に判定する。** そして画面での出し分けは
 * どちらの代わりにもならない（security.md §1）。API ハンドラは
 * `assertPermission()` → `assertEntitlement()` の順で必ず両方を通すこと。
 *
 * @param propertyId 施設の画面ならその施設 ID。組織全体の画面は `null`。
 */
export async function listEnabledModules(
  env: Env,
  ctx: TenantContext,
  propertyId: string | null,
): Promise<ModuleCode[]> {
  if (propertyId !== null) assertIdBelongsToTenant(propertyId, ctx);

  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select({ moduleCode: moduleEntitlement.moduleCode })
    .from(moduleEntitlement)
    .where(
      withTenantScope(
        moduleEntitlement,
        ctx,
        NO_PROPERTY_SCOPE,
        eq(moduleEntitlement.isEnabled, true),
        propertyCondition(propertyId),
        validityCondition(ctx.now),
      ),
    );

  // 組織全体の行と施設単位の行が同じモジュールで両方立ちうる（判定は OR）。
  // 重複を畳んで返す。
  return [...new Set(rows.map((row) => row.moduleCode))];
}
