/**
 * 文言の引き当てと言語の解決。
 *
 * task:  docs/tasks/P0-15.md（P0-14 の「キーを引くだけ」を置き換える）
 * ルール: .claude/rules/ui-writing.md §1 / docs/PK-IMPL-CONTRACT.md §7
 *
 * ── ブラウザの言語設定を参照しない ──────────────────────
 * `Accept-Language` も `navigator.language` も読まない。現場は共用端末で、
 * 端末の設定は「いま使っている人」を表さない（ui-writing.md §1）。
 * **言語はユーザー属性（`user.locale`）で持ち、無ければ組織の既定
 * （`organization.locale`）へ、それも無ければ `ja` へ落とす。**
 * この 3 段だけが言語の決まり方で、他の入力を足さないこと。
 *
 * ── 補間を持たない ──────────────────────────────────────
 * `t("key")` はカタログの値をそのまま返す。`{name}` のような差し込みは
 * **意図的に実装していない。** 差し込みが要る文面は、語順が言語で変わる。
 * 契約 §7.1 は 7 言語を挙げており、置換だけの補間は 5 言語目で破綻する。
 * 値を混ぜる必要が出た画面は、数値・日付を別要素として組むこと
 * （`formatCount()` の類はその画面を作る task が置く）。
 */

import {
  CATALOGS,
  DEFAULT_LOCALE,
  LOCALES,
  ja,
  type Locale,
  type MessageKey,
} from "../locales/index.js";

export { DEFAULT_LOCALE, LOCALES };
export type { Locale, MessageKey };

/** 文言を引く関数。画面は基本これを受け取る。 */
export type Translator = (key: MessageKey) => string;

/** `LOCALES` に載っている言語かどうか。 */
export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * 表示言語を決める。**候補は前から順に見て、最初に一致したものを採る。**
 *
 * 呼び出し側は `resolveLocale(user.locale, organization.locale)` の順で渡す。
 * 対応外の値（DB に `zh-CN` が入っている等）は一致とみなさず次の候補へ進み、
 * 最後は `ja` になる。**未対応の言語で画面が空になる状態を作らない。**
 */
export function resolveLocale(...candidates: readonly (string | null | undefined)[]): Locale {
  for (const candidate of candidates) {
    if (isLocale(candidate)) return candidate;
  }
  return DEFAULT_LOCALE;
}

/**
 * その言語の `t()` を作る。
 *
 * 訳が無いキーは `ja` を返す。**キーそのものを返さない。** 画面に
 * `nav.dashboard` と出るより、日本語が出るほうが現場で困らない。
 */
export function createTranslator(locale: Locale): Translator {
  const catalog = CATALOGS[locale];
  if (locale === DEFAULT_LOCALE) return (key) => ja[key];
  return (key) => catalog[key] ?? ja[key];
}

/**
 * 既定言語（日本語）の `t()`。
 *
 * 管理画面は日本語のみ（ui-writing.md §1）なので、`/app/*` の画面は
 * これをそのまま使ってよい。**モバイル（`/m/*`・P1 以降）は
 * `createTranslator(resolveLocale(...))` を loader から渡すこと。**
 */
export const t: Translator = (key) => ja[key];
