import { Link } from "react-router";

import { t, type MessageKey } from "../lib/i18n.js";

import { isSettingsItemActive } from "./settingsNav.js";

/**
 * 設定サイドバー（人間の指示 2026-08-22 / DECISIONS #258）。
 *
 * ```
 * ┌──────────┬──────────────┬──────────────────────────┐
 * │ GLOBAL   │ 設定 (208px) │ 客室マスタ        [新規] │
 * │ SIDEBAR  │ 🏨 施設と客室 │                          │
 * │（変更なし)│  施設設定    │ （各画面の中身はそのまま）│
 * │          │ ▸客室マスタ◀ │                          │
 * │          │  客室タイプ  │                          │
 * └──────────┴──────────────┴──────────────────────────┘
 * ```
 *
 * ── 全体ナビと設定内ナビを分ける ────────────────────────
 * 左のサイドバー（全体ナビ）は**触らない。** ここは設定領域の中だけの
 * ナビで、17 画面を 6 群に分けて並べ、**同じ領域を 1 クリックで移動できる**
 * ようにする。#257 の「← 設定」はこれに置き換わった（横の移動が
 * 1 クリック増えたままだったため）。
 *
 * ── 3 状態の見え方は全体ナビと同じ ──────────────────────
 * 権限が無い項目は**そもそも渡ってこない**（`buildSettingsHub()` が
 * `resolveNavItem()` で落とす）。未契約はグレー＋案内でリンクにしない。
 * ここでの表示制御は権限制御ではない（security.md §1）。
 *
 * ── 狭いときは畳む ──────────────────────────────────────
 * `<details>` で畳む。**JS を使わない**（スクリプトが落ちても設定間を
 * 移動できる／動きは CSS が繋ぐ）。広いときは CSS が `summary` を隠し、
 * 中身を常時開いた形にする（`.pk-settings` の container query）。
 * **判断は viewport ではなく作業領域の幅**で行う（左のサイドバーを
 * レールに畳むと同じ viewport でも作業領域は 158px 広がるため）。
 */
export interface SettingsNavItem {
  key: MessageKey;
  icon: string;
  href: string | null;
  locked: boolean;
}

export interface SettingsNavGroup {
  key: string;
  label: MessageKey;
  icon: string;
  items: readonly SettingsNavItem[];
}

export function SettingsSidebar({
  groups,
  pathname,
}: {
  groups: readonly SettingsNavGroup[];
  pathname: string;
}) {
  if (groups.length === 0) return null;

  // 畳んだときの見出しに「いまどこか」を出す。**開かずに現在地が分かる。**
  const current = groups
    .flatMap((group) => group.items)
    .find((item) => isSettingsItemActive(item.href, pathname));

  return (
    <details className="pk-settingsnav">
      <summary className="pk-settingsnav__toggle">
        <span aria-hidden="true" className="pk-settingsnav__toggleIcon">
          ⚙
        </span>
        <span className="pk-settingsnav__toggleLabel">{t("settings.hub.title")}</span>
        {current === undefined ? null : (
          <span className="pk-settingsnav__toggleCurrent">{t(current.key)}</span>
        )}
      </summary>
      <nav aria-label={t("settings.nav.label")} className="pk-settingsnav__body">
        {groups.map((group) => (
          <div className="pk-settingsnav__group" key={group.key}>
            {/* 群は見出し。**押せない。** 階層は 1 段だけにする
                （群を押せると「群の画面」があると誤解される）。 */}
            <p className="pk-settingsnav__groupLabel">
              <span aria-hidden="true" className="pk-settingsnav__groupIcon">
                {group.icon}
              </span>
              {t(group.label)}
            </p>
            {group.items.map((item) => (
              <SettingsNavEntry item={item} key={item.key} pathname={pathname} />
            ))}
          </div>
        ))}
      </nav>
    </details>
  );
}

function SettingsNavEntry({ item, pathname }: { item: SettingsNavItem; pathname: string }) {
  const label = t(item.key);
  const icon = (
    <span aria-hidden="true" className="pk-settingsnav__icon">
      {item.icon}
    </span>
  );

  // 未契約。**リンクにしない**（全体ナビの `pk-nav--locked` と同じ扱い）。
  if (item.locked || item.href === null) {
    return (
      <span
        className="pk-settingsnav__item pk-settingsnav__item--locked"
        title={t("nav.locked.notice")}
      >
        {icon}
        <span className="pk-settingsnav__label">{label}</span>
        <span className="pk-settingsnav__note">{t("nav.locked")}</span>
      </span>
    );
  }

  const active = isSettingsItemActive(item.href, pathname);

  return (
    <Link
      aria-current={active ? "page" : undefined}
      className={
        active ? "pk-settingsnav__item pk-settingsnav__item--active" : "pk-settingsnav__item"
      }
      to={item.href}
    >
      {icon}
      <span className="pk-settingsnav__label">{label}</span>
    </Link>
  );
}
