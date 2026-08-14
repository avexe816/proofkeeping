/**
 * 日報 PDF の生成（PK-SPEC-P2 §9）。**Queue コンシューマ。**
 *
 * task:  docs/tasks/P2-14.md
 * ルール: .claude/rules/architecture.md §5 / billing.md §5 / testing.md §4
 *
 * ```
 * cron（10 分ごと） → 日締め + 10 分の施設を拾う → QUEUE_PDF_GENERATION
 * POST /api/v1/reports/daily/generate                → QUEUE_PDF_GENERATION
 *                                                    ← ここで PDF を作り R2 へ
 * ```
 *
 * ── なぜ Queue なのか ───────────────────────────────────
 * P2-14 の完了条件そのもの（「Queue コンシューマ内で生成される」）。
 * §15 は「100 室で 30 秒以内」を求めており、レイアウトと書体の
 * 埋め込みだけで数百 ms かかる。**リクエストハンドラの CPU 予算
 * （50ms / architecture.md §5）に収まらない。**
 *
 * ── 冪等（testing.md §4）─────────────────────────────────
 * 同じメッセージを 3 回処理しても結果が変わらない。効いているのは 3 つ。
 *   ① 自動生成は**その業務日の日報が既にあれば何もしない**（§9.3 は
 *      自動生成を 1 日 1 回と定める）。
 *   ② R2 のキーに版が入る。同じ版を作り直しても同じキーへ同じ内容が
 *      載る（§9.5 / `lib/report/dailyReportKey.ts`）。
 *   ③ payload は `requestedAtMs` を生成時刻に使う。**`new Date()` に
 *      しないこと。** 再送のたびにハッシュが変わり「同じ結果」でなくなる。
 * 一意制約 `(propertyId, businessDate, revision)` が最後の砦になる。
 *
 * ── 旧版を消さない ──────────────────────────────────────
 * 再生成は版を上げた**別のキー・別の行**になる（§9.3）。
 * 上書き・削除の経路をこのファイルへ足さないこと（billing.md §2）。
 *
 * ── 監査ログ ────────────────────────────────────────────
 * 手動の発行（§9.3 の再生成）だけ `document.issued` を書く。
 * **自動生成では書かない。** バッチにはセッションが無く、名乗れる
 * `membership.id` が存在しない（OPEN_QUESTIONS #033）。
 * 自動生成の記録は**追記しかできない `daily_report` の行そのもの**
 * （`generatedById = null` が「人ではない」を表す / DECISIONS #084）。
 */

import {
  createDailyReport,
  findLatestDailyReport,
  findTaxProfile,
  recordAudit,
  type Env,
  type TenantContext,
} from "@pk/db";
import { fiscalYearOf } from "@pk/billing";
import { canonicalJson, dailyReportCounters, dailyReportPayloadToCanonical } from "@pk/engine";
import { renderDailyReportPdf } from "@pk/pdf";

import { issueDocumentNumber } from "../lib/document/sequencer.js";
import { sha256Hex, sha256HexOfText } from "../lib/evidence/hash.js";
import { collectDailyReport } from "../lib/report/dailyReport.js";
import {
  dailyReportFileName,
  dailyReportKey,
  nextRevision,
} from "../lib/report/dailyReportKey.js";
import { DAILY_REPORT_FONT_KEY, loadDailyReportFont } from "../lib/report/font.js";

import { generateAuditReport, isAuditReportMessage } from "./auditReport.js";

/** キューへ載せるメッセージ。**組織の解決に要る値を全部持たせる。** */
export interface DailyReportMessage {
  kind: "DAILY_REPORT";
  organizationId: string;
  orgShortId: string;
  propertyId: string;
  /** 業務日 `YYYY-MM-DD`（architecture.md §7）。 */
  businessDate: string;
  /** `AUTO` は日締め 10 分後の自動生成、`MANUAL` は §9.3 の手動再生成。 */
  mode: "AUTO" | "MANUAL";
  /** 手動再生成した `membership.id`。**`AUTO` では `null`。** */
  requestedById: string | null;
  /** 要求した時刻（ミリ秒）。**再送でも変わらない**（冒頭の「冪等」）。 */
  requestedAtMs: number;
}

