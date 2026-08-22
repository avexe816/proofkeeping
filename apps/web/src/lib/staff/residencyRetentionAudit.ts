/**
 * 削除バッチが「走ったが 0 件だった」ことの記録（P8-11）。
 *
 * task: docs/tasks/P8-11.md
 * ルール: .claude/rules/security.md §6
 * 決定: docs/DECISIONS.md #268
 *
 * ── 消した回はここを通らない ────────────────────────────
 * 実際に消える回の監査ログは、**DELETE と同じ D1 `batch()` の中**で
 * `deleteResidencyRecords()` が書く（`repositories/residency.ts`）。
 * 別の `await` にすると、間で落ちて「消えたのに記録が無い」状態が
 * 作れてしまう。
 *
 * **ここが残っているのは 0 件の回のためだけ。** 消す行が無い回は DELETE が
 * 1 文も出ないので束ねる相手がいない。「走ったが 0 件」と「走っていない」を
 * 区別できないと、消えていない理由を追えない（`photo.retentionDeleted` と
 * 同じ判断 / DECISIONS #165）。
 *
 * ── 件数を受け取らない（**型で塞ぐ**）──────────────────
 * この関数に**引数が無い。** 件数を受け取れる形にしておくと、将来
 * 非 0 の件数をここから別の `await` で書けてしまい、**原子性を回復した
 * ばかりの経路をまた壊せる。** 書く値は `{"deleted": 0}` に固定してある。
 *
 * ── 閲覧の記録と分けてある ──────────────────────────────
 * `residencyAudit.ts` は**ソースに `after` が現れないこと**を spec が
 * 固定している（値を載せられない形を書き方の水準で守るため）。
 * こちらは `after` を持つので、同居させるとあちらの守りを緩める。
 * **ファイルを分けて両方を保つ。**
 *
 * ── 畳まない ────────────────────────────────────────────
 * 閲覧（`recordResidencyView()`）は画面を開くたびに起きるので 1 日 1 件へ
 * 畳むが、**削除バッチは日次で元々 1 日 1 件。** 畳むと、2 度走ったときに
 * 2 度目が残らない。
 */

import {
  recordAudit,
  RESIDENCY_DELETION_TARGET,
  systemActorId,
  type Env,
  type TenantContext,
} from "@pk/db";

export { RESIDENCY_DELETION_TARGET };

/**
 * 削除バッチが走り、**対象が 1 件も無かった**ことを記録する。
 *
 * **件数の引数を持たない。** 書く値は常に `{"deleted": 0}`。
 * 実際に消えた回の記録はこの関数から作れない。
 */
export async function recordEmptyResidencyRetentionRun(
  env: Env,
  ctx: TenantContext,
): Promise<void> {
  await recordAudit(env, ctx, {
    // 誰も操作していない。**人の ID を借りない**（DECISIONS #164）。
    actorId: systemActorId(ctx.orgShortId),
    action: "residency.deleted",
    targetType: RESIDENCY_DELETION_TARGET,
    // **リテラルの 0。** 呼び出し側から動かせない。
    after: { deleted: 0 },
  });
}
