/**
 * 帳票 PDF の和文書体（PK-SPEC-P2 §9）。
 *
 * task:  docs/tasks/P2-14.md（当初）/ オーナー指示 2026-08-22（同梱へ変更）
 * 決定:  docs/DECISIONS.md #255
 *
 * ── 何を使っているか ────────────────────────────────────
 * **IPAゴシック（`ipag.ttf`）を無改変のまま同梱している。**
 * ライセンスは IPA Font License Agreement v1.0
 * （`src/assets/fonts/IPA_Font_License_Agreement_v1.0.txt` に全文）。
 * 第 2 条 5 項が「文書に埋め込んで、その文書の内容を表示するためだけに
 * 使う場合、これ以上の義務を負わない」と定めており、PDF への埋め込みは
 * この条項がそのまま当たる。無改変・改名なしで置いているのは第 3 条 2 項
 * （名称を変えない・改変しない・許諾書を添付する）に沿わせるため。
 * **サブセット化しないこと。** 改変にあたり、別の条件（第 3 条 1 項）へ移る。
 *
 * ── なぜ同梱なのか（R2 から変えた）──────────────────────
 * 以前は R2（`DOCUMENTS`）の `fonts/pk-jp-regular.ttf` を読んでいた。
 * **置くのが人手の作業で、置かれていなかった。** その間、日報・請求書・
 * 領収書・支払明細書・監査レポートの PDF は 1 通も作られず
 * （`FONT_ASSET_MISSING` で再送に回り、3 回で落ちる）、業務の流れが
 * ここで止まっていた（docs/OPEN_QUESTIONS.md #054）。
 *
 * 同梱にすると、**デプロイした時点で必ず在る。** 環境ごとの手作業も、
 * 「staging では出るが production では出ない」という差も無くなる。
 * 代わりに Worker のスクリプトが大きくなる（実測は #255 に記録）。
 *
 * ── ネットワークから取りに行かない ──────────────────────
 * ビルド時に data URL へ畳む（Vite の `?inline`）。実行時に fetch も
 * R2 も KV も読まない。**この方針を崩さないこと**（オーナー指示）。
 *
 * ── data URL で渡すこと（URL やパスにしない）────────────
 * `@react-pdf/font` は `src` の形で読み込み方を変える。data URL なら
 * `fontkit.create()`（同期・バイト列から）だが、**パスとして扱われると
 * `fontkit.open()` を呼ぶ。これは browser 版のバンドルに存在しない**
 * （ビルドが `IMPORT_IS_UNDEFINED` を警告する枝）。`?url` に変えると
 * 実行時に `undefined is not a function` で落ちる。**`?inline` のまま。**
 */

import type { DailyReportFont } from "@pk/pdf";

// Vite がビルド時に `data:font/ttf;base64,...` へ畳む。**実行時の取得は無い。**
import fontDataUrl from "../../assets/fonts/ipag.ttf?inline";

/** `@react-pdf/renderer` に登録する family 名。 */
export const DAILY_REPORT_FONT_FAMILY = "PkJp";

/**
 * 同梱した和文書体。**必ず在る**ので `null` を返さない。
 *
 * 参照のたびに新しい物を作らない（data URL は 8MB 前後の文字列で、
 * 複製すると 1 通ごとにその分の記憶域を使う）。
 */
const EMBEDDED: DailyReportFont = {
  kind: "EMBEDDED",
  family: DAILY_REPORT_FONT_FAMILY,
  dataUrl: fontDataUrl,
};

/**
 * 帳票 PDF に使う和文書体を返す。
 *
 * **同期。`env` を取らない。** 以前の `loadDailyReportFont(env)` は R2 を
 * 読むため非同期で、取得できないことがあった。同梱後は「無い」が
 * 起こらないので、呼び出し側の失敗の枝も消してある。
 */
export function dailyReportFont(): DailyReportFont {
  return EMBEDDED;
}
