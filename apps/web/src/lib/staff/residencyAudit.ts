/**
 * 在留資格を見たことの記録（INV-08 v2 / DECISIONS #261）。
 *
 * task: なし（オーナー判断 2026-08-22 / OPEN_QUESTIONS #110 決着）
 * ルール: .claude/rules/security.md §6
 *
 * ── なぜ画面から切り出してあるのか ──────────────────────
 * 記録そのものは `/app/settings/staff` の loader で起きるが、**あの画面は
 * 初期 PIN を `action` の戻り値として運ぶ**（DECISIONS #177）。
 * 監査ログの口を同じファイルへ置くと、取り違えたときに PIN が
 * 監査ログへ入りうる（`tests/security/initialPin.spec.ts` と
 * `staffScreen.spec.ts` がその同居を禁じている）。
 *
 * ── 値を載せられない形にしてある ────────────────────────
 * この関数は**操作者と日付しか受け取らない。** 在留資格の値も、氏名も、
 * 期限も、引数に存在しない。**「載せない」を約束ではなく型で守る。**
 *
 * ── 1 日 1 件に畳む ─────────────────────────────────────
 * 閲覧は画面を開くたびに起きる。そのまま書くと監査ログが閲覧の行で
 * 埋まり、**本当に追いたい変更の行が探せなくなる**（オーナー判断
 * 2026-08-22「畳んでください」）。同じ人が同じ日に何度開いても 1 行。
 *
 * ── 一覧は 1 件。行ごとに記録しない ─────────────────────
 * 記録するのは「一覧を見た」という事実だけで、**誰の在留資格を見たかは
 * 残さない。** 行ごとに残すと、監査ログ自体が「誰が在留資格を持つか」の
 * 一覧になる。
 */

import { recordAuditDaily, type Env, type TenantContext } from "@pk/db";

/** 「一覧を見た」の対象種別。**個人を指す ID を持たない。** */
export const RESIDENCY_VIEW_TARGET = "residencyList";

/**
 * 在留資格の一覧を見たことを記録する。
 *
 * @param actorId 操作者の `membership.id`。
 * @param businessDate 畳む単位の日（`YYYY-MM-DD`）。
 * @returns 書いたら `true`、その日ぶんが既にあって見送ったら `false`。
 */
export async function recordResidencyView(
  env: Env,
  ctx: TenantContext,
  input: { actorId: string; businessDate: string },
): Promise<boolean> {
  return recordAuditDaily(env, ctx, {
    actorId: input.actorId,
    action: "residency.viewed",
    targetType: RESIDENCY_VIEW_TARGET,
    // 業務日の始まり（UTC）。ここで要るのは「同じ日か」の判定だけで、
    // 境目が数時間ずれても畳む効きは変わらない。**施設ごとの日締めを
    // 持ち込まない**（在留資格は組織の事実で、施設に紐づかない）。
    since: new Date(`${input.businessDate}T00:00:00.000Z`),
  });
}
