/**
 * 施設をまたぐ一覧で「どこまで見えるか」を決める共通の scope 判定。
 *
 * task:  docs/tasks/P7-18.md（**P7-20 が再利用する** / P7-20 §やること）
 * ルール: .claude/rules/security.md §1 / .claude/rules/architecture.md §2
 *
 * ── なぜ `findings.ts` の書き方を共通化しないのか ────────
 * 既存の施設横断一覧（差異レポート / P4-06）は
 *
 *     assertPermission(ctx, action, propertyId === undefined
 *       ? ORGANIZATION_TARGET : propertyTarget([propertyId]));
 *
 * と書いている。**施設を選ばない一覧＝組織全体の権限**という判定で、
 * これは差異レポートでは正しい（`finding.read` は `PROPERTY_MANAGER` /
 * `VENDOR_ADMIN` にしか `ASSIGNED` を配っておらず、施設横断で読むのは
 * 運営側だけ）。
 *
 * **検査キューでは成り立たない。** 主な利用者の `INSPECTOR` は
 * `inspection.read` が `ASSIGNED` なので、上の書き方だと
 * 「施設を選ばない検査キュー」に到達できるロールが 1 つも無くなる。
 * かといって `ORGANIZATION_TARGET` を素通しにすると、担当外施設まで
 * 見える口ができる。
 *
 * そこで**第 3 の答え**をここに置く。施設スコープロールに対しては
 * 「組織全体」ではなく **`ctx.allowedPropertyIds` の集合そのもの**を
 * 対象にして権限を問う。担当施設を全部足した範囲なら、その人は
 * 定義上すべて読めるので通り、担当外は 1 件も入らない。
 *
 * ── 判定の根拠を `PERMISSION_MATRIX` に閉じる ───────────
 * `isOrgWideRole()` をここで参照しない。「組織全体を見られるか」は
 * ロールの属性ではなく**操作ごとのマトリクスの値**で決まる
 * （`permission.ts` の `can()` 冒頭と同じ方針）。ロール名で分岐すると、
 * マトリクスを変えたときにここだけ古い判断が残る。
 *
 * ── 403 を返さない ──────────────────────────────────────
 * 権限が無ければ `assertPermission()` が `NotFoundError` を投げ、
 * `resourceGuard` が **404** に写す（INV-31 / security.md §1）。
 * `CLEANER` が検査キューに 404 で落ちるのはこの経路。
 */

import type { TenantContext } from "@pk/db";

import {
  ORGANIZATION_TARGET,
  assertPermission,
  can,
  propertyTarget,
  type PermissionAction,
} from "../auth/permission.js";

/** 一覧が対象にする施設の範囲。 */
export interface ListScope {
  /**
   * 絞り込む施設 ID。**`null` は「組織全体」**で、「絞り込み不要」ではない。
   *
   * `null` のとき、実際の絞り込みはリポジトリ層の第 1 層
   * （`withTenantScope()` の `organizationId` 条件）だけが掛かる。
   * 呼び出し側がこの値で `where` を組む必要は無い（組めば二重に掛かるだけで
   * 害は無いが、施設が 1 件も無い組織で空の `IN ()` を作らないこと）。
   *
   * 空配列にはならない。担当施設ゼロの施設スコープロールは
   * `resolveListScope()` の中で 404 になる。
   */
  propertyIds: readonly string[] | null;
  /**
   * 1 施設に絞り込んだ場合のその ID。絞っていなければ `null`。
   *
   * 画面の施設セレクタと、リポジトリの `propertyId` フィルタに渡す値。
   */
  selectedPropertyId: string | null;
  /**
   * 「全施設」を選べる相手か（画面のセレクタに出すかどうか）。
   *
   * **これは表示の都合であって権限判定ではない。** 偽でも施設横断の一覧は
   * 返る（担当施設の範囲で）。security.md §1「フロントの非表示は権限制御と
   * みなさない」。
   */
  canSelectAll: boolean;
}

/**
 * 一覧の scope を解決する。**権限が無ければ `NotFoundError`（→ 404）。**
 *
 * | 相手 | `propertyId` の指定 | 結果 |
 * |---|---|---|
 * | 操作が `DENY`（例: `CLEANER` の `inspection.read`） | 問わず | **404** |
 * | 組織全体（`ORG`） | 無し | 全施設（`propertyIds = null`） |
 * | 組織全体（`ORG`） | 有り | その 1 施設 |
 * | 施設スコープ（`ASSIGNED`） | 無し | **担当施設の全部** |
 * | 施設スコープ（`ASSIGNED`） | 有り・担当内 | その 1 施設 |
 * | 施設スコープ（`ASSIGNED`） | 有り・担当外 | **404** |
 * | 施設スコープ・担当施設ゼロ | 無し | **404** |
 *
 * 最後の行が 404 なのは `can()` の仕様（`propertyTarget([])` は拒否）。
 * 空の一覧を 200 で返す手もあるが、**担当が 1 件も無い人に画面を開かせて
 * 「0 件」と見せる**のは、割当漏れを「今日は仕事が無い」と誤読させる。
 *
 * @param requestedPropertyId クエリで指定された施設。無指定は `null`。
 */
export function resolveListScope(
  ctx: TenantContext,
  action: PermissionAction,
  requestedPropertyId: string | null,
): ListScope {
  // 「全施設」を選べるか。**先に計算しておく。** 下の `assertPermission()` は
  // 投げるので、投げたあとでは計算できない。
  const canSelectAll = can(ctx, action, ORGANIZATION_TARGET);

  if (requestedPropertyId !== null) {
    // 担当外・別組織の施設 ID はここで 404。**DB へ行く前に落とす。**
    assertPermission(ctx, action, propertyTarget([requestedPropertyId]));
    return {
      propertyIds: [requestedPropertyId],
      selectedPropertyId: requestedPropertyId,
      canSelectAll,
    };
  }

  if (canSelectAll) {
    return { propertyIds: null, selectedPropertyId: null, canSelectAll };
  }

  // 施設スコープロール。**担当施設の集合そのもの**に対して権限を問う。
  // `can()` は「部分集合であること」を見るので、担当施設を全部並べた
  // 対象は通り、1 つでも担当外が混じれば通らない。
  assertPermission(ctx, action, propertyTarget(ctx.allowedPropertyIds));
  return {
    propertyIds: ctx.allowedPropertyIds,
    selectedPropertyId: null,
    canSelectAll,
  };
}
