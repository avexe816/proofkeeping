/**
 * 月次締めの API（PK-SPEC-P5 §2.8・§6.1・§9）。
 *
 * ```
 * GET  /api/v1/billing-periods?counterpartyId=&status=
 * POST /api/v1/billing-periods/:billingPeriodId/aggregate
 * GET  /api/v1/billing-periods/:billingPeriodId/lines      ★合意の画面が見る明細
 * GET  /api/v1/billing-periods/:billingPeriodId/lines/tasks?lineKey=  ★証跡への入口
 * POST /api/v1/billing-periods/:billingPeriodId/request-review
 * POST /api/v1/billing-periods/:billingPeriodId/agree
 * POST /api/v1/billing-periods/:billingPeriodId/reject
 * GET  /api/v1/billing-periods/:billingPeriodId/reviews
 * ```
 *
 * task: docs/tasks/P5-05.md（一覧・集計）/ docs/tasks/P5-12.md（双方合意）
 *       / docs/tasks/P5-13.md（証跡へのドリルダウン）
 *
 * ── 差戻しはコメント無しでは通らない（§6.2 MUST）─────────
 * `reject` は `comment` が空だと **400**。理由の無い差戻しが残ると、
 * 履歴（`billing_period_review`）を置いた理由がそのまま消える。
 * 合意・差戻し・確認依頼はすべて**追記だけ**の履歴に残り、
 * 書き換える口は無い。
 *
 * ── `request-review` は状態を変えない ───────────────────
 * §9 に口はあるが §2.8 に対応する状態が無い（OPEN_QUESTIONS #072）。
 * **状態を増やさず、出来事として履歴に残す**（DECISIONS #128）。
 *
 * ── `aggregate` は手動の再実行 ──────────────────────────
 * 本来の起点は毎月 1 日 04:00 の Cron（`lib/billing/monthlyClose.ts`）。
 * この口は締めを取りこぼしたときに人が押すためのもので、**同じ
 * 状態機械と同じ楽観ロックを通る。** 2 回押しても 2 回進まない。
 *
 * ── 物理削除の口が無い ──────────────────────────────────
 * CLAUDE.md §4。締めの記録は請求の根拠そのもの（billing.md §2）。
 * 履歴（`billing_period_review`）にも更新・削除の口を作らない。
 */

import {
  closedPeriodAsOf,
  evaluateBillingPeriodTransition,
  type BillingPeriodStatusValue,
  type InvoiceDraft,
} from "@pk/billing";
import {
  BILLING_PERIOD_STATUSES,
  billingPeriodAgreeRequestSchema,
  type BillingLineTasksResponse,
  billingPeriodRejectRequestSchema,
  billingPeriodRequestReviewRequestSchema,
  type BillingPeriodLinesResponse,
  type BillingPeriodListResponse,
  type BillingPeriodReviewListResponse,
  type BillingPeriodSummary,
} from "@pk/contracts";
import {
  appendBillingPeriodReview,
  ensureBillingPeriod,
  findBillingPeriodById,
  findCounterpartyById,
  listBillingPeriodReviews,
  listBillingPeriods,
  listTasksByIds,
  recordAudit,
  updateBillingPeriodStatus,
  type BillingPeriodReviewLineComment,
  type BillingPeriodReviewLineSnapshot,
  type Env,
  type TenantContext,
} from "@pk/db";
import { Hono } from "hono";

import { buildPeriodDraft } from "../../../lib/billing/draft.js";
import { toTaskSummaries } from "../../../lib/task/summary.js";
import { ORGANIZATION_TARGET, assertPermission } from "../../../lib/auth/permission.js";
import { getSession, getTenant, type AppEnv } from "../../../middleware/index.js";

const billingPeriods = new Hono<AppEnv>();

function invalidRequest() {
  return { error: "INVALID_REQUEST" as const };
}

function notFound() {
  return { error: "RESOURCE_NOT_FOUND" as const };
}

