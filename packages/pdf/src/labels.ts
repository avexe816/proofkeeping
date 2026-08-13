/**
 * 日報の文言（PK-SPEC-P2 §9.2）。
 *
 * task:  docs/tasks/P2-14.md
 * ルール: .claude/rules/ui-writing.md §2（禁止語）
 *
 * ── なぜここに日本語があるのか ──────────────────────────
 * 帳票は**画面ではなく文書**で、施設へ提出する紙（PDF）になる。
 * 管理画面は日本語のみ（ui-writing.md §1）であり、日報の宛先は
 * 施設と清掃会社なので、`t("key")` の多言語の対象にしていない。
 * **`apps/web/src/locales` を引かないのは依存の向きの問題でもある**
 * （`@pk/pdf` は Queue コンシューマから使われるライブラリで、
 * 画面の文言カタログに依存させない）。
 *
 * ESLint の `pk/no-forbidden-words` は `packages/pdf/**` を対象に含めている
 * （`packages/config/eslint/base.js`）。ここに「不正」「監視」「異常」の類を
 * 書けば CI が落ちる。**言い換えの表は ui-writing.md §2。**
 */

/** 見出しと固定文言。 */
export const DAILY_REPORT_LABELS = {
  title: "ProofKeeping 清掃実績日報",
  property: "施設",
  businessDate: "業務日",
  generatedAt: "生成日時",
  documentNo: "文書番号",
  revision: "版",
  summary: "サマリー",
  details: "明細",
  incomplete: "未完了・入室不可",
  findings: "不具合・忘れ物",
  documentHash: "文書ハッシュ",
  payloadSha256: "SHA-256",
  none: "該当なし",
  /** 版が 2 以上のときに冒頭へ出す。**旧版が残っていることを明示する。** */
  supersedes: "この日報は再生成された版です。前の版も保管されています。",
} as const;

/** サマリーの行見出し（§9.2 の 8 項目）。 */
export const SUMMARY_LABELS = {
  totalTasks: "対象タスク",
  completedTasks: "完了",
  incompleteTasks: "未完了",
  inspectedTasks: "検査対象",
  passedFirstRound: "初回合格",
  reworkedTasks: "差戻し",
  passedAfterRework: "再清掃後合格",
  selfInspectedTasks: "自己検査",
} as const;

/** 明細の列見出し（§9.2）。 */
export const DETAIL_COLUMNS = [
  "部屋",
  "種別",
  "担当",
  "開始",
  "完了",
  "実作業分",
  "検査者",
  "結果",
  "再清掃",
] as const;

/** 未完了・入室不可の列見出し（§9.2）。 */
export const INCOMPLETE_COLUMNS = ["部屋", "理由", "現在状態", "対応者"] as const;

/** 不具合・忘れ物の列見出し（§9.2）。 */
export const FINDING_COLUMNS = ["管理番号", "部屋", "種類", "状態"] as const;

/** タスク種別（`schema/task.ts` の `TASK_TYPES`）。 */
export const TASK_TYPE_LABELS: Record<string, string> = {
  CHECKOUT: "アウト",
  STAYOVER: "ステイ",
  DEEP: "定期",
  COMMON_AREA: "共用部",
  RECHECK: "再確認",
};

/** タスクの状態（同 `TASK_STATUSES`）。 */
export const TASK_STATUS_LABELS: Record<string, string> = {
  CREATED: "未割当",
  ASSIGNED: "割当済",
  IN_PROGRESS: "作業中",
  PAUSED: "中断",
  AWAITING_INSPECTION: "検査待ち",
  REWORK: "再清掃",
  COMPLETED: "完了",
  BLOCKED: "入室不可",
  CANCELLED: "取消",
};

/** 検査結果（同 `INSPECTION_RESULTS`）。 */
export const INSPECTION_RESULT_LABELS: Record<string, string> = {
  PASS: "合格",
  FAIL: "差戻し",
};

/** 忘れ物の区分（`schema/report.ts` の `LOST_ITEM_CATEGORIES`）。 */
export const LOST_ITEM_CATEGORY_LABELS: Record<string, string> = {
  VALUABLE: "貴重品",
  ELECTRONICS: "電子機器",
  CLOTHING: "衣類",
  BAG: "かばん",
  MEDICINE: "薬",
  FOOD: "飲食物",
  DOCUMENT: "書類",
  OTHER: "その他",
};

/** 忘れ物の状態（同 `LOST_ITEM_STATUSES`）。 */
export const LOST_ITEM_STATUS_LABELS: Record<string, string> = {
  FOUND: "発見",
  STORED: "保管中",
  REPORTED_TO_POLICE: "警察届出",
  RETURN_PENDING: "返却待ち",
  RETURNED: "返却済",
  DISPOSED: "処分済",
  TRANSFERRED: "引継ぎ",
};

/** 不具合の区分（同 `ISSUE_CATEGORIES`）。 */
export const ISSUE_CATEGORY_LABELS: Record<string, string> = {
  CLEANING: "清掃",
  PLUMBING: "水まわり",
  ELECTRICAL: "電気",
  HVAC: "空調",
  FURNITURE: "什器",
  AMENITY: "備品",
  SAFETY: "安全",
  OTHER: "その他",
};

/** 不具合の状態（同 `ISSUE_STATUSES`）。 */
export const ISSUE_STATUS_LABELS: Record<string, string> = {
  OPEN: "未対応",
  ACKNOWLEDGED: "受付済",
  IN_PROGRESS: "対応中",
  RESOLVED: "解決",
  CLOSED: "完了",
  WONT_FIX: "対応しない",
};

/**
 * 訳語を引く。**無ければ元の値をそのまま返す。**
 *
 * 語彙が増えた日に PDF が空欄になるより、英字のまま出るほうが調べられる。
 */
export function labelOf(table: Record<string, string>, value: string | null): string {
  if (value === null) return "";
  return table[value] ?? value;
}
