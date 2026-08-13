/**
 * 忘れ物の規則（PK-SPEC-P2 §7.2・§7.3）。**純粋関数。**
 *
 * task: docs/tasks/P2-11.md
 *
 * ── 自動廃棄をしないための形 ────────────────────────────
 * §7.3 MUST「『自動廃棄』はしない。期限が来ても責任者の明示操作が必要」。
 * このモジュールは**期限を計算し、警告の段階を返すだけ。**
 * `LostItemStatus` を返す関数を 1 つも置いていない。**期限から状態を
 * 導く関数をここへ足さないこと。** 足せた瞬間に、それを呼ぶバッチが
 * 書けるようになる。
 *
 * ── 法的判断をしない ────────────────────────────────────
 * §7.1「ProofKeeping は法的判断を自動化せず、期限管理と記録を支援する」。
 * 「警察へ届け出るべき」は返さない。返すのは**いつまでに責任者が
 * 判断するか**（`retentionDays`）と、**いま何色で出すか**（`warningLevel`）。
 */

/** 忘れ物の区分（`packages/db` の `LOST_ITEM_CATEGORIES` と同じ語彙。依存はさせない）。 */
export const LOST_ITEM_CATEGORY_VALUES = [
  "VALUABLE",
  "ELECTRONICS",
  "CLOTHING",
  "BAG",
  "MEDICINE",
  "FOOD",
  "DOCUMENT",
  "OTHER",
] as const;

export type LostItemCategoryValue = (typeof LOST_ITEM_CATEGORY_VALUES)[number];

/**
 * 警告の段階（§7.3 の「警告」欄）。
 *
 * | 値 | §7.3 の記述 |
 * |---|---|
 * | `URGENT` | 貴重品「発見直後から赤」/ 食品「即時」 |
 * | `ATTENTION` | 電子機器・書類・薬「7 日以内に責任者判断」（オレンジ）|
 * | `NORMAL` | 期限まで余裕がある |
 *
 * **`URGENT` は赤で出してよい唯一の場所。** ui-writing.md §3 が禁じるのは
 * 「経過時間超過の赤色表示」（清掃者を急かす表示）で、§7.3 が
 * 明示的に「発見直後から赤」と定めるここは別。
 */
export const LOST_ITEM_WARNING_LEVELS = ["NORMAL", "ATTENTION", "URGENT"] as const;

export type LostItemWarningLevel = (typeof LOST_ITEM_WARNING_LEVELS)[number];

/** 期限が近いことを知らせ始める日数（§7.3 の「期限 7 日前」）。 */
export const RETENTION_WARNING_DAYS = 7;

/**
 * §7.3 の既定の保持期限（日）。
 *
 * `null` は「施設設定に従う」。表の「施設設定（既定 90 日）」/
 * 「施設設定（既定 当日）」がこれにあたる。
 */
const DEFAULT_RETENTION_DAYS: Readonly<Record<LostItemCategoryValue, number | null>> = {
  // 「7 日以内に警察届出を促す」。**促すだけで、届け出はしない。**
  VALUABLE: 7,
  ELECTRONICS: 7,
  DOCUMENT: 7,
  MEDICINE: 7,
  // 「施設設定（既定 90 日）」
  CLOTHING: null,
  BAG: null,
  OTHER: null,
  // 「施設設定（既定 当日）」
  FOOD: null,
};

/** 施設設定の既定値（§7.3）。**施設が値を持たないときだけ使う。** */
export const DEFAULT_PROPERTY_RETENTION_DAYS = 90;
export const DEFAULT_FOOD_RETENTION_DAYS = 0;

/**
 * 保持日数を決める（§7.3）。
 *
 * @param propertyRetentionDays 施設設定。**未設定なら `null` を渡す。**
 * @returns 発見日から数えた日数。`0` は当日（食品）。
 */
export function retentionDaysFor(
  category: LostItemCategoryValue,
  propertyRetentionDays: number | null,
): number {
  const fixed = DEFAULT_RETENTION_DAYS[category];
  if (fixed !== null) return fixed;
  if (category === "FOOD") {
    // **食品だけは施設設定より短い側を採る。** 施設が 90 日と設定していても
    // 食品を 90 日置く運用は成り立たない（§7.3 は「当日」）。
    return propertyRetentionDays === null
      ? DEFAULT_FOOD_RETENTION_DAYS
      : Math.min(propertyRetentionDays, DEFAULT_FOOD_RETENTION_DAYS);
  }
  return propertyRetentionDays ?? DEFAULT_PROPERTY_RETENTION_DAYS;
}

/**
 * 保持期限の時刻（§7.3）。
 *
 * **発見時刻に日数を足すだけ。** 業務日の境（05:00 / architecture.md §7）へ
 * 丸めていない。期限は「発見から N 日」であって「業務日で N 日後」ではなく、
 * 丸めると発見が深夜だった品物の期限が 1 日ずれる。
 */
export function retentionDueAtMs(
  foundAtMs: number,
  category: LostItemCategoryValue,
  propertyRetentionDays: number | null,
): number {
  return foundAtMs + retentionDaysFor(category, propertyRetentionDays) * 86_400_000;
}

/**
 * いま何色で出すか（§7.3）。
 *
 * **期限を過ぎていても `URGENT` を返すだけで、状態は変えない**（冒頭の注記）。
 *
 * @param nowMs 現在時刻。**この関数の中で時計を読まない**（CLAUDE.md §5）。
 */
export function warningLevelFor(
  category: LostItemCategoryValue,
  retentionDueAtMsValue: number,
  nowMs: number,
): LostItemWarningLevel {
  // 貴重品は「発見直後から赤」。期限に関わらず。
  if (category === "VALUABLE") return "URGENT";
  // 食品は「即時」。
  if (category === "FOOD") return "URGENT";

  if (nowMs >= retentionDueAtMsValue) return "URGENT";

  const remainingMs = retentionDueAtMsValue - nowMs;
  if (remainingMs <= RETENTION_WARNING_DAYS * 86_400_000) return "ATTENTION";

  // 電子機器・書類・薬は「7 日以内に責任者判断」＝常にオレンジ。
  // 上の期限判定を通り抜けるのは保持日数が 7 を超える場合だけなので、
  // ここへは来ないが、**区分の意図を式に残しておく。**
  if (category === "ELECTRONICS" || category === "DOCUMENT" || category === "MEDICINE") {
    return "ATTENTION";
  }
  return "NORMAL";
}

/**
 * 管理番号（§7.2）。
 *
 * ```
 * LNF-{施設コード}-{YYYYMMDD}-{4桁連番}
 * 例: LNF-HTLA-20260910-0003
 * ```
 *
 * **連番は呼び出し側が決める。** ここは形だけを作る。採番は
 * 「その施設・その業務日の最大値 + 1」で、リポジトリ層が行う
 * （`DocumentSequencer` を使わない理由は `repositories/lostItem.ts` の注記）。
 *
 * @param sequence 1 始まり。9999 を超えたら 5 桁になる（**切り詰めない。**
 *   桁で切ると番号が重複する）。
 */
export function lostItemManagementNo(
  propertyCode: string,
  businessDate: string,
  sequence: number,
): string {
  const date = businessDate.replaceAll("-", "");
  return `LNF-${propertyCode}-${date}-${String(sequence).padStart(4, "0")}`;
}
