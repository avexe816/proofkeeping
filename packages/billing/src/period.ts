/**
 * 月次締めの期間と状態遷移（PK-SPEC-P5 §2.8・§6.1）。
 *
 * task: docs/tasks/P5-05.md
 *
 * ── 純粋関数 ────────────────────────────────────────────
 * DB・fetch・環境変数・`Date.now()` を持ち込まない（CLAUDE.md §5）。
 * 「今日」は `onDate`（`YYYY-MM-DD`）で受け取る。暦の計算は UTC の
 * `Date` で行うが、**扱っているのは時刻ではなく暦日**なので
 * タイムゾーンは関係しない（`businessDate` と同じ考え方 /
 * architecture.md §7）。
 *
 * ── 締め日は取引先ごと ──────────────────────────────────
 * `counterparty.closingDay`（1〜31、31 は月末の意味 / §2.1）。
 * 20 日締めの取引先の 9 月分は **8/21 〜 9/20**。暦月とは限らない。
 */

/** 月次締めの状態（§2.8）。`packages/db` の `BILLING_PERIOD_STATUSES` と同じ語彙。 */
export const BILLING_PERIOD_STATUS_VALUES = [
  "OPEN",
  "REVIEWING",
  "AGREED",
  "INVOICED",
  "CLOSED",
] as const;

export type BillingPeriodStatusValue = (typeof BILLING_PERIOD_STATUS_VALUES)[number];

/** 期間（両端を含む）。`YYYY-MM-DD`。 */
export interface BillingPeriodRange {
  periodFrom: string;
  periodTo: string;
}

