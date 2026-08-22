/**
 * 設定サイドバー（設定領域の中だけのナビ）の判定（人間の指示 2026-08-22
 * ／DECISIONS #258。#257 の breadcrumb を置き換える）。
 *
 * ── 何を解いているか ────────────────────────────────────
 * 設定は 17 画面あり、入口は `/app/settings` のハブ 1 枚だけだった。
 * サブ画面へ入ると**同じ設定どうしを行き来する道が無く**、隣の設定へ
 * 移るのに毎回ハブへ戻る必要があった。#257 の「← 設定」は戻り道は作った
 * ものの、**横の移動は 1 クリック増えたまま**だった。
 *
 * 全体ナビ（左のサイドバー）と設定内ナビを分けるのが定石で、ここは
 * その**設定内ナビが出る場所**と**いまどれを開いているか**だけを決める。
 *
 * ── ここは分類を持たない ────────────────────────────────
 * どの画面がどの群かは `NAV_ITEMS` の `settingsGroup`（`navigation.ts`）が
 * 唯一の正。**URL の文字列から群を推測しない。**
 * この module が URL を見るのは 2 つの判断だけ:
 *
 *   1. 設定サイドバーを出す場所か（`isSettingsSubScreen`）
 *   2. その項目を選択表示にするか（`isSettingsItemActive`）
 */

import { SETTINGS_ACTIVE_PREFIXES, SETTINGS_HUB_PATH, isActivePrefix } from "./navigation.js";

/**
 * 設定領域（ハブとその配下）か。
 *
 * `/app/settings/*` に加えて `/app/training` と `/app/audit/logs` も
 * 設定（`SETTINGS_ACTIVE_PREFIXES`）。**URL が離れているだけで扱いは同じ。**
 */
export function isSettingsArea(pathname: string): boolean {
  return isActivePrefix(SETTINGS_ACTIVE_PREFIXES, pathname);
}

/**
 * 設定サイドバーを出す画面か。**ハブ自身には出さない**（人間の判断 A）。
 *
 * ハブはカードが目次そのもので、同じ 17 リンクを 1 画面に 2 組並べても
 * 情報が増えない。
 */
export function isSettingsSubScreen(pathname: string): boolean {
  return isSettingsArea(pathname) && pathname !== SETTINGS_HUB_PATH;
}

/**
 * その項目を選択表示にするか。
 *
 * **自分の URL と、その配下**（`/app/settings/integrations/{id}/mappings`）。
 * 子画面は一覧に並べず、**親を選択状態にする**（人間の判断 D）。
 * `/` で区切って照合するので `/app/settings/rooms` が
 * `/app/settings/room-types` に反応することはない。
 */
export function isSettingsItemActive(href: string | null, pathname: string): boolean {
  if (href === null) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}
