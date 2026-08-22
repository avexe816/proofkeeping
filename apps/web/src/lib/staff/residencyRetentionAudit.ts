/**
 * 在留資格を「保存期間の満了で消した」ことの記録（P8-11）。
 *
 * task: docs/tasks/P8-11.md
 * ルール: .claude/rules/security.md §6
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
 *
 * ── 0 件でも呼ぶ ────────────────────────────────────────
 * 呼び出し側が件数で分岐しないこと。「走ったが対象が無かった」と
 * 「走っていない」が区別できないと、消えていない理由を追えない
 * （`photo.retentionDeleted` と同じ判断 / DECISIONS #165）。
 */

import { recordAudit, systemActorId, type Env, type TenantContext } from "@pk/db";

/** 「保存期間の満了で消した」の対象種別。**個人を指す ID を持たない。** */
export const RESIDENCY_DELETION_TARGET = "residencyRetention";

/**
 * 保存期間を満了した在留資格を消したことを記録する。
 *
 * @param input.deleted 消えた行数。**これ以外を受け取らない。**
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