function lastDayOfMonth(year: number, month: number): number {
  // month は 1〜12。翌月の 0 日目 = 当月の末日。
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function ymd(year: number, month: number, day: number): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${String(year).padStart(4, "0")}-${pad(month)}-${pad(day)}`;
}

/**
 * その月の締め日（`closingDay` がその月に無ければ末日）。
 *
 * **31 日締めは「月末」の意味**（§2.1）。2 月は 28 日（閏年は 29 日）に
 * なる。30 日締めの 2 月も同じ扱いで、締め日が消えて期間が飛ばない。
 */
export function closingDateOf(year: number, month: number, closingDay: number): string {
  return ymd(year, month, Math.min(closingDay, lastDayOfMonth(year, month)));
}

/** `YYYY-MM-DD` を 1 日進める。**暦日の計算**（時刻を持たない）。 */
function nextDate(date: string): string {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + 1);
  return shifted.toISOString().slice(0, 10);
}

/**
 * `onDate` の時点で**直近に締まった**期間を返す。
 *
 * 締め日が `onDate` より前にあるものだけを対象にする。毎月 1 日 04:00 の
 * バッチ（§6.1）が 10/1 に走ると、月末締めなら 9/1〜9/30、
 * 20 日締めなら 8/21〜9/20 を返す。
 *
 * **まだ締まっていない期間を返さない。** 締め日当日に走らせても、
 * その日の分は翌月の集計に入る（締め日は期間に含まれるので、
 * 当日の作業がまだ増えうる）。
 */
export function closedPeriodAsOf(closingDay: number, onDate: string): BillingPeriodRange {
  const year = Number(onDate.slice(0, 4));
  const month = Number(onDate.slice(5, 7));

  // 当月の締め日が `onDate` より前ならそれが直近。そうでなければ前月。
  let toYear = year;
  let toMonth = month;
  if (closingDateOf(year, month, closingDay) >= onDate) {
    toMonth -= 1;
    if (toMonth === 0) {
      toMonth = 12;
      toYear -= 1;
    }
  }

  const periodTo = closingDateOf(toYear, toMonth, closingDay);

  let fromYear = toYear;
  let fromMonth = toMonth - 1;
  if (fromMonth === 0) {
    fromMonth = 12;
    fromYear -= 1;
  }
  const periodFrom = nextDate(closingDateOf(fromYear, fromMonth, closingDay));

  return { periodFrom, periodTo };
}

// ────────────────────────────────────────────────────────────
// 状態遷移（§6.1）
// ────────────────────────────────────────────────────────────

/**
 * 月次締めに対して起こせること。
 *
 * ```
 * OPEN
 *   │ AGGREGATE（月次集計バッチ・毎月 1 日 04:00）
 *   v
 * REVIEWING ──┬─ AGREE ──> AGREED ─ ISSUE_INVOICE ─> INVOICED ─ CLOSE ─> CLOSED
 *             └─ REJECT（差戻し。AGREED からも戻れる）
 * ```
 *
 * **`REQUEST_REVIEW` を置いていない。** §9 の API 一覧にはあるが、
 * §2.8 の状態は 5 つで「ホテルの確認待ち」に当たる値が無い。状態を
 * 増やすのは仕様に根拠のない設計選択（workflow.md §6）なので、
 * 確認依頼と差戻しコメントは**双方合意フローの task（P5-12）**が
 * 通知と履歴の表を持って実装する。docs/OPEN_QUESTIONS.md #072。
 */
export const BILLING_PERIOD_ACTIONS = [
  "AGGREGATE",
  "AGREE",
  "REJECT",
  "ISSUE_INVOICE",
  "CLOSE",
] as const;

export type BillingPeriodAction = (typeof BILLING_PERIOD_ACTIONS)[number];

const TRANSITIONS: Readonly<
  Record<BillingPeriodAction, { from: readonly BillingPeriodStatusValue[]; to: BillingPeriodStatusValue }>
> = {
  AGGREGATE: { from: ["OPEN"], to: "REVIEWING" },
  AGREE: { from: ["REVIEWING"], to: "AGREED" },
  // 差戻しは合意のあとにも起こる（§6.1 の「差戻し → REVIEWING」）。
  REJECT: { from: ["REVIEWING", "AGREED"], to: "REVIEWING" },
  // **請求書を出したあとに集計をやり直さない**（§2.8 の注記）。
  ISSUE_INVOICE: { from: ["AGREED"], to: "INVOICED" },
  CLOSE: { from: ["INVOICED"], to: "CLOSED" },
};

/** `evaluateBillingPeriodTransition()` の結果。 */
export type BillingPeriodTransition =
  | { allowed: true; next: BillingPeriodStatusValue }
  | { allowed: false; reason: "INVALID_TRANSITION" };

/**
 * その状態でその操作を起こしてよいか。
 *
 * **`allowed: false` を 404 に写すのは呼び出し側**（越境と取り違えない）。
 * ここは状態だけを見る。権限は `assertPermission()`、テナントは
 * リポジトリ層の責務。
 */
export function evaluateBillingPeriodTransition(
  current: BillingPeriodStatusValue,
  action: BillingPeriodAction,
): BillingPeriodTransition {
  const rule = TRANSITIONS[action];
  if (!rule.from.includes(current)) return { allowed: false, reason: "INVALID_TRANSITION" };
  return { allowed: true, next: rule.to };
}

// ────────────────────────────────────────────────────────────
// 取引先が受け持つ施設（§3.1 の「対象」を決めるのに要る）
// ────────────────────────────────────────────────────────────

/**
 * 取引先の施設範囲。
 *
 * ── 仕様に対応表が無い ──────────────────────────────────
 * §3.1 は集計対象を「期間内に `COMPLETED` となった CleaningTask」と
 * するが、**どの施設のタスクかを決める表が §2 に無い。** 施設
 * （`property`）は `counterpartyId` を持たず、取引先も施設の一覧を
 * 持たない。docs/OPEN_QUESTIONS.md #071。
 *
 * 唯一その対応を持っているのが**料金設定**で、§2.2 は
 * `pricingRule.propertyId` の null を「取引先の全施設」と定めている。
 * ここから導く。表を新設すると仕様の版上げが要る（推測で実装しない /
 * CLAUDE.md §1-4）。
 */
export type CounterpartyPropertyScope =
  | { kind: "ALL_PROPERTIES" }
  | { kind: "LISTED"; propertyIds: string[] };

/**
 * 料金設定から取引先の施設範囲を導く。
 *
 * `propertyId` が null の行が 1 つでもあれば「全施設」。そうでなければ
 * 料金設定に現れる施設だけ。**有効期間で絞らない** — 期間の途中で
 * 切れた料金設定しか無い施設も、その期間の作業は請求の対象になる
 * （単価が引けなければ ¥0 明細＋警告 / §3.2 MUST）。
 */
export function counterpartyPropertyScope(
  rules: readonly { propertyId: string | null }[],
): CounterpartyPropertyScope {
  const listed = new Set<string>();
  for (const rule of rules) {
    if (rule.propertyId === null) return { kind: "ALL_PROPERTIES" };
    listed.add(rule.propertyId);
  }
  return { kind: "LISTED", propertyIds: [...listed].sort() };
}
