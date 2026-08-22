import { Fragment } from "react";
import { Link } from "react-router";

import { t } from "../lib/i18n.js";

import { buildBreadcrumb } from "./breadcrumb.js";

/**
 * 上位の画面へ戻る帯（人間の指摘 2026-08-22 / DECISIONS #257）。
 *
 * ```
 * ┌──────────────────────────────────────────┐
 * │ ← 設定 › 連携設定                        │  ← ここ（28px の細い帯）
 * ├──────────────────────────────────────────┤
 * │ マッピング設定                           │  pk-pagehead
 * ```
 *
 * ── なぜシェルが描くのか ────────────────────────────────
 * 設定のサブ画面は 16 枚あり、各画面に戻るリンクを手で置くと**置き忘れが
 * 出る**（置き忘れは lint も typecheck も通る種類の壊れ方）。URL から
 * 機械的に決まるものなので `layout.tsx` が 1 か所で描く。新しい設定画面を
 * 足した人は何もしなくてよい。
 *
 * ── 戻り先が無ければ何も描かない ────────────────────────
 * `buildBreadcrumb()` が空を返す画面（ハブ自身・設定の外）では要素ごと
 * 出さない。**空の帯を残さない**（高さだけが増えて見出しが下がる）。
 */
export function Breadcrumb({ pathname }: { pathname: string }) {
  const trail = buildBreadcrumb(pathname);
  if (trail.length === 0) return null;

  return (
    <nav aria-label={t("nav.breadcrumb")} className="pk-crumbs">
      {trail.map((crumb, index) => (
        <Fragment key={crumb.href}>
          {/* 区切りは飾り。読み上げではリンクが順に読まれれば足りる。 */}
          {index === 0 ? null : (
            <span aria-hidden="true" className="pk-crumbs__sep">
              ›
            </span>
          )}
          <Link className="pk-crumbs__link" to={crumb.href}>
            {/* 矢印は先頭だけ。**「押せば上へ戻る」の合図**で、
                プロトタイプの「← 一覧へ戻る」と同じ役割。 */}
            {index === 0 ? (
              <span aria-hidden="true" className="pk-crumbs__back">
                ←
              </span>
            ) : null}
            {t(crumb.label)}
          </Link>
        </Fragment>
      ))}
    </nav>
  );
}
