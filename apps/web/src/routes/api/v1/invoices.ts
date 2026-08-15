/**
 * 請求書の API（PK-SPEC-P5 §4.1・§9）。
 *
 * ```
 * GET  /api/v1/invoices?counterpartyId=&from=&to=&minAmount=&maxAmount=
 * GET  /api/v1/invoices/:invoiceId
 * POST /api/v1/invoices/issue-and-send        ★1クリック
 * POST /api/v1/invoices/:invoiceId/regenerate-pdf
 * POST /api/v1/invoices/:invoiceId/resend
 * ```
 *
 * task: docs/tasks/P5-07.md
 *
 * ── 物理削除の口が無い（CLAUDE.md §4 / billing.md §2）───
 * `DELETE` も、金額を書き換える `PATCH` も無い。**訂正は赤伝＋再発行**
 * （§5 / P5-09）。取消（`void`）と赤伝（`credit-note`）は P5-09 の担当で、
 * ここには置いていない。
 *
 * ── 1 クリック（§10.5）─────────────────────────────────
 * 締め画面の [ 請求書を発行して送信 ] が確認ダイアログ 1 回のあとに
 * この 1 本を叩く。**発行と送付を別の口に分けない。** 分けると
 * 「発行したが送っていない」状態を人が作れてしまう。
 *
 * ── 二重発行（§4.3 MUST）────────────────────────────────
 * `Idempotency-Key` ヘッダを受けるが、**鍵の記録という別の状態を
 * 作らない。** 締めの行が「1 期間 1 請求書」を保証している
 * （`lib/billing/issue.ts` 冒頭 / docs/DECISIONS.md #055 と同じ判断）。
 * 2 回目は既存の請求書を **200** で返す（201 ではない）。
 */

import {
  invoiceCorrectRequestSchema,
  invoiceIssueRequestSchema,
  type InvoiceDetailResponse,
  type InvoiceListResponse,
  type InvoiceSummary,
  type BillingLineTasksResponse,
} from "@pk/contracts";
import {
  findInvoiceById,
  listInvoiceLines,
  listInvoiceTaxSummaries,
  listInvoices,
  recordAudit,
  findTaxProfile,
  type InvoiceStatus,
  listTasksByIds,
} from "@pk/db";
import { Hono } from "hono";

import { emitOutboundEvent } from "../../../consumers/outboundWebhook.js";

import { ORGANIZATION_TARGET, assertPermission } from "../../../lib/auth/permission.js";
import {
  enqueueInvoicePdf,
  findSendableInvoice,
  issueInvoice,
} from "../../../lib/billing/issue.js";
import { correctInvoice } from "../../../lib/billing/creditNote.js";
import { enqueueInvoiceDelivery } from "../../../lib/billing/deliver.js";
import { signObjectUrl } from "../../../lib/storage/signedUrl.js";
import { toTaskSummaries } from "../../../lib/task/summary.js";
import { getSession, getTenant, type AppEnv } from "../../../middleware/index.js";

const invoices = new Hono<AppEnv>();

function invalidRequest() {
  return { error: "INVALID_REQUEST" as const };
}

