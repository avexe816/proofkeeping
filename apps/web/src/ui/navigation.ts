/**
 * サイドバーのナビゲーション登録簿。**純粋データと絞り込みだけ。**
 *
 * task:  docs/tasks/P0-14.md
 * 参照:  ui-prototypes/owner/pkown-v3-A-login-daily.html（4 セクション 12 項目）
 * ルール: .claude/rules/security.md §1 / .claude/rules/ui-writing.md §1
 *
 * ── 3 つの状態を混ぜない ────────────────────────────────
 *
 * | 状態 | 見え方 | 根拠 |
 * |---|---|---|
 * | 権限が無い | **項目ごと消す** | 404 の世界。存在を示唆しない（security.md §1） |
 * | 契約が無い | グレー＋案内 | 買えば使える。存在を隠す理由が無い（402） |
 * | 画面が未実装 | 淡色＋「準備中」 | 到達先がまだ無い |
 *
 * `CLEANER` / `INSPECTOR` に差異レポートの項目を「グレーで」出してはならない。
 * グレーは「契約すれば見られる」という意味になる。
 *
 * ── ここでの表示制御は権限制御ではない ──────────────────
 * フロントでのメニュー非表示は UX 上の措置（security.md §1）。
 * 各画面の API は `assertPermission()` → `assertEntitlement()` を必ず別に通すこと。
 *
 * ── `action` の暫定的な当て方 ───────────────────────────
 * P0-10 は「各画面の権限は、その画面を作る task が `PERMISSION_ACTIONS` に
 * 1 行足す」と定めており、画面固有の行はまだ 1 つも無い。
 * そこで `PLANNED` の項目には**その画面へ到達する前提として最低限必要な操作**
 * （施設を見られること＝`property.read` など）を置いてある。
 * **各画面の task は、自分の行を `PERMISSION_ACTIONS` に足してここを差し替えること。**
 * 推測でマトリクスに行を足さないための暫定であって、権限の定義ではない。
 */

import type { ModuleCode, TenantContext } from "@pk/db";

import {
  ORGANIZATION_TARGET,
  can,
  propertyTarget,
  type PermissionAction,
} from "../lib/auth/permission.js";
import type { MessageKey } from "../lib/i18n.js";

/** サイドバーの見出し（プロトタイプの 4 セクション）。 */
export const NAV_SECTIONS = ["daily", "records", "analysis", "settings"] as const;

export type NavSection = (typeof NAV_SECTIONS)[number];

/** 見出しの文言キー。 */
export const NAV_SECTION_LABEL: Record<NavSection, MessageKey> = {
  daily: "nav.section.daily",
  records: "nav.section.records",
  analysis: "nav.section.analysis",
  settings: "nav.section.settings",
};

/**
 * 項目の状態。
 *
 * `READY` は `href` を必ず持つ（型で強制する）。画面を作る task が
 * `PLANNED` → `READY` に変え、`href` を足す。
 */
interface NavItemBase {
  key: MessageKey;
  section: NavSection;
  /**
   * 項目のアイコン（A01 §4.1「アイコン + ラベル + 件数バッジ」）。
   *
   * **絵文字 1 文字。** 画像を持たないのは、サイドバーのためだけに
   * スプライトや font を足すと、色とサイズの調整先が 2 つに増えるため。
   * 幅は CSS（`.pk-nav__icon`）で固定してラベルの左端を揃える。
   */
  icon: string;
  /** 未契約ならグレー表示にするモジュール（P0-12）。 */
  moduleCode: ModuleCode;
  /** 権限判定の操作。**全項目が必ず持つ。** */
  action: PermissionAction;
  /** 権限の対象。施設の画面か、組織全体の画面か。 */
  scope: "ORGANIZATION" | "PROPERTY";
}

/**
 * `href` は `{propertyId}` を含んでよい（PK-SPEC-P0 §23.5 の
 * `/app/p/{propertyId}/board`）。差し替えは `buildNavigation()` が行い、
 * **表示中の施設が無いときはその項目を出さない**（到達先が無いため）。
 */
export const PROPERTY_ID_PLACEHOLDER = "{propertyId}";

