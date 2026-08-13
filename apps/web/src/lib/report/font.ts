/**
 * 日報 PDF の和文フォント（PK-SPEC-P2 §9）。
 *
 * task: docs/tasks/P2-14.md
 *
 * ── なぜフォントを外から持ってくるのか ──────────────────
 * `@react-pdf/renderer` の既定は Helvetica で、**CJK のグリフを持たない。**
 * 和文を渡しても例外にはならず、**字が出ないだけの PDF ができる。**
 * 日報は施設へ提出する文書なので、これは静かな事故になる。
 *
 * 和文 TTF は数 MB ある。**Worker のバンドルに含めない**
 * （アップロードの上限に効くうえ、フォントの差し替えでコードの
 * デプロイが要る形になる）。R2（`DOCUMENTS`）に 1 つ置き、
 * 生成のときに読む。
 *
 * ── 置く場所（人手の作業）──────────────────────────────
 * ```
 * wrangler r2 object put pk-documents/fonts/pk-jp-regular.ttf --file <TTF>
 * ```
 * **これが無いと日報は作られない**（`loadDailyReportFont()` が `null` を
 * 返し、コンシューマが失敗として再送に回す）。空白だらけの PDF を
 * 出すより、出さずに気づけるほうがよい。使う TTF は「日本語の
 * グリフを持ち、埋め込みが許諾されているもの」であること
 * （P0-02 と同じく、実物の用意は人間の作業。docs/PROGRESS.md 参照）。
 *
 * ── data URL で渡すこと（URL やパスにしない）────────────
 * `@react-pdf/font` は `src` の形で読み込み方を変える。data URL なら
 * `fontkit.create()`（同期・バイト列から）だが、**パスとして扱われると
 * `fontkit.open()` を呼ぶ。これは browser 版のバンドルに存在しない**
 * （`pnpm --filter @pk/web build` が `IMPORT_IS_UNDEFINED` を警告する枝）。
 * R2 の URL を直接渡す形にすると、Worker から取りに行けても
 * 実行時に `undefined is not a function` で落ちる。**バイト列を
 * base64 にしてから渡す。**
 *
 * ── isolate ごとに 1 回だけ読む ─────────────────────────
 * R2 から数 MB を読み、base64 に直す処理は安くない。
 * 同じ isolate で 2 通目以降は使い回す。**プロセスをまたいで
 * 共有しない**（Workers に共有メモリは無い）。
 */

import type { DailyReportFont } from "@pk/pdf";
import type { Env } from "@pk/db";

/** R2（`DOCUMENTS`）のフォントのキー。**署名付き URL では配れない接頭辞**（`files.ts`）。 */
export const DAILY_REPORT_FONT_KEY = "fonts/pk-jp-regular.ttf";

/** `@react-pdf/renderer` に登録する family 名。 */
export const DAILY_REPORT_FONT_FAMILY = "PkJp";

/** isolate ごとの控え。**未取得は `undefined`、取りに行って無かったのは `null`。** */
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
 * フォントを読む。**無ければ `null`。**
 *
 * @returns 登録に使える `DailyReportFont`。R2 に置かれていなければ `null`。
 */
export async function loadDailyReportFont(env: Env): Promise<DailyReportFont | null> {
  if (cached !== undefined) return cached;

  const object = await env.DOCUMENTS.get(DAILY_REPORT_FONT_KEY);
  if (object === null) {
    cached = null;
    return null;
  }

  const bytes = new Uint8Array(await object.arrayBuffer());
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