/** 一覧。**取引先と状態で絞れる**（§9）。 */
billingPeriods.get("/", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "billing.read", ORGANIZATION_TARGET);

  const counterpartyId = c.req.query("counterpartyId");
  const statusQuery = c.req.queries("status") ?? [];
  const statuses = statusQuery.filter((value): value is BillingPeriodStatusValue =>
    (BILLING_PERIOD_STATUSES as readonly string[]).includes(value),
  );
  // **知らない状態名を黙って無視しない。** 綴り違いで全件が返ると、
  // 画面は「該当なし」ではなく「全部ある」を見せる。
  if (statuses.length !== statusQuery.length) return c.json(invalidRequest(), 400);

  const rows = await listBillingPeriods(c.env, ctx, {
    ...(counterpartyId === undefined ? {} : { counterpartyId }),
    ...(statuses.length === 0 ? {} : { status: statuses }),
  });

  const body: BillingPeriodListResponse = { data: rows.map(toSummary) };
  return c.json(body);
});

/**
 * 集計（`OPEN → REVIEWING`）。**冪等。**
 *
 * 既に `REVIEWING` 以降へ進んでいれば 409 を返す。**200 で黙って
 * 何もしないのは避ける** — 押した人は「集計し直した」と読むが、
 * 実際には古い状態のままだからである。
 */
billingPeriods.post("/:billingPeriodId/aggregate", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "billing.write", ORGANIZATION_TARGET);

  const billingPeriodId = c.req.param("billingPeriodId");
  const before = await findBillingPeriodById(c.env, ctx, billingPeriodId);
  if (before === undefined) return c.json(notFound(), 404);

  const transition = evaluateBillingPeriodTransition(before.status, "AGGREGATE");
  if (!transition.allowed) return c.json({ error: "INVALID_TRANSITION" as const }, 409);

  const changed = await updateBillingPeriodStatus(
    c.env,
    ctx,
    billingPeriodId,
    { status: transition.next, aggregatedAt: ctx.now },
    before.status,
  );
  // 0 なら別のリクエストが先に進めている。**状態機械の判定と DB の
  // 実際の状態がずれた**ということなので、成功にしない。
  if (changed === 0) return c.json({ error: "INVALID_TRANSITION" as const }, 409);

  await recordAudit(c.env, ctx, {
    actorId: getSession(c).membershipId,
    action: "billingPeriod.statusChanged",
    targetType: "billingPeriod",
    targetId: billingPeriodId,
    before: { status: before.status },
    after: { status: transition.next },
    ...ipOf(c.req.header("CF-Connecting-IP")),
  });

  return c.json({ billingPeriodId, status: transition.next });
});

/**
 * 取引先の「直近に締まった期間」を起票する（§6.1 の `OPEN`）。
 *
 * Cron を待たずに当月ぶんを起こしたいときの口。**期間は締め日から
 * 導き、リクエストで受け取らない。** 期間を指定できると、締め日と
 * 合わない範囲の請求書が作れてしまう。
 */
billingPeriods.post("/", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "billing.write", ORGANIZATION_TARGET);

  const counterpartyId = c.req.query("counterpartyId");
  if (counterpartyId === undefined) return c.json(invalidRequest(), 400);

  const counterparty = await findCounterpartyById(c.env, ctx, counterpartyId);
  if (counterparty === undefined) return c.json(notFound(), 404);

  // 現地時刻の暦日。Cron（`lib/billing/monthlyClose.ts`）と同じ基準で引く。
  const onDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ctx.now);

  const range = closedPeriodAsOf(counterparty.closingDay, onDate);
  const ensured = await ensureBillingPeriod(c.env, ctx, { counterpartyId, ...range });

  return c.json({ billingPeriodId: ensured.id, ...range }, ensured.created ? 201 : 200);
});

// ────────────────────────────────────────────────────────────
// 双方合意フロー（§6 / P5-12）
// ────────────────────────────────────────────────────────────

/**
 * 締めと、そのとき見える明細を揃えて返す。
 *
 * **発行（`lib/billing/issue.ts`）と同じ `buildPeriodDraft()` を通る。**
 * 合意の画面が別の計算をすると、見て合意した数字と請求書が食い違う
 * （§0.2 の出荷判定）。
 */
