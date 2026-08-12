/**
 * 清掃タスクの API（PK-SPEC-P1 §3・§5・§6）。
 *
 * ```
 * GET    /api/v1/tasks?propertyId=&businessDate=&assignee=me
 * GET    /api/v1/tasks/:taskId/checklist
 * POST   /api/v1/tasks/:taskId/checklist
 * POST   /api/v1/tasks/:taskId/:action     assign|start|pause|resume|complete|block|unblock|cancel
 * POST   /api/v1/tasks/generate
 * ```
 *
 * task: docs/tasks/P1-03.md / docs/tasks/P1-05.md / docs/tasks/P1-06.md
 *
 * ── 画面はここに無い ────────────────────────────────────
 * M-02 / M-03 / M-04 / W-03 / W-04 は P1-07 以降。この task は API だけを置く。
 *
 * ── `Idempotency-Key` ───────────────────────────────────
 * 状態変更 API は必ずヘッダを読む（CLAUDE.md §5）。オフラインキューは
 * 同じ鍵で再送し、2 回目以降は状態を変えずに 200 を返す（§8.2 の
 * 「409 は成功として扱う」を、409 を作らずに満たす形）。
 */

import {
  checklistResultUpdateRequestSchema,
  taskActionSchema,
  taskGenerateRequestSchema,
  taskTransitionRequestSchema,
  type TaskChecklistResponse,
  type TaskError,
  type TaskGenerateResponse,
  type TaskListResponse,
  type TaskSummary,
} from "@pk/contracts";
import {
  findTaskById,
  listChecklistResults,
  listRooms,
  listTasks,
  listTemplateItems,
  countPhotosByChecklistItem,
  recordChecklistResult,
  type Env,
  type TenantContext,
} from "@pk/db";
import { checklistProgress } from "@pk/engine";
import { Hono } from "hono";

import { assertPermission, propertyTarget } from "../../../lib/auth/permission.js";
import { businessDateOf } from "../../../lib/businessDate.js";
import { generateTasksForProperty } from "../../../lib/task/generate.js";
import { runTransition } from "../../../lib/task/transition.js";
import { getNow, getSession, getTenant, type AppEnv } from "../../../middleware/index.js";

const tasks = new Hono<AppEnv>();

/** 400。**文言を載せない。** 画面が i18n キーへ写す。 */
function invalidRequest(): TaskError {
  return { error: "INVALID_REQUEST" };
}

/**
 * タスク一覧（M-02 / W-04）。
 *
 * `assignee=me` はセッションの `membershipId` で絞る。**クライアントから
 * 任意の担当者 ID を受け取る口にしない。** 他人のタスク一覧を引く経路は
 * 施設責任者の画面（`propertyId` 指定）に限る。
 */
tasks.get("/", async (c) => {
  const ctx = getTenant(c);
  const propertyId = c.req.query("propertyId");
  const businessDate = c.req.query("businessDate") ?? businessDateOf(getNow(c));

  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) return c.json(invalidRequest(), 400);

  // 施設を指定しない一覧（自分のタスク）は組織全体の読み取り権限で足りる。
  // 施設を指定した場合は、その施設に対する権限で判定する（INV-32 の対象は
  // 「クライアントが送った施設で権限を通す」ことであり、ここは絞り込みに使い、
  // 権限は同じ値で `ASSIGNED` 判定に掛ける。担当外なら 404 になる）。
  assertPermission(
    ctx,
    "task.read",
    propertyId === undefined ? propertyTarget(ctx.allowedPropertyIds) : propertyTarget([propertyId]),
  );

  const rows = await listTasks(c.env, ctx, {
    propertyId,
    businessDate,
    ...(propertyId === undefined ? { assigneeId: getSession(c).membershipId } : {}),
  });

  const body: TaskListResponse = {
    businessDate,
    data: await toSummaries(c.env, ctx, rows),
  };
  return c.json(body);
});

/**
 * タスクの状態変更（§5.3）。
 *
 * **操作は URL の末尾で表す。** ボディに `action` を入れると、
 * ルート単位でのレート制限や監査の切り分けができなくなる。
 */
tasks.post("/:taskId/:action", async (c) => {
  const action = taskActionSchema.safeParse(c.req.param("action"));
  if (!action.success) return c.notFound();

  const parsed = await readJson(c.req.raw);
  if (parsed === null) return c.json(invalidRequest(), 400);

  const body = taskTransitionRequestSchema.safeParse(parsed);
  if (!body.success) return c.json(invalidRequest(), 400);

  const ctx = getTenant(c);
  const outcome = await runTransition(c.env, ctx, {
    taskId: c.req.param("taskId"),
    action: action.data,
    actorId: getSession(c).membershipId,
    reasonCode: body.data.reasonCode,
    assigneeId: body.data.assigneeId,
    clientTs: body.data.clientTs,
    note: body.data.note,
    idempotencyKey: c.req.header("Idempotency-Key"),
    ip: c.req.header("CF-Connecting-IP"),
  });

  if (outcome.kind === "REJECTED") {
    const error: TaskError = {
      error: outcome.error,
      ...(outcome.incompleteItemIds === undefined && outcome.missingPhotoItemIds === undefined
        ? {}
        : {
            details: {
              ...(outcome.incompleteItemIds === undefined
                ? {}
                : { incompleteItemIds: outcome.incompleteItemIds }),
              ...(outcome.missingPhotoItemIds === undefined
                ? {}
                : { missingPhotoItemIds: outcome.missingPhotoItemIds }),
            },
          }),
    };
    return c.json(error, 409);
  }

  const task = await findTaskById(c.env, ctx, outcome.taskId);
  if (task === undefined) return c.notFound();
  const [summary] = await toSummaries(c.env, ctx, [task]);
  if (summary === undefined) return c.notFound();

  return c.json({ data: summary, unchanged: outcome.unchanged });
});

