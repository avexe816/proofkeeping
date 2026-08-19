import type { Role } from "@pk/db";

import { t } from "../lib/i18n.js";
import type { SelectableProperty } from "../lib/property/selection.js";

import type { PropertySummary } from "@pk/contracts";

import { PropertySwitcher } from "./PropertySwitcher.js";
import { UserMenu } from "./UserMenu.js";

/**
 * 上部バー（PK-SPEC-UI-A01 §1「TOPBAR」）。
 *
 * task: docs/tasks/P0-14.md
 *
 * 高さ 58px、背景は `--brandTop`（サイドバーより濃い）。
 * 左から **ブランド 214px → 施設セレクタ**、右端に **通知 → ユーザー**。
 * ブランドの幅をサイドバーと揃えることで、施設セレクタの左端と
 * サイドバーの右端に縦のラインが通る（A01 §1.1）。
 *
 * ── 通知は器も置いていない ──────────────────────────────
 * A01 §3.2 はバッジの規定（HIGH・MEDIUM のみ、99+、0 件は出さない）を
 * 定めるが、**数える対象の通知が P0 に無い。** 0 件のときバッジを出さない
 * 規定に従うと、今は常に空になる。空の鈴だけ置いても意味が無いので、
 * 通知そのものを作る task が topbar 右端（ユーザーの左隣）に足すこと。
 */
export function Topbar(props: {
  displayName: string;
  role: Role;
  isOrgWide: boolean;
  properties: readonly SelectableProperty[];
  selectedPropertyId: string | null;
  /** `"ALL"`（全社サマリー）を選んでいるか（P0-21）。 */
  isOrgScope: boolean;
  /** 全社サマリーを持つロールか。**非表示だけで済ませない**（§23.1）。 */
  canViewOrgWide: boolean;
  /** ミニバッジの元（§23.3）。読めていなければ空。 */
  summaries: readonly PropertySummary[];
}) {
  return (
    <header className="pk-topbar">
      {/* ロゴは 2 語に分ける。**"Keeping" を `--accent2`（金）にする**
          （ui-prototypes の `.brand em` / A01 §3 の配色）。i18n の
          `app.brand` は 1 語のままにし、**表示の都合で分けるのは
          ここだけ**にする（辞書に markup を持ち込まない）。 */}
      <div className="pk-topbar__brand">
        {/* レール時（A01 §4.4）は 56px に収まるモノグラムへ切り替える。
            どちらを出すかは CSS（`.pk-shell--nav-collapsed`）が決める。 */}
        <span className="pk-topbar__brandFull">
          {t("app.brand.proof")}
          <em className="pk-topbar__brandAccent">{t("app.brand.keeping")}</em>
        </span>
        <span className="pk-topbar__brandMark">
          {t("app.brand.mark.proof")}
          <em className="pk-topbar__brandAccent">{t("app.brand.mark.keeping")}</em>
        </span>
      </div>
      <PropertySwitcher
        properties={props.properties}
        selectedPropertyId={props.selectedPropertyId}
        isOrgScope={props.isOrgScope}
        canViewOrgWide={props.canViewOrgWide}
        summaries={props.summaries}
      />
      <div className="pk-topbar__right">
        <UserMenu displayName={props.displayName} role={props.role} isOrgWide={props.isOrgWide} />
      </div>
    </header>
  );
}
