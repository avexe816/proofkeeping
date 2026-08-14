/**
 * 送付ログの API（PK-SPEC-P5 §2.7・§9 / P5-10）。
 *
 * ```
 * GET /api/v1/deliveries?docType=&documentId=
 * GET /api/v1/deliveries/failed
 * ```
 *
 * task: docs/tasks/P5-10.md
 *
 * ── 不達に気づける状態を作るための口 ────────────────────
 * §11 のリスク表「メール不達に気づかない → 入金遅延」への対策。
 * `failed` は **`BOUNCED` / `FAILED` だけ**を新しい順に返す。
 * 画面はこれを見て警告を出す（P5-10 の完了条件）。
 *
 * ── 追記のみ。消す口が無い ──────────────────────────────
 * 誰にいつ送ったかは電子取引の記録そのもの（billing.md §2）。
 * `DELETE` も `PATCH` も作らない。状態を進めるのは webhook の
 * コンシューマだけ。
 *
 * ── 本文を返さない ──────────────────────────────────────
 * `bodyPreview` は冒頭 120 文字で、差異の詳細を含めない約束
 * （ui-writing.md §6）。一覧では返さず、件名と状態だけを見せる。
 */

import {
  DELIVERY_DOC_TYPES,
  listDocumentDeliveries,
  listFailedDeliveries,
  type DeliveryDocType,
  type DeliveryStatus,
} from "@pk/db";
import { Hono } from "hono";

import { ORGANIZATION_TARGET, assertPermission } from "../../../lib/auth/permission.js";
import { getTenant, type AppEnv } from "../../../middleware/index.js";

const deliveries = new Hono<AppEnv>();

function invalidRequest() {
  return { error: "INVALID_REQUEST" as const };
}

/** 応答の 1 件。**`organizationId` と本文を含めない。** */
interface DeliverySummary {
  deliveryId: string;
  docType: DeliveryDocType;
  documentId: string;
  toEmail: string;
  subject: string;
  status: DeliveryStatus;
  errorMessage: string | null;
  queuedAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  openedAt: string | null;
}

function toSummary(row: {
  id: string;
  docType: DeliveryDocType;
  documentId: string;
  toEmail: string;
  subject: string;
  status: DeliveryStatus;
  errorMessage: string | null;
  queuedAt: Date;
  sentAt: Date | null;
  deliveredAt: Date | null;
  openedAt: Date | null;
}): DeliverySummary {
  return {
    deliveryId: row.id,
    docType: row.docType,
    documentId: row.documentId,
    toEmail: row.toEmail,
    subject: row.subject,
    status: row.status,
    errorMessage: row.errorMessage,
    queuedAt: row.queuedAt.toISOString(),
    sentAt: row.sentAt === null ? null : row.sentAt.toISOString(),
    deliveredAt: row.deliveredAt === null ? null : row.deliveredAt.toISOString(),
    openedAt: row.openedAt === null ? null : row.openedAt.toISOString(),
  };
}

/**
 * 不達の一覧（画面の警告の材料）。
 *
 * **`/:docType` より前に置く。** Hono は先に一致した経路を使うので、
 * 後ろに置くと `failed` が `documentId` として読まれる。
 */
deliveries.get("/failed", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "billing.read", ORGANIZATION_TARGET);

  const rows = await listFailedDeliveries(c.env, ctx, {});
  return c.json({ data: rows.map(toSummary) });
});

/** 文書 1 通ぶんの送付履歴（§9）。**古い順**（送った順に読む）。 */
deliveries.get("/", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "billing.read", ORGANIZATION_TARGET);

  const docType = c.req.query("docType");
  const documentId = c.req.query("documentId");
  if (docType === undefined || documentId === undefined) return c.json(invalidRequest(), 400);
  if (!(DELIVERY_DOC_TYPES as readonly string[]).includes(docType)) {
    return c.json(invalidRequest(), 400);
  }

  const rows = await listDocumentDeliveries(c.env, ctx, {
    docType: docType as DeliveryDocType,
    documentId,
  });
  return c.json({ data: rows.map(toSummary) });
});

export default deliveries;
