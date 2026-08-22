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
 * この関数の**入力は操作者だけで、時刻は `ctx.now` から取得する。**
 * 在留資格の値も、氏名も、期限も、引数に存在しない。
 * **「載せない」を約束ではなく型で守る。**
 *
 * ── 1 日 1 件に畳む ─────────────────────────────────────
 * 閲覧は画面を開くたびに起きる。そのまま書くと監査ログが閲覧の行で
 * 埋まり、**本当に追いたい変更の行が探せなくなる**（オーナー判断
 * 2026-08-22「畳んでください」）。同じ人が同じ日に何度開いても 1 行。
 *
 * ── 「同じ日」は **JST の暦日**（00:00〜23:59 Asia/Tokyo）────
 * **施設ごとの業務日・日締めを持ち込まない。** 在留資格は組織の事実で
 * 施設に紐づかず、日締め時刻（施設ごとに違う）を当てる根拠が無い。
 * 一方で UTC の暦日にすると、日本の利用者にとって **9:00 に日付が変わる**
 * ことになり、「同じ日に 2 回見た」の直感と合わない。
 * そこで **JST の暦日**を採る。境目は `startOfJstDay()` が UTC の瞬間へ
 * 直す（JST = UTC+9 の固定オフセット。日本に夏時刻は無い）。
 *
 * **`businessDate` の文字列をそのまま `T00:00:00.000Z` で読まないこと。**
 * それは JST の日付を UTC の 0 時として解釈することになり、**その瞬間は
 * JST の 9:00。** 05:00〜08:59 JST に開くと境目が現在時刻より未来になり、
 * 既存の行が検索範囲から外れて**毎回 1 行増える**（2026-08-22 に修正）。
 *
 * ── 一覧は 1 件。行ごとに記録しない ─────────────────────
 * 記録するのは「一覧を見た」という事実だけで、**誰の在留資格を見たかは
 * 残さない。** 行ごとに残すと、監査ログ自体が「誰が在留資格を持つか」の
 * 一覧になる。
 */

import { recordAuditDaily, type Env, type TenantContext } from "@pk/db";

/** 「一覧を見た」の対象種別。**個人を指す ID を持たない。** */
export const RESIDENCY_VIEW_TARGET = "residencyList";

/** JST の固定オフセット（UTC+9）。**日本に夏時刻は無い。** */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * その瞬間が属する **JST の暦日の始まり**を、UTC の瞬間として返す。
 *
 * ```
 * 2026-08-22T00:00:00+09:00  →  2026-08-21T15:00:00Z
 * ```
 *
 * **常に `now` 以前になる。** 畳みの境目が未来を指すと、既存の行が
 * 検索範囲から外れて記録が毎回増える（この関数を置いた理由）。
 */
export function startOfJstDay(now: Date): Date {
  // UTC の暦として読むために +9h ずらしてから、その日の 0 時を取る。
  const shifted = new Date(now.getTime() + JST_OFFSET_MS);
  const startShifted = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );
  return new Date(startShifted - JST_OFFSET_MS);
}

/**
 * 在留資格の一覧を見たことを記録する。
 *
 * 畳む単位は **JST の暦日**で、時刻は `ctx.now` から取る
 * （**日付の文字列を受け取らない** — 受け取ると、どの時間帯の日付かが
 * 呼び出し側の都合で変わりうる）。
 *
 * @param actorId 操作者の `membership.id`。
 * @returns 書いたら `true`、その日ぶんが既にあって見送ったら `false`。
 */
export async function recordResidencyView(
  env: Env,
  ctx: TenantContext,
  input: { actorId: string },
): Promise<boolean> {
  return recordAuditDaily(env, ctx, {
    actorId: input.actorId,
    action: "residency.viewed",
    targetType: RESIDENCY_VIEW_TARGET,
    since: startOfJstDay(ctx.now),
  });
}
