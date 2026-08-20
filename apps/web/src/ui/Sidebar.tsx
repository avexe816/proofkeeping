import type { Role } from "@pk/db";
import { useEffect, useState } from "react";
import { Form, NavLink, useLocation } from "react-router";

import { t } from "../lib/i18n.js";
import {
  readClosedSections,
  safeLocalStorage,
  toggleSection,
  writeClosedSections,
} from "../lib/ui/sidebarSections.js";

import {
  NAV_SECTION_LABEL,
  isActivePrefix,
  type VisibleNavItem,
  type VisibleNavSection,
} from "./navigation.js";

/**
 * サイドバー（PK-SPEC-UI-A01 §4）。
 *
 * task: docs/tasks/P0-14.md / docs/tasks/P7-21.md（折りたたみ）
 *
 * 幅 214px（レール時 56px / A01 §4.4）、背景 `--brand`。**ナビゲーションだけを持つ。**
 * ブランド・施設セレクタ・ユーザー・通知は topbar（A01 §4.2）。
 * 最下部に閲覧範囲の注記（A01 §4.3）とレール切替（§4.4）。
 *
 * 項目の 3 状態（権限が無い＝そもそも来ない / 未契約＝グレー＋案内 /
 * 未実装＝準備中）の意味は `navigation.ts` の冒頭を読むこと。
 *
 * ── 2 種類の「畳む」──────────────────────────────────────
 * - レール（全体）: セッションに持つ。SSR が確定した幅で描く（ちらつき禁止）。
 * - セクション開閉: 端末（`localStorage`）に持つ。SSR は常に全展開で描き、
 *   閉じた選択だけを hydration 後に反映する（`sidebarSections.ts` の注記）。
 *
 * ── 畳む動きは「押した瞬間に始まる」──────────────────────
 * どちらの畳みも**サーバーの応答を待たない。** レールは `layout.tsx` が
 * 状態を持ち、書き込みは背景の `fetch`。セクションは元から端末の中だけ。
 * 見た目の移り変わりは CSS（`.pk-sidebar__items` の `grid-template-rows`、
 * `.pk-sidebar` の `width`）が 180〜220ms で繋ぐ。**JS でアニメーションを
 * 書かない**（`prefers-reduced-motion` の尊重が CSS 側で完結する）。
 *
 * 閉じたセクションの項目は DOM に残したまま高さ 0 へ畳む（動きを繋ぐため）。
 * 見えない項目に Tab が止まらないよう `inert` を付ける。
 */
