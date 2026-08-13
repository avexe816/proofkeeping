/**
 * 清掃タスクの API（PK-SPEC-P1 §3・§5・§6）。
 *
 * ```
 * GET    /api/v1/tasks?propertyId=&businessDate=&assignee=me
 * GET    /api/v1/tasks/my-day?businessDate=          1 日の動線（§19.6）
 * GET    /api/v1/tasks/:taskId/checklist
 * POST   /api/v1/tasks/:taskId/checklist
 * GET    /api/v1/tasks/:taskId/photos
 * POST   /api/v1/tasks/:taskId/photos       multipart/form-data
 * POST   /api/v1/tasks/:taskId/:action      assign|start|pause|resume|complete|block|unblock|cancel
 * POST   /api/v1/tasks/generate
 * ```
 *
 * task: docs/tasks/P1-03.md / docs/tasks/P1-05.md / docs/tasks/P1-06.md /
 *       docs/tasks/P1-11.md（写真）
 *
 * ── 登録の順序が意味を持つ ──────────────────────────────
 * **`/:taskId/:action` は最後に登録すること。** Hono は登録順に照合し、
 * 静的な区間を優先しない。`/:taskId/:action` を先に置くと
 * `POST /tasks/{id}/checklist` が `action = "checklist"` として吸われ、
 * `taskActionSchema` が弾いて 404 になる（P1-06 の配線はこれで
 * 届いていなかった。P1-10 が画面を作るにあたり順序を入れ替えて直した）。
 *
 * ── 画面は `routes/m/*` にある ──────────────────────────
 * M-02 / M-03 / M-04 は P1-08〜P1-10。W-03 / W-04 は P1-14 / P1-15。
 *
 * ── `Idempotency-Key` ───────────────────────────────────
 * 状態変更 API は必ずヘッダを読む（CLAUDE.md §5）。オフラインキューは
 * 同じ鍵で再送し、2 回目以降は状態を変えずに 200 を返す（§8.2 の
 * 「409 は成功として扱う」を、409 を作らずに満たす形）。
 */

