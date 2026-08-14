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

// ────────────────────────────────────────────────────────────
// 月次監査レポート（P4-14 / PK-SPEC-P4 §7）
// ────────────────────────────────────────────────────────────

/**
 * 重要度（§2.5）。**画面（`lib/reconciliation/labels.ts`）とは別に持つ。**
 * 帳票の文言は i18n を通さない（`no-literal-string` の対象外 / 冒頭の注記）。
 */
export const SEVERITY_LABELS: Record<string, string> = {
  HIGH: "重要度 高",
  MEDIUM: "重要度 中",
  LOW: "重要度 低",
};

/**
 * 差異の状態（§2.5）。
 *
 * **`FALSE_POSITIVE` を「誤検知」と書かない**（ui-writing.md §2）。
 * 帳票に出るのは「対象外」。
 */
export const FINDING_STATUS_LABELS: Record<string, string> = {
  OPEN: "未対応",
  REVIEWING: "確認中",
  RESOLVED: "対応済",
  FALSE_POSITIVE: "対象外",
  SUPPRESSED: "抑制",
};

/**
 * 月次監査レポートの固定文言（§7.1）。
 *
 * **免責文はここに無い。** `@pk/engine` の `AUDIT_REPORT_DISCLAIMER` が
 * 唯一の出どころで、テンプレートが直に読む（§7.2 MUST）。
 * ここへ写経しないこと。
 */
export const AUDIT_REPORT_LABELS = {
  title: "ProofKeeping 稼働照合レポート",
  property: "施設",
  period: "対象期間",
  engine: "エンジン / ルールセット",
  section1: "1. サマリー",
  section2: "2. 重要度別の推移（12か月）",
  section3: "3. 重要度 高 の全件詳細",
  section4: "4. 未対応項目一覧",
  section5: "5. ルール別の件数と対象外の割合",
  section6: "6. 免責事項",
  roomDays: "評価対象客室日数",
  sources: "利用可能な記録系統",
  total: "抽出された差異",
  suppressed: "抑制された差異",
  resolved: "対応済",
  dismissed: "対象外",
  open: "未対応",
  none: "該当なし",
  noValue: "—",
  sourceLabels: {
    occupancy: "稼働記録",
    observation: "現場観察",
    signal: "物理信号",
  } as Record<string, string>,
  trendColumns: ["対象月", "重要度 高", "重要度 中", "重要度 低"] as const,
  findingColumns: ["業務日", "部屋", "ルール", "内容", "確信度", "状態"] as const,
  ruleColumns: ["ルール", "名称", "件数", "対象外", "対象外の割合"] as const,
} as const;
