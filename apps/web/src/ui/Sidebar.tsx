import type { Role } from "@pk/db";
import { NavLink } from "react-router";

import { t } from "../lib/i18n.js";

import { NAV_SECTION_LABEL, type VisibleNavItem, type VisibleNavSection } from "./navigation.js";

/**
 * サイドバー（PK-SPEC-UI-A01 §4）。
 *
 * task: docs/tasks/P0-14.md
 *
 * 幅 214px、背景 `--brand`。**ナビゲーションだけを持つ。**
 * ブランド・施設セレクタ・ユーザー・通知は topbar（A01 §4.2）。
 * 最下部に閲覧範囲の注記（A01 §4.3）。
 *
 * 項目の 3 状態（権限が無い＝そもそも来ない / 未契約＝グレー＋案内 /
 * 未実装＝準備中）の意味は `navigation.ts` の冒頭を読むこと。
 */
export function Sidebar(props: {
  navigation: readonly VisibleNavSection[];
  isOrgWide: boolean;
  role: Role;
}) {
  return (
    <nav className="pk-sidebar">
      <div className="pk-sidebar__nav">
        {props.navigation.map((group) => (
          <div className="pk-sidebar__group" key={group.section}>
            <p className="pk-sidebar__heading">{t(NAV_SECTION_LABEL[group.section])}</p>
            {group.items.map((entry) => (
              <NavEntry entry={entry} key={entry.item.key} />
            ))}
          </div>
        ))}
      </div>
      <div className="pk-sidebar__foot">
        <p>{props.isOrgWide ? t("sidebar.scope.org") : t("sidebar.scope.assigned")}</p>
        {props.role === "AUDITOR" ? <p>{t("sidebar.scope.readonly")}</p> : null}
      </div>
    </nav>
  );
}

function NavEntry({ entry }: { entry: VisibleNavItem }) {
  const label = t(entry.item.key);
  // **`aria-hidden`。** 意味はラベルが持っており、読み上げに絵文字の
  // 名前（「グラフ」等）が混ざると項目名が二重になる。
  const icon = (
    <span aria-hidden="true" className="pk-nav__icon">
      {entry.item.icon}
    </span>
  );

  // 未契約。**リンクにしない。** 案内は `title` にも出して、
  // グレーの理由が分かるようにする。
  if (entry.locked) {
    return (
      <span className="pk-nav pk-nav--locked" title={t("nav.locked.notice")}>
        {icon}
        {label}
        <span className="pk-nav__note">{t("nav.locked")}</span>
      </span>
    );
  }

  // `href` は `buildNavigation()` が `{propertyId}` を解決した値。
  // `PLANNED` は到達先が無いので `null`（型ではなく値で判定する）。
  if (entry.item.status === "PLANNED" || entry.href === null) {
    return (
      <span className="pk-nav pk-nav--planned">
        {icon}
        {label}
        <span className="pk-nav__note">{t("nav.planned")}</span>
      </span>
    );
  }

  return (
    <NavLink
      className={({ isActive }) => (isActive ? "pk-nav pk-nav--active" : "pk-nav")}
      to={entry.href}
    >
      {icon}
      {label}
    </NavLink>
  );
}
