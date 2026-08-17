import { ALL_PROPERTIES, type PropertySummary } from "@pk/contracts";
import {
  findUserById,
  isOrgWideRole,
  listEnabledModules,
  type ModuleCode,
  type Role,
} from "@pk/db";
import { Outlet, useLoaderData, type LoaderFunctionArgs } from "react-router";

import { businessDateOf } from "../../lib/businessDate.js";
import {
  hasOrgWideView,
  listSelectableProperties,
  resolveSelectedScope,
  type SelectableProperty,
} from "../../lib/property/selection.js";
import { getPropertySummaries } from "../../lib/property/summary.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";
import { Sidebar } from "../../ui/Sidebar.js";
import { Topbar } from "../../ui/Topbar.js";
import { buildNavigation, type VisibleNavSection } from "../../ui/navigation.js";

/**
 * 管理画面のシェル（PK-SPEC-UI-A01 v3 レイアウト標準）。
 *
 * task: docs/tasks/P0-14.md
 * 参照: ui-prototypes/pk-v3-layout-standard.html
 *
 * ```
 * ┌───────────────────────────────────────────────┐
 * │ TOPBAR 58px  ブランド214px │施設セレクタ│ … │通知│ユーザー│
 * ├──────────┬────────────────────────────────────┤
 * │ SIDEBAR  │ PAGE HEADER                        │
 * │ 214px    ├────────────────────────────────────┤
 * │ nav のみ │ CONTENT（各画面 = 後続 task）      │
 * └──────────┴────────────────────────────────────┘
 * ```
 *
 * ── loader が 1 回で用意する ────────────────────────────
 * 施設一覧・表示中の施設・契約済みモジュールを**ここで 1 度だけ**引く。
 * 子の画面が同じものを引き直さないこと（D1 の往復が画面数だけ増える）。
 *
 * ── サイドバーの中身も施設で変わる ──────────────────────
 * 施設セレクタを topbar に置く理由（A01 §2.2）。切り替えると
 * コンテンツだけでなくナビの権限判定（担当施設か）も変わる。
 */

export interface ShellData {
  user: { displayName: string };
  role: Role;
  isOrgWide: boolean;
  properties: readonly SelectableProperty[];
  selectedPropertyId: string | null;
  /** `"ALL"` を選んでいるか（P0-21）。 */
  isOrgScope: boolean;
  canViewOrgWide: boolean;
  summaries: readonly PropertySummary[];
  navigation: readonly VisibleNavSection[];
  enabledModules: readonly ModuleCode[];
}

/**
 * URL から表示スコープを読む。**URL を正とする**（PK-SPEC-P0 §23.5）。
 *
 * この loader と子画面の loader は**並行に走る。** 子の `switchProperty()` が
 * セッションを書き換えるのはこの loader が読んだ後なので、セッションだけを
 * 見るとナビとセレクタが 1 画面ぶん古い選択で組まれる（全社サマリーから
 * 客室ボードを開いた瞬間、施設系の項目がサイドバーから消える）。
 * 施設が URL に載っている画面はその施設、`/app/org/*` は全社。
 * それ以外（施設横断の一覧など）だけセッションへ落ちる。
 */
function selectionFromPath(pathname: string): string | undefined {
  const match = /^\/app\/p\/([^/]+)(?:\/|$)/.exec(pathname);
  if (match?.[1] !== undefined) return decodeURIComponent(match[1]);
  if (pathname === "/app/org" || pathname.startsWith("/app/org/")) return ALL_PROPERTIES;
  return undefined;
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<ShellData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  const properties = await listSelectableProperties(env, tenant);
  // **セッションの値を認可の根拠にしない。** ロールと一覧から解き直す
  // （DECISIONS #020）。降格後に `"ALL"` が残っていれば既定施設へ落ちる。
  // URL が施設を示す画面では URL が勝つ（`selectionFromPath()` の注記）。
  const { scope, property: selected } = resolveSelectedScope(
    selectionFromPath(new URL(request.url).pathname) ?? session.selectedPropertyId,
    tenant,
    properties,
  );
  const isOrgScope = scope === ALL_PROPERTIES;
  const selectedPropertyId = selected?.id ?? null;

  // ── ナビの施設リンクは全社表示でも消さない ──────────────
  // プロトタイプのサイドバーは常に全項目を並べる。全社サマリー表示中に
  // 客室ボードなどの項目が消えると「クリックしたら項目がなくなる」ように
  // 見える。到達先が要る項目には**既定施設**（セレクタの解決と同じ規則）を
  // 当てる。施設が 1 つも無いときだけ従来どおり項目を出さない。
  const navPropertyId =
    selectedPropertyId ?? resolveSelectedScope(undefined, tenant, properties).property?.id ?? null;

  // ミニバッジ（§23.3）。60 秒キャッシュが効くので毎画面で引いてよい。
  const summaries = await getPropertySummaries(env, tenant, businessDateOf(now));

  // 表示中の施設の契約を見る。施設が無い場合は組織全体の契約で判断する。
  const enabledModules = await listEnabledModules(env, tenant, selectedPropertyId);

  const user = await findUserById(env, tenant, session.userId);

  return {
    // `findUserById()` はテナントスコープで引くので、ここで見つからないのは
    // 所属だけ残ってユーザーが消えた状態。名前を出さずに画面は開く。
    user: { displayName: user?.displayName ?? "" },
    role: tenant.role,
    // **`allowedPropertyIds.length === 0` で判定しないこと。** 施設スコープの
    // ロールに割当が 1 つも無い状態と区別が付かず、閲覧範囲の表示が逆に出る。
    isOrgWide: isOrgWideRole(tenant.role),
    properties,
    selectedPropertyId,
    isOrgScope,
    canViewOrgWide: hasOrgWideView(tenant),
    summaries,
    navigation: buildNavigation(tenant, { selectedPropertyId: navPropertyId, enabledModules }),
    enabledModules,
  };
}

export default function AppShell() {
  const data = useLoaderData<ShellData>();

  return (
    <div className="pk-shell">
      <Topbar
        displayName={data.user.displayName}
        role={data.role}
        isOrgWide={data.isOrgWide}
        properties={data.properties}
        selectedPropertyId={data.selectedPropertyId}
        isOrgScope={data.isOrgScope}
        canViewOrgWide={data.canViewOrgWide}
        summaries={data.summaries}
      />
      <div className="pk-shell__body">
        <Sidebar navigation={data.navigation} isOrgWide={data.isOrgWide} role={data.role} />
        <main className="pk-main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