/** メッセージの形を確かめる。**Zod を使わない**（contracts は API の入出力の定義）。 */
export function isDailyReportMessage(value: unknown): value is DailyReportMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  const requestedById = message["requestedById"];
  return (
    message["kind"] === "DAILY_REPORT" &&
    typeof message["organizationId"] === "string" &&
    typeof message["orgShortId"] === "string" &&
    typeof message["propertyId"] === "string" &&
    typeof message["businessDate"] === "string" &&
    (message["mode"] === "AUTO" || message["mode"] === "MANUAL") &&
    (requestedById === null || typeof requestedById === "string") &&
    typeof message["requestedAtMs"] === "number"
  );
}

/** 1 件の処理結果。**呼び出し側（`queue()`）が ack / retry を決める。** */
export type DailyReportOutcome =
  | { kind: "OK"; reportId: string; documentNo: string; revision: number; bytes: number }
  /** 施設が無い・既に生成済み。**再送しても直らない**ので ack する。 */
  | { kind: "SKIPPED"; reason: string }
  /** R2 / D1 / 書体の不足。**直しうる**ので retry する。 */
  | { kind: "FAILED"; reason: string };

/**
 * 日報を 1 通作る。
 *
 * ここが「PDF の集計値と DB 明細が一致する」の実装。**payload を 1 度だけ
 * 組み、PDF もその payload から描き、DB の集計列も同じ payload から入れる。**
 * 数え直す経路をこの関数の中に作らないこと。
 */
export async function generateDailyReport(
  env: Env,
  message: DailyReportMessage,
): Promise<DailyReportOutcome> {
  const generatedAt = new Date(message.requestedAtMs);
  const ctx: TenantContext = {
    organizationId: message.organizationId,
    orgShortId: message.orgShortId,
    // バッチと同じ扱い（`lib/task/nightly.ts` の注記 / OPEN_QUESTIONS #033）。
    // **`assertPermission()` は呼ばない。** 認可は投入した API 側で済んでいる。
    role: "ORG_ADMIN",
    allowedPropertyIds: [],
    now: generatedAt,
  };

  try {
    const latest = await findLatestDailyReport(
      env,
      ctx,
      message.propertyId,
      message.businessDate,
    );

    // ① 自動生成は 1 日 1 回（§9.3）。**もうあるなら何もしない。**
    if (message.mode === "AUTO" && latest !== undefined) {
      return { kind: "SKIPPED", reason: "ALREADY_GENERATED" };
    }

    // 書体が無ければ**作らない**（`lib/report/font.ts` の注記）。
    // 和文が空白の日報を施設へ渡さないため。
    const font = await loadDailyReportFont(env);
    if (font === null) {
      console.error(`daily-report-font-missing key=${DAILY_REPORT_FONT_KEY}`);
      return { kind: "FAILED", reason: "FONT_ASSET_MISSING" };
    }

    const revision = nextRevision(latest?.revision);
    // **版が変わっても文書番号は変わらない**（§9.3）。採番は初版だけ。
    const documentNo = latest?.documentNo ?? (await issueReportNumber(env, ctx, message));

    const collected = await collectDailyReport(env, ctx, {
      propertyId: message.propertyId,
      businessDate: message.businessDate,
      documentNo,
      revision,
      generatedAt,
    });
    if (collected.kind !== "OK") return { kind: "SKIPPED", reason: collected.kind };

    const payload = collected.payload;
    const payloadSha256 = await sha256HexOfText(
      canonicalJson(dailyReportPayloadToCanonical(payload)),
    );
    const pdf = await renderDailyReportPdf(payload, payloadSha256, font);
    const pdfSha256 = await sha256Hex(pdf);

    const storageKey = dailyReportKey({
      organizationId: message.organizationId,
      propertyId: message.propertyId,
      businessDate: message.businessDate,
      documentNo,
      revision,
    });

    // **R2 が先、DB が後。** 逆にすると「行はあるが PDF が無い日報」が
    // 一覧に出る。PDF だけが残った場合は同じ版を作り直せば上書きされる。
    await env.DOCUMENTS.put(storageKey, pdf, {
      httpMetadata: {
        contentType: "application/pdf",
        contentDisposition: `attachment; filename="${dailyReportFileName(documentNo, revision)}"`,
      },
      // §9.5「PDF の SHA-256 を DB と R2 metadata に保存」。
      customMetadata: {
        documentNo,
        revision: String(revision),
        pdfSha256,
        payloadSha256,
      },
    });

    const counters = dailyReportCounters(payload);
    const created = await createDailyReport(env, ctx, {
      propertyId: message.propertyId,
      businessDate: message.businessDate,
      documentNo,
      revision,
      storageKey,
      payloadSha256,
      pdfSha256,
      ...counters,
      generatedById: message.requestedById,
      supersedesId: latest?.id ?? null,
    });

    // 手動の発行だけ監査へ（冒頭の注記 / security.md §6）。
    //
    // **ここで失敗しても retry しない。** 日報の行はもう入っているので、
    // 再送は「同じ日の版がもう 1 つ増える」形になる。監査ログが 1 件
    // 欠けるより、**存在しない再生成が帳票として残るほうが害が大きい。**
    // 欠けたことはログに残す。
    if (message.mode === "MANUAL" && message.requestedById !== null) {
      try {
        await recordAudit(env, ctx, {
          actorId: message.requestedById,
          action: "document.issued",
          targetType: "dailyReport",
          targetId: created.id,
          propertyId: message.propertyId,
          after: { documentNo, revision, businessDate: message.businessDate, pdfSha256 },
        });
      } catch (error) {
        const reason = error instanceof Error ? error.name : "UNKNOWN";
        console.error(`daily-report-audit-failed report=${created.id} reason=${reason}`);
      }
    }

    return { kind: "OK", reportId: created.id, documentNo, revision, bytes: pdf.byteLength };
  } catch (error) {
    // **payload をログへ流さない。** 例外の名前と施設・業務日だけ。
    // 施設 ID は組織を含む自己記述 ID なので出さない（architecture.md §1）。
    const reason = error instanceof Error ? error.name : "UNKNOWN";
    console.error(`daily-report-failed date=${message.businessDate} reason=${reason}`);
    return { kind: "FAILED", reason };
  }
}

