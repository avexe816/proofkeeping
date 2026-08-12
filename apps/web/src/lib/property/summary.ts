/**
 * 施設サマリー（PK-SPEC-P0 §23.3）。
 *
 * task:  docs/tasks/P0-21.md
 * ルール: .claude/rules/architecture.md §3
 *
 * ── rollup だけを読む ───────────────────────────────────
 * §26 の絶対ルール「施設サマリーを rollup テーブル以外から取得しない」。
 * タスクテーブルを数えないこと。**客室数だけは客室マスタから取る**
 * （rollup に室数の列が無いため。`countSellableRoomsByProperty()` の注記）。
 *
 * ── 60 秒キャッシュ ─────────────────────────────────────
 * ドロップダウンを開くたびに全施設ぶんを集計しない（§23.3 MUST）。
 * 置き場は `CONFIG` KV。**`SHARD_MAP` へ相乗りさせないこと**
 * （architecture.md §1 — あちらは TTL 禁止）。
 *
 * ── キャッシュのキーにロールを含める ────────────────────
 * 返す施設はロールと担当施設で変わる（§23.3「クライアント側で
 * フィルタしない」）。組織 ID だけをキーにすると、**施設責任者の
 * キャッシュをオーナーが引く**（またはその逆）。
 * 担当施設の集合そのものをキーへ入れる。
 */

import {
  countSellableRoomsByProperty,
  listPropertyRollups,
  type Env,
  type TenantContext,
} from "@pk/db";
import type { PropertySummary } from "@pk/contracts";

import { listSelectableProperties } from "./selection.js";

/** キャッシュの有効期間（秒）。§23.3 の「60 秒」。 */
export const SUMMARY_CACHE_TTL_SECONDS = 60;

/**
 * キャッシュのキー。
 *
 * 担当施設は並べ替えてから連結する。**順序が変わっただけで別キーに
 * なると、キャッシュが当たらないまま KV が膨らむ。**
 */
export function summaryCacheKey(ctx: TenantContext, businessDate: string): string {
  const scope =
    ctx.allowedPropertyIds.length === 0 ? "org" : [...ctx.allowedPropertyIds].sort().join(",");
  return `summary:${ctx.organizationId}:${ctx.role}:${scope}:${businessDate}`;
}

/**
 * 施設サマリーを返す。**到達できる施設だけ。**
 *
 * `skipCache` はテストと、切替直後に古い数字を出したくない経路のため。
 */
export async function getPropertySummaries(
  env: Env,
  ctx: TenantContext,
  businessDate: string,
  options: { skipCache?: boolean } = {},
): Promise<readonly PropertySummary[]> {
  const key = summaryCacheKey(ctx, businessDate);

  if (options.skipCache !== true) {
    const cached = await env.CONFIG.get(key, "json");
    // 形の検証はしない。**自分で書いた値しか入らないキー**で、
    // 壊れていれば下の再計算で上書きされる。
    if (cached !== null) return cached as readonly PropertySummary[];
  }

  const summaries = await buildPropertySummaries(env, ctx, businessDate);

  await env.CONFIG.put(key, JSON.stringify(summaries), {
    expirationTtl: SUMMARY_CACHE_TTL_SECONDS,
  });
  return summaries;
}

/** 集計の実体。キャッシュを見ない。 */
export async function buildPropertySummaries(
  env: Env,
  ctx: TenantContext,
  businessDate: string,
): Promise<readonly PropertySummary[]> {
  const [properties, rollups, roomCounts] = await Promise.all([
    listSelectableProperties(env, ctx),
    listPropertyRollups(env, ctx, businessDate),
    countSellableRoomsByProperty(env, ctx),
  ]);

  const byProperty = new Map(rollups.map((row) => [row.propertyId, row]));

  return properties.map((property) => {
    const rollup = byProperty.get(property.id);
    return {
      propertyId: property.id,
      code: property.code,
      name: property.name,
      roomCount: roomCounts.get(property.id) ?? 0,
      // 行が無い＝まだ集計されていない。**0 と区別する**（画面は数字を出さない）。
      hasRollup: rollup !== undefined,
      totalTasks: rollup?.totalTasks ?? 0,
      completedTasks: rollup?.completedTasks ?? 0,
      reworkTasks: rollup?.reworkTasks ?? 0,
      openIssues: rollup?.openIssues ?? 0,
    };
  });
}

/** 検索入力を出す施設数の下限（§23.2「8 を超える場合」→ 9 以上）。 */
export const PROPERTY_SEARCH_THRESHOLD = 8;

/** 検索入力を出すか。 */
export function needsPropertySearch(propertyCount: number): boolean {
  return propertyCount > PROPERTY_SEARCH_THRESHOLD;
}
