/**
 * 写真の保持期間（PK-SPEC-P7 §4.5 / security.md §4 / P7-10）。**純粋。**
 *
 * task:  docs/tasks/P7-10.md
 * ルール: .claude/rules/security.md §4
 *
 * ```
 * 既定保持期間: 6 か月
 * 上位プラン:   13 か月
 * 最大:         36 か月
 *
 * 日次バッチで期限切れを削除し、削除件数を監査ログに記録する。
 * MUST: 削除の 30 日前に管理者へ通知し、必要なら期間延長できるようにする。
 * ```
 *
 * ── これは「退避」ではない。本当に消える ────────────────
 * P7 固有の絶対ルール「アーカイブを『削除』と表現しない」は
 * **年次アーカイブ（§19.7）の話。** あちらは R2 に写しが残る。
 * こちらは**写しを作らずに消す。** だから言い換えない。
 * 「削除」と書いてあるものを「退避」と呼ぶと、消えたことが伝わらなくなる。
 *
 * ── 短くする方向へ倒さない ──────────────────────────────
 * `archivePolicy.ts` は「知らない表は退避しない」＝残す側へ倒した。
 * ここも同じ向きで、**迷ったら長く持つ。**
 *   - 版数が引けなければ**最大**（36 か月）ではなく既定（6 か月）…ではない。
 *     引けないのは一時的な障害でありうるので、**その回は何も消さない。**
 *     判断は `resolvePhotoRetentionMonths()` ではなく呼び出し側が行う。
 *   - 上書き値が短すぎれば版数の既定まで引き上げる（下げさせない）。
 *   - 上書き値が長すぎれば 36 か月で頭打ち。
 *
 * ── 期限の判定に業務日を使わない ────────────────────────
 * 保持期間は「アップロードからの経過」で、施設の日締めとは関係が無い。
 * `uploadedAt`（ミリ秒）をそのまま比べる。
 */

/** 版数（`schema/billing.ts` の `SUBSCRIPTION_PLANS`）。 */
export type PhotoRetentionPlan = "BASE" | "PRO" | "ENT";

/**
 * 版数ごとの既定の保持期間（§4.5 / security.md §4）。
 *
 * 「既定 6 か月・**上位プランで 13 か月**」。`PRO` から上を上位とする。
 */
export const PHOTO_RETENTION_DEFAULT_MONTHS: Readonly<Record<PhotoRetentionPlan, number>> = {
  BASE: 6,
  PRO: 13,
  ENT: 13,
};

/** 上限（§4.5「最大 36」）。**これ以上は延長できない。** */
export const PHOTO_RETENTION_MAX_MONTHS = 36;

/** 削除の何日前に通知するか（§4.5 MUST / security.md §4）。 */
export const PHOTO_RETENTION_NOTICE_DAYS = 30;

/**
 * その組織で実際に使う保持期間（月）。
 *
 * @param plan 契約している版数。
 * @param overrideMonths 組織が延長した値（`organization.photoRetentionMonths`）。
 *   未設定なら `null`。
 *
 * **上書きで短くはできない。** 版数の既定を下限にする。短くできると
 * 「設定を触ったら過去の写真がまとめて消えた」が起こりうるうえ、
 * §4.5 MUST が求めているのは「**必要なら期間延長できる**」ことだけ。
 */
export function resolvePhotoRetentionMonths(
  plan: PhotoRetentionPlan,
  overrideMonths: number | null,
): number {
  const base = PHOTO_RETENTION_DEFAULT_MONTHS[plan];
  if (overrideMonths === null || !Number.isInteger(overrideMonths)) return base;
  if (overrideMonths < base) return base;
  return Math.min(overrideMonths, PHOTO_RETENTION_MAX_MONTHS);
}

/**
 * その値を保持期間として受け付けてよいか（設定画面・API の検証用）。
 *
 * **範囲外を黙って丸めない。** `resolvePhotoRetentionMonths()` は
 * バッチが安全側へ倒すための関数で、入力の検証はこちら。
 */
export function isAcceptableRetentionMonths(months: number, plan: PhotoRetentionPlan): boolean {
  if (!Number.isInteger(months)) return false;
  return months >= PHOTO_RETENTION_DEFAULT_MONTHS[plan] && months <= PHOTO_RETENTION_MAX_MONTHS;
}

/**
 * この時刻より前にアップロードされた写真が削除対象、という境界（ミリ秒）。
 *
 * **境界そのものは含めない。** ちょうど期限の写真は残す側に倒す
 * （`archiveCutoffBusinessDate()` と同じ向き）。
 *
 * **`Date.now()` を呼ばない。** 現在時刻は引数で受ける（CLAUDE.md §5）。
 */
export function photoDeletionCutoffMs(now: Date, retentionMonths: number): number {
  return monthsBefore(now, retentionMonths);
}

/**
 * 「30 日以内に削除される」写真の上側の境界（ミリ秒）。
 *
 * `photoDeletionCutoffMs()` 以上・この値未満のものが通知の対象。
 * **既に消える回のものを通知に含めない。** 通知した 30 日後に消える、
 * という関係を保つ。
 */
export function photoNoticeCutoffMs(now: Date, retentionMonths: number): number {
  return monthsBefore(now, retentionMonths) + PHOTO_RETENTION_NOTICE_DAYS * 24 * 60 * 60 * 1000;
}

/** `now` の n か月前（UTC）。**月末の繰り上がりは `Date` に任せる。** */
function monthsBefore(now: Date, months: number): number {
  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth() - months,
    now.getUTCDate(),
    now.getUTCHours(),
    now.getUTCMinutes(),
    now.getUTCSeconds(),
    now.getUTCMilliseconds(),
  );
}

/** 1 枚の写真の、削除に対する立ち位置。 */
export type PhotoRetentionState =
  /** 期限を過ぎた。**この回で消える。** */
  | "EXPIRED"
  /** 30 日以内に期限が来る。**通知の対象。** */
  | "EXPIRING_SOON"
  /** まだ先。 */
  | "RETAINED";

/** `uploadedAtMs` がどれに当たるか。 */
export function photoRetentionStateOf(
  uploadedAtMs: number,
  now: Date,
  retentionMonths: number,
): PhotoRetentionState {
  if (uploadedAtMs < photoDeletionCutoffMs(now, retentionMonths)) return "EXPIRED";
  if (uploadedAtMs < photoNoticeCutoffMs(now, retentionMonths)) return "EXPIRING_SOON";
  return "RETAINED";
}

/**
 * 写真を持つ表（security.md §4）。**4 つ。**
 *
 * いずれも `storage_key`（R2 のキー）と `uploaded_at` を持つ。
 * **ここに無い表の写真は消えない。** 表が増えたときに書き足し忘れると
 * 「消えずに残る」＝取り返しのつく側に倒れる（`archivePolicy.ts` と同じ向き）。
 */
export const PHOTO_TABLES = [
  "task_photo",
  "inspection_photo",
  "issue_photo",
  "lost_item_photo",
] as const;

export type PhotoTable = (typeof PHOTO_TABLES)[number];

/**
 * 1 回のバッチで消す上限。
 *
 * **Workers の CPU 予算と R2 の呼び出し回数に対する歯止め。**
 * 超えたぶんは翌日の回で消える（日次なので必ず追いつく）。
 * 呼び出し側は「上限に達した」ことをログへ出すこと
 * （**黙って打ち切ると「消えた件数」の意味が変わる**）。
 */
export const PHOTO_DELETION_BATCH_LIMIT = 500;
