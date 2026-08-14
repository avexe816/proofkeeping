/**
 * 日報の API（PK-SPEC-P2 §14.4）。
 *
 * ```
 * GET  /api/v1/reports/daily?propertyId=&from=&to=   一覧（旧版も出る）
 * GET  /api/v1/reports/daily/:id                     1 件
 * POST /api/v1/reports/daily/generate                生成を要求（Queue へ）
 * POST /api/v1/reports/daily/:id/regenerate          版を上げて作り直す
 * GET  /api/v1/reports/daily/:id/download            署名付き URL（§9.6）
 * ```
 *
 * task: docs/tasks/P2-14.md
 *
 * ── 生成は必ず Queue を通る ─────────────────────────────
 * `POST` は 202 を返すだけ。PDF はコンシューマが作る
 * （architecture.md §5 / P2-14 の完了条件）。**ここで
 * `renderDailyReportPdf()` を呼ばないこと。**
 *
 * ── 削除・訂正の口が無い ────────────────────────────────
 * 発行済み帳票は消さない・書き換えない（billing.md §2）。
 * 作り直しは `regenerate` で、**旧版は残る**（§9.3）。
 *
 * ── 送付の口も無い ──────────────────────────────────────
 * §9.6「P2 では 1 クリック送付を実装しない（P5）」。
 * ダウンロードと閲覧、署名付き URL の一時発行までがこの task。
 */

import {
  auditReportGenerateRequestSchema,
  dailyReportGenerateRequestSchema,
  type AuditReportDownloadResponse,
  type AuditReportGenerateResponse,
  type DailyReportDownloadResponse,
  type DailyReportGenerateResponse,
  type DailyReportSummary,
} from "@pk/contracts";
import {
  findDailyReportById,
  findPropertyById,
  listDailyReports,
  type DailyReportRow,
} from "@pk/db";
import { Hono } from "hono";

import type { AuditReportMessage } from "../../../consumers/auditReport.js";
import type { DailyReportMessage } from "../../../consumers/dailyReport.js";
import { auditReportKey } from "../../../lib/report/auditReport.js";
import { assertPermission, propertyTarget } from "../../../lib/auth/permission.js";
import { signObjectUrl } from "../../../lib/storage/signedUrl.js";
import { getNow, getSession, getTenant, type AppEnv } from "../../../middleware/index.js";

const reports = new Hono<AppEnv>();

