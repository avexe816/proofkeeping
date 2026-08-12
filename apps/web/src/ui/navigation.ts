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
    section: "daily",
    moduleCode: "HOUSEKEEPING_CORE",
    action: "property.read",
    scope: "PROPERTY",
    status: "READY",
    href: "/app/dashboard",
  },
  {
    key: "nav.board",
    section: "daily",
    moduleCode: "HOUSEKEEPING_CORE",
    action: "property.read",
    scope: "PROPERTY",
    status: "READY",
    href: `/app/p/${PROPERTY_ID_PLACEHOLDER}/board`,
  },
  // W-04（P1-14）。**`task.manage`。** 配分は施設責任者の判断で、
  // 「盤面が見える人＝配れる人」ではない（§10.1 / §5.3）。
  {
    key: "nav.tasks",
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
    section: "daily",
    moduleCode: "HOUSEKEEPING_CORE",
    action: "roomPlan.write",
    scope: "PROPERTY",
    status: "READY",
    href: `/app/p/${PROPERTY_ID_PLACEHOLDER}/plan`,
  },
  {
    key: "nav.findings",
    section: "daily",
    moduleCode: "AUDIT",
    action: "finding.read",
    scope: "PROPERTY",
    status: "PLANNED",
  },
  // ── 記録の確認 ────────────────────────────────────────
  {
    key: "nav.findingDetail",
    section: "records",
    moduleCode: "AUDIT",
    action: "finding.read",
    scope: "PROPERTY",
    status: "PLANNED",
  },
  {
    key: "nav.cleaningRecords",
    section: "records",
    moduleCode: "HOUSEKEEPING_CORE",
    action: "property.read",
    scope: "PROPERTY",
    status: "PLANNED",
  },
  {
    key: "nav.inspection",
    section: "records",
    moduleCode: "HOUSEKEEPING_CORE",
    action: "property.read",
    scope: "PROPERTY",
    status: "PLANNED",
  },
  // ── 資材と分析 ────────────────────────────────────────
  {
    key: "nav.linen",
    section: "analysis",
    moduleCode: "HOUSEKEEPING_CORE",
    action: "property.read",
    scope: "PROPERTY",
    status: "PLANNED",
  },
  {
    key: "nav.report",
    section: "analysis",
    moduleCode: "AUDIT",
    action: "property.read",
    scope: "PROPERTY",
    status: "PLANNED",
  },
  {
    key: "nav.billing",
    section: "analysis",
    moduleCode: "BILLING",
    action: "billing.read",
    scope: "PROPERTY",
    status: "PLANNED",
  },
  // ── 設定 ──────────────────────────────────────────────
  // ここまで `/app/settings/*` の 3 画面（客室マスタ・事業者税務・そして
  // 今回の 2 つ）は**サイドバーに現れなかった。** ルートは実在するのに
  // 到達経路が無く、URL を直に打つしか無い状態だった。
  {
    key: "nav.rooms",
    section: "settings",
    moduleCode: "HOUSEKEEPING_CORE",
    action: "property.write",
    scope: "PROPERTY",
    status: "READY",
    href: "/app/settings/rooms",
  },
  // W-16 / W-17（P1-06 / P1-02 の未達分）。§10.1 の担当ロールは `ORG_ADMIN`。
  // **`scope` は `ORGANIZATION`。** 権限マトリクスがこの 2 操作を組織単位で
  // 定めており、施設スコープロールには項目ごと出ない。
  {
    key: "nav.checklists",
    section: "settings",
    moduleCode: "HOUSEKEEPING_CORE",
    action: "checklistTemplate.write",
    scope: "ORGANIZATION",
    status: "READY",
    href: "/app/settings/checklists",
  },
  {
    key: "nav.standardTimes",
    section: "settings",
    moduleCode: "HOUSEKEEPING_CORE",
    action: "standardTime.write",
    scope: "ORGANIZATION",
    status: "READY",
    href: "/app/settings/standard-times",
  },
  // W-11 事業者・税務設定（P0-16）。**`PLATFORM`。** 登録番号の設定は
  // 請求モジュールの契約が無くても要る（未設定でも画面は成立する / P0-16）。
  {
    key: "nav.taxProfile",
    section: "settings",
    moduleCode: "PLATFORM",
    action: "taxProfile.write",
    scope: "ORGANIZATION",
    status: "READY",
    href: "/app/settings/tax",
  },
  {
    key: "nav.propertySettings",
    section: "settings",
    moduleCode: "PLATFORM",
    action: "property.write",
    scope: "PROPERTY",
    status: "PLANNED",
  },
  {
    key: "nav.permission",
    section: "settings",
    moduleCode: "PLATFORM",
    action: "user.write",
    scope: "ORGANIZATION",
    status: "PLANNED",
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