function notFound() {
  return { error: "RESOURCE_NOT_FOUND" as const };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** 現地時刻の暦日（`Asia/Tokyo`）。発行日に使う。 */
function todayInJst(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * 一覧（§9 MUST）。
 *
 * **取引年月日・取引金額・取引先の 3 条件を組み合わせられる。**
 * 電子帳簿保存法の検索要件そのもの（§1.2 MUST）。**この 3 つを
 * 外さないこと。** 画面（P5-11）はこの口を使う。
 */
invoices.get("/", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "billing.read", ORGANIZATION_TARGET);

  const from = c.req.query("from");
  const to = c.req.query("to");
  const minAmount = c.req.query("minAmount");
  const maxAmount = c.req.query("maxAmount");
  const counterpartyId = c.req.query("counterpartyId");
  // §9 の `&counterparty=`。**人が検索するのは名前**（電帳法の 3 項目）。
  const counterparty = c.req.query("counterparty");

  if (
    (minAmount !== undefined && !/^-?\d+$/.test(minAmount)) ||
    (maxAmount !== undefined && !/^-?\d+$/.test(maxAmount))
  ) {
    return c.json(invalidRequest(), 400);
  }

  const rows = await listInvoices(c.env, ctx, {
    ...(counterpartyId === undefined ? {} : { counterpartyId }),
    ...(counterparty === undefined ? {} : { counterpartyName: counterparty }),
    ...(from === undefined ? {} : { issueDateFrom: from }),
    ...(to === undefined ? {} : { issueDateTo: to }),
    ...(minAmount === undefined ? {} : { amountFrom: Number(minAmount) }),
    ...(maxAmount === undefined ? {} : { amountTo: Number(maxAmount) }),
  });

  const body: InvoiceListResponse = { data: rows.map(toSummary) };
  return c.json(body);
});

/** 1 通。明細と税区分を添える（§6.3 のドリルダウンの入口）。 */
invoices.get("/:invoiceId", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "billing.read", ORGANIZATION_TARGET);

  const invoiceId = c.req.param("invoiceId");
  const invoice = await findInvoiceById(c.env, ctx, invoiceId);
  if (invoice === undefined) return c.json(notFound(), 404);

  const [lines, taxSummaries] = await Promise.all([
    listInvoiceLines(c.env, ctx, invoiceId),
    listInvoiceTaxSummaries(c.env, ctx, invoiceId),
  ]);

  const body: InvoiceDetailResponse = {
    ...toSummary(invoice),
    lines: lines.map((line) => ({
      lineNo: line.lineNo,
      propertyId: line.propertyId,
      itemCode: line.itemCode,
      description: line.description,
      serviceDateFrom: line.serviceDateFrom,
      serviceDateTo: line.serviceDateTo,
      quantity: line.quantity,
      unit: line.unit,
      unitPrice: line.unitPrice,
      amount: line.amount,
      taxRate: line.taxRate,
      isReducedRate: line.isReducedRate,
      // §6.3 のドリルダウン。**集計元のタスク ID**（P5-13 が辿る）。
      taskIds: taskIdsOf(line.sourceRef),
    })),
    taxSummaries: taxSummaries.map((summary) => ({
      taxRate: summary.taxRate,
      isReducedRate: summary.isReducedRate,
      subtotalAmount: summary.subtotalAmount,
      taxAmount: summary.taxAmount,
      totalAmount: summary.totalAmount,
    })),
  };
  return c.json(body);
});

/**
 * `GET /:invoiceId/lines/:lineNo/tasks` — 明細行の集計元タスク（§6.3）。
 *
 * ```
 * 行2 アウト清掃 / ツイン 95室
 *   → 対象タスク一覧（95件）      ← ここ
 *     → 各タスクの証跡（W-07）    ← GET /evidence/tasks/:taskId
 *       → 清掃時刻・検査結果・写真
 * ```
 *
 * ── **組み直さない。** ──────────────────────────────────
 * 読むのは発行時に固定した `invoiceLine.sourceRef.taskIds` だけ。
 * 締めの明細（`GET /billing-periods/:id/lines/tasks`）は組み直すが、
 * **発行済みの請求書は根拠が動いてはならない**（billing.md §6）。
 * 料金設定やタスクが後から変わっても、この一覧は発行時のままになる。
 *
 * ── 行は `lineNo` で指す ────────────────────────────────
 * 発行済みの明細は不変（`uq_inv_line` が `invoiceId` × `lineNo`）なので、
 * 位置が動かない。締め側が `lineKey` を使うのは、あちらが組み直すたびに
 * 行の増減で位置がずれるからで、ここには当てはまらない。
 */
