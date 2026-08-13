/**
 * PDF の描画（PK-SPEC-P2 §9.5）。
 *
 * task:  docs/tasks/P2-14.md
 * ルール: .claude/rules/architecture.md §5（CPU 50ms 超は Queue へ）
 *
 * ── **リクエストハンドラから呼ばないこと。** ────────────
 * `@react-pdf/renderer` はレイアウトと書体の埋め込みを行う。100 室の
 * 明細で数百 ms かかり、Workers のリクエストの CPU 予算（50ms）を超える。
 * 呼んでよいのは Queue コンシューマの中だけ（CLAUDE.md §2 の
 * 「PDF は Queue コンシューマ内のみ」）。
 *
 * ── 書体の登録は 1 回だけ ───────────────────────────────
 * `Font.register()` はグローバルな登録簿に書き込む。**同じ family を
 * 2 回登録すると、そのたびに data URL を復号し直す**（和文フォントは
 * 数 MB あるので、これが 1 通ごとに走ると CPU を食う）。
 * isolate ごとに 1 回で済むよう、登録済みの family を覚えておく。
 *
 * ── 出力は `Uint8Array` ─────────────────────────────────
 * `renderToBuffer()` は Node の `Buffer` を返す。**Workers に `Buffer` は
 * 無い**（`nodejs_compat` があれば動くが、R2 へ渡す型は `Uint8Array` で
 * 揃える）。境界でここだけが変換を持つ。
 */

import type { DailyReportPayload } from "@pk/engine";
import { Font, renderToBuffer } from "@react-pdf/renderer";

import { buildDailyReportDocument, type DailyReportFont } from "./dailyReport.js";

/** この isolate で登録済みの family。**再登録を避けるためだけの記憶。** */
const registeredFamilies = new Set<string>();

/** 書体を登録する（登録済みなら何もしない）。 */
export function registerFont(font: DailyReportFont): void {
  if (font.kind !== "EMBEDDED") return;
  if (registeredFamilies.has(font.family)) return;
  Font.register({ family: font.family, src: font.dataUrl });
  registeredFamilies.add(font.family);
}

/**
 * 日報 PDF を作る。**同じ payload からは同じ内容の PDF ができる。**
 *
 * `@react-pdf/renderer` は PDF の `CreationDate` を書き込むため、
 * **バイト列そのものは実行のたびに変わりうる。** だから冪等性は
 * 「同じキーへ同じ内容を置き直す」ことで担保し、バイト単位の一致には
 * 依存しない（`consumers/dailyReport.ts` の「冪等」）。
 *
 * @param payloadSha256 紙に載せる文書ハッシュ（§9.2）。
 */
export async function renderDailyReportPdf(
  payload: DailyReportPayload,
  payloadSha256: string,
  font: DailyReportFont,
): Promise<Uint8Array> {
  registerFont(font);
  const buffer = await renderToBuffer(buildDailyReportDocument(payload, payloadSha256, font));
  return new Uint8Array(buffer);
}
