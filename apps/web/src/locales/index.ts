/**
 * 文言カタログ。**JSON が正で、この TS は型を付けるだけ。**
 *
 * task:  docs/tasks/P0-15.md
 * ルール: .claude/rules/ui-writing.md §1, §2 / docs/PK-IMPL-CONTRACT.md §7
 *
 * ── なぜ JSON なのか ────────────────────────────────────
 * P0-14 は `ja.ts`（`as const` のオブジェクト）で持っていた。P0-15 で
 * JSON へ移したのは、翻訳の受け渡しに TS の構文が邪魔になるため。
 * 契約 §7.3 は翻訳を現場スタッフの確認に掛けると定めており、
 * 翻訳者が触る成果物にコードを混ぜない。
 *
 * ── ja が全キーを持つ。他言語は部分集合 ─────────────────
 * `MessageKey` は **`ja.json` のキーから導く。** 他言語の JSON は
 * `Partial<Record<MessageKey, string>>` として読み、欠けたキーは
 * `ja` へ落ちる（`createTranslator()`）。契約 §7.1 は 7 言語を挙げるが、
 * **追加は「翻訳が揃った言語から `LOCALES` に足す」**という順序にする。
 * 空文字のキーを並べた JSON を先に置くと、画面に空欄が出る。
 *
 * ── 禁止語の検査 ────────────────────────────────────────
 * ESLint の `pk/no-forbidden-words` は locales 配下を対象に含むが、
 * **ESLint は既定で .json を解析しない。** JSON へ移した文言が検査から
 * 外れないよう、`locales.spec.ts` が同じ語彙表（`rules/forbidden-words-list.js`）で
 * 全カタログを検査する。CI の `forbidden-words` ジョブ（P0-19）も
 * .json を grep 対象に含めてある。**二重にしてあるのは意図。**
 */

import enJson from "./en.json";
import jaJson from "./ja.json";

/**
 * 日本語カタログ。**全キーを持つ唯一のカタログ。**
 *
 * ここへキーを足したら他言語は自動で追随しない。追随させる必要も無い
 * （欠けたキーは `ja` に落ちる）。
 */
export const ja = jaJson;

/** 文言のキー。**この型に無いキーはコンパイルが通らない。** */
export type MessageKey = keyof typeof jaJson;

/** 言語ごとのカタログ。`ja` 以外は部分集合。 */
export type MessageCatalog = Partial<Record<MessageKey, string>>;

/**
 * 英語カタログ。**モバイル（`/m/*`）向け**（ui-writing.md §1）。
 *
 * 管理画面は日本語のみのため、管理画面専用のキーは意図的に訳していない。
 * 訳が無いキーは `ja` が出る。
 */
export const en: MessageCatalog = enJson;

/**
 * 対応言語。**翻訳が揃った言語だけを載せる。**
 *
 * 契約 §7.1 は `ja` / `en` / `zh-CN` / `vi` / `id` / `my` / `ne` を挙げるが、
 * 実際に翻訳を持つのは 2 言語。残り 5 言語は現場スタッフの確認を経てから
 * （§7.3「機械翻訳のまま使用しない」）カタログと一緒にここへ足す。
 */
export const LOCALES = ["ja", "en"] as const;

export type Locale = (typeof LOCALES)[number];

/** 既定言語。ブラウザの言語設定は参照しない（ui-writing.md §1）。 */
export const DEFAULT_LOCALE: Locale = "ja";

/** 言語ごとのカタログ表。 */
export const CATALOGS: Record<Locale, MessageCatalog> = { ja, en };
