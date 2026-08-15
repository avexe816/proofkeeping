/**
 * トライアルの期間・上限・終了後の扱い（PK-SPEC-P7 §2.5）。**純粋関数。**
 *
 * task:  docs/tasks/P7-03.md
 * 決定:  docs/DECISIONS.md #182 / #183
 *
 * ── §2.5 が定めるもの ───────────────────────────────────
 *   期間    30 日
 *   制限    施設 3 つまで、客室 150 室まで
 *   機能    全モジュール利用可（Audit も含む）
 *   終了時  **読み取り専用**へ移行。データは 90 日保持
 *
 * MUST: **トライアル終了でデータを即削除しない。** 90 日間は復帰できる。
 *
 * ── ここに時計を持ち込まない ────────────────────────────
 * `now` は必ず引数で受ける。`Date.now()` を呼ばない。
 * 判定の呼び出し側（middleware・画面）が 1 か所で時刻を作る。
 *
 * ── 「削除する」関数を置いていない ──────────────────────
 * §2.5 MUST は「即削除しない」。**90 日が過ぎたら消す仕組みは、
 * まだどの task にも無い。** `retentionEndsAt()` は期限を計算するだけで、
 * 消すコードはここにも他にも無い（＝現状は保持され続ける）。
 * 消す task を書くときに、この期限を持ち込むこと。
 */

/** §2.5 の期間と上限。**設定項目にしない。** */
export const TRIAL_DAYS = 30;
export const TRIAL_MAX_PROPERTIES = 3;
export const TRIAL_MAX_ROOMS = 150;
/** 終了後にデータを保持する日数（§2.5 / §3.5 の解約と同じ 90 日）。 */
export const TRIAL_RETENTION_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * トライアルの局面。
 *
 * `NOT_TRIAL` は「トライアルではない」（有償・未契約を含む）。
 * **`NOT_TRIAL` を「制限なし」と読み替えないこと。** 未契約の扱いは
 * エンタイトルメント（`assertEntitlement()` → 402）の担当で、ここではない。
 */
export type TrialPhase = "NOT_TRIAL" | "ACTIVE" | "EXPIRED" | "RETENTION_ENDED";

/** 判定に要る契約の情報だけ。**行そのものを受け取らない**（列が増えても壊れない）。 */
export interface TrialInput {
  status: string | null | undefined;
  /** トライアルの終了時刻。`null` なら期限が決まっていない。 */
  trialEndsAt: Date | null | undefined;
}

/**
 * いまどの局面か。
 *
 * ── `trialEndsAt` が無いトライアルは `ACTIVE` ────────────
 * 期限が入っていない行を「終了」と読むと、**設定漏れが即座に
 * 読み取り専用**になる。§2.5 の目的は「30 日で切る」ことであって、
 * 「期限の無い行を止める」ことではない。**迷ったら止めない側へ倒す。**
 */
export function trialPhaseOf(input: TrialInput, now: Date): TrialPhase {
  if (input.status !== "TRIAL") return "NOT_TRIAL";
  const endsAt = input.trialEndsAt;
  if (endsAt === null || endsAt === undefined) return "ACTIVE";
  if (now.getTime() < endsAt.getTime()) return "ACTIVE";
  return now.getTime() < retentionEndsAt(endsAt).getTime() ? "EXPIRED" : "RETENTION_ENDED";
}

/** トライアル開始から 30 日後。 */
export function trialEndsAtFrom(startedAt: Date): Date {
  return new Date(startedAt.getTime() + TRIAL_DAYS * DAY_MS);
}

/** データを保持する期限（終了から 90 日後）。**消す仕組みはまだ無い。** */
export function retentionEndsAt(trialEndsAt: Date): Date {
  return new Date(trialEndsAt.getTime() + TRIAL_RETENTION_DAYS * DAY_MS);
}

/**
 * 書き込みを止めるか（§2.5「終了時は読み取り専用モードへ移行」）。
 *
 * **保持期間が過ぎても読み取り専用のまま。** ここが `true` を返すのは
 * 「書けない」であって「消えた」ではない。消す仕組みは無い（冒頭の注記）。
 */
export function isReadOnly(phase: TrialPhase): boolean {
  return phase === "EXPIRED" || phase === "RETENTION_ENDED";
}

/** 上限。トライアル以外は掛からない（`null` = 上限なし）。 */
export interface TrialLimits {
  properties: number | null;
  rooms: number | null;
}

export function limitsOf(phase: TrialPhase): TrialLimits {
  return phase === "ACTIVE"
    ? { properties: TRIAL_MAX_PROPERTIES, rooms: TRIAL_MAX_ROOMS }
    : { properties: null, rooms: null };
}

/**
 * 客室をあと何室作れるか。**上限が無ければ `null`。**
 *
 * 既に上限を超えている場合は `0` を返す（負の数にしない）。
 * 上限を下げる運用は無いが、移行やデータ修正で起きうる。
 */
export function remainingRooms(phase: TrialPhase, current: number): number | null {
  const limit = limitsOf(phase).rooms;
  if (limit === null) return null;
  return Math.max(0, limit - current);
}

/** 施設をあと何件作れるか。**上限が無ければ `null`。** */
export function remainingProperties(phase: TrialPhase, current: number): number | null {
  const limit = limitsOf(phase).properties;
  if (limit === null) return null;
  return Math.max(0, limit - current);
}

/**
 * その件数を追加してよいか。
 *
 * **超える分だけを弾くのではなく、まとめて拒む。** CSV で 200 室を
 * 取り込もうとしたときに「先頭 150 室だけ入る」と、どの行が入ったかを
 * 利用者が追えない（`createRooms()` の「見送った件数を出す」とは別の話で、
 * あちらは重複の見送り）。
 */
export function canAddRooms(phase: TrialPhase, current: number, adding: number): boolean {
  const remaining = remainingRooms(phase, current);
  return remaining === null || adding <= remaining;
}
