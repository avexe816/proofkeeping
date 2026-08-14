/**
 * 領収書の API（PK-SPEC-P5 §4.2・§9）。
 *
 * ```
 * GET  /api/v1/receipts?counterpartyId=&from=&to=&minAmount=&maxAmount=
 * POST /api/v1/receipts/issue-and-send        ★1クリック
 * ```
 *
 * task: docs/tasks/P5-08.md
 *
 * ── 入金の記録と領収書の発行が 1 本 ─────────────────────
 * §4.2 の画面は「入金を記録」に「領収書を発行して送信する」の
 * チェック（既定オン）が付く。**分けない。** 分けると「入金は記録した
 * が領収書を出していない」状態を人が作れてしまう。
 * チェックを外した場合（入金の記録だけ）は §9 の `POST /payments` に
 * 当たるが、**入金だけを置く表が §2 に無い**（OPEN_QUESTIONS #076）。
 * 全額入金は `invoice.status = PAID` で表せるので、その口は
 * P5-09（訂正）と一緒に判断する。ここには置かない。
 *
 * ── 物理削除の口が無い（CLAUDE.md §4 / billing.md §2）───
 * `DELETE` も、金額を書き換える `PATCH` も無い。
 *
 * ── 印紙貼付欄を作らない（billing.md §3）────────────────
 * 印紙に関する値をリクエストでもレスポンスでも扱わない。
 */

import {
  receiptIssueRequestSchema,
  type ReceiptListResponse,
  type ReceiptSummary,
} from "@pk/contracts";
import {
  findTaxProfile,
  listReceipts,
  recordAudit,
  type PaymentMethod,
  type ReceiptStatus,
} from "@pk/db";
import { Hono } from "hono";

import { ORGANIZATION_TARGET, assertPermission } from "../../../lib/auth/permission.js";
import {
  enqueueReceiptDelivery,
  enqueueReceiptPdf,
} from "../../../lib/billing/deliverReceipt.js";
import { issueReceipt } from "../../../lib/billing/receipt.js";
import { getSession, getTenant, type AppEnv } from "../../../middleware/index.js";

const receipts = new Hono<AppEnv>();

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
 * 一覧。**検索 3 項目は請求書と同じ**（§1.2 MUST / 電子帳簿保存法）。
 */
receipts.get("/", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "billing.read", ORGANIZATION_TARGET);

  const from = c.req.query("from");
  const to = c.req.query("to");
  const minAmount = c.req.query("minAmount");
  const maxAmount = c.req.query("maxAmount");
  const counterpartyId = c.req.query("counterpartyId");

  if (
    (minAmount !== undefined && !/^-?\d+$/.test(minAmount)) ||
    (maxAmount !== undefined && !/^-?\d+$/.test(maxAmount))
  ) {
    return c.json(invalidRequest(), 400);
  }

  const rows = await listReceipts(c.env, ctx, {
    ...(counterpartyId === undefined ? {} : { counterpartyId }),
    ...(from === undefined ? {} : { issueDateFrom: from }),
    ...(to === undefined ? {} : { issueDateTo: to }),
    ...(minAmount === undefined ? {} : { amountFrom: Number(minAmount) }),
    ...(maxAmount === undefined ? {} : { amountTo: Number(maxAmount) }),
  });

  const body: ReceiptListResponse = { data: rows.map(toSummary) };
  return c.json(body);
});

/**
 * ★1 クリック発行（§4.2）。
 *
 * 入金を記録し（`invoice.status = PAID`）、採番し、領収書を作り、
 * PDF と送付を Queue へ投げる。**同期で行うのは ①〜③ まで**（§8.3 MUST）。
 *
 * **一部入金は 409 で断る。** 金額を置く列が無く、`PARTIALLY_PAID` へ
 * 進めても「いくら入ったか」が残らない（OPEN_QUESTIONS #076）。
 * 黙って全額として記録するほうが危ない。
 */
receipts.post("/issue-and-send", async (c) => {
  const parsed = receiptIssueRequestSchema.safeParse(await readJson(c.req.raw));
  if (!parsed.success) return c.json(invalidRequest(), 400);

  const ctx = getTenant(c);
  assertPermission(ctx, "billing.write", ORGANIZATION_TARGET);

  const outcome = await issueReceipt(c.env, ctx, {
    invoiceId: parsed.data.invoiceId,
    receivedAmount: parsed.data.receivedAmount,
    receivedDate: parsed.data.receivedDate,
    paymentMethod: parsed.data.paymentMethod,
    issueDate: todayInJst(ctx.now),
    ...(parsed.data.purposeText === undefined ? {} : { purposeText: parsed.data.purposeText }),
  });

  if (outcome.kind === "REJECTED") {
    if (outcome.reason === "INVOICE_NOT_FOUND") return c.json(notFound(), 404);
    return c.json({ error: outcome.reason }, 409);
  }

  const taxProfile = await findTaxProfile(c.env, ctx);
  // ④ PDF → ⑤ 送付。**どちらも Queue。** 失敗しても領収書は残る。
  await enqueueReceiptPdf(c.env, ctx, {
    receiptId: outcome.receiptId,
    sealImageKey: taxProfile?.sealImageKey ?? null,
  });
  await enqueueReceiptDelivery(c.env, ctx, {
    receiptId: outcome.receiptId,
    sentById: getSession(c).membershipId,
  });

  // ⑥ 監査ログ（security.md §6「帳票の発行」）。
  await recordAudit(c.env, ctx, {
    actorId: getSession(c).membershipId,
    action: "document.issued",
    targetType: "receipt",
    targetId: outcome.receiptId,
    after: {
      documentNo: outcome.documentNo,
      receivedAmount: parsed.data.receivedAmount,
      paymentMethod: parsed.data.paymentMethod,
      invoiceId: parsed.data.invoiceId,
    },
    ...ipOf(c.req.header("CF-Connecting-IP")),
  });

  return c.json(
    { receiptId: outcome.receiptId, documentNo: outcome.documentNo, invoicePaid: true },
    201,
  );
});

/** 一覧の 1 件。**`organizationId` と R2 のキーを落とす。** */
function toSummary(row: {
  id: string;
  invoiceId: string | null;
  counterpartyId: string;
  documentNo: string;
  issueDate: string;
  counterpartyName: string;
  receivedAmount: number;
  receivedDate: string;
  paymentMethod: PaymentMethod;
  totalAmount: number;
  isQualifiedInvoice: boolean;
  status: ReceiptStatus;
  pdfStorageKey: string | null;
  sentAt: Date | null;
}): ReceiptSummary {
  return {
    receiptId: row.id,
    invoiceId: row.invoiceId,
    counterpartyId: row.counterpartyId,
    documentNo: row.documentNo,
    issueDate: row.issueDate,
    counterpartyName: row.counterpartyName,
    receivedAmount: row.receivedAmount,
    receivedDate: row.receivedDate,
    paymentMethod: row.paymentMethod,
    totalAmount: row.totalAmount,
    isQualifiedInvoice: row.isQualifiedInvoice,
    status: row.status,
    hasPdf: row.pdfStorageKey !== null,
    sentAt: row.sentAt === null ? null : row.sentAt.toISOString(),
  };
}

function ipOf(ip: string | undefined): { ip?: string } {
  return ip === undefined ? {} : { ip };
}

export default receipts;
