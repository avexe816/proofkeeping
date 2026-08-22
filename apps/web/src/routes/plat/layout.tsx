import { Form, NavLink, Outlet, useLoaderData, type LoaderFunctionArgs } from "react-router";

import { t } from "../../lib/i18n.js";
import { requirePlatformOperator } from "../../lib/platform/requireOperator.js";
import { getEnv } from "../../lib/ui/cloudflare.js";

/**
 * 運営画面のシェル（PF-01 / `ui-prototypes/platform/` 共通シェル）。
 *
 * task: docs/tasks/PF-01.md
 *
 * ── テナントのシェルを使い回さない ──────────────────────
 * `routes/app/layout.tsx` は施設セレクタ・契約モジュール・レール切替と
 * いった**テナントの概念**でできている。運営面に施設は無い。
 * 見た目のトークン（app.css の `pk-sidebar` / `pk-nav`）だけを共有し、
 * 構造は分ける。
 *
 * ── 群の名前は「何をする場所か」で付ける ────────────────
 * 群の見出しに task ID（旧「P4エンジン」）を出さない。運営画面を見るのは
 * 開発の進め方を知らない人で、`P4` は読み手の側に意味を持たない。
 * 「照合」であって「検知」ではない（PK-SPEC-P4 §1.1 / ui-writing.md §2 —
 * 「検知」は禁止語）。人間の指示 2026-08-22 / DECISIONS #251。
 *
 * ── ナビは 4 群 12 項目（プロトタイプの並び）─────────────
 * まだ画面の無い項目は**リンクにしない**（到達先の無いリンクを作らない /
 * `ui/navigation.ts` と同じ判断）。PF-03〜PF-14 が 1 つずつ差し替える。
 *
 * ── サイドバー脚注（**逐語**）───────────────────────────
 * 「プラットフォーム運営 / 個人情報へのアクセスは制限されます」
 * （PK-IMPL-CONTRACT INV-10 の宣言。消さないこと）。
 */

/** ナビ 1 項目。`href` が `null` ならまだ画面が無い（グレー表示）。 */
interface PlatNavItem {
  key: Parameters<typeof t>[0];
  icon: string;
  href: string | null;
}

interface PlatNavSection {
  label: Parameters<typeof t>[0];
  /** 見出しの下に 1 行で出す説明。**群が何をする場所かを日本語で言う。** */
  note: Parameters<typeof t>[0];
  items: readonly PlatNavItem[];
}

/** プロトタイプの 4 群 12 項目。**並びを変えない。** */
const PLAT_NAV: readonly PlatNavSection[] = [
  {
    label: "plat.nav.section.status",
    note: "plat.nav.section.status.note",
    items: [
      { key: "plat.nav.status", icon: "📡", href: "/plat/status" },
      { key: "plat.nav.tenants", icon: "🏢", href: "/plat/tenants" },
      { key: "plat.nav.usage", icon: "📊", href: "/plat/usage" },
    ],
  },
  {
    label: "plat.nav.section.engine",
    note: "plat.nav.section.engine.note",
    items: [
      { key: "plat.nav.rules", icon: "🧠", href: null },
      { key: "plat.nav.accuracy", icon: "🎯", href: null },
      { key: "plat.nav.validation", icon: "🧪", href: null },
    ],
  },
  {
    label: "plat.nav.section.support",
    note: "plat.nav.section.support.note",
    items: [
      { key: "plat.nav.tickets", icon: "🎫", href: null },
      { key: "plat.nav.issues", icon: "🐞", href: null },
      { key: "plat.nav.announcements", icon: "📢", href: null },
    ],
  },
  {
    label: "plat.nav.section.governance",
    note: "plat.nav.section.governance.note",
    items: [
      { key: "plat.nav.revenue", icon: "💴", href: null },
      { key: "plat.nav.compliance", icon: "🔐", href: null },
      { key: "plat.nav.config", icon: "⚙️", href: null },
    ],
  },
];

interface PlatShellData {
  displayName: string;
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<PlatShellData> {
  const env = getEnv(context);
  const operator = await requirePlatformOperator(env, request, new Date());
  // **メールを画面に載せない。** 表示名だけで足りる。
  return { displayName: operator.displayName };
}

export default function PlatShell() {
  const data = useLoaderData<PlatShellData>();

  return (
    <div className="pk-shell">
      <header className="pk-topbar">
        <div className="pk-topbar__brand">
          <span className="pk-topbar__brandFull">
            {t("app.brand.proof")}
            <em className="pk-topbar__brandAccent">{t("app.brand.keeping")}</em>
          </span>
        </div>
        {/* プロトタイプのブランド脇バッジ「PLATFORM ADMIN」。 */}
        <span className="pk-plat-badge">{t("plat.badge")}</span>
        <div className="pk-topbar__right">
          <div className="pk-user">
            <span aria-hidden="true" className="pk-user__avatar">
              {data.displayName.slice(0, 1)}
            </span>
            <div className="pk-user__identity">
              <span className="pk-user__name">{data.displayName}</span>
              {/* A01 §3.3 の必須バッジ。運営は常に「全テナント」。 */}
              <span className="pk-user__badge">{t("plat.role.badge")}</span>
            </div>
            <Form action="/plat/logout" method="post">
              <button className="pk-button pk-button--onBrand" type="submit">
                {t("user.logout")}
              </button>
            </Form>
          </div>
        </div>
      </header>
      <div className="pk-shell__body">
        {/* テナントの Sidebar と同じ見た目クラスを使う。開閉・レール切替
            （P7-21）は持たない — 12 項目で収まる。 */}
        <nav aria-label={t("plat.nav.label")} className="pk-sidebar">
          <div className="pk-sidebar__nav">
            {PLAT_NAV.map((section) => (
              <div className="pk-sidebar__group" key={section.label}>
                <p className="pk-sidebar__heading pk-sidebar__heading--static">
                  {t(section.label)}
                </p>
                {/* 群の説明（人間の指示 2026-08-22 / DECISIONS #251）。
                    見出しは 9px の記号のような字で、何をする場所かを言えない。
                    テナント側の `nav.note.*`（設定ハブ）と同じ考え方で
                    1 行だけ添える。**リンクにはしない。** */}
                <p className="pk-sidebar__note">{t(section.note)}</p>
                {section.items.map((item) =>
                  item.href === null ? (
                    // まだ画面が無い。**リンクにしない。**
                    <span className="pk-nav pk-nav--planned" key={item.key}>
                      <span aria-hidden="true" className="pk-nav__icon">
                        {item.icon}
                      </span>
                      <span className="pk-nav__label">{t(item.key)}</span>
                      <span className="pk-nav__note">{t("nav.planned")}</span>
                    </span>
                  ) : (
                    <NavLink
                      className={({ isActive }) => (isActive ? "pk-nav pk-nav--active" : "pk-nav")}
                      key={item.key}
                      to={item.href}
                    >
                      <span aria-hidden="true" className="pk-nav__icon">
                        {item.icon}
                      </span>
                      <span className="pk-nav__label">{t(item.key)}</span>
                    </NavLink>
                  ),
                )}
              </div>
            ))}
          </div>
          {/* サイドバー脚注（INV-10 の宣言 / **逐語**）。 */}
          <div className="pk-sidebar__foot">
            <p className="pk-sidebar__scope">{t("plat.nav.footer.role")}</p>
            <p className="pk-sidebar__scope">{t("plat.nav.footer.privacy")}</p>
          </div>
        </nav>
        <main className="pk-main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