import {
  MAX_PHOTOS_PER_TASK,
  checklistResultUpdateRequestSchema,
  inspectionOverrideRequestSchema,
  inspectionStartRequestSchema,
  linenUpsertRequestSchema,
  observationSkipRequestSchema,
  observationUpsertRequestSchema,
  photoUploadMetaSchema,
  taskActionSchema,
  taskGenerateRequestSchema,
  taskTransitionRequestSchema,
  type InspectionError,
  type ObservationError,
  type ObservationUpsertResponse,
  type PhotoError,
  type TaskChecklistResponse,
  type TaskError,
  type TaskGenerateResponse,
  type TaskListResponse,
  type TaskPhoto,
  type TaskPhotoListResponse,
  type TaskPhotoUploadResponse,
  type TaskSummary,
} from "@pk/contracts";
import {
  findTaskById,
  listChecklistResults,
  listRooms,
  listTaskPhotos,
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
import { verifyTaskEvidence } from "../../../lib/evidence/verify.js";
import { overrideInspection } from "../../../lib/inspection/override.js";
import { startInspection } from "../../../lib/inspection/start.js";
import { buildLinenResponse, recordLinen } from "../../../lib/observation/linen.js";
import {
  buildObservationDetail,
  recordObservation,
  skipObservationForTask,
} from "../../../lib/observation/record.js";
import { uploadPhoto } from "../../../lib/photo/upload.js";
import { signObjectUrl } from "../../../lib/storage/signedUrl.js";
import { generateTasksForProperty } from "../../../lib/task/generate.js";
import { buildMyDayResponse } from "../../../lib/task/myDay.js";
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
 * 1 日の動線（§19.6）。**清掃員のモバイル画面はこれを使う。**
 *
 * ```
 * GET /api/v1/tasks/my-day?businessDate=2026-08-10
 * ```
 *
 * ── 担当者を受け取らない ────────────────────────────────
 * セッションの `membershipId` で絞る。**クエリで担当者を指定させない。**
 * 指定できると、施設責任者の権限で他人の 1 日を再構成できてしまう（INV-07）。
 *
 * ── 権限は担当施設ぶんだけ ──────────────────────────────
 * 自分に割り当たったタスクしか返らないので、判定は組織スコープの
 * `task.read` で足りる（`GET /` の `assignee=me` と同じ扱い）。
 * リポジトリ層の `scopeToProperties()` が担当外施設を落とす。
 *
 * ── `/:taskId/:action` より前に登録すること ─────────────
 * Hono は登録順に照合する。冒頭の「登録の順序が意味を持つ」を参照。
 * `my-day` は 1 区間なので `/:taskId/:action`（2 区間）とは衝突しないが、
 * `GET /:taskId` を将来足すと吸われる。**静的な区間を先に置く。**
 */
tasks.get("/my-day", async (c) => {
  const ctx = getTenant(c);
  const now = getNow(c);
  const businessDate = c.req.query("businessDate") ?? businessDateOf(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) return c.json(invalidRequest(), 400);

  assertPermission(ctx, "task.read", propertyTarget(ctx.allowedPropertyIds));

  const body = await buildMyDayResponse(
    c.env,
    ctx,
    getSession(c).membershipId,
    businessDate,
    now,
  );
  return c.json(body);
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

/** タスクの写真一覧（M-03 / §7.4）。**署名付き URL を都度発行する。** */
tasks.get("/:taskId/photos", async (c) => {
  const ctx = getTenant(c);
  const taskId = c.req.param("taskId");
  const task = await findTaskById(c.env, ctx, taskId);
  if (task === undefined) return c.notFound();
  assertPermission(ctx, "task.read", propertyTarget([task.propertyId]));

  const rows = await listTaskPhotos(c.env, ctx, taskId);
  const body: TaskPhotoListResponse = {
    taskId,
    count: rows.length,
    limit: MAX_PHOTOS_PER_TASK,
    data: await Promise.all(
      rows.map(async (row) => toPhoto(row, await signObjectUrl(c.env.SESSION_SECRET, row.storageKey, getNow(c)))),
    ),
  };
  return c.json(body);
});

/**
 * 写真のアップロード（§7）。**`multipart/form-data`。**
 *
 * `clientId` が冪等鍵（§7.5）。同じ鍵の 2 回目は R2 へ書かずに既存を返す。
 * EXIF の除去は `uploadPhoto()` の中（サーバー側の 2 重目 / INV-11）。
 */
tasks.post("/:taskId/photos", async (c) => {
  const ctx = getTenant(c);

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "INVALID_REQUEST" } satisfies PhotoError, 400);
  }

  const meta = photoUploadMetaSchema.safeParse({
    clientId: form.get("clientId"),
    kind: form.get("kind") ?? undefined,
    checklistItemId: form.get("checklistItemId") ?? undefined,
  });
  if (!meta.success) return c.json({ error: "INVALID_REQUEST" } satisfies PhotoError, 400);

  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "INVALID_REQUEST" } satisfies PhotoError, 400);
  }

  const outcome = await uploadPhoto(c.env, ctx, {
    taskId: c.req.param("taskId"),
    clientId: meta.data.clientId,
    kind: meta.data.kind,
    checklistItemId: meta.data.checklistItemId,
    bytes: new Uint8Array(await file.arrayBuffer()),
    uploadedById: getSession(c).membershipId,
  });

  if (outcome.kind === "REJECTED") {
    // タスクが無い場合は `INVALID_REQUEST` で返ってくる。**404 に写す**
    // （資源の存在を推測させない / INV-31）。
    if (outcome.error === "INVALID_REQUEST") return c.notFound();
    return c.json({ error: outcome.error } satisfies PhotoError, PHOTO_ERROR_STATUS[outcome.error]);
  }

  const body: TaskPhotoUploadResponse = {
    data: toPhoto(
      {
        id: outcome.photo.photoId,
        taskId: outcome.photo.taskId,
        kind: outcome.photo.photoKind,
        checklistItemId: outcome.photo.checklistItemId,
        width: outcome.photo.width,
        height: outcome.photo.height,
        fileSize: outcome.photo.fileSize,
        capturedAt: outcome.photo.capturedAt,
        uploadedAt: outcome.photo.uploadedAt,
      },
      await signObjectUrl(c.env.SESSION_SECRET, outcome.photo.storageKey, getNow(c)),
    ),
    unchanged: outcome.unchanged,
  };
  return c.json(body);
});

/**
 * 検査の開始（PK-SPEC-P2 §4.2 / §14.1）。
 *
 * **経路がタスク側にあるのは §14.1 がそう書いているから。** 実装は
 * `lib/inspection/start.ts` にあり、以降の操作は `/api/v1/inspections/*`。
 *
 * 3 区間なので `/:taskId/:action`（2 区間）とは衝突しないが、
 * **静的な区間を先に置く**という冒頭の方針に合わせてここに登録する。
 */
tasks.post("/:taskId/inspection/start", async (c) => {
  const parsed = await readJson(c.req.raw);
  const body = inspectionStartRequestSchema.safeParse(parsed ?? {});
  if (!body.success) return c.json({ error: "INVALID_REQUEST" } satisfies InspectionError, 400);

  const outcome = await startInspection(c.env, getTenant(c), {
    taskId: c.req.param("taskId"),
    inspectorId: getSession(c).membershipId,
    overrideReason: body.data.overrideReason,
    clientTs: body.data.clientTs,
    idempotencyKey: c.req.header("Idempotency-Key"),
    ip: c.req.header("CF-Connecting-IP"),
  });

  if (outcome.kind === "REJECTED") {
    return c.json({ error: outcome.error } satisfies InspectionError, 409);
  }
  return c.json(outcome.body);
});