/** DB の行 → 応答。**`storageKey` を返さない**（R2 のキー体系を外へ出さない）。 */
function toSummary(row: DailyReportRow): DailyReportSummary {
  return {
    reportId: row.id,
    propertyId: row.propertyId,
    businessDate: row.businessDate,
    documentNo: row.documentNo,
    revision: row.revision,
    payloadSha256: row.payloadSha256,
    pdfSha256: row.pdfSha256,
    totalTasks: row.totalTasks,
    completedTasks: row.completedTasks,
    failedFirstInspection: row.failedFirstInspection,
    openIssues: row.openIssues,
    openLostItems: row.openLostItems,
    generatedAt: row.generatedAt.getTime(),
    generatedById: row.generatedById,
    supersedesId: row.supersedesId,
  };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * 一覧（§14.4）。
 *
 * `propertyId` はクライアントが送るが、**それを権限の対象にしていない。**
 * `assertPermission()` へ渡す値がリクエスト由来だと `ASSIGNED` の判定が
 * 何も守らない（INV-32）。ここでは権限を施設 ID で見たうえで、返す行は
 * リポジトリ層のテナント・施設スコープが絞る。**担当外の施設 ID を
 * 送っても 0 件になる。**
 */
reports.get("/daily", async (c) => {
  const propertyId = c.req.query("propertyId");
  if (propertyId === undefined) return c.json({ error: "INVALID_REQUEST" }, 400);

  const ctx = getTenant(c);
  assertPermission(ctx, "dailyReport.read", propertyTarget([propertyId]));

  const rows = await listDailyReports(c.env, ctx, {
    propertyId,
    businessDateFrom: c.req.query("from"),
    businessDateTo: c.req.query("to"),
  });
  return c.json({ data: rows.map(toSummary) });
});

/** 1 件（§14.4）。**権限は日報が指す施設で見る。** */
reports.get("/daily/:reportId", async (c) => {
  const ctx = getTenant(c);
  const row = await findDailyReportById(c.env, ctx, c.req.param("reportId"));
  if (row === undefined) return c.notFound();
  assertPermission(ctx, "dailyReport.read", propertyTarget([row.propertyId]));

  return c.json({ data: toSummary(row) });
});

/**
 * 生成を要求する（§14.4）。**Queue へ渡して 202 を返す。**
 *
 * `mode: "MANUAL"` で投げるので、**その業務日の日報が既にあれば
 * 版が 1 つ増える**（§9.3）。自動生成（`AUTO`）は既にあれば何もしない。
 * この違いはコンシューマ側にある（`consumers/dailyReport.ts`）。
 */
reports.post("/daily/generate", async (c) => {
  const parsed = dailyReportGenerateRequestSchema.safeParse(await readJson(c.req.raw));
  if (!parsed.success) return c.json({ error: "INVALID_REQUEST" }, 400);

  const ctx = getTenant(c);
  // 施設の存在を先に見る。**無い施設への要求をキューへ載せない。**
  const property = await findPropertyById(c.env, ctx, parsed.data.propertyId);
  if (property === undefined) return c.notFound();
  assertPermission(ctx, "dailyReport.generate", propertyTarget([property.id]));

  await enqueue(c.env, {
    kind: "DAILY_REPORT",
    organizationId: ctx.organizationId,
    orgShortId: ctx.orgShortId,
    propertyId: property.id,
    businessDate: parsed.data.businessDate,
    mode: "MANUAL",
    requestedById: getSession(c).membershipId,
    requestedAtMs: getNow(c).getTime(),
  });

  const body: DailyReportGenerateResponse = {
    status: "QUEUED",
    propertyId: property.id,
    businessDate: parsed.data.businessDate,
  };
  return c.json(body, 202);
});

/**
 * 版を上げて作り直す（§9.3）。
 *
 * **本文を取らない。** 対象は URL の日報で、施設と業務日はその行から
 * 引く。リクエストで業務日を受け取る形にすると、「別の日の日報を
 * この ID で作り直す」が書けてしまう。
 */
reports.post("/daily/:reportId/regenerate", async (c) => {
  const ctx = getTenant(c);
  const row = await findDailyReportById(c.env, ctx, c.req.param("reportId"));
  if (row === undefined) return c.notFound();
  assertPermission(ctx, "dailyReport.generate", propertyTarget([row.propertyId]));

  await enqueue(c.env, {
    kind: "DAILY_REPORT",
    organizationId: ctx.organizationId,
    orgShortId: ctx.orgShortId,
    propertyId: row.propertyId,
    businessDate: row.businessDate,
    mode: "MANUAL",
    requestedById: getSession(c).membershipId,
    requestedAtMs: getNow(c).getTime(),
  });

  const body: DailyReportGenerateResponse = {
    status: "QUEUED",
    propertyId: row.propertyId,
    businessDate: row.businessDate,
  };
  return c.json(body, 202);
});

/**
 * ダウンロード（§9.6）。**15 分有効の署名付き URL**（security.md §4）。
 *
 * PDF の実体をこの応答で返さない。Worker が R2 の中身を流すのは
 * `/api/v1/files/{key}` の 1 か所だけ（P0-16）。
 */
reports.get("/daily/:reportId/download", async (c) => {
  const ctx = getTenant(c);
  const row = await findDailyReportById(c.env, ctx, c.req.param("reportId"));
  if (row === undefined) return c.notFound();
  assertPermission(ctx, "dailyReport.read", propertyTarget([row.propertyId]));

  // R2 に実体が無ければ 404。**行だけが残る状態を「あります」と答えない。**
  const object = await c.env.DOCUMENTS.head(row.storageKey);
  if (object === null) return c.notFound();

  const body: DailyReportDownloadResponse = {
    url: await signObjectUrl(c.env.SESSION_SECRET, row.storageKey, getNow(c)),
    documentNo: row.documentNo,
    revision: row.revision,
    pdfSha256: row.pdfSha256,
  };
  return c.json(body);
});

/**
 * 月次監査レポートを作る（PK-SPEC-P4 §7・§8）。
 *
 * ── 権限は差異レポートと同じ ────────────────────────────
 * §6.4 の「エクスポート」（`OWNER` / `ORG_ADMIN` / `AUDITOR`）。
 * 中身は差異の要約そのものなので、**差異を読めない相手に出さない**
 * （`finding.read` / security.md §1）。
 *
 * ── 生成はここで行わない ────────────────────────────────
 * Queue へ投げるだけ（architecture.md §5 / P4-14 の完了条件
 * 「Queue コンシューマ内で生成される」）。
 */
reports.post("/audit/monthly", async (c) => {
  const parsed = auditReportGenerateRequestSchema.safeParse(await readJson(c.req.raw));
  if (!parsed.success) return c.json({ error: "INVALID_REQUEST" }, 400);

  const ctx = getTenant(c);
  const property = await findPropertyById(c.env, ctx, parsed.data.propertyId);
  if (property === undefined) return c.notFound();
  assertPermission(ctx, "finding.read", propertyTarget([property.id]));

  const message: AuditReportMessage = {
    kind: "AUDIT_REPORT",
    organizationId: ctx.organizationId,
    orgShortId: ctx.orgShortId,
    propertyId: property.id,
    month: parsed.data.month,
    requestedById: getSession(c).membershipId,
    requestedAtMs: getNow(c).getTime(),
  };
  await c.env.QUEUE_PDF_GENERATION.send(message);

  const body: AuditReportGenerateResponse = {
    status: "QUEUED",
    propertyId: property.id,
    month: parsed.data.month,
  };
  return c.json(body, 202);
});

/**
 * 月次監査レポートを受け取る（§7）。
 *
 * **表に行が無い**（DECISIONS #119）ので、R2 のキーを直に見る。
 * まだ作られていなければ 404（「作りました」と嘘をつかない）。
 */
reports.get("/audit/monthly/download", async (c) => {
  const ctx = getTenant(c);
  const propertyId = c.req.query("propertyId");
  const month = c.req.query("month");
  if (propertyId === undefined || month === undefined) {
    return c.json({ error: "INVALID_REQUEST" }, 400);
  }
  if (!/^\d{4}-\d{2}$/.test(month)) return c.json({ error: "INVALID_REQUEST" }, 400);

  assertPermission(ctx, "finding.read", propertyTarget([propertyId]));

  const key = auditReportKey({
    organizationId: ctx.organizationId,
    propertyId,
    month,
  });
  const object = await c.env.DOCUMENTS.head(key);
  if (object === null) return c.notFound();

  const body: AuditReportDownloadResponse = {
    url: await signObjectUrl(c.env.SESSION_SECRET, key, getNow(c)),
    propertyId,
    month,
  };
  return c.json(body);
});

/** キューへ載せる。**投入は 1 か所**（メッセージの形を散らさない）。 */
async function enqueue(env: AppEnv["Bindings"], message: DailyReportMessage): Promise<void> {
  await env.QUEUE_PDF_GENERATION.send(message);
}

export default reports;
