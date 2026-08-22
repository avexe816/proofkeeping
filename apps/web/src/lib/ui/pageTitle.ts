/**
 * ブラウザのタブに出す題名（人間の指示 2026-08-22
 * 「ページのテーマ・リンクの文字にしてください」）。
 *
 * ── 題名の一覧を新しく作らない ──────────────────────────
 * サイドバーの項目（`NAV_ITEMS`）が**すでにその画面の名前を持っている。**
 * ここで別表を起こすと、画面を足した人が 2 か所を直すことになり、
 * 片方だけ増える（`settingsGroup` を union にしたのと同じ考え / #258）。
 * **リンクの文字をそのままタブに出す。**
 *
 * ── `root.tsx` の `meta` から呼ぶ ───────────────────────
 * 画面ごとに `meta` を書くと 50 個以上に散る。React Router の
 * `MetaFunction` は `location` を受け取るので、**1 か所で経路から引ける。**
 *
 * ── 見つからないときは既定へ ────────────────────────────
 * `/login` や `/m/*` はサイドバーを持たない。**推測で名前を作らない**
 * （`app.title` に倒す）。名前が要るようになったら、その画面を作る task が
 * ここへ 1 行足す。
 */

import { t, type MessageKey } from "../i18n.js";

import { NAV_ITEMS, PROPERTY_ID_PLACEHOLDER } from "../../ui/navigation.js";

/** 題名とブランドの区切り。**全角の縦棒**（日本語の題名に馴染む）。 */
const SEPARATOR = "｜";

/**
 * `href` を経路の照合に使える形へ。
 *
 * `/app/p/{propertyId}/board` のように施設 ID を含む項目があるので、
 * **プレースホルダより手前だけ**を接頭辞として見る。
 */
function prefixOf(href: string): string {
  const at = href.indexOf(PROPERTY_ID_PLACEHOLDER);
  return at < 0 ? href : href.slice(0, at);
}

/**
 * その経路の画面名のキー。**無ければ `null`。**
 *
 * 一致は接頭辞で見て、**いちばん長く一致したもの**を採る。
 * `/app/settings/rooms` が `/app/settings` にも当たるが、長い方が勝つ。
 */
export function pageTitleKey(pathname: string): MessageKey | null {
  let best: { key: MessageKey; length: number } | null = null;

  for (const item of NAV_ITEMS) {
    if (item.status !== "READY") continue;
    // `activeFor` を持つ項目（設定の入口）は配下ぜんぶを引き受けてしまう。
    // **`href` だけで見る** — 配下の画面はそれぞれ自分の項目を持っている。
    const prefix = prefixOf(item.href);
    if (prefix === "") continue;
    const hit = pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
    if (!hit) continue;
    if (best === null || prefix.length > best.length) best = { key: item.key, length: prefix.length };
  }

  return best?.key ?? null;
}

/**
 * タブに出す文字列。
 *
 * **ブランドを後ろに置く。** タブが狭いと後ろから省かれるので、
 * 先に画面名が読めるほうがよい（同じ画面を何枚も開くのが前提）。
 */
export function documentTitle(pathname: string): string {
  const key = pageTitleKey(pathname);
  return key === null ? t("app.title") : `${t(key)}${SEPARATOR}${t("app.brand")}`;
}
