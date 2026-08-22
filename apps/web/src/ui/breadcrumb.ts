/**
 * 上位の画面へ戻る道（人間の指摘 2026-08-22「設定のサブ画面から上位へ
 * すぐ戻れない。毎回サイドバーを押し直している」／DECISIONS #257）。
 *
 * ── 何を解いているか ────────────────────────────────────
 * 設定は `/app/settings` のハブ 1 枚に寄せてあり（DECISIONS の設定ハブ）、
 * **サイドバーには「⚙ 設定」しか出ない。** サブ画面（`/app/settings/rooms`
 * など）を開くと、画面の中に上位へ戻る手掛かりが 1 つも無く、戻るには
 * サイドバーへ視線と手を戻す必要があった。ここはその 1 本を作る。
 *
 * ── 現在地ではなく「戻り先」を並べる ────────────────────
 * 返すのは**祖先だけ**で、開いている画面自身は含めない。画面名は
 * すぐ下の `.pk-pagehead__title` に必ず出ており、同じ語を 2 行続けても
 * 情報が増えないため。**押せるものだけを並べる。**
 *
 * ── 登録簿を写さない ────────────────────────────────────
 * 戻り先は `NAV_ITEMS`（`navigation.ts`）から引く。ハブのカードと同じ表を
 * 見るので、**設定画面が増えてもここへ書き足す必要が無い**（`breadcrumb.spec.ts`
 * がハブの全 URL について道が付くことを固定する）。
 *
 * ── 権限を判定しない ────────────────────────────────────
 * ここは URL の親子関係だけを見る純粋関数で、**権限も契約も見ない。**
 * 戻り先はいずれも「いま開けている画面より上位」で、ハブ自身は
 * 開ける設定が 1 枚も無ければ 404 を返す（`settingsHub.tsx`）。
 * 表示制御を権限制御とみなさないのは家の作法どおり（security.md §1）。
 */

import type { MessageKey } from "../lib/i18n.js";

import {
  NAV_ITEMS,
  PROPERTY_ID_PLACEHOLDER,
  SETTINGS_ACTIVE_PREFIXES,
  SETTINGS_HUB_PATH,
  SETTINGS_ITEM_KEY,
  isActivePrefix,
} from "./navigation.js";

/** 戻り先 1 つ。**必ず押せる**（`href` を持たない要素は作らない）。 */
export interface Crumb {
  label: MessageKey;
  href: string;
}

/**
 * 設定ハブに載る画面のうち、**さらに下の画面を持ちうるもの。**
 *
 * `{propertyId}` を含む URL は静的に照合できないので外す（設定の項目に
 * 現時点で該当は無いが、足された時に黙って誤った親を返さないため）。
 */
const SETTINGS_PAGES: readonly Crumb[] = NAV_ITEMS.flatMap((item) =>
  item.placement === "SETTINGS" &&
  item.status === "READY" &&
  !item.href.includes(PROPERTY_ID_PLACEHOLDER)
    ? [{ label: item.key, href: item.href }]
    : [],
);

/**
 * その URL から見た戻り先を、上位から順に返す。**空なら戻り道を出さない。**
 *
 * | 開いている画面 | 返すもの |
 * |---|---|
 * | `/app/settings`（ハブ自身） | なし（ここが上位） |
 * | `/app/settings/rooms` | 設定 |
 * | `/app/settings/integrations/{id}/mappings` | 設定 → 連携設定 |
 * | `/app/training` / `/app/audit/logs` | 設定（ハブのカードだが URL が外にある） |
 * | 設定以外の画面 | なし |
 */
export function buildBreadcrumb(pathname: string): readonly Crumb[] {
  // 設定の外は対象にしない。**戻り先が自明でない画面に道を作らない**
  // （一覧 → 詳細のような親子は各画面が持つべきで、ここで推測しない）。
  if (!isActivePrefix(SETTINGS_ACTIVE_PREFIXES, pathname)) return [];
  if (pathname === SETTINGS_HUB_PATH) return [];

  const trail: Crumb[] = [{ label: SETTINGS_ITEM_KEY, href: SETTINGS_HUB_PATH }];

  // 間に挟まる画面（いまは連携設定 → マッピング設定の 1 段だけ）。
  // **接頭辞が短い順**に並べる。深さが増えてもそのまま積み上がる。
  trail.push(
    ...SETTINGS_PAGES.filter((page) => pathname.startsWith(`${page.href}/`)).sort(
      (a, b) => a.href.length - b.href.length,
    ),
  );

  return trail;
}
