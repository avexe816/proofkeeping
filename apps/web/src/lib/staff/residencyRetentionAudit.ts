/**
 * 在留資格の削除バッチが「走ったが 0 件だった」ことの記録（P8-11）。
 *
 * task: docs/tasks/P8-11.md
 * ルール: .claude/rules/security.md §6
 *
 * ── 消した回はここを通らない（**hotfix 2026-08-22**）──────
 * 実際に消える回の監査ログは、**DELETE と同じ D1 `batch()` の中**で
 * `deleteResidencyRecords()` が書く。別の `await` にすると、間で落ちて
 * 「消えたのに記録が無い」状態が作れてしまう。
 *
 * **ここが残っているのは 0 件の回のため。** 消す行が無い回は DELETE が
 * 1 文も出ないので束ねる相手がいない。「走ったが 0 件」と「走っていない」を
 * 区別できないと、消えていない理由を追えない（`photo.retentionDeleted` と
 * 同じ判断 / DECISIONS #165）。**0 以外を渡さないこと。**
 *
 * ── 閲覧の記録と分けてある ──────────────────────────────
 * `residencyAudit.ts` は**ソースに `after` が現れないこと**を spec が
 * 固定している（値を載せられない形を書き方の水準で守るため）。
 * こちらは**件数を `after` に持つ**ので、同居させると
 * あちらの守りを緩めることになる。**ファイルを分けて両方を保つ。**
 *
 * ── 受け取れるのは件数だけ ──────────────────────────────
 * 氏名も種別も期限も更新申請日も、この関数の引数に存在しない。
 * 消した相手の `staffProfileId` すら受け取らない —
 * 受け取れば「誰が在留資格を持っていたか」の一覧が監査ログに残り、
 * **監査ログが「消したはずの情報」の控えになる**（P8-11 の禁止事項）。
 * **「載せない」を約束ではなく型で守る。**
 *
 * ── 畳まない ────────────────────────────────────────────
 * 閲覧（`recordResidencyView()`）は画面を開くたびに起きるので 1 日 1 件へ
 * 畳むが、**削除は日次バッチで元々 1 日 1 件。** 畳むと、2 度走ったときに
 * 2 度目が残らない。物理削除は取り返しがつかないので、走った回数は
 * そのまま残す。
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
 * 削除バッチが走ったことを記録する。**消す行が無かった回だけ。**
 *
 * @param input.deleted 消えた行数。**0 を渡すこと**（消えた回の記録は
 *   `deleteResidencyRecords()` が DELETE と同じ batch の中で書く）。
 */
export async function recordResidencyDeletion(
  env: Env,
  ctx: TenantContext,
  input: { deleted: number },
): Promise<void> {
  await recordAudit(env, ctx, {
    // 誰も操作していない。**人の ID を借りない**（DECISIONS #164）。
    actorId: systemActorId(ctx.orgShortId),
    action: "residency.deleted",
    targetType: RESIDENCY_DELETION_TARGET,
    after: { deleted: input.deleted },
  });
}