async function loadPeriodWithDraft(env: Env, ctx: TenantContext, billingPeriodId: string) {
  const period = await findBillingPeriodById(env, ctx, billingPeriodId);
  if (period === undefined) return undefined;

  const counterparty = await findCounterpartyById(env, ctx, period.counterpartyId);
  // 取引先が引けない締めは**明細を組めない**（端数処理の方式が決まらない）。
  // 越境と同じ 404 に寄せる（403 を作らない / DECISIONS #022）。
  if (counterparty === undefined) return undefined;

  const draft = await buildPeriodDraft(env, ctx, {
    counterpartyId: period.counterpartyId,
    periodFrom: period.periodFrom,
    periodTo: period.periodTo,
    taxRoundingMode: counterparty.taxRoundingMode,
  });

  return { period, draft };
}

/** 履歴に残す明細の写し（§6.2 の修正履歴）。**金額は整数のまま。** */
function snapshotOf(draft: InvoiceDraft): BillingPeriodReviewLineSnapshot[] {
  return draft.lines.map((line) => ({
    lineNo: line.lineNo,
    lineKey: line.lineKey,
    itemCode: line.itemCode,
    description: line.description,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    amount: line.amount,
    taxRate: line.taxRate,
  }));
}

/**
 * `GET /:billingPeriodId/lines` — 合意の画面が見る明細（§6.2）。
 *
 * **発行前の明細。** `invoiceLine` はまだ存在しない（請求書を出した
 * 時点で作られる）。ここが返す `lineKey` が、差戻しコメントを行に
 * 結びつける鍵になる。
 *
 * 集計元のタスク ID は**件数だけ**にしてある。一覧は §6.3 の
 * ドリルダウン（P5-13）が別の口で返す。明細 300 行それぞれに
 * タスク ID を数百件ぶら下げると、画面を開くたびに数 MB を運ぶ。
 */
billingPeriods.get("/:billingPeriodId/lines", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "billing.read", ORGANIZATION_TARGET);

  const loaded = await loadPeriodWithDraft(c.env, ctx, c.req.param("billingPeriodId"));
  if (loaded === undefined) return c.json(notFound(), 404);
  const { period, draft } = loaded;

  const body: BillingPeriodLinesResponse = {
    billingPeriodId: period.id,
    counterpartyId: period.counterpartyId,
    periodFrom: period.periodFrom,
    periodTo: period.periodTo,
    status: period.status,
    data: draft.lines.map((line) => ({
      lineNo: line.lineNo,
      lineKey: line.lineKey,
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
      taskCount: line.sourceRef.taskIds.length,
    })),
    subtotalAmount: draft.subtotalAmount,
    taxAmount: draft.taxAmount,
    totalAmount: draft.totalAmount,
    // §3.2 MUST。**単価が引けなかった行を黙って落とさない。**
    warnings: draft.warnings.map((warning) => ({
      code: warning.code,
      propertyId: warning.propertyId,
      taskType: warning.taskType,
      roomTypeId: warning.roomTypeId,
      taskCount: warning.taskCount,
      ...(warning.detail === undefined ? {} : { detail: warning.detail }),
    })),
  };
  return c.json(body);
});

/**
 * `GET /:billingPeriodId/lines/tasks?lineKey=` — 明細行の集計元タスク（§6.3）。
 *
 * **請求機能の核心。** 「アウト清掃 / ツイン 95 室 ¥361,000」の 95 室が
 * どのタスクだったのかを開き、そこから W-07（`GET /evidence/tasks/:taskId`）へ
 * 進める。請求根拠が写真とタイムスタンプまで遡れる。
 *
 * ── 行は `lineKey` で指す。**クエリで受け取る。** ──────
 * `lineKey` は `施設|清掃種別|客室タイプ` で `|` を含む。パスに置くと
 * encode の有無で経路が割れる。`lineNo` を使わないのは P5-12 と同じ理由
 * （再集計で位置が動く）。
 *
 * ── 明細を組み直す ──────────────────────────────────────
 * 発行前の締めには保存された明細が無い。`buildPeriodDraft()` を通す
 * （発行と同じ関数 / DECISIONS #129）。**発行済みの請求書は組み直さない** —
 * そちらは `GET /invoices/:id/lines/:lineNo/tasks` が固定済みの
 * `sourceRef` を読む。
 *
 * ── 証跡そのものは返さない ──────────────────────────────
 * W-07 の口が既にある（P2-09）。写真の署名付き URL は 15 分で切れるので
 * （security.md §4）、一覧で 95 件ぶんを先に発行しない。
 */