invoices.get("/:invoiceId/lines/:lineNo/tasks", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "billing.read", ORGANIZATION_TARGET);

  const lineNo = Number(c.req.param("lineNo"));
  if (!Number.isInteger(lineNo) || lineNo < 1) return c.json(invalidRequest(), 400);

  const invoiceId = c.req.param("invoiceId");
  const invoice = await findInvoiceById(c.env, ctx, invoiceId);
  if (invoice === undefined) return c.json(notFound(), 404);

  const lines = await listInvoiceLines(c.env, ctx, invoiceId);
  const line = lines.find((candidate) => candidate.lineNo === lineNo);
  if (line === undefined) return c.json(notFound(), 404);

  const taskIds = taskIdsOf(line.sourceRef);
  // 施設スコープはリポジトリ層が掛ける。担当外施設のタスクは**返らない**。
  const rows = await listTasksByIds(c.env, ctx, taskIds);

  const body: BillingLineTasksResponse = {
    lineNo: line.lineNo,
    // 発行済みの明細は `lineKey` を持たない（列が無い）。位置が正。
    lineKey: null,
    description: line.description,
    taskCount: taskIds.length,
    data: await toTaskSummaries(c.env, ctx, rows),
  };
  return c.json(body);
});

/**
 * ★1 クリック発行（§4.1）。
 *
 * 締めを `INVOICED` にロックし、採番し、請求書を作り、PDF と送付を
 * Queue へ投げる。**同期で行うのは ①〜⑦ まで**（§8.3 MUST）。
 */
invoices.post("/issue-and-send", async (c) => {
  const parsed = invoiceIssueRequestSchema.safeParse(await readJson(c.req.raw));
  if (!parsed.success) return c.json(invalidRequest(), 400);

  const ctx = getTenant(c);
  assertPermission(ctx, "billing.write", ORGANIZATION_TARGET);

  const outcome = await issueInvoice(c.env, ctx, {
    billingPeriodId: parsed.data.billingPeriodId,
    actorId: getSession(c).membershipId,
    issueDate: todayInJst(ctx.now),
  });

  if (outcome.kind === "ALREADY_ISSUED") {
    // §4.3 MUST「既に発行済みの場合は既存の請求書を返す」。**201 にしない。**
    return c.json({ invoiceId: outcome.invoiceId, alreadyIssued: true }, 200);
  }

  if (outcome.kind === "REJECTED") {
    if (outcome.reason === "PERIOD_NOT_FOUND") return c.json(notFound(), 404);
    return c.json({ error: outcome.reason }, 409);
  }

  // ⑩ 送付を Queue へ。**PDF の完了を待たない**（コンシューマが繋ぐ）。
  await enqueueInvoiceDelivery(c.env, ctx, {
    invoiceId: outcome.invoiceId,
    sentById: getSession(c).membershipId,
  });

  // ⑬ 監査ログ（security.md §6「帳票の発行」）。
  await recordAudit(c.env, ctx, {
    actorId: getSession(c).membershipId,
    action: "document.issued",
    targetType: "invoice",
    targetId: outcome.invoiceId,
    after: {
      documentNo: outcome.documentNo,
      totalAmount: outcome.draft.totalAmount,
      // **単価が引けなかった明細の件数を残す**（§11 の「請求漏れ」）。
      warnings: outcome.draft.warnings.length,
    },
    ...ipOf(c.req.header("CF-Connecting-IP")),
  });

  // ⑭ 送信 Webhook（P6-13 / PK-SPEC-P6 §6.4 の `invoice.issued`）。
  // **失敗を握りつぶす。** 顧客の都合で足す通知経路で、届かなくても
  // 請求書の発行は成立している（`emitOutboundEvent()` の注記）。
  // **本文に金額を載せない。** 受け取った側は `invoiceId` で
  // 公開 API（`GET /api/v1/public/invoices`）を引く。
  await emitOutboundEvent(c.env, {
    orgShortId: ctx.orgShortId,
    event: "invoice.issued",
    targetId: outcome.invoiceId,
    propertyId: null,
    eventId: `invoice.issued:${outcome.invoiceId}`,
    occurredAtMs: ctx.now.getTime(),
  });

  return c.json(
    {
      invoiceId: outcome.invoiceId,
      documentNo: outcome.documentNo,
      totalAmount: outcome.draft.totalAmount,
      warnings: outcome.draft.warnings,
    },
    201,
  );
});