export type NavItem =
  (NavItemBase & { status: "READY"; href: string }) | (NavItemBase & { status: "PLANNED" });

/**
 * ナビゲーションの全項目。**プロトタイプの並び順そのまま。**
 *
 * URL に施設 ID を含める形（`/app/p/{propertyId}/board` — PK-SPEC-P0 §23.5）は
 * **P0-21 の担当**。P0-14 は `/app/dashboard` だけを実在させる。
 */
export const NAV_ITEMS: readonly NavItem[] = [
  // ── 日次運用 ──────────────────────────────────────────
  {
    key: "nav.dashboard",
    icon: "📊",
    section: "daily",
    moduleCode: "HOUSEKEEPING_CORE",
    action: "property.read",
    scope: "PROPERTY",
    status: "READY",
    href: "/app/dashboard",
  },
  {
    key: "nav.board",
    icon: "🏨",
    section: "daily",
    moduleCode: "HOUSEKEEPING_CORE",
    action: "property.read",
    scope: "PROPERTY",
    status: "READY",
    href: `/app/p/${PROPERTY_ID_PLACEHOLDER}/board`,
  },
  // P7-19 進捗モニタ。**施設横断**の画面で URL に施設 ID を持たない
  // （`nav.inspection` と同じ形）。操作は `property.read` なので
  // 施設スコープロールは担当施設ぶんだけが見える。
  {
    key: "nav.progress",
    icon: "📶",
    section: "daily",
    moduleCode: "HOUSEKEEPING_CORE",
    action: "property.read",
    scope: "PROPERTY",
    status: "READY",
    href: "/app/ops/progress",
  },
  // W-04（P1-14）。**`task.manage`。** 配分は施設責任者の判断で、
  // 「盤面が見える人＝配れる人」ではない（§10.1 / §5.3）。
  {
    key: "nav.tasks",
    icon: "🧹",
    section: "daily",
    moduleCode: "HOUSEKEEPING_CORE",
    action: "task.manage",
    scope: "PROPERTY",
    status: "READY",
    href: `/app/p/${PROPERTY_ID_PLACEHOLDER}/tasks`,
  },
  // W-05（P1-04 の未達分）。**`roomPlan.write`。** 当日の客室状況は
  // 入力する画面で、読むだけの人が辿る先ではない（§10.1 の `P_MANAGER 以上`）。
  {
    key: "nav.plan",
    icon: "🛏️",
    section: "daily",
    moduleCode: "HOUSEKEEPING_CORE",
    action: "roomPlan.write",
    scope: "PROPERTY",
    status: "READY",
    href: `/app/p/${PROPERTY_ID_PLACEHOLDER}/plan`,
  },
  // ops 02 シフトと割当（P8-03）。「日次運用」の進捗モニタの後。
  // 門は shift.manage（OWNER / ORG_ADMIN のみ / OPEN_QUESTIONS #112）。
  {
    key: "nav.shifts",
    icon: "🗓️",
    section: "daily",
    moduleCode: "PLATFORM",
    action: "shift.manage",
    scope: "ORGANIZATION",
    status: "READY",
    href: "/app/shifts",
  },
  // W-06 差異レポート一覧（P4-06 / PK-SPEC-P4 §6.1）。
  // **`href` に `{propertyId}` を持たない。** §6.1 のフィルタは「全施設」を
  // 含み、施設は画面のセレクタで切り替える。`scope` を `PROPERTY` のままに
  // してあるのは、施設スコープロール（`PROPERTY_MANAGER` / `VENDOR_ADMIN`）に
  // 出すため。組織全体を読めない相手には表示中の施設が既定になる。
  {
    key: "nav.findings",
    icon: "⚠️",
    section: "daily",
    moduleCode: "AUDIT",
    action: "finding.read",
    scope: "PROPERTY",
    status: "READY",
    href: "/app/audit/findings",
  },
  // ── 記録の確認 ────────────────────────────────────────
  // W-07 差異詳細（P4-07 / 人間の指示 2026-08-17 で入口を実装）。
  // ID の無いサイドバーからは 1 件を指せないので、**「次に確認する 1 件」へ
  // 直行する入口**（`/app/audit/findings/next`）に繋ぐ。未確認が無ければ
  // 空状態が出る。個別の詳細へは従来どおり一覧の行からも入れる。
  {
    key: "nav.findingDetail",
    icon: "🔍",
    section: "records",
    moduleCode: "AUDIT",
    action: "finding.read",
    scope: "PROPERTY",
    status: "READY",
    href: "/app/audit/findings/next",
  },
  // W-06 証跡一覧（P2-09 / PK-SPEC-P2 §12.1）。**`task.read`。**
  // 中身はタスクの記録なので、それを読める相手が辿れる先にする
  // （`routes/api/v1/tasks.ts` の `/evidence/verify` と同じ判断）。
  // ZIP の持ち出しだけが別の権限（`evidence.export`）。
  {
    key: "nav.cleaningRecords",
    icon: "📋",
    section: "records",
    moduleCode: "HOUSEKEEPING_CORE",
    action: "task.read",
    scope: "PROPERTY",
    status: "READY",
    href: `/app/p/${PROPERTY_ID_PLACEHOLDER}/evidence`,
  },
  // W-09 忘れ物管理（P7-22 / PK-SPEC-P2 §12.1）。**`lostItem.read`。**
  // `CLEANER` にも出る（自分が登録した分だけが見える / §7.4 — 絞りは lib）。
  // 保管場所・返却先の出し分けは `lostItem.readStorage`（画面側で判定）。
  {
    key: "nav.lostItems",
    icon: "🧳",
    section: "records",
    moduleCode: "HOUSEKEEPING_CORE",
    action: "lostItem.read",
    scope: "PROPERTY",
    status: "READY",
    href: `/app/p/${PROPERTY_ID_PLACEHOLDER}/lost-found`,
  },
  // W-10 不具合管理（P7-22 / 同 §12.1）。**`issue.read`。**
  {
    key: "nav.issues",
    icon: "🔧",
    section: "records",
    moduleCode: "HOUSEKEEPING_CORE",
    action: "issue.read",
    scope: "PROPERTY",
    status: "READY",
    href: `/app/p/${PROPERTY_ID_PLACEHOLDER}/issues`,
  },
  // 検査キュー（P7-18 / ui-prototypes/ops/pkops-A-daily-quality.html 04）。
  // **`action` を `property.read` から `inspection.read` へ差し替えた。**
  // 冒頭「`action` の暫定的な当て方」が言う「画面を作る task が差し替える」
  // のがこれ。`property.read` のままだと `CLEANER` の項目が残る
  // （あちらは現場ロールにも配られている）。
  // **`href` に `{propertyId}` を持たない。** 施設横断の一覧で、施設は
  // 画面のセレクタで絞る（`nav.findings` と同じ判断）。
  {
    key: "nav.inspection",
    icon: "👁️",
    section: "records",
    moduleCode: "HOUSEKEEPING_CORE",
    action: "inspection.read",
    scope: "PROPERTY",
    status: "READY",
    href: "/app/inspections/queue",
  },
  // ── 資材と分析 ────────────────────────────────────────
  // W-22 データ品質ダッシュボード（P3-12 / PK-SPEC-P3 §6.3）。
  // **`scope` は `PROPERTY`。** 施設と月で見る画面で、URL に施設 ID を持つ。
  {
    key: "nav.dataQuality",
    icon: "📈",
    section: "analysis",
    moduleCode: "HOUSEKEEPING_CORE",
    action: "dataQuality.read",
    scope: "PROPERTY",
    status: "READY",
    href: `/app/p/${PROPERTY_ID_PLACEHOLDER}/data-quality`,
  },
  // リネン消費の独立項目は**置かない**（人間の指示 2026-08-17）。
  // 集計は進捗モニタの列として実装済み（第3批-09 / DECISIONS #195 の運用）。
  // 「準備中」のまま押せない項目を残さない。
  // 月次レポート（owner 09 / docs/PROTOTYPE_GAP.md 第2批 09）。
  // **`action` を `property.read` から `finding.read` へ差し替えた**
  // （冒頭「`action` の暫定的な当て方」の差し替え）。§3 に差異の内訳が
  // 載るので、差異へ到達できないロールには項目ごと出さない。
  {
    key: "nav.report",
    icon: "📄",
    section: "analysis",
    moduleCode: "AUDIT",
    action: "finding.read",
    scope: "PROPERTY",
    status: "READY",
    href: `/app/p/${PROPERTY_ID_PLACEHOLDER}/report`,
  },
  // 請求確認（P5-19 / PK-SPEC-P5 §6）。**発注元（CLIENT_VIEWER）にも出す**
  // 唯一の請求系項目。門は `billing.read`（発注元はリポジトリ層が自分の
  // 取引先の期間に絞る）。運営側の「契約と請求」（billing.readInternal）とは
  // 別 — あちらは発注元に出ない。
  {
    key: "nav.billingPeriods",
    icon: "🤝",
    section: "analysis",
    moduleCode: "BILLING",
    action: "billing.read",
    scope: "ORGANIZATION",
    status: "READY",
    href: "/app/billing-periods",
  },
  // 契約と請求（owner 10 / 人間の指示 2026-08-17: 銀行振込前提で実装）。
  // **`scope` を `ORGANIZATION` へ差し替えた。** 請求書は組織の資源で、
  // API（/api/v1/invoices）も `ORGANIZATION_TARGET` で判定している。
  {
    key: "nav.billing",
    icon: "💴",
    section: "analysis",
    moduleCode: "BILLING",
    action: "billing.readInternal",
    scope: "ORGANIZATION",
    status: "READY",
    href: "/app/billing",
  },
  // §7.2 清掃会社プラン（P5-15）。**`moduleCode` は `VENDOR_PLAN`。**
  // 受託の収支を見る画面で、請求書を作れること（`BILLING`）とは別に売る
  // （PK-SPEC-P7 §3.1 のモジュール一覧に `VENDOR_PLAN` がある）。
  // **`scope` は `ORGANIZATION`。** 受託施設を横断して組織平均と比べる
  // 画面で、1 施設ぶんだけを出しても §7.2 MUST の判定が成り立たない。
  {
    key: "nav.vendorPlan",
    icon: "🏢",
    section: "analysis",
    moduleCode: "VENDOR_PLAN",
    action: "billing.readInternal",
    scope: "ORGANIZATION",
    status: "READY",
    href: "/app/org/vendor-plan",
  },
  // 支払集計（P5-18 / docs/PK-SPEC-PAY.md §3）。清掃会社プランの直後。
  // 門は payout.read（OWNER / ORG_ADMIN のみ / PAY §4）。
  {
    key: "nav.payouts",
    icon: "💴",
    section: "analysis",
    moduleCode: "BILLING",
    action: "payout.read",
    scope: "ORGANIZATION",
    status: "READY",
    href: "/app/org/payouts",
  },
  // ── 設定 ──────────────────────────────────────────────
  // ここまで `/app/settings/*` の 3 画面（客室マスタ・事業者税務・そして
  // 今回の 2 つ）は**サイドバーに現れなかった。** ルートは実在するのに
  // 到達経路が無く、URL を直に打つしか無い状態だった。
  {
    key: "nav.rooms",
    icon: "🚪",
    section: "settings",
    moduleCode: "HOUSEKEEPING_CORE",
    action: "property.write",
    scope: "PROPERTY",
    status: "READY",
    href: "/app/settings/rooms",
  },
  // W-25 客室タイプ管理（P1-24）。**客室マスタの直後に置く。**
  // W-16 / W-17 は客室タイプが 1 件も無いと設定を始められないので、
  // 設定の並びとしてはこちらが先に目に入る必要がある。
  // `scope` は `PROPERTY`（`room_type` は施設ごとのマスタ）。
  {
    key: "nav.roomTypes",
    icon: "🛎️",
    section: "settings",
    moduleCode: "HOUSEKEEPING_CORE",
    action: "property.write",
    scope: "PROPERTY",
    status: "READY",
    href: "/app/settings/room-types",
  },
  // W-16 / W-17（P1-06 / P1-02 の未達分）。§10.1 の担当ロールは `ORG_ADMIN`。
  // **`scope` は `ORGANIZATION`。** 権限マトリクスがこの 2 操作を組織単位で
  // 定めており、施設スコープロールには項目ごと出ない。
  {
    key: "nav.checklists",
    icon: "☑️",
    section: "settings",
    moduleCode: "HOUSEKEEPING_CORE",
    action: "checklistTemplate.write",
    scope: "ORGANIZATION",
    status: "READY",
    href: "/app/settings/checklists",
  },
  {
    key: "nav.standardTimes",
    icon: "⏱️",
    section: "settings",
    moduleCode: "HOUSEKEEPING_CORE",
    action: "standardTime.write",
    scope: "ORGANIZATION",
    status: "READY",
    href: "/app/settings/standard-times",
  },
  // W-20 観察項目の設定（P3-11 / PK-SPEC-P3 §6.1）。担当ロールは `ORG_ADMIN`。
  // **`scope` は `ORGANIZATION`**（上の 2 つと同じ理由）。設定の対象は
  // 表示中の施設だが、到達できるロールは組織単位で決まる。
  {
    key: "nav.observationSettings",
    icon: "👀",
    section: "settings",
    moduleCode: "HOUSEKEEPING_CORE",
    action: "observationConfig.write",
    scope: "ORGANIZATION",
    status: "READY",
    href: "/app/settings/observation",
  },
  // W-21 ベースライン確認・上書き（P3-10 / PK-SPEC-P3 §5.5・§6.1）。
  // 担当ロールは `ORG_ADMIN`（上書きできるのはこのロールだけ / §5.5）。
  // **`scope` は `ORGANIZATION`**（W-20 と同じ理由）。
  // W-25 ルール設定（P4-13 / PK-SPEC-P4 §2.7）。**`ruleConfig.read`。**
  // §6.4 の表で `OWNER` / `ORG_ADMIN` だけ（`AUDITOR` は読み取り）。
  {
    key: "nav.rules",
    icon: "⚖️",
    section: "settings",
    moduleCode: "AUDIT",
    action: "ruleConfig.read",
    scope: "PROPERTY",
    status: "READY",
    href: "/app/settings/rules",
  },
  {
    key: "nav.baseline",
    icon: "📐",
    section: "settings",
    moduleCode: "HOUSEKEEPING_CORE",
    action: "baseline.override",
    scope: "ORGANIZATION",
    status: "READY",
    href: "/app/settings/baseline",
  },
  // W-11 事業者・税務設定（P0-16）。**`PLATFORM`。** 登録番号の設定は
  // 請求モジュールの契約が無くても要る（未設定でも画面は成立する / P0-16）。
  {
    key: "nav.taxProfile",
    icon: "🧾",
    section: "settings",
    moduleCode: "PLATFORM",
    action: "taxProfile.write",
    scope: "ORGANIZATION",
    status: "READY",
    href: "/app/settings/tax",
  },
  // 取引先と料金（P5-02 / P5-03 / PK-SPEC-P5 §2.1・§2.2）。
  // **`moduleCode` は `BILLING`。** 事業者・税務設定（`PLATFORM`）と違い、
  // 請求モジュールの契約が無ければ使う場面が無い。
  // `scope` は `ORGANIZATION` — 取引先は組織のマスタで、`billing.read` は
  // `INSPECTOR` / `CLEANER` に配られていない（security.md §1）。
  {
    key: "nav.counterparties",
    icon: "🤝",
    section: "settings",
    moduleCode: "BILLING",
    action: "billing.readInternal",
    scope: "ORGANIZATION",
    status: "READY",
    href: "/app/settings/counterparties",
  },
  // 支払単価の設定（P5-18 / PAY §1.2）。取引先（請求単価）の直後。
  {
    key: "nav.payRules",
    icon: "🧮",
    section: "settings",
    moduleCode: "BILLING",
    action: "payout.write",
    scope: "ORGANIZATION",
    status: "READY",
    href: "/app/settings/pay-rules",
  },
  // P7-20 監査ログの閲覧。**読み取り専用。** 門は auditLog.read
  // （P5-16 で finding.read から分離。発注元に操作履歴を開かない）。
  {
    key: "nav.auditLogs",
    icon: "🧭",
    section: "settings",
    moduleCode: "AUDIT",
    action: "auditLog.read",
    scope: "PROPERTY",
    status: "READY",
    href: "/app/audit/logs",
  },
  // 施設設定（owner 11 / OPEN_QUESTIONS #103 の残り半分）。施設マスタの
  // 作成・編集。**施設横断の画面**なので `{propertyId}` を持たない
  // （作成は施設が決まる前の操作）。
  {
    key: "nav.propertySettings",
    icon: "⚙️",
    section: "settings",
    moduleCode: "PLATFORM",
    action: "property.write",
    scope: "PROPERTY",
    status: "READY",
    href: "/app/settings/properties",
  },
  // ops 07 スタッフ管理（P8-01）。**登録と台帳を 1 画面に持つ**
  // （プロトタイプのヘッダーが「＋ スタッフを登録」で、その下が一覧）。
  // 門は `user.write` — 登録の口が同じ画面にあるため、読むだけの相手を
  // 入れると押せないボタンが並ぶ。在留期限の列だけは `residency.read`
  // で別に絞る（INV-08 / 画面側）。
  {
    key: "nav.staff",
    icon: "👥",
    section: "settings",
    moduleCode: "PLATFORM",
    action: "user.write",
    scope: "ORGANIZATION",
    status: "READY",
    href: "/app/settings/staff",
  },
  // W-12 権限と監査の権限側（メンバー管理 / 人間の指示 2026-08-19）。
  // 監査側の閲覧は nav.auditLogs（P7-20）。
  {
    key: "nav.permission",
    icon: "🔑",
    section: "settings",
    moduleCode: "PLATFORM",
    action: "user.write",
    scope: "ORGANIZATION",
    status: "READY",
    href: "/app/settings/members",
  },
];