billingPeriods.get("/:billingPeriodId/lines/tasks", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "billing.read", ORGANIZATION_TARGET);

  const lineKey = c.req.query("lineKey");
  if (lineKey === undefined || lineKey === "") return c.json(invalidRequest(), 400);

  const loaded = await loadPeriodWithDraft(c.env, ctx, c.req.param("billingPeriodId"));
  if (loaded === undefined) return c.json(notFound(), 404);

  const line = loaded.draft.lines.find((candidate) => candidate.lineKey === lineKey);
  // 明細に無い行。**404**（403 を作らない / DECISIONS #022）。差し戻しの
  // あいだに元データが動いて行が消えることは実際に起こる。
  if (line === undefined) return c.json(notFound(), 404);

  // 施設スコープはリポジトリ層が掛ける。担当外施設のタスクは**返らない**。
  const rows = await listTasksByIds(c.env, ctx, line.sourceRef.taskIds);

  const body: BillingLineTasksResponse = {
    lineNo: line.lineNo,
    lineKey: line.lineKey,
    description: line.description,
    // 集計時に確定した件数。**返った行数と違うことがある**（上の注記）。
    taskCount: line.sourceRef.taskIds.length,
    data: await toTaskSummaries(c.env, ctx, rows),
  };
  return c.json(body);
});

/**
 * `GET /:billingPeriodId/reviews` — 合意・差戻しの履歴（§6.2 MUST）。
 *
 * **古い順。** 起きた順に読めないと「言った・言わない」が起きる。
 * 書き換える口は無い（追記だけ）。
 */
billingPeriods.get("/:billingPeriodId/reviews", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "billing.read", ORGANIZATION_TARGET);

  const billingPeriodId = c.req.param("billingPeriodId");
  const period = await findBillingPeriodById(c.env, ctx, billingPeriodId);
  if (period === undefined) return c.json(notFound(), 404);

  const rows = await listBillingPeriodReviews(c.env, ctx, billingPeriodId);
  const body: BillingPeriodReviewListResponse = {
    data: rows.map((row) => ({
      reviewId: row.id,
      seq: row.seq,
      action: row.action,
      comment: row.comment,
      lineComments: row.lineComments,
      linesSnapshot: row.linesSnapshot,
      snapshotTotalAmount: row.snapshotTotalAmount,
      statusBefore: row.statusBefore,
      statusAfter: row.statusAfter,
      byCounterparty: row.byCounterparty,
      actorId: row.actorId,
      createdAt: row.createdAt.toISOString(),
    })),
  };
  return c.json(body);
});

/**
 * `POST /:billingPeriodId/request-review` — ホテルへの確認依頼（§9）。
 *
 * **状態を変えない。** §2.8 に「ホテルの確認待ち」に当たる状態が無い
 * （OPEN_QUESTIONS #072）。状態を増やすのは仕様に根拠のない設計選択なので、
 * 依頼した事実を履歴に残すだけにしてある（DECISIONS #128）。
 * 履歴には**そのとき見えていた明細**が付くので、「どの数字で確認を
 * 頼んだか」が後から分かる。
 *
 * `REVIEWING` のときだけ。集計前（`OPEN`）に確認は頼めないし、
 * 合意済み・発行済みに頼み直すのは差戻し（`reject`）である。
 */
