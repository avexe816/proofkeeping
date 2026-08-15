/**
 * バッチが監査ログを書くときの操作者（P7-10 / PK-SPEC-P7 §4.5）。
 *
 * task: docs/tasks/P7-10.md
 *
 * ── なぜ `repositories/audit.ts` に置かないのか ──────────
 * あちらは **`recordAudit` と `listAuditLogs` の 2 つしか公開しない**
 * ことを spec が固定している（INV-30「監査ログを消せない」）。
 * 関数を足すとその守りが緩む。ここは D1 を触らない純粋な値なので、
 * **別のファイルに出して INV-30 の一覧を触らない。**
 */

/**
 * バッチが監査ログを書くときの操作者 ID（P7-10 / DECISIONS #164）。
 *
 * **`membership` の行ではない。** 実在しない ID をあえて使う。
 *
 * ── なぜ人の ID を使わないのか ──────────────────────────
 * §4.5 の削除は日次バッチで、**誰も操作していない。** 組織の `OWNER` を
 * 借りると、監査ログが「その人が消した」と読める記録を作る。
 * security.md §5 は従業員データの扱いに注意を求めており、
 * **やっていないことを記録に残さない**のが向き。
 *
 * ── なぜ組織短縮 ID を前に付けるのか ────────────────────
 * `recordAudit()` が `assertIdBelongsToTenant()` を掛けるため
 * （architecture.md §2 第 2 層）。**この規約を緩めない。**
 * 組織を跨いだ ID が監査ログへ入る経路を作らないほうが大事で、
 * 「実在しない membership を指す」ことは読み手にとって明白にできる
 * （`__system_` という綴りは他のどの entityPrefix とも重ならない）。
 */
export function systemActorId(orgShortId: string): string {
  return `${orgShortId}__${SYSTEM_ACTOR_LOCAL_ID}`;
}

/**
 * バッチの操作者の局所部。**固定値。**
 *
 * 接頭辞 `sys` は `ENTITY_PREFIXES` に登録してあるが、**この接頭辞を持つ表は
 * 無い。** `assertIdBelongsToTenant()` が `parseId()` を通すため、
 * 自己記述 ID の形（`{orgShortId}__{prefix}_{ulid}`）に合わせる必要がある。
 *
 * ULID 部を採番せず固定にしてあるのは、**実行のたびに違う ID が並ぶと
 * 「別々の誰かが操作した」ように読めるため。** バッチは 1 つの主体で、
 * 監査ログの上でもそう見えるべき。値は ULID の文字集合
 * （Crockford Base32 / `0-9A-HJKMNP-TV-Z`）26 桁で、時刻部が
 * すべて 0 なので実際に採番された ULID とは重ならない。
 */
const SYSTEM_ACTOR_LOCAL_ID = "sys_00000000000000000000000000";

/** 監査ログの操作者がバッチか（画面が「システム」と表示するため）。 */
export function isSystemActorId(actorId: string): boolean {
  return actorId.split("__")[1] === SYSTEM_ACTOR_LOCAL_ID;
}
