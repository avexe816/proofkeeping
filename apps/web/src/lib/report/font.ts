/**
 * 帳票 PDF の和文書体（PK-SPEC-P2 §9）。
 *
 * task:  docs/tasks/P2-14.md（当初）/ オーナー指示 2026-08-22
 * 決定:  docs/DECISIONS.md #255（R2 をやめる）→ **#256（置き場所を静的アセットへ）**
 *
 * ── 何を使っているか ────────────────────────────────────
 * **IPAゴシック（`ipag.ttf`）を無改変のまま同梱している。**
 * ライセンスは IPA Font License Agreement v1.0（全文は書体と同じ
 * ディレクトリ `public/fonts/` に置いてある）。第 2 条 5 項が
 * 「文書に埋め込んで、その文書の内容を表示するためだけに使う場合、
 * これ以上の義務を負わない」と定めており、PDF への埋め込みはこの条項が
 * そのまま当たる。無改変・改名なしで置いているのは第 3 条 2 項
 * （名称を変えない・改変しない・許諾書を添付する）に沿わせるため。
 * **サブセット化しないこと。** 改変にあたり、別の条件（第 3 条 1 項）へ移る。
 *
 * ── なぜ静的アセットなのか（スクリプトへの同梱をやめた）──
 * R2 に置く形は**人手の作業で、置かれていなかった**（OPEN_QUESTIONS #054）。
 * そこでスクリプトへ同梱したところ、**無料枠の上限 3 MiB を超えて
 * staging のデプロイが落ちた**（gzip 6.34 MiB / DECISIONS #256）。
 *
 * **静的アセットはスクリプトの容量に数えられない。** `build/client` に
 * 置いて `ASSETS` binding から読む。デプロイに同梱されるので**置き忘れが
 * 起きない**という R2 に対する利点は保ったまま、容量の制約を外せる。
 *
 * ── ネットワークから取りに行かない ──────────────────────
 * `ASSETS` は Worker に紐づく binding で、外へ出る通信ではない。
 * fetch も R2 も KV も読まない。**この方針を崩さないこと**（オーナー指示）。
 *
 * ── data URL で渡すこと（URL やパスにしない）────────────
 * `@react-pdf/font` は `src` の形で読み込み方を変える。data URL なら
 * `fontkit.create()`（同期・バイト列から）だが、**パスとして扱われると
 * `fontkit.open()` を呼ぶ。これは browser 版のバンドルに存在しない**
 * （ビルドが `IMPORT_IS_UNDEFINED` を警告する枝）。アセットの URL を
 * そのまま渡すと実行時に `undefined is not a function` で落ちる。
 * **バイト列を base64 にしてから渡す。**
 *
 * ── isolate ごとに 1 回だけ読む ─────────────────────────
 * 6MB を読んで base64 に直す処理は安くない。同じ isolate で 2 通目以降は
 * 使い回す。**プロセスをまたいで共有しない**（Workers に共有メモリは無い）。
 */

import type { DailyReportFont } from "@pk/pdf";
import type { Env } from "@pk/db";

/** アセットの位置。**`public/fonts/` に置いたものがそのままここへ出る。** */
export const DAILY_REPORT_FONT_PATH = "/fonts/ipag.ttf";

/** `@react-pdf/renderer` に登録する family 名。 */
export const DAILY_REPORT_FONT_FAMILY = "PkJp";

/** isolate ごとの控え。**未取得は `undefined`、読めなかったのは `null`。** */
let cached: DailyReportFont | null | undefined;

/** base64 へ直すときの塊。**引数に展開するので大きくしすぎない**（`apply` の上限）。 */
const BASE64_CHUNK = 0x8000;

/** バイト列 → base64。**Workers に `Buffer` は無い**ので `btoa` を使う。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
  }
  return btoa(binary);
}

/**
 * 和文書体を読む。**読めなければ `null`。**
 *
 * 呼び出し側は `null` を失敗として扱い、再送に回すこと。**空白の PDF を
 * 出さない**（`packages/pdf/src/dailyReport.ts` の注記）。
 *
 * @param env `ASSETS` binding を持つ env。
 */
export async function loadDailyReportFont(env: Env): Promise<DailyReportFont | null> {
  if (cached !== undefined) return cached;

  // **相対パスは使えない。** binding の `fetch()` は絶対 URL を要求する。
  // 出ていく通信ではないので、host は何でもよい。
  const response = await env.ASSETS.fetch(new Request(`https://assets.local${DAILY_REPORT_FONT_PATH}`));
  if (!response.ok) {
    cached = null;
    return null;
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  // 0 バイトを「読めた」にしない（書体として使えない）。
  if (bytes.byteLength === 0) {
    cached = null;
    return null;
  }

  cached = {
    kind: "EMBEDDED",
    family: DAILY_REPORT_FONT_FAMILY,
    dataUrl: `data:font/ttf;base64,${bytesToBase64(bytes)}`,
  };
  return cached;
}

/** テスト用に控えを捨てる。**本番の経路から呼ばないこと。** */
export function resetDailyReportFontCache(): void {
  cached = undefined;
}