billingPeriods.post("/:billingPeriodId/request-review", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "billing.write", ORGANIZATION_TARGET);

  const parsed = billingPeriodRequestReviewRequestSchema.safeParse(await readJson(c));
  if (!parsed.success) return c.json(invalidRequest(), 400);

  const loaded = await loadPeriodWithDraft(c.env, ctx, c.req.param("billingPeriodId"));
  if (loaded === undefined) return c.json(notFound(), 404);
  const { period, draft } = loaded;

  if (period.status !== "REVIEWING") {
    return c.json({ error: "INVALID_TRANSITION" as const }, 409);
  }

  const appended = await appendBillingPeriodReview(c.env, ctx, {
    billingPeriodId: period.id,
    action: "REQUEST_REVIEW",
    comment: parsed.data.comment ?? null,
    lineComments: [],
    linesSnapshot: snapshotOf(draft),
    snapshotTotalAmount: draft.totalAmount,
    statusBefore: period.status,
    statusAfter: period.status,
    byCounterparty: false,
    actorId: getSession(c).membershipId,
  });

  return c.json({ billingPeriodId: period.id, status: period.status, seq: appended.seq }, 201);
});

/**
 * `POST /:billingPeriodId/agree` — 合意（`REVIEWING → AGREED` / §6.1）。
 *
 * **合意した瞬間の明細を履歴に固定する。** 合意のあとに元データが
 * 動けば、次に組み立てた明細は違う数字になる。何に合意したのかが
 * 残らないと、§6.2 の MUST が成り立たない。
 *
 * `agreedByCounterparty` は取引先の意思として記録したか。ホテルの
 * 担当者は利用者ではないので、**代わりに入力した人が `actorId` に残る。**
 */
billingPeriods.post("/:billingPeriodId/agree", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "billing.write", ORGANIZATION_TARGET);

  const parsed = billingPeriodAgreeRequestSchema.safeParse(await readJson(c));
  if (!parsed.success) return c.json(invalidRequest(), 400);

  const loaded = await loadPeriodWithDraft(c.env, ctx, c.req.param("billingPeriodId"));
  if (loaded === undefined) return c.json(notFound(), 404);
  const { period, draft } = loaded;

  const transition = evaluateBillingPeriodTransition(period.status, "AGREE");
  if (!transition.allowed) return c.json({ error: "INVALID_TRANSITION" as const }, 409);

  const changed = await updateBillingPeriodStatus(
    c.env,
    ctx,
    period.id,
    {
      status: transition.next,
      agreedAt: ctx.now,
      agreedByCounterparty: parsed.data.byCounterparty,
    },
    period.status,
  );
  // 0 なら別のリクエストが先に進めている。**履歴を書く前に落とす。**
  // 状態が動いていないのに「合意した」と残ると、履歴のほうが嘘になる。
  if (changed === 0) return c.json({ error: "INVALID_TRANSITION" as const }, 409);

  await appendBillingPeriodReview(c.env, ctx, {
    billingPeriodId: period.id,
    action: "AGREE",
    comment: parsed.data.comment ?? null,
    lineComments: [],
    linesSnapshot: snapshotOf(draft),
    snapshotTotalAmount: draft.totalAmount,
    statusBefore: period.status,
    statusAfter: transition.next,
    byCounterparty: parsed.data.byCounterparty,
    actorId: getSession(c).membershipId,
  });

  await recordAudit(c.env, ctx, {
    actorId: getSession(c).membershipId,
    action: "billingPeriod.statusChanged",
    targetType: "billingPeriod",
    targetId: period.id,
    before: { status: period.status },
    after: { status: transition.next, agreedByCounterparty: parsed.data.byCounterparty },
    ...ipOf(c.req.header("CF-Connecting-IP")),
  });

  return c.json({ billingPeriodId: period.id, status: transition.next });
});

/**
 * `POST /:billingPeriodId/reject` — 差戻し（§6.2 MUST）。
 *
 * **コメントが無ければ 400。** 理由の無い差戻しを記録に残さない。
 * 明細行を指すコメントは `lineKey`（`lineNo` ではない）で付ける。
 * **いま組み立てた明細に無い `lineKey` は 400。** 消えた行に対する
 * コメントを受け取ると、どの作業への指摘なのかが誰にも分からなくなる。
 *
 * `AGREED` からも差し戻せる（§6.1 の「差戻し → REVIEWING」）。
 * そのとき `agreedAt` と `agreedByCounterparty` を**戻す。** 合意は
 * 取り消されており、残っていると `AGREED` 相当の請求ができてしまう。
 * 取り消したという事実は履歴に残る。
 */
