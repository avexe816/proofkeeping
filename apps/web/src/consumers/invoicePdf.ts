/**
 * 請求書 PDF の生成（PK-SPEC-P5 §8.1・§8.3）。**Queue コンシューマ。**
 *
 * task:  docs/tasks/P5-06.md
 * ルール: .claude/rules/architecture.md §5 / billing.md §1・§2
 *
 * ```
 * POST /api/v1/invoices/issue-and-send   → QUEUE_PDF_GENERATION（P5-07）
 * POST /api/v1/invoices/:id/regenerate-pdf →     同上
 *                                        ← ここで PDF を作り R2 へ
 * ```
 *
 * ── なぜ Queue なのか（§8.3 MUST / P5-06 の完了条件）────
 * `@react-pdf/renderer` はレイアウトと書体の埋め込みを行う。明細が
 * 数十行あると数百 ms かかり、**リクエストの CPU 予算（50ms）に
 * 収まらない。** `renderInvoicePdf()` は Queue の中からしか呼ばない。
 *
 * ── 投入する側はまだ無い ────────────────────────────────
 * 発行フロー（§4.1 の ⑦）は P5-07。**このコンシューマは先に完成させて
 * よい**（P5-01 が書き込みの無いスキーマを先に置いたのと同じ）。
 * 逆に「発行の一部だけ」を先に作らないこと（§4.1 の ①〜⑥ は
 * 1 トランザクション）。
 *
 * ── 冪等（testing.md §4）─────────────────────────────────
 * 同じメッセージを 3 回処理しても結果が変わらない。
 *   ① R2 のキーが `(組織, 文書番号, 版)` で決まる。3 回作れば同じキーへ
 *      同じ内容が載る。
 *   ② payload は発行時に固定された値から毎回組み直す。**差分を足さない。**
 *   ③ 行を作らないので、行が増えることもない。
 * `pdfSha256` の書き戻しはここで行わない（§4.1 の ⑧）。**帳票の列を
 * 書き換える経路をコンシューマに持たせない** — 書き戻しは発行フローが
 * 持ち、P5-07 が実装する。
 *
 * ── 消さない・上書きしない ──────────────────────────────
 * 版を上げた再発行は別のキーになる。元の PDF は**閲覧可能なまま
 * 維持する**（billing.md §2）。削除の経路をこのファイルへ足さないこと。
 */

import { type Env, type TenantContext } from "@pk/db";
import { renderInvoicePdf } from "@pk/pdf";

import { loadDailyReportFont } from "../lib/report/font.js";
import { collectInvoicePayload, invoicePdfKey, loadInvoiceSeal } from "../lib/report/invoice.js";

/** キューへ載せるメッセージ。**組織の解決に要る値を全部持たせる。** */
export interface InvoicePdfMessage {
  kind: "INVOICE_PDF";
  organizationId: string;
  orgShortId: string;
  invoiceId: string;
  /**
   * 角印画像の R2 キー。**投入側が渡す**（コンシューマが税務プロファイルを
   * 引き直さない / `lib/report/invoice.ts` の注記）。未設定なら `null`。
   */
  sealImageKey: string | null;
  /** 要求した時刻（ミリ秒）。**再送でも変わらない**（冒頭の「冪等」）。 */
  requestedAtMs: number;
}

/** メッセージの形を確かめる。**Zod を使わない**（contracts は API の入出力の定義）。 */
export function isInvoicePdfMessage(value: unknown): value is InvoicePdfMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    message["kind"] === "INVOICE_PDF" &&
    typeof message["organizationId"] === "string" &&
    typeof message["orgShortId"] === "string" &&
    typeof message["invoiceId"] === "string" &&
    (message["sealImageKey"] === null || typeof message["sealImageKey"] === "string") &&
    typeof message["requestedAtMs"] === "number"
  );
}

/** 1 件の処理結果。**呼び出し側（`queue()`）が ack / retry を決める。** */
export type InvoicePdfOutcome =
  | { kind: "OK"; key: string; bytes: number }
  /** 請求書が無い・スナップショットが読めない。**再送しても直らない。** */
  | { kind: "SKIPPED"; reason: string }
  /** R2 / D1 / 書体の不足。**直しうる**ので retry する。 */
  | { kind: "FAILED"; reason: string };

/**
 * 請求書 PDF を 1 通作る。
 *
 * **同じ文書・同じ版を作り直すと同じキーへ同じ内容が載る**（冒頭の「冪等」）。
 */
export async function generateInvoicePdf(
  env: Env,
  message: InvoicePdfMessage,
): Promise<InvoicePdfOutcome> {
  const ctx: TenantContext = {
    organizationId: message.organizationId,
    orgShortId: message.orgShortId,
    // バッチと同じ扱い（`consumers/dailyReport.ts` の注記 / OPEN_QUESTIONS #033）。
    // **`assertPermission()` は呼ばない。** 認可は投入した API 側で済んでいる。
    role: "ORG_ADMIN",
    allowedPropertyIds: [],
    now: new Date(message.requestedAtMs),
  };

  try {
    const source = await collectInvoicePayload(env, ctx, message.invoiceId);
    if (source === null) return { kind: "SKIPPED", reason: "INVOICE_NOT_FOUND" };
    const { payload, revision } = source;

    // **和文の書体が無ければ作らない。** 「動いているのに読めない PDF」を
    // 取引先へ送らない（`packages/pdf/src/dailyReport.ts` の注記）。
    const font = await loadDailyReportFont(env);
    if (font === null) return { kind: "FAILED", reason: "FONT_NOT_FOUND" };

    // 角印は無くても請求書は成立する（§1.1 の 6 要件に入っていない）。
    const seal = await loadInvoiceSeal(env, message.sealImageKey);

    const bytes = await renderInvoicePdf(payload, font, seal);
    const key = invoicePdfKey({
      organizationId: message.organizationId,
      documentNo: payload.documentNo,
      revision,
    });

    await env.DOCUMENTS.put(key, bytes, {
      httpMetadata: { contentType: "application/pdf" },
    });

    return { kind: "OK", key, bytes: bytes.byteLength };
  } catch (error) {
    // **中身をログへ流さない。** 例外の名前だけ（architecture.md §1）。
    // 文書番号も出さない（取引の内容が推測できる）。
    const reason = error instanceof Error ? error.name : "UNKNOWN";
    console.error(`invoice-pdf-failed reason=${reason}`);
    return { kind: "FAILED", reason };
  }
}
