/**
 * 月次監査レポート PDF の生成（PK-SPEC-P4 §7）。**Queue コンシューマ。**
 *
 * task:  docs/tasks/P4-14.md
 * ルール: .claude/rules/architecture.md §5 / ui-writing.md §2
 *
 * ```
 * POST /api/v1/reports/audit/monthly → QUEUE_PDF_GENERATION
 *                                    ← ここで PDF を作り R2 へ
 * ```
 *
 * ── なぜ Queue なのか（P4-14 の完了条件）────────────────
 * 1 か月ぶんの差異と 12 か月ぶんの推移を読み、A4 数ページを描く。
 * **リクエストハンドラの CPU 予算（50ms）に収まらない。**
 * `renderAuditReportPdf()` は Queue の中からしか呼ばない。
 *
 * ── 冪等（testing.md §4）─────────────────────────────────
 * 同じメッセージを 3 回処理しても結果が変わらない。
 *   ① R2 のキーが `(組織, 施設, 月)` で決まる（版を持たない）。
 *      3 回作れば同じキーに同じ内容が載る。
 *   ② payload は元データから毎回組み直す。**差分を足さない。**
 *   ③ 表に行を作らないので、行が増えることもない（DECISIONS #119）。
 *
 * ── 免責事項（§7.2 MUST）────────────────────────────────
 * テンプレートが `AUDIT_REPORT_DISCLAIMER` を直に読む。**この
 * コンシューマから文言を渡す経路が無い。**
 */

import type { Env, TenantContext } from "@pk/db";
import { renderAuditReportPdf } from "@pk/pdf";

import { auditReportKey, collectAuditReport } from "../lib/report/auditReport.js";
import { loadDailyReportFont } from "../lib/report/font.js";

/** キューへ載せるメッセージ。**組織の解決に要る値を全部持たせる。** */
export interface AuditReportMessage {
  kind: "AUDIT_REPORT";
  organizationId: string;
  orgShortId: string;
  propertyId: string;
  /** 対象月 `YYYY-MM`。 */
  month: string;
  /** 要求した `membership.id`。 */
  requestedById: string;
  /** 要求した時刻（ミリ秒）。**再送でも変わらない**（冒頭の「冪等」）。 */
  requestedAtMs: number;
}

/** メッセージの形を確かめる。**Zod を使わない**（contracts は API の入出力の定義）。 */
export function isAuditReportMessage(value: unknown): value is AuditReportMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    message["kind"] === "AUDIT_REPORT" &&
    typeof message["organizationId"] === "string" &&
    typeof message["orgShortId"] === "string" &&
    typeof message["propertyId"] === "string" &&
    typeof message["month"] === "string" &&
    typeof message["requestedById"] === "string" &&
    typeof message["requestedAtMs"] === "number"
  );
}

/** 1 件の処理結果。**呼び出し側（`queue()`）が ack / retry を決める。** */
export type AuditReportOutcome =
  | { kind: "OK"; key: string; bytes: number }
  /** 施設が無い・月の形が違う。**再送しても直らない**ので ack する。 */
  | { kind: "SKIPPED"; reason: string }
  /** R2 / D1 / 書体の不足。**直しうる**ので retry する。 */
  | { kind: "FAILED"; reason: string };

/**
 * 月次監査レポートを 1 通作る。
 *
 * **同じ月を作り直すと同じキーへ上書きする。** 日報（§9.3）と違って
 * 版を持たないのは、このレポートが発行済み帳票ではなく、元データから
 * いつでも作り直せる要約だから（DECISIONS #119）。
 */
export async function generateAuditReport(
  env: Env,
  message: AuditReportMessage,
): Promise<AuditReportOutcome> {
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
    const payload = await collectAuditReport(env, ctx, {
      propertyId: message.propertyId,
      month: message.month,
    });
    if (payload === null) return { kind: "SKIPPED", reason: "PROPERTY_OR_MONTH_NOT_FOUND" };

    // **和文の書体が無ければ作らない。** 「動いているのに読めない PDF」を
    // 出回らせない（`packages/pdf/src/dailyReport.ts` の注記）。
    const font = await loadDailyReportFont(env);
    if (font === null) return { kind: "FAILED", reason: "FONT_NOT_FOUND" };

    const bytes = await renderAuditReportPdf(payload, font);
    const key = auditReportKey({
      organizationId: message.organizationId,
      propertyId: message.propertyId,
      month: message.month,
    });

    await env.DOCUMENTS.put(key, bytes, {
      httpMetadata: { contentType: "application/pdf" },
    });

    return { kind: "OK", key, bytes: bytes.byteLength };
  } catch (error) {
    // **中身をログへ流さない。** 例外の名前だけ（architecture.md §1）。
    const reason = error instanceof Error ? error.name : "UNKNOWN";
    console.error(`audit-report-failed month=${message.month} reason=${reason}`);
    return { kind: "FAILED", reason };
  }
}