/**
 * PDF の再生成（§9 / §4.1 MUST「再生成できるようにする」）。
 *
 * **金額を作り直さない。** 発行時に固定した明細から同じ PDF を組み直す
 * だけ。取り消した請求書には作らない。
 */
invoices.post("/:invoiceId/regenerate-pdf", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "billing.write", ORGANIZATION_TARGET);

  const invoiceId = c.req.param("invoiceId");
  const invoice = await findSendableInvoice(c.env, ctx, invoiceId);
  if (invoice === undefined) return c.json(notFound(), 404);

  const taxProfile = await findTaxProfile(c.env, ctx);
  const queued = await enqueueInvoicePdf(c.env, ctx, {
    invoiceId,
    sealImageKey: taxProfile?.sealImageKey ?? null,
  });
  if (!queued) return c.json({ error: "QUEUE_UNAVAILABLE" as const }, 503);

  return c.json({ invoiceId, queued: true });
});

/**
 * 再送（§9 / §4.1 MUST「再送ができる」）。
 *
 * **送付ログが 1 行増える**（§2.7 は追記のみ）。`SENT` になっている
 * 請求書をもう一度送っても状態は変わらない（`markInvoiceSent()` は
 * `CONFIRMED` のときだけ進む）。
 */
invoices.post("/:invoiceId/resend", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "billing.write", ORGANIZATION_TARGET);

  const invoiceId = c.req.param("invoiceId");
  const invoice = await findSendableInvoice(c.env, ctx, invoiceId);
  if (invoice === undefined) return c.json(notFound(), 404);

  const queued = await enqueueInvoiceDelivery(c.env, ctx, {
    invoiceId,
    sentById: getSession(c).membershipId,
  });
  if (!queued) return c.json({ error: "QUEUE_UNAVAILABLE" as const }, 503);

  await recordAudit(c.env, ctx, {
    actorId: getSession(c).membershipId,
    action: "document.sent",
    targetType: "invoice",
    targetId: invoiceId,
    after: { documentNo: invoice.documentNo, resend: true },
    ...ipOf(c.req.header("CF-Connecting-IP")),
  });

  return c.json({ invoiceId, queued: true });
});

/**
 * 訂正（§5.2）。**赤伝を切り、元請求書を取り消す。**
 *
 * ── 元の請求書を消さない・書き換えない（§5.1 / billing.md §2）──
 * 変わるのは `status` / `voidedAt` / `voidReason` だけ。**金額も明細も
 * PDF も動かない。** 元の PDF は R2 に残り、`download` から引き続き
 * 取れる（§5.2 MUST）。
 *
 * ── 番号は欠番のまま（§5.3）─────────────────────────────
 * 赤伝は新しい番号を採る。元の番号は再利用しない。
 */