/** タスク生成（§3.2 の「随時 施設責任者が手動で再生成」）。 */
tasks.post("/generate", async (c) => {
  const parsed = await readJson(c.req.raw);
  const body = taskGenerateRequestSchema.safeParse(parsed);
  if (!body.success) return c.json(invalidRequest(), 400);

  const ctx = getTenant(c);
  assertPermission(ctx, "task.manage", propertyTarget([body.data.propertyId]));

  const result = await generateTasksForProperty(
    c.env,
    ctx,
    body.data.propertyId,
    body.data.businessDate,
  );

  const response: TaskGenerateResponse = { businessDate: body.data.businessDate, ...result };
  return c.json(response);
});

/** タスクのチェックリスト（M-04）。 */
tasks.get("/:taskId/checklist", async (c) => {
  const ctx = getTenant(c);
  const taskId = c.req.param("taskId");
  const task = await findTaskById(c.env, ctx, taskId);
  if (task === undefined) return c.notFound();
  assertPermission(ctx, "task.read", propertyTarget([task.propertyId]));

  const body = await buildChecklistResponse(c.env, ctx, taskId);
  return c.json(body);
});

/**
 * チェックリストの記録（M-04）。**1 項目ずつ。**
 *
 * 一括更新の口を作らない。画面から「すべてチェック」を消しても、
 * まとめて送れる API があれば同じことができてしまう（§6.3）。
 */
tasks.post("/:taskId/checklist", async (c) => {
  const parsed = await readJson(c.req.raw);
  const body = checklistResultUpdateRequestSchema.safeParse(parsed);
  if (!body.success) return c.json(invalidRequest(), 400);

  const ctx = getTenant(c);
  const taskId = c.req.param("taskId");
  const task = await findTaskById(c.env, ctx, taskId);
  if (task === undefined) return c.notFound();
  assertPermission(ctx, "task.write", propertyTarget([task.propertyId]));

  const recorded = await recordChecklistResult(c.env, ctx, {
    taskId,
    itemId: body.data.itemId,
    value: body.data.value,
    reasonCode: body.data.reasonCode,
    checkedById: getSession(c).membershipId,
  });
  // 展開されていない項目。**その項目はこのタスクに存在しない**ので 404。
  if (!recorded) return c.notFound();

  return c.json(await buildChecklistResponse(c.env, ctx, taskId));
});

/** チェックリストの応答を組み立てる。 */
async function buildChecklistResponse(
  env: Env,
  ctx: TenantContext,
  taskId: string,
): Promise<TaskChecklistResponse> {
  const [results, photoCounts] = await Promise.all([
    listChecklistResults(env, ctx, taskId),
    countPhotosByChecklistItem(env, ctx, taskId),
  ]);

  const items = await listTemplateItems(
    env,
    ctx,
    [...new Set(results.map((row) => row.itemId))],
  );
  const itemById = new Map(items.map((item) => [item.id, item]));

  const progress = checklistProgress(
    results.map((row) => ({
      itemId: row.itemId,
      isRequired: row.isRequired,
      photoRequired: row.photoRequired,
      value: row.value,
      photoCount: photoCounts.get(row.itemId) ?? 0,
    })),
  );

  return {
    taskId,
    done: progress.done,
    total: progress.total,
    items: results.map((row) => ({
      itemId: row.itemId,
      section: itemById.get(row.itemId)?.section ?? "",
      labels: itemById.get(row.itemId)?.labels ?? {},
      isRequired: row.isRequired,
      photoRequired: row.photoRequired,
      value: row.value,
      reasonCode: row.reasonCode,
      checkedAt: row.checkedAt?.getTime() ?? null,
      photoCount: photoCounts.get(row.itemId) ?? 0,
      sortOrder: row.sortOrder,
    })),
  };
}

/** `listTasks()` が返す 1 行のうち、応答に使う列だけ。 */
type TaskRow = Awaited<ReturnType<typeof listTasks>>[number];

/**
 * 一覧の応答へ写す。
 *
 * 客室番号は画面が必ず要る（M-02 は部屋番号で並ぶ）。
 * **タスクごとに客室を引かない。** 1 回で引いて突き合わせる。
 */
async function toSummaries(
  env: Env,
  ctx: TenantContext,
  rows: readonly TaskRow[],
): Promise<TaskSummary[]> {
  if (rows.length === 0) return [];

  const rooms = await listRooms(env, ctx, {});
  const roomById = new Map(rooms.map((room) => [room.id, room]));

  return rows.map((task) => ({
    taskId: task.id,
    shortId: task.shortId,
    propertyId: task.propertyId,
    roomId: task.roomId,
    roomNumber: roomById.get(task.roomId)?.roomNumber ?? "",
    roomTypeName: null,
    businessDate: task.businessDate,
    taskType: task.taskType,
    status: task.status,
    priority: task.priority,
    assigneeId: task.assigneeId,
    standardMinutes: task.standardMinutes,
    actualMinutes: task.actualMinutes,
    pauseCount: task.pauseCount,
    startedAt: task.startedAt?.getTime() ?? null,
    completedAt: task.completedAt?.getTime() ?? null,
    // 進捗は載せない。タスクごとに 1 クエリ増えるため（`taskSummarySchema` の注記）。
  }));
}

/** JSON を読む。**壊れていたら `null`。** 例外を 500 にしない。 */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export default tasks;