billingPeriods.post("/:billingPeriodId/reject", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "billing.write", ORGANIZATION_TARGET);

  const parsed = billingPeriodRejectRequestSchema.safeParse(await readJson(c));
  if (!parsed.success) return c.json(invalidRequest(), 400);

  const loaded = await loadPeriodWithDraft(c.env, ctx, c.req.param("billingPeriodId"));
  if (loaded === undefined) return c.json(notFound(), 404);
  const { period, draft } = loaded;

  const byLineKey = new Map(draft.lines.map((line) => [line.lineKey, line]));
  const lineComments: BillingPeriodReviewLineComment[] = [];
  for (const entry of parsed.data.lineComments) {
    const line = byLineKey.get(entry.lineKey);
    if (line === undefined) return c.json(invalidRequest(), 400);
    lineComments.push({
      lineKey: entry.lineKey,
      lineNo: line.lineNo,
      description: line.description,
      comment: entry.comment,
    });
  }

  const transition = evaluateBillingPeriodTransition(period.status, "REJECT");
  if (!transition.allowed) return c.json({ error: "INVALID_TRANSITION" as const }, 409);

  const changed = await updateBillingPeriodStatus(
    c.env,
    ctx,
    period.id,
    { status: transition.next, agreedAt: null, agreedByCounterparty: false },
    period.status,
  );
  if (changed === 0) return c.json({ error: "INVALID_TRANSITION" as const }, 409);

  const appended = await appendBillingPeriodReview(c.env, ctx, {
    billingPeriodId: period.id,
    action: "REJECT",
    comment: parsed.data.comment,
    lineComments,
    linesSnapshot: snapshotOf(draft),
    snapshotTotalAmount: draft.totalAmount,
    statusBefore: period.status,
    statusAfter: transition.next,
    // 差戻しはホテル側の意思（§6.2 の見本の「行2 へのコメント（ホテル側）」）。
    byCounterparty: true,
    actorId: getSession(c).membershipId,
  });

  await recordAudit(c.env, ctx, {
    actorId: getSession(c).membershipId,
    action: "billingPeriod.statusChanged",
    targetType: "billingPeriod",
    targetId: period.id,
    before: { status: period.status },
    after: { status: transition.next, rejected: true },
    ...ipOf(c.req.header("CF-Connecting-IP")),
  });

  return c.json({ billingPeriodId: period.id, status: transition.next, seq: appended.seq });
});

/**
 * 本文を JSON として読む。**空の本文を `{}` として扱う。**
 *
 * `agree` と `request-review` は本文が無くても成り立つ（既定値がある）。
 * `reject` は `comment` が必須なので、`{}` は zod が弾く。
 */
async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

/** 一覧の 1 件。**`organizationId` を落とす**（組織 ID を応答に出さない）。 */
function toSummary(row: {
  id: string;
  counterpartyId: string;
  periodFrom: string;
  periodTo: string;
  status: BillingPeriodStatusValue;
  aggregatedAt: Date | null;
  agreedAt: Date | null;
  agreedByCounterparty: boolean;
  invoiceId: string | null;
}): BillingPeriodSummary {
  return {
    billingPeriodId: row.id,
    counterpartyId: row.counterpartyId,
    periodFrom: row.periodFrom,
    periodTo: row.periodTo,
    status: row.status,
    aggregatedAt: row.aggregatedAt === null ? null : row.aggregatedAt.toISOString(),
    agreedAt: row.agreedAt === null ? null : row.agreedAt.toISOString(),
    agreedByCounterparty: row.agreedByCounterparty,
    invoiceId: row.invoiceId,
  };
}

function ipOf(ip: string | undefined): { ip?: string } {
  return ip === undefined ? {} : { ip };
}

export default billingPeriods;