invoices.post("/:invoiceId/credit-note", async (c) => {
  const parsed = invoiceCorrectRequestSchema.safeParse(await readJson(c.req.raw));
  if (!parsed.success) return c.json(invalidRequest(), 400);

  const ctx = getTenant(c);
  assertPermission(ctx, "billing.write", ORGANIZATION_TARGET);

  const invoiceId = c.req.param("invoiceId");
  const outcome = await correctInvoice(c.env, ctx, {
    invoiceId,
    reason: parsed.data.reason,
    actorId: getSession(c).membershipId,
    issueDate: todayInJst(ctx.now),
  });

  if (outcome.kind === "REJECTED") {
    if (outcome.reason === "INVOICE_NOT_FOUND") return c.json(notFound(), 404);
    return c.json({ error: outcome.reason }, 409);
  }

  // 監査ログ（security.md §6「帳票の訂正」）。**理由を残す。**
  await recordAudit(c.env, ctx, {
    actorId: getSession(c).membershipId,
    action: "document.corrected",
    targetType: "invoice",
    targetId: invoiceId,
    reason: parsed.data.reason,
    after: {
      creditNoteId: outcome.creditNoteId,
      creditNoteDocumentNo: outcome.creditNoteDocumentNo,
      periodReopened: outcome.periodReopened,
    },
    ...ipOf(c.req.header("CF-Connecting-IP")),
  });

  return c.json(
    {
      creditNoteId: outcome.creditNoteId,
      creditNoteDocumentNo: outcome.creditNoteDocumentNo,
      periodReopened: outcome.periodReopened,
    },
    201,
  );
});

/**
 * PDF のダウンロード（§9）。**15 分有効の署名付き URL**（security.md §4）。
 *
 * ── 取り消した請求書も取れる（§5.2 MUST）────────────────
 * 「元の PDF は R2 に残し、閲覧できる状態を維持する。ダウンロード
 * リンクを無効化しない」。**`VOIDED` を弾かないこと。**
 * `findSendableInvoice()` を使わないのはそのため（あれは送付の判定）。
 */
invoices.get("/:invoiceId/download", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "billing.read", ORGANIZATION_TARGET);

  const invoiceId = c.req.param("invoiceId");
  const invoice = await findInvoiceById(c.env, ctx, invoiceId);
  if (invoice === undefined) return c.json(notFound(), 404);
  // PDF がまだ無い（`CONFIRMED` のまま）。**再生成できる**ので 409。
  if (invoice.pdfStorageKey === null) return c.json({ error: "PDF_NOT_READY" as const }, 409);

  return c.json({
    url: await signObjectUrl(c.env.SESSION_SECRET, invoice.pdfStorageKey, ctx.now),
    documentNo: invoice.documentNo,
  });
});

/** 集計元のタスク ID（§6.3）。形が違えば空。 */
function taskIdsOf(sourceRef: Record<string, unknown> | null): string[] {
  if (sourceRef === null) return [];
  const taskIds = sourceRef["taskIds"];
  if (!Array.isArray(taskIds)) return [];
  return taskIds.filter((value): value is string => typeof value === "string");
}

/** 一覧の 1 件。**`organizationId` を落とす**（組織 ID を応答に出さない）。 */
function toSummary(row: {
  id: string;
  counterpartyId: string;
  documentNo: string;
  issueDate: string;
  dueDate: string;
  periodFrom: string;
  periodTo: string;
  counterpartyName: string;
  subtotalAmount: number;
  taxAmount: number;
  totalAmount: number;
  isQualifiedInvoice: boolean;
  isCreditNote: boolean;
  status: InvoiceStatus;
  pdfStorageKey: string | null;
  sentAt: Date | null;
}): InvoiceSummary {
  return {
    invoiceId: row.id,
    counterpartyId: row.counterpartyId,
    documentNo: row.documentNo,
    issueDate: row.issueDate,
    dueDate: row.dueDate,
    periodFrom: row.periodFrom,
    periodTo: row.periodTo,
    counterpartyName: row.counterpartyName,
    subtotalAmount: row.subtotalAmount,
    taxAmount: row.taxAmount,
    totalAmount: row.totalAmount,
    isQualifiedInvoice: row.isQualifiedInvoice,
    isCreditNote: row.isCreditNote,
    status: row.status,
    /** PDF ができているか。**R2 のキーそのものを返さない。** */
    hasPdf: row.pdfStorageKey !== null,
    sentAt: row.sentAt === null ? null : row.sentAt.toISOString(),
  };
}

function ipOf(ip: string | undefined): { ip?: string } {
  return ip === undefined ? {} : { ip };
}

export default invoices;