/**
 * 文書番号を採る（`RPT-2026-0042` / billing.md §5）。
 *
 * 年度は**業務日**から決める（生成日時ではない）。日締めをまたぐ生成で
 * 年度が変わると、同じ業務日の日報が別年度の連番を持つことになる。
 * 年度の開始月は税務プロファイル。**未設定なら 4 月**（日本の既定）。
 */
async function issueReportNumber(
  env: Env,
  ctx: TenantContext,
  message: DailyReportMessage,
): Promise<string> {
  const taxProfile = await findTaxProfile(env, ctx);
  const fiscalYear = fiscalYearOf(message.businessDate, taxProfile?.fiscalYearStartMonth ?? 4);
  const issued = await issueDocumentNumber(env, {
    organizationId: message.organizationId,
    documentType: "REPORT",
    fiscalYear,
  });
  return issued.documentNumber;
}

/**
 * `pdf-generation` キューのハンドラ。
 *
 * **1 件ずつ ack / retry を決める。** バッチ全体を retry にすると、
 * 成功した日報の版が無駄に増える（`MANUAL` の再送は新しい版になる）。
 *
 * ── 1 本のキューに 2 種類が載る ─────────────────────────
 * architecture.md §5 の `pdf-generation` は「日報・請求書・領収書・
 * 監査レポート」の 1 本。**`kind` で振り分ける。**
 * P4-14 が `AUDIT_REPORT` を足した。種別ごとにキューを増やさないこと
 * （wrangler.toml の宣言が増え、無料枠の本数を使い切る）。
 */
export async function handleDailyReportBatch(env: Env, batch: MessageBatch): Promise<void> {
  for (const message of batch.messages) {
    if (isAuditReportMessage(message.body)) {
      const outcome = await generateAuditReport(env, message.body);
      if (outcome.kind === "FAILED") message.retry();
      else message.ack();
      continue;
    }
    if (!isDailyReportMessage(message.body)) {
      // 形が違うものは**再送しても直らない。** ack して落とす。
      console.error("pdf-generation-invalid-message");
      message.ack();
      continue;
    }
    const outcome = await generateDailyReport(env, message.body);
    if (outcome.kind === "FAILED") message.retry();
    else message.ack();
  }
}