/**
 * 残存タスクの緊急上書き（PK-SPEC-P2 §13.3 / P2-16）。
 *
 * ```
 * POST /api/v1/tasks/:taskId/inspection/override   { "reason": "..." }
 * ```
 *
 * **1 件ずつしか受け取らない。** §13.1 で廃止した一括承認を、名前を変えて
 * 戻さないため（`lib/inspection/override.ts` の注記）。理由が無ければ 400。
 *
 * `Idempotency-Key` は受け取らない。**冪等性は状態そのもので担保している**
 * （2 回目は `COMPLETED` かつ `EMERGENCY_OVERRIDE` を見て `unchanged: true`）。
 * 鍵を保存する表を増やしても、判定の材料は同じものになる。
 */
tasks.post("/:taskId/inspection/override", async (c) => {
  const parsed = await readJson(c.req.raw);
  const body = inspectionOverrideRequestSchema.safeParse(parsed ?? {});
  if (!body.success) return c.json({ error: "INVALID_REQUEST" } satisfies InspectionError, 400);

  const outcome = await overrideInspection(c.env, getTenant(c), {
    taskId: c.req.param("taskId"),
    actorId: getSession(c).membershipId,
    reason: body.data.reason,
    ip: c.req.header("CF-Connecting-IP"),
  });

  if (outcome.kind === "REJECTED") {
    return c.json({ error: outcome.error } satisfies InspectionError, 409);
  }
  return c.json(outcome.body);
});

/**
 * 証跡の整合性確認（PK-SPEC-P2 §6.3 / §12.2「整合性を確認」）。
 *
 * ```
 * GET /api/v1/tasks/:taskId/evidence/verify
 * ```
 *
 * **示せるのは「保存後に書き換えられていないこと」だけ。** P2 は外部の
 * 時刻認証を導入していない（§6.1）ので、「その時刻に存在したこと」の
 * 証明ではない。画面の文言もそう書くこと（P2-08）。
 *
 * 権限は `task.read`。**証跡そのものに別のアクションを足していない。**
 * 内容はタスクの記録（チェックリスト・写真・検査結果）で、それを読める
 * 相手が連鎖の健全性も確かめられないと、確認の意味が無い。
 * 3 区間なので `/:taskId/:action`（2 区間）とは衝突しないが、
 * **静的な区間を先に置く**という冒頭の方針に合わせてここに登録する。
 */
tasks.get("/:taskId/evidence/verify", async (c) => {
  const ctx = getTenant(c);
  const task = await findTaskById(c.env, ctx, c.req.param("taskId"));
  if (task === undefined) return c.notFound();
  assertPermission(ctx, "task.read", propertyTarget([task.propertyId]));

  return c.json(await verifyTaskEvidence(c.env, ctx, task.id));
});

/**
 * 入室時の観察記録（PK-SPEC-P3 §7）。
 *
 * ```
 * GET  /api/v1/tasks/:taskId/observation        既定値と施設設定も返す
 * PUT  /api/v1/tasks/:taskId/observation        冪等。上書き可
 * POST /api/v1/tasks/:taskId/observation/skip   「今回は記録しない」
 * GET  /api/v1/tasks/:taskId/linen
 * PUT  /api/v1/tasks/:taskId/linen              配列で一括
 * ```
 *
 * **`/:taskId/:action`（2 区間）より前に登録すること**（冒頭の「登録の順序」）。
 * `observation` は 2 区間で、後ろに置くと `action = "observation"` として
 * 吸われる。
 */
tasks.get("/:taskId/observation", async (c) => {
  const ctx = getTenant(c);
  const task = await findTaskById(c.env, ctx, c.req.param("taskId"));
  if (task === undefined) return c.notFound();
  assertPermission(ctx, "observation.read", propertyTarget([task.propertyId]));

  return c.json(await buildObservationDetail(c.env, ctx, task));
});

/**
 * 観察の記録（M-05 / M-05b）。**冪等**（§7 MUST）。
 *
 * オフラインキューは同じ `Idempotency-Key` で再送する。2 回目は
 * 何も変えずに 200 を返す（`unchanged: true`）。
 */