/** 画面へ渡す 1 項目。`locked` が真ならグレー表示＋案内。 */
export interface VisibleNavItem {
  item: NavItem;
  /** 契約に含まれていない。**権限が無いのではない。** */
  locked: boolean;
  /** `{propertyId}` を解決したあとのリンク先。`PLANNED` は `null`。 */
  href: string | null;
}

/** セクション単位にまとめた表示用の形。空のセクションは含めない。 */
export interface VisibleNavSection {
  section: NavSection;
  items: readonly VisibleNavItem[];
}

export interface NavigationInput {
  /** 表示中の施設。無ければ施設スコープの項目は出ない。 */
  selectedPropertyId: string | null;
  /** 契約済みモジュール（`listEnabledModules()`）。 */
  enabledModules: readonly ModuleCode[];
}

/**
 * 表示するナビゲーションを組み立てる。**純粋関数。**
 *
 * 判定の順序は API と同じ「権限 → 契約」。逆にすると、担当外の施設に対して
 * 「契約していない」と答えることになり、グレー表示が資源の存在を示唆する
 * （`lib/entitlement.ts` の冒頭と同じ理由）。
 */
export function buildNavigation(
  ctx: TenantContext,
  input: NavigationInput,
): readonly VisibleNavSection[] {
  const enabled = new Set(input.enabledModules);

  const visible: VisibleNavItem[] = [];
  for (const item of NAV_ITEMS) {
    const target =
      item.scope === "ORGANIZATION"
        ? ORGANIZATION_TARGET
        : propertyTarget(input.selectedPropertyId === null ? [] : [input.selectedPropertyId]);

    // 権限が無い項目は存在ごと消す。グレーにしない。
    if (!can(ctx, item.action, target)) continue;

    let href: string | null = null;
    if (item.status === "READY") {
      if (item.href.includes(PROPERTY_ID_PLACEHOLDER)) {
        // 表示中の施設が無いなら到達先が作れない。**項目ごと出さない。**
        // 空の `propertyId` でリンクを作ると 404 へ誘導することになる。
        if (input.selectedPropertyId === null) continue;
        href = item.href.replace(PROPERTY_ID_PLACEHOLDER, input.selectedPropertyId);
      } else {
        href = item.href;
      }
    }

    visible.push({ item, locked: !enabled.has(item.moduleCode), href });
  }

  return NAV_SECTIONS.map((section) => ({
    section,
    items: visible.filter((entry) => entry.item.section === section),
  })).filter((group) => group.items.length > 0);
}
