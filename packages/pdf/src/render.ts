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

import type { InvoicePayload } from "@pk/billing";
import type { AuditReportPayload, DailyReportPayload } from "@pk/engine";
import { Font, renderToBuffer } from "@react-pdf/renderer";

import { buildAuditReportDocument, type AuditReportFont } from "./auditReport.js";
import { buildInvoiceDocument, type InvoiceFont, type InvoiceSeal } from "./invoice.js";
import { buildDailyReportDocument, type DailyReportFont } from "./dailyReport.js";

/** この isolate で登録済みの family。**再登録を避けるためだけの記憶。** */
const registeredFamilies = new Set<string>();

/** 書体を登録する（登録済みなら何もしない）。 */
export function registerFont(font: DailyReportFont | AuditReportFont | InvoiceFont): void {
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

/**
 * 月次監査レポート PDF を作る（PK-SPEC-P4 §7 / P4-14）。
 *
 * **Queue コンシューマ内でのみ呼ぶ**（冒頭の注記）。§7 のレポートは
 * 12 か月ぶんの推移と全件詳細を含み、日報より重い。
 *
 * 免責文（§7.2 MUST）はテンプレートが定数から読む。**ここでも
 * payload からも差し替えられない。**
 */
export async function renderAuditReportPdf(
  payload: AuditReportPayload,
  font: AuditReportFont,
): Promise<Uint8Array> {
  registerFont(font);
  const buffer = await renderToBuffer(buildAuditReportDocument(payload, font));
  return new Uint8Array(buffer);
}

/**
 * 請求書 PDF を作る（PK-SPEC-P5 §8.1 / P5-06）。
 *
 * **Queue コンシューマ内でのみ呼ぶ**（§8.3 MUST / 冒頭の注記）。
 * 明細が数十行あり、書体の埋め込みと合わせてリクエストの CPU 予算を
 * 超える。
 *
 * **payload の値をそのまま描く。** 金額の計算はここでも
 * テンプレートでも行わない（`invoice.ts` の「数値を再計算しない」）。
 *
 * @param seal 角印。**未設定なら `null`**（枠を出さない）。
 */
export async function renderInvoicePdf(
  payload: InvoicePayload,
  font: InvoiceFont,
  seal: InvoiceSeal = null,
): Promise<Uint8Array> {
  registerFont(font);
  const buffer = await renderToBuffer(buildInvoiceDocument(payload, font, seal));
  return new Uint8Array(buffer);
}