tasks.put("/:taskId/observation", async (c) => {
  const body = observationUpsertRequestSchema.safeParse(await readJson(c.req.raw));
  if (!body.success) {
    return c.json({ error: "INVALID_REQUEST" } satisfies ObservationError, 400);
  }

  const ctx = getTenant(c);
  const task = await findTaskById(c.env, ctx, c.req.param("taskId"));
  if (task === undefined) return c.notFound();
  assertPermission(ctx, "observation.write", propertyTarget([task.propertyId]));

  const outcome = await recordObservation(c.env, ctx, task, {
    ...body.data,
    recordedById: getSession(c).membershipId,
    idempotencyKey: c.req.header("Idempotency-Key"),
  });
  if (outcome.kind === "REJECTED") {
    // **409 にしない。** 409 はキューが「処理済」として捨てる
    // （`lib/observation/linen.ts` の注記と同じ理由）。
    return c.json({ error: outcome.error } satisfies ObservationError, 400);
  }

  const detail = await buildObservationDetail(c.env, ctx, task);
  const response: ObservationUpsertResponse = {
    data: detail.data,
    unchanged: outcome.unchanged,
  };
  return c.json(response);
});

/** 「今回は記録しない」（§1.3 MUST）。**理由を受け取らない。** */
tasks.post("/:taskId/observation/skip", async (c) => {
  const body = observationSkipRequestSchema.safeParse((await readJson(c.req.raw)) ?? {});
  if (!body.success) {
    return c.json({ error: "INVALID_REQUEST" } satisfies ObservationError, 400);
  }

  const ctx = getTenant(c);
  const task = await findTaskById(c.env, ctx, c.req.param("taskId"));
  if (task === undefined) return c.notFound();
  assertPermission(ctx, "observation.write", propertyTarget([task.propertyId]));

  const result = await skipObservationForTask(c.env, ctx, task);
  const response: ObservationUpsertResponse = { data: null, unchanged: result.unchanged };
  return c.json(response);
});

/** 退室前のリネン枚数（M-06 / §4.3）。 */
tasks.get("/:taskId/linen", async (c) => {
  const ctx = getTenant(c);
  const task = await findTaskById(c.env, ctx, c.req.param("taskId"));
  if (task === undefined) return c.notFound();
  assertPermission(ctx, "observation.read", propertyTarget([task.propertyId]));

  return c.json(await buildLinenResponse(c.env, ctx, task));
});

/** リネン枚数の記録。**破損・汚損には写真 1 枚が要る**（§4.3 MUST）。 */
tasks.put("/:taskId/linen", async (c) => {
  const body = linenUpsertRequestSchema.safeParse(await readJson(c.req.raw));
  if (!body.success) {
    return c.json({ error: "INVALID_REQUEST" } satisfies ObservationError, 400);
  }

  const ctx = getTenant(c);
  const task = await findTaskById(c.env, ctx, c.req.param("taskId"));
  if (task === undefined) return c.notFound();
  assertPermission(ctx, "observation.write", propertyTarget([task.propertyId]));

  const outcome = await recordLinen(c.env, ctx, task, {
    entries: body.data.entries,
    recordedById: getSession(c).membershipId,
  });
  if (outcome.kind === "REJECTED") {
    return c.json({ error: outcome.error } satisfies ObservationError, 400);
  }

  return c.json(await buildLinenResponse(c.env, ctx, task));
});

/**
 * タスクの状態変更（§5.3）。
 *
 * **操作は URL の末尾で表す。** ボディに `action` を入れると、
 * ルート単位でのレート制限や監査の切り分けができなくなる。
 *
 * **この登録はこのファイルの最後に置くこと**（冒頭の「登録の順序」）。
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

/**
 * 写真のエラーに対する HTTP ステータス。
 *
 * 413 / 415 を使うのは、撮り直しで直るのか（大きすぎ・形式違い）、
 * 何枚か消してもらう必要があるのか（409）を画面が区別するため。
 */
const PHOTO_ERROR_STATUS = {
  INVALID_REQUEST: 400,
  PHOTO_LIMIT_EXCEEDED: 409,
  PHOTO_TOO_LARGE: 413,
  UNSUPPORTED_IMAGE: 415,
} as const satisfies Record<string, 400 | 409 | 413 | 415>;

/** 写真の行 + 署名付き URL を応答へ写す。**`storageKey` を出さない。** */
function toPhoto(
  row: {
    id: string;
    taskId: string;
    kind: TaskPhoto["kind"];
    checklistItemId: string | null;
    width: number;
    height: number;
    fileSize: number;
    capturedAt: Date | number | null;
    uploadedAt: Date | number;
  },
  url: string,
): TaskPhoto {
  const toMillis = (value: Date | number): number =>
    typeof value === "number" ? value : value.getTime();
  return {
    photoId: row.id,
    taskId: row.taskId,
    kind: row.kind,
    checklistItemId: row.checklistItemId,
    width: row.width,
    height: row.height,
    fileSize: row.fileSize,
    capturedAt: row.capturedAt === null ? null : toMillis(row.capturedAt),
    uploadedAt: toMillis(row.uploadedAt),
    url,
  };
}

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