export function Sidebar(props: {
  navigation: readonly VisibleNavSection[];
  isOrgWide: boolean;
  role: Role;
  /** レール（56px）表示か（A01 §4.4）。 */
  collapsed: boolean;
  /**
   * レールの切替。**状態は `layout.tsx` が持つ**（シェルの修飾子が
   * ブランド幅も同時に切り替えるため）。JS が無い環境ではこの
   * ハンドラが呼ばれず、`<Form>` の素の POST がそのまま効く。
   */
  onToggleCollapsed: () => void;
}) {
  const location = useLocation();
  // 依存はセクションの構成だけ（権限・契約で増減する）。並びが同じなら読み直さない。
  const sectionsKey = props.navigation.map((group) => group.section).join("|");
  const [closedSections, setClosedSections] = useState<readonly string[]>([]);

  // SSR とクライアント初回描画を一致させるため、保存値は effect で読む。
  useEffect(() => {
    setClosedSections(readClosedSections(safeLocalStorage(), sectionsKey.split("|")));
  }, [sectionsKey]);

  const onToggleSection = (section: string) => {
    const next = toggleSection(closedSections, section);
    setClosedSections(next);
    writeClosedSections(safeLocalStorage(), next);
  };

  return (
    <nav className="pk-sidebar">
      <div className="pk-sidebar__nav">
        {props.navigation.map((group) => {
          // レール時はアイコンだけを縦に並べる。見出しも開閉も効かせない
          // （閉じたセクションの項目が消えると、レールの一覧性が壊れる）。
          const closed = !props.collapsed && closedSections.includes(group.section);
          return (
            <div
              className={
                closed ? "pk-sidebar__group pk-sidebar__group--closed" : "pk-sidebar__group"
              }
              key={group.section}
            >
              <button
                aria-expanded={!closed}
                className="pk-sidebar__heading"
                onClick={() => {
                  onToggleSection(group.section);
                }}
                type="button"
              >
                {t(NAV_SECTION_LABEL[group.section])}
              </button>
              {/* 高さを繋ぐための 2 枚。外が `0fr ↔ 1fr`、内が `overflow: hidden`。 */}
              <div className="pk-sidebar__items" inert={closed}>
                <div className="pk-sidebar__itemsInner">
                  {group.items.map((entry) => (
                    <NavEntry collapsed={props.collapsed} entry={entry} key={entry.item.key} />
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="pk-sidebar__foot">
        <p className="pk-sidebar__scope">
          {props.isOrgWide ? t("sidebar.scope.org") : t("sidebar.scope.assigned")}
        </p>
        {props.role === "AUDITOR" ? (
          <p className="pk-sidebar__scope">{t("sidebar.scope.readonly")}</p>
        ) : null}
        {/* JS が無い環境のための素の POST（action-only ルート）。
            JS があるときは既定の送信を止め、その場で幅を変える。
            リダイレクトを待たないので押し心地が往復 1 回ぶん速い。 */}
        <Form
          action="/app/toggle-sidebar"
          method="post"
          onSubmit={(event) => {
            event.preventDefault();
            props.onToggleCollapsed();
          }}
        >
          <input name="collapsed" type="hidden" value={props.collapsed ? "false" : "true"} />
          <input name="next" type="hidden" value={location.pathname + location.search} />
          <button
            aria-label={props.collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
            className="pk-sidebar__toggle"
            title={props.collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
            type="submit"
          >
            <span aria-hidden="true" className="pk-sidebar__toggleIcon">
              {props.collapsed ? "»" : "«"}
            </span>
            <span className="pk-nav__label">{t("sidebar.collapse")}</span>
          </button>
        </Form>
      </div>
    </nav>
  );
}

function NavEntry({ collapsed, entry }: { collapsed: boolean; entry: VisibleNavItem }) {
  const { pathname } = useLocation();
  const label = t(entry.item.key);
  // **`aria-hidden`。** 意味はラベルが持っており、読み上げに絵文字の
  // 名前（「グラフ」等）が混ざると項目名が二重になる。
  const icon = (
    <span aria-hidden="true" className="pk-nav__icon">
      {entry.item.icon}
    </span>
  );
  // レール時はラベルを隠すので、`title` で全文を補う（A01 §4.4）。
  const title = collapsed ? label : undefined;

  // 未契約。**リンクにしない。** 案内は `title` にも出して、
  // グレーの理由が分かるようにする。
  if (entry.locked) {
    return (
      <span className="pk-nav pk-nav--locked" title={collapsed ? label : t("nav.locked.notice")}>
        {icon}
        <span className="pk-nav__label">{label}</span>
        <span className="pk-nav__note">{t("nav.locked")}</span>
      </span>
    );
  }

  // `href` は `buildNavigation()` が `{propertyId}` を解決した値。
  // `PLANNED` は到達先が無いので `null`（型ではなく値で判定する）。
  if (entry.item.status === "PLANNED" || entry.href === null) {
    return (
      <span className="pk-nav pk-nav--planned" title={title}>
        {icon}
        <span className="pk-nav__label">{label}</span>
        <span className="pk-nav__note">{t("nav.planned")}</span>
      </span>
    );
  }

  // **設定は配下の画面を開いている間も選択状態にする**（人間の指示
  // 2026-08-20）。`/app/training` のように `href` の下に無い URL も
  // 含むので、`activeFor` を持つ項目だけ接頭辞で判定して上書きする。
  const activeByPrefix =
    entry.item.activeFor === undefined ? null : isActivePrefix(entry.item.activeFor, pathname);

  return (
    <NavLink
      className={({ isActive }) =>
        (activeByPrefix ?? isActive) ? "pk-nav pk-nav--active" : "pk-nav"
      }
      title={title}
      to={entry.href}
    >
      {icon}
      <span className="pk-nav__label">{label}</span>
    </NavLink>
  );
}
